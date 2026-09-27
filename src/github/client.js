// @ts-check
/**
 * Cliente REST mínimo para a API do GitHub e servidores compatíveis (Gitea, Forgejo).
 * O `fetch` é injectado para que os testes corram sem rede. O token nunca aparece nas
 * mensagens nem nos parâmetros dos erros, e nunca segue para outra origem que não a do apiUrl.
 */

import { Buffer } from 'node:buffer';

import { GitHubApiError } from '../core/errors.js';

const API_VERSION = '2022-11-28';
const DEFAULT_USER_AGENT = 'quality-ratchet';
const JSON_ACCEPT = 'application/vnd.github+json';
const RAW_ACCEPT = 'application/vnd.github.raw+json';
const PER_PAGE = 100;
const MAX_PAGES = 50;
const MAX_ERROR_BODY = 300;
const REDACTED = '***';
const UTF8_DECODER = new TextDecoder();
const LINK_VALUE = /<([^>]*)>([^<]*)/g;
const LINK_REL = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i;

/**
 * Pull request normalizado, igual para a resposta da API e para o payload de um evento.
 * @typedef {object} PullRequestInfo
 * @property {number} number
 * @property {string} title
 * @property {string[]} labels nomes das etiquetas
 * @property {string} baseSha
 * @property {string} headSha
 * @property {string} baseRepo `full_name` do repositório base (ex: 'dono/repo')
 * @property {string} headRepo `full_name` do repositório de origem ('' se o fork foi apagado)
 */

/**
 * Comentário de uma issue ou pull request.
 * @typedef {object} IssueComment
 * @property {number} id
 * @property {string} body
 * @property {string} user login do autor ('' quando ausente)
 */

/** @typedef {{id: number}} CommentRef */

/**
 * Aviso de paginação interrompida pelo limite de segurança.
 * @typedef {object} TruncationInfo
 * @property {string} path caminho pedido, sem parâmetros de paginação
 * @property {number} pages número de páginas lidas
 */

/**
 * @typedef {object} GitHubClientDeps
 * @property {typeof fetch} fetch
 * @property {string} apiUrl URL base da API (ex: 'https://api.github.com')
 * @property {string} token token de acesso; vazio omite o header authorization
 * @property {string} [userAgent] por omissão 'quality-ratchet'
 * @property {(info: TruncationInfo) => void} [onTruncated] regista o corte da paginação
 */

/**
 * @typedef {object} GitHubClient
 * @property {(repo: string, number: number) => Promise<PullRequestInfo>} getPullRequest
 * @property {(repo: string, path: string, ref: string) => Promise<string|null>} getFileAtRef
 * @property {(repo: string, number: number) => Promise<IssueComment[]>} listIssueComments
 * @property {(repo: string, number: number, body: string) => Promise<CommentRef>} createComment
 * @property {(repo: string, commentId: number, body: string) => Promise<CommentRef>} updateComment
 */

/**
 * @typedef {object} SendOptions
 * @property {string} [method] método HTTP, por omissão GET
 * @property {string} [accept] header accept, por omissão o JSON da API
 * @property {unknown} [body] corpo a serializar em JSON
 */

/** @typedef {{method: string, path: string}} RequestTarget */

/**
 * Resposta a interpretar como JSON e a sua origem, para as mensagens de erro.
 * @typedef {object} JsonSource
 * @property {string} route caminho relativo ao apiUrl ou URL absoluto
 * @property {number} status código HTTP da resposta
 */

/**
 * Estado de uma listagem paginada.
 * @typedef {object} PageState
 * @property {string} path caminho da listagem, sem parâmetros de paginação
 * @property {number} page número do pedido actual, a começar em 1
 * @property {unknown[]} items elementos acumulados
 * @property {string} last JSON da última página lida, para detectar páginas repetidas
 */

/**
 * Cria o cliente REST com as dependências injectadas.
 * @param {GitHubClientDeps} deps
 * @returns {GitHubClient}
 */
export function createGitHubClient(deps) {
  return {
    getPullRequest: (repo, number) => getPullRequest(deps, repo, number),
    getFileAtRef: (repo, path, ref) => getFileAtRef(deps, repo, path, ref),
    listIssueComments: (repo, number) => listIssueComments(deps, repo, number),
    createComment: (repo, number, body) => createComment(deps, repo, number, body),
    updateComment: (repo, commentId, body) => updateComment(deps, repo, commentId, body),
  };
}

/**
 * Converte um pull request da API, ou do payload de um evento, para PullRequestInfo.
 * @param {unknown} data objecto `pull_request` tal como o GitHub o devolve
 * @returns {PullRequestInfo}
 */
export function mapPullRequest(data) {
  const pr = asRecord(data);
  const base = asRecord(pr.base);
  const head = asRecord(pr.head);
  return {
    number: Number(pr.number),
    title: asString(pr.title),
    labels: asArray(pr.labels).map(labelName).filter((name) => name !== ''),
    baseSha: asString(base.sha),
    headSha: asString(head.sha),
    baseRepo: asString(asRecord(base.repo).full_name),
    headRepo: asString(asRecord(head.repo).full_name),
  };
}

/**
 * Obtém um pull request pelo número.
 * @param {GitHubClientDeps} deps
 * @param {string} repo 'dono/repo'
 * @param {number} number
 * @returns {Promise<PullRequestInfo>}
 */
async function getPullRequest(deps, repo, number) {
  const route = `${repoRoute(repo)}/pulls/${number}`;
  return mapPullRequest(await requestJson(deps, route, {}));
}

/**
 * Lê o conteúdo de um ficheiro numa referência. Devolve null quando o ficheiro não existe,
 * e também sem fazer o pedido quando o caminho está vazio ou sai da raiz do repositório.
 * @param {GitHubClientDeps} deps
 * @param {string} repo 'dono/repo'
 * @param {string} path caminho no repositório
 * @param {string} ref ramo, etiqueta ou sha
 * @returns {Promise<string|null>}
 */
async function getFileAtRef(deps, repo, path, ref) {
  const segments = normalizeRepoPath(path);
  if (segments === null) return null;
  const query = `?ref=${encodeURIComponent(ref)}`;
  const route = `${repoRoute(repo)}/contents/${encodeSegments(segments)}${query}`;
  const response = await send(deps, route, { accept: RAW_ACCEPT }).catch(nullIfNotFound);
  return response === null ? null : readFileBody(deps, response, route);
}

/**
 * Lista todos os comentários de uma issue ou pull request, percorrendo as páginas.
 * @param {GitHubClientDeps} deps
 * @param {string} repo 'dono/repo'
 * @param {number} number
 * @returns {Promise<IssueComment[]>}
 */
async function listIssueComments(deps, repo, number) {
  const items = await collectPages(deps, `${repoRoute(repo)}/issues/${number}/comments`);
  return items.map(mapComment);
}

/**
 * Publica um comentário novo.
 * @param {GitHubClientDeps} deps
 * @param {string} repo 'dono/repo'
 * @param {number} number
 * @param {string} body
 * @returns {Promise<CommentRef>}
 */
async function createComment(deps, repo, number, body) {
  const route = `${repoRoute(repo)}/issues/${number}/comments`;
  const data = await requestJson(deps, route, { method: 'POST', body: { body } });
  return { id: Number(asRecord(data).id) };
}

/**
 * Substitui o body de um comentário existente.
 * @param {GitHubClientDeps} deps
 * @param {string} repo 'dono/repo'
 * @param {number} commentId
 * @param {string} body
 * @returns {Promise<CommentRef>}
 */
async function updateComment(deps, repo, commentId, body) {
  const route = `${repoRoute(repo)}/issues/comments/${commentId}`;
  const data = await requestJson(deps, route, { method: 'PATCH', body: { body } });
  const id = asRecord(data).id;
  return { id: id === undefined ? commentId : Number(id) };
}

/**
 * Percorre as páginas de uma listagem até não haver página seguinte. Pára no limite de
 * segurança, avisa através de onTruncated e devolve o que leu.
 * @param {GitHubClientDeps} deps
 * @param {string} path caminho da listagem, sem parâmetros de paginação
 * @returns {Promise<unknown[]>}
 */
async function collectPages(deps, path) {
  /** @type {PageState} */
  const state = { path, page: 1, items: [], last: '' };
  /** @type {string|null} */
  let route = pageRoute(path, 1);
  while (route !== null && state.page <= MAX_PAGES) {
    route = await readPage(deps, route, state);
    state.page += 1;
  }
  if (route !== null) deps.onTruncated?.({ path, pages: MAX_PAGES });
  return state.items;
}

/**
 * Lê uma página e acumula os elementos no estado. Uma página igual à anterior indica um
 * servidor que ignora o parâmetro `page`, e termina a listagem sem duplicar elementos.
 * @param {GitHubClientDeps} deps
 * @param {string} route caminho da página ou URL absoluto vindo do header Link
 * @param {PageState} state
 * @returns {Promise<string|null>} rota da página seguinte, ou null quando terminou
 */
async function readPage(deps, route, state) {
  const response = await send(deps, route, {});
  const batch = asArray(await readJson(deps, response, route));
  const snapshot = JSON.stringify(batch);
  if (batch.length > 0 && snapshot === state.last) return null;
  state.last = snapshot;
  state.items.push(...batch);
  return nextRoute(deps, response, resolveUrl(deps.apiUrl, route), state, batch.length);
}

/**
 * Decide qual a próxima página a pedir. Com header Link segue a relação "next"; sem ele
 * pede a página seguinte, excepto quando a actual veio vazia ou quando o total anunciado
 * em X-Total-Count (Gitea, Forgejo) já foi lido.
 * @param {GitHubClientDeps} deps
 * @param {Response} response resposta da página actual
 * @param {string} url URL absoluto da página actual, base dos links relativos
 * @param {PageState} state
 * @param {number} count número de elementos da página actual
 * @returns {string|null}
 */
function nextRoute(deps, response, url, state, count) {
  const link = response.headers.get('link');
  if (link !== null) return followLink(deps.apiUrl, url, link);
  if (count === 0 || reachedTotal(response, state.items.length)) return null;
  return pageRoute(state.path, state.page + 1);
}

/**
 * URL da relação "next" do header Link, fixado na origem do apiUrl para que o token não
 * siga para outro servidor (o Gitea gera os links com o ROOT_URL público, que pode não ser
 * o endereço usado pelo runner).
 * @param {string} apiUrl
 * @param {string} base URL da página actual
 * @param {string} link valor do header Link
 * @returns {string|null}
 */
function followLink(apiUrl, base, link) {
  const target = findNextLink(link);
  if (target === null) return null;
  const url = new URL(target, base);
  return new URL(`${url.pathname}${url.search}`, new URL(apiUrl).origin).href;
}

/**
 * Procura a relação "next" num header Link (RFC 8288): o valor de rel pode vir sem aspas,
 * em maiúsculas ou com várias relações separadas por espaços.
 * @param {string} link
 * @returns {string|null} alvo da relação, tal como vem no header
 */
function findNextLink(link) {
  for (const [, target, params] of link.matchAll(LINK_VALUE)) {
    const rel = LINK_REL.exec(params);
    const relations = (rel?.[1] ?? rel?.[2] ?? '').toLowerCase().split(/\s+/);
    if (relations.includes('next')) return target;
  }
  return null;
}

/**
 * Indica se já foram lidos todos os elementos anunciados no header X-Total-Count.
 * @param {Response} response
 * @param {number} collected elementos lidos até agora
 * @returns {boolean}
 */
function reachedTotal(response, collected) {
  const total = (response.headers.get('x-total-count') ?? '').trim();
  return /^\d+$/.test(total) && collected >= Number(total);
}

/**
 * Acrescenta os parâmetros de paginação a um caminho.
 * @param {string} path
 * @param {number} page
 * @returns {string}
 */
function pageRoute(path, page) {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}per_page=${PER_PAGE}&page=${page}`;
}

/**
 * Faz um pedido e devolve o JSON da resposta (null quando não há body).
 * @param {GitHubClientDeps} deps
 * @param {string} route caminho relativo ao apiUrl
 * @param {SendOptions} options
 * @returns {Promise<unknown>}
 */
async function requestJson(deps, route, options) {
  const response = await send(deps, route, options);
  return readJson(deps, response, route);
}

/**
 * Envia um pedido à API. Qualquer resposta fora de 2xx lança GitHubApiError.
 * @param {GitHubClientDeps} deps
 * @param {string} route caminho relativo ao apiUrl ou URL absoluto
 * @param {SendOptions} options
 * @returns {Promise<Response>}
 */
async function send(deps, route, options) {
  const url = resolveUrl(deps.apiUrl, route);
  const method = options.method ?? 'GET';
  const target = { method, path: displayPath(deps.apiUrl, url) };
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const init = { method, headers: buildHeaders(deps, options), body };
  const response = await callFetch(deps, url, init, target);
  if (!response.ok) throw await httpError(deps, response, target);
  return response;
}

/**
 * Monta os headers do pedido.
 * @param {GitHubClientDeps} deps
 * @param {SendOptions} options
 * @returns {Record<string, string>}
 */
function buildHeaders(deps, options) {
  /** @type {Record<string, string>} */
  const headers = {
    accept: options.accept ?? JSON_ACCEPT,
    'x-github-api-version': API_VERSION,
    'user-agent': deps.userAgent ?? DEFAULT_USER_AGENT,
  };
  if (deps.token !== '') headers.authorization = `token ${deps.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return headers;
}

/**
 * Chama o fetch injectado, convertendo falhas de rede em GitHubApiError com estado 0.
 * @param {GitHubClientDeps} deps
 * @param {string} url
 * @param {RequestInit} init
 * @param {RequestTarget} target
 * @returns {Promise<Response>}
 */
async function callFetch(deps, url, init, target) {
  try {
    return await deps.fetch(url, init);
  } catch (error) {
    const body = truncate(redact(reasonOf(error), deps.token));
    throw new GitHubApiError('github_api_failed', { ...target, status: 0, body }, 0);
  }
}

/**
 * Constrói o erro de uma resposta HTTP falhada, com o body truncado e sem o token.
 * @param {GitHubClientDeps} deps
 * @param {Response} response
 * @param {RequestTarget} target
 * @returns {Promise<GitHubApiError>}
 */
async function httpError(deps, response, target) {
  const body = truncate(redact(await readErrorBody(response), deps.token));
  const status = response.status;
  return new GitHubApiError('github_api_failed', { ...target, status, body }, status);
}

/**
 * Lê o body de uma resposta de erro; se a leitura falhar, devolve o motivo da falha.
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readErrorBody(response) {
  try {
    return await response.text();
  } catch (error) {
    return reasonOf(error);
  }
}

/**
 * Converte um 404 em null; qualquer outro erro é relançado.
 * @param {unknown} error
 * @returns {null}
 */
function nullIfNotFound(error) {
  if (error instanceof GitHubApiError && error.status === 404) return null;
  throw error;
}

/**
 * Lê o body de uma resposta JSON. 204 ou body vazio devolvem null.
 * @param {GitHubClientDeps} deps
 * @param {Response} response
 * @param {string} route usado apenas nas mensagens de erro
 * @returns {Promise<unknown>}
 */
async function readJson(deps, response, route) {
  if (response.status === 204) return null;
  const text = await response.text();
  return text.trim() === '' ? null : parseJson(deps, text, { route, status: response.status });
}

/**
 * Interpreta JSON, lançando GitHubApiError com o código json_invalid em caso de falha. O
 * motivo do JSON.parse cita parte do texto, por isso também passa pela ocultação do token.
 * @param {GitHubClientDeps} deps
 * @param {string} text
 * @param {JsonSource} source
 * @returns {unknown}
 */
function parseJson(deps, text, source) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const path = displayPath(deps.apiUrl, resolveUrl(deps.apiUrl, source.route));
    const reason = truncate(redact(reasonOf(error), deps.token));
    throw new GitHubApiError('json_invalid', { path, reason }, source.status);
  }
}

/**
 * Devolve o conteúdo de um ficheiro. O GitHub responde em raw; o Gitea e o Forgejo ignoram
 * o Accept raw e devolvem um envelope JSON com o conteúdo em base64. Nos dois casos um BOM
 * UTF-8 inicial é removido, tal como faz o Response.text() na resposta raw.
 * @param {GitHubClientDeps} deps
 * @param {Response} response
 * @param {string} route
 * @returns {Promise<string>}
 */
async function readFileBody(deps, response, route) {
  const text = await response.text();
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  if (text.trim() === '' || !type.includes('json') || type.includes('raw')) return text;
  const data = asRecord(parseJson(deps, text, { route, status: response.status }));
  if (typeof data.content !== 'string' || data.encoding !== 'base64') return text;
  return UTF8_DECODER.decode(Buffer.from(data.content, 'base64'));
}

/**
 * Converte um comentário da API para IssueComment.
 * @param {unknown} item
 * @returns {IssueComment}
 */
function mapComment(item) {
  const comment = asRecord(item);
  const user = asString(asRecord(comment.user).login);
  return { id: Number(comment.id), body: asString(comment.body), user };
}

/**
 * Nome de uma etiqueta, aceitando objectos `{name}` ou strings.
 * @param {unknown} label
 * @returns {string}
 */
function labelName(label) {
  return typeof label === 'string' ? label : asString(asRecord(label).name);
}

/**
 * Caminho base de um repositório na API.
 * @param {string} repo 'dono/repo'
 * @returns {string}
 */
function repoRoute(repo) {
  return `/repos/${encodeSegments(repo.split('/').filter((segment) => segment !== ''))}`;
}

/**
 * Normaliza um caminho do repositório: ignora segmentos vazios e `.` e resolve `..`. Sem
 * isto, o parser de URL do fetch resolveria os `..` (mesmo codificados como %2E%2E) e o
 * pedido sairia de /contents/.
 * @param {string} path
 * @returns {string[]|null} segmentos, ou null se o caminho ficar vazio ou sair da raiz
 */
function normalizeRepoPath(path) {
  /** @type {string[]} */
  const segments = [];
  for (const segment of path.split('/')) {
    if (segment === '..' && segments.pop() === undefined) return null;
    if (segment !== '' && segment !== '.' && segment !== '..') segments.push(segment);
  }
  return segments.length === 0 ? null : segments;
}

/**
 * Codifica cada segmento com encodeURIComponent e junta-os com barras.
 * @param {string[]} segments
 * @returns {string}
 */
function encodeSegments(segments) {
  return segments.map(encodeURIComponent).join('/');
}

/**
 * Junta um caminho ao apiUrl; URLs absolutos (header Link) ficam como estão.
 * @param {string} apiUrl
 * @param {string} route
 * @returns {string}
 */
function resolveUrl(apiUrl, route) {
  return /^https?:\/\//i.test(route) ? route : `${trimTrailingSlash(apiUrl)}${route}`;
}

/**
 * Caminho a mostrar em erros: o URL sem o prefixo do apiUrl.
 * @param {string} apiUrl
 * @param {string} url
 * @returns {string}
 */
function displayPath(apiUrl, url) {
  const base = trimTrailingSlash(apiUrl);
  return url.startsWith(base) ? url.slice(base.length) : url;
}

/**
 * @param {string} url
 * @returns {string}
 */
function trimTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

/**
 * Substitui todas as ocorrências do token.
 * @param {string} text
 * @param {string} token
 * @returns {string}
 */
function redact(text, token) {
  return token === '' ? text : text.split(token).join(REDACTED);
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncate(text) {
  return text.slice(0, MAX_ERROR_BODY);
}

/**
 * Motivo legível de um erro. O fetch do Node rejeita com "fetch failed" e guarda a causa
 * real (ex: ENOTFOUND, ECONNREFUSED) em `cause`, que por isso é acrescentada.
 * @param {unknown} error
 * @returns {string}
 */
function reasonOf(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : '';
  return cause === '' ? error.message : `${error.message}: ${cause}`;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  if (typeof value !== 'object' || value === null) return {};
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  return typeof value === 'string' ? value : '';
}
