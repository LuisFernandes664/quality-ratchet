// @ts-check
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, test } from 'node:test';

import { GitHubApiError } from '../../src/core/errors.js';
import { createGitHubClient, mapPullRequest } from '../../src/github/client.js';

const API_URL = 'https://api.example.test';
const API_ORIGIN = new URL(API_URL).origin;
const TOKEN = 'ghs_segredoMuitoSecreto123';
const REPO = 'dono/projecto';

/**
 * @typedef {object} FakeReply
 * @property {number} [status]
 * @property {Record<string, string>} [headers]
 * @property {string|null} [body]
 */

/**
 * @typedef {object} RecordedRequest
 * @property {string} url
 * @property {string} method
 * @property {Record<string, string>} headers
 * @property {unknown} body
 */

/**
 * Fetch falso: regista os pedidos e responde com a função indicada (recebe o índice do
 * pedido e o URL). Uma excepção lançada pela função simula uma falha de rede.
 * @param {(index: number, url: string) => FakeReply} reply
 * @returns {{fetch: typeof fetch, requests: RecordedRequest[]}}
 */
function fakeFetch(reply) {
  /** @type {RecordedRequest[]} */
  const requests = [];
  /** @type {typeof fetch} */
  const fetchFake = async (input, init = {}) => {
    const url = String(input);
    const headers = /** @type {Record<string, string>} */ ({ ...init.headers });
    requests.push({ url, method: init.method ?? 'GET', headers, body: init.body });
    const answer = reply(requests.length - 1, url);
    const { status = 200, headers: replyHeaders = {}, body = null } = answer;
    return new Response(body, { status, headers: replyHeaders });
  };
  return { fetch: fetchFake, requests };
}

/**
 * Resposta JSON com status 200 por omissão.
 * @param {unknown} data
 * @param {Record<string, string>} [headers]
 * @returns {FakeReply}
 */
function json(data, headers = {}) {
  return text(JSON.stringify(data), 'application/json', headers);
}

/**
 * Resposta de texto com o content-type indicado e status 200.
 * @param {string} body
 * @param {string} contentType
 * @param {Record<string, string>} [headers]
 * @returns {FakeReply}
 */
function text(body, contentType, headers = {}) {
  return { body, headers: { 'content-type': contentType, ...headers } };
}

/**
 * Cliente ligado a um fetch falso que responde através da função indicada. A espera entre
 * tentativas é falsa e regista os atrasos pedidos.
 * @param {(index: number, url: string) => FakeReply} reply
 * @param {Partial<import('../../src/github/client.js').GitHubClientDeps>} [extra]
 */
function setup(reply, extra = {}) {
  const fake = fakeFetch(reply);
  /** @type {number[]} */
  const delays = [];
  const sleep = async (/** @type {number} */ ms) => { delays.push(ms); };
  const deps = { fetch: fake.fetch, apiUrl: API_URL, token: TOKEN, sleep, ...extra };
  return { client: createGitHubClient(deps), requests: fake.requests, delays };
}

/**
 * Resposta falsa que falha nos primeiros pedidos e depois responde com `then`.
 * @param {FakeReply[]} failures respostas dos primeiros pedidos, pela ordem
 * @param {FakeReply} then resposta dos pedidos seguintes
 * @returns {(index: number) => FakeReply}
 */
function failingFirst(failures, then) {
  return (index) => failures[index] ?? then;
}

/**
 * Executa a promessa e devolve o GitHubApiError que ela rejeita.
 * @param {Promise<unknown>} promise
 * @returns {Promise<GitHubApiError>}
 */
async function captureError(promise) {
  const error = await promise.then(
    () => assert.fail('era esperado um erro'),
    (/** @type {unknown} */ reason) => reason,
  );
  assert.ok(error instanceof GitHubApiError);
  return error;
}

/**
 * Lista de comentários falsos com ids consecutivos.
 * @param {number} first
 * @param {number} count
 */
function comments(first, count) {
  return Array.from({ length: count }, (_, index) => ({ id: first + index, body: 'x' }));
}

/**
 * Header Link com as relações indicadas.
 * @param {Record<string, number>} relations
 * @returns {string}
 */
function linkHeader(relations) {
  const url = `${API_URL}/repositories/1/issues/7/comments?per_page=100`;
  return Object.entries(relations).map(([rel, page]) => `<${url}&page=${page}>; rel="${rel}"`)
    .join(', ');
}

/**
 * Origens dos pedidos de uma listagem cuja primeira página traz o header Link indicado e
 * a segunda vem vazia.
 * @param {string} link valor do header Link
 * @param {string} [apiUrl]
 * @returns {Promise<string[]>}
 */
async function linkOrigins(link, apiUrl = API_URL) {
  const pages = [json(comments(1, 1), { link }), json([])];
  const reply = (/** @type {number} */ index) => pages[index] ?? assert.fail('pedido a mais');
  const { client, requests } = setup(reply, { apiUrl });
  await client.listIssueComments(REPO, 7);
  return requests.map((request) => new URL(request.url).origin);
}

/**
 * Lista comentários em que a primeira página traz o header Link produzido pela função
 * indicada (recebe o URL da segunda página) e a segunda já não tem página seguinte.
 * @param {(url: string) => string} link
 * @returns {Promise<RecordedRequest[]>}
 */
async function followLinkValue(link) {
  const url = `${API_URL}/repositories/1/issues/7/comments?page=2`;
  const pages = [
    json(comments(1, 1), { link: link(url) }),
    json(comments(2, 1), { link: `<${url}>; rel="prev"` }),
  ];
  const { client, requests } = setup((index) => pages[index] ?? assert.fail('pedido a mais'));
  await client.listIssueComments(REPO, 7);
  return requests;
}

const PULL_REQUEST = {
  number: 42,
  title: 'feat: nova métrica',
  labels: [{ name: 'hotfix' }, { name: 'docs' }],
  base: { sha: 'aaa111', repo: { full_name: 'dono/projecto' } },
  head: { sha: 'bbb222', repo: { full_name: 'colaborador/projecto' } },
};

describe('createGitHubClient: headers', () => {
  test('envia accept, authorization com token, versão da API e user-agent', async () => {
    const { client, requests } = setup(() => json(PULL_REQUEST));
    await client.getPullRequest(REPO, 42);
    assert.deepEqual(requests[0].headers, {
      accept: 'application/vnd.github+json',
      authorization: `token ${TOKEN}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'quality-ratchet',
    });
  });

  test('envia content-type JSON quando há body', async () => {
    const { client, requests } = setup(() => ({ ...json({ id: 5 }), status: 201 }));
    await client.createComment(REPO, 42, 'olá');
    assert.equal(requests[0].headers['content-type'], 'application/json');
  });

  test('envia o body serializado em JSON', async () => {
    const { client, requests } = setup(() => ({ ...json({ id: 5 }), status: 201 }));
    await client.createComment(REPO, 42, 'olá');
    assert.equal(requests[0].body, JSON.stringify({ body: 'olá' }));
  });

  test('usa o user-agent indicado nas dependências', async () => {
    const { client, requests } = setup(() => json(PULL_REQUEST), { userAgent: 'ratchet-teste' });
    await client.getPullRequest(REPO, 42);
    assert.equal(requests[0].headers['user-agent'], 'ratchet-teste');
  });

  test('omite o header authorization quando o token está vazio', async () => {
    const { client, requests } = setup(() => json(PULL_REQUEST), { token: '' });
    await client.getPullRequest(REPO, 42);
    assert.equal('authorization' in requests[0].headers, false);
  });

  test('junta os caminhos a um apiUrl com prefixo e barra final (estilo Gitea)', async () => {
    const apiUrl = 'https://gitea.example.test/api/v1/';
    const { client, requests } = setup(() => json(PULL_REQUEST), { apiUrl });
    await client.getPullRequest(REPO, 42);
    assert.equal(requests[0].url, 'https://gitea.example.test/api/v1/repos/dono/projecto/pulls/42');
  });
});

describe('createGitHubClient: erros', () => {
  test('usa o código github_api_failed num erro HTTP', async () => {
    const { client } = setup(() => ({ status: 403, body: 'proibido' }));
    const error = await captureError(client.getPullRequest(REPO, 42));
    assert.equal(error.code, 'github_api_failed');
  });

  test('expõe o estado HTTP em error.status', async () => {
    const { client } = setup(() => ({ status: 403, body: 'proibido' }));
    const error = await captureError(client.getPullRequest(REPO, 42));
    assert.equal(error.status, 403);
  });

  test('guarda método, caminho, estado e body do erro HTTP', async () => {
    const { client } = setup(() => ({ status: 403, body: 'proibido' }));
    const error = await captureError(client.getPullRequest(REPO, 42));
    assert.deepEqual(error.params, {
      method: 'GET',
      path: '/repos/dono/projecto/pulls/42',
      status: 403,
      body: 'proibido',
    });
  });

  test('trunca o body do erro a 300 caracteres', async () => {
    const { client } = setup(() => ({ status: 500, body: 'e'.repeat(1000) }));
    const error = await captureError(client.getPullRequest(REPO, 42));
    assert.equal(error.params.body, 'e'.repeat(300));
  });

  test('nunca inclui o token na mensagem nem nos parâmetros do erro', async () => {
    const { client } = setup(() => ({ status: 401, body: `token inválido: ${TOKEN}` }));
    const error = await captureError(client.getPullRequest(REPO, 42));
    const shown = JSON.stringify({ message: error.message, params: error.params });
    assert.equal(shown.includes(TOKEN), false);
  });

  test('converte uma falha de rede em GitHubApiError com estado 0', async () => {
    const { client } = setup(() => { throw new TypeError('fetch failed'); });
    const error = await captureError(client.getPullRequest(REPO, 42));
    assert.equal(error.status, 0);
  });

  test('usa a mensagem da falha de rede como body do erro', async () => {
    const { client } = setup(() => { throw new TypeError('fetch failed'); });
    const error = await captureError(client.getPullRequest(REPO, 42));
    assert.equal(error.params.body, 'fetch failed');
  });

  test('acrescenta a causa real de uma falha de rede do fetch', async () => {
    const cause = new Error('getaddrinfo ENOTFOUND api.example.test');
    const { client } = setup(() => { throw new TypeError('fetch failed', { cause }); });
    const error = await captureError(client.getPullRequest(REPO, 42));
    assert.equal(error.params.body, 'fetch failed: getaddrinfo ENOTFOUND api.example.test');
  });

  test('lança json_invalid quando uma resposta 200 não traz JSON válido', async () => {
    const { client } = setup(() => ({ body: '<html>' }));
    const error = await captureError(client.getPullRequest(REPO, 42));
    assert.equal(error.code, 'json_invalid');
  });

  test('json_invalid indica o caminho relativo ao apiUrl', async () => {
    const { client } = setup(() => ({ body: '<html>' }));
    const error = await captureError(client.getPullRequest(REPO, 42));
    assert.equal(error.params.path, '/repos/dono/projecto/pulls/42');
  });

  test('json_invalid não inclui o token citado pelo JSON.parse', async () => {
    const { client } = setup(() => ({ body: `<html>${TOKEN}</html>` }));
    const error = await captureError(client.getPullRequest(REPO, 42));
    const shown = JSON.stringify({ message: error.message, params: error.params });
    assert.equal(shown.includes(TOKEN), false);
  });

  test('getPullRequest relança um 404 em vez de devolver null', async () => {
    const { client } = setup(() => ({ status: 404, body: '{"message":"Not Found"}' }));
    const error = await captureError(client.getPullRequest(REPO, 42));
    assert.equal(error.status, 404);
  });
});

describe('createGitHubClient: comentários', () => {
  test('createComment faz POST para /issues/<n>/comments', async () => {
    const { client, requests } = setup(() => ({ ...json({ id: 77 }), status: 201 }));
    await client.createComment(REPO, 42, 'texto');
    const { method, url } = requests[0];
    assert.deepEqual({ method, url }, {
      method: 'POST', url: `${API_URL}/repos/dono/projecto/issues/42/comments`,
    });
  });

  test('createComment devolve o id criado', async () => {
    const { client } = setup(() => ({ ...json({ id: 77 }), status: 201 }));
    assert.deepEqual(await client.createComment(REPO, 42, 'texto'), { id: 77 });
  });

  test('updateComment faz PATCH para o comentário', async () => {
    const { client, requests } = setup(() => json({ id: 9 }));
    await client.updateComment(REPO, 9, 'texto');
    const { method, url } = requests[0];
    assert.deepEqual({ method, url }, {
      method: 'PATCH', url: `${API_URL}/repos/dono/projecto/issues/comments/9`,
    });
  });

  test('aceita uma resposta 204 sem body', async () => {
    const { client } = setup(() => ({ status: 204 }));
    const updated = await client.updateComment(REPO, 9, 'texto');
    assert.deepEqual(updated, { id: 9 });
  });

  test('mapeia id, body e login do autor', async () => {
    const page = [{ id: 3, body: 'olá', user: { login: 'bot' }, extra: true }];
    const { client } = setup((index) => json(index === 0 ? page : []));
    const list = await client.listIssueComments(REPO, 7);
    assert.deepEqual(list, [{ id: 3, body: 'olá', user: 'bot' }]);
  });
});

describe('createGitHubClient: paginação', () => {
  test('pede per_page=100 e page=1 na primeira página', async () => {
    const { client, requests } = setup(() => json([]));
    await client.listIssueComments(REPO, 7);
    const url = `${API_URL}/repos/dono/projecto/issues/7/comments?per_page=100&page=1`;
    assert.equal(requests[0].url, url);
  });

  /** Três páginas ligadas pelo header Link. */
  const LINKED_PAGES = Object.freeze([
    json(comments(1, 2), { link: linkHeader({ next: 2, last: 3 }) }),
    json(comments(3, 2), { link: linkHeader({ prev: 1, next: 3, last: 3 }) }),
    json(comments(5, 1), { link: linkHeader({ prev: 2, first: 1 }) }),
  ]);

  test('junta os comentários de todas as páginas do header Link', async () => {
    const { client } = setup((index) => LINKED_PAGES[index] ?? assert.fail('pedido a mais'));
    const list = await client.listIssueComments(REPO, 7);
    assert.deepEqual(list.map((comment) => comment.id), [1, 2, 3, 4, 5]);
  });

  test('pede a página seguinte pelo URL do header Link', async () => {
    const { client, requests } = setup((index) => LINKED_PAGES[index] ?? assert.fail('a mais'));
    await client.listIssueComments(REPO, 7);
    const third = `${API_URL}/repositories/1/issues/7/comments?per_page=100&page=3`;
    assert.equal(requests[2].url, third);
  });

  test('pára quando o header Link já não tem rel="next"', async () => {
    const pages = [
      json(comments(1, 1), { link: linkHeader({ next: 2 }) }),
      json(comments(2, 1), { link: linkHeader({ prev: 1 }) }),
    ];
    const { client, requests } = setup((index) => pages[index] ?? assert.fail('pedido a mais'));
    await client.listIssueComments(REPO, 7);
    assert.equal(requests.length, 2);
  });

  /** Páginas sem header Link, a última vazia. */
  const UNLINKED_PAGES = Object.freeze([
    json(comments(1, 30)), json(comments(31, 30)), json(comments(61, 5)), json([]),
  ]);

  test('sem header Link pede a página seguinte até vir uma página vazia', async () => {
    const { client } = setup((index) => UNLINKED_PAGES[index] ?? assert.fail('pedido a mais'));
    const list = await client.listIssueComments(REPO, 7);
    assert.equal(list.length, 65);
  });

  test('sem header Link incrementa o parâmetro page', async () => {
    const reply = (/** @type {number} */ index) => UNLINKED_PAGES[index] ?? assert.fail('a mais');
    const { client, requests } = setup(reply);
    await client.listIssueComments(REPO, 7);
    assert.match(requests[3].url, /per_page=100&page=4$/);
  });

  test('pára nas 50 páginas', async () => {
    const { client, requests } = setup((index) => json(comments(index + 1, 1)));
    await client.listIssueComments(REPO, 7);
    assert.equal(requests.length, 50);
  });

  test('chama onTruncated com o caminho e as páginas ao atingir o limite', async () => {
    /** @type {unknown[]} */
    const warnings = [];
    const onTruncated = (/** @type {unknown} */ info) => warnings.push(info);
    const { client } = setup((index) => json(comments(index + 1, 1)), { onTruncated });
    await client.listIssueComments(REPO, 7);
    assert.deepEqual(warnings, [{ path: '/repos/dono/projecto/issues/7/comments', pages: 50 }]);
  });

  test('devolve o que leu ao atingir o limite mesmo sem onTruncated', async () => {
    const { client } = setup((index) => json(comments(index + 1, 1)));
    const list = await client.listIssueComments(REPO, 7);
    assert.equal(list.length, 50);
  });

  test('não chama onTruncated quando a última página é a 50.ª', async () => {
    /** @type {unknown[]} */
    const warnings = [];
    const onTruncated = (/** @type {unknown} */ info) => warnings.push(info);
    const last = { link: linkHeader({ prev: 49 }) };
    const reply = (/** @type {number} */ index) => (index < 50
      ? json(comments(index + 1, 1), index === 49 ? last : {})
      : assert.fail('pedido a mais'));
    const { client } = setup(reply, { onTruncated });
    await client.listIssueComments(REPO, 7);
    assert.deepEqual(warnings, []);
  });

  test('aceita rel=next sem aspas', async () => {
    const requests = await followLinkValue((url) => `<${url}>; rel=next`);
    assert.equal(requests.length, 2);
  });

  test('aceita REL e NEXT em maiúsculas depois de outros parâmetros', async () => {
    const requests = await followLinkValue((url) => `<${url}>; title="x"; REL="NEXT"`);
    assert.equal(requests.length, 2);
  });

  test('segue um rel com várias relações separadas por espaços', async () => {
    const requests = await followLinkValue((url) => `<${url}>; rel="next last"`);
    assert.equal(requests.length, 2);
  });

  test('não confunde rel="nextpage" com rel="next"', async () => {
    const requests = await followLinkValue((url) => `<${url}>; rel="nextpage"`);
    assert.equal(requests.length, 1);
  });

  test('resolve um link relativo contra a página actual', async () => {
    const pages = [
      json(comments(1, 1), { link: '</repositories/1/issues/7/comments?page=2>; rel="next"' }),
      json(comments(2, 1), { link: '' }),
    ];
    const { client, requests } = setup((index) => pages[index] ?? assert.fail('pedido a mais'));
    await client.listIssueComments(REPO, 7);
    assert.equal(requests[1].url, `${API_URL}/repositories/1/issues/7/comments?page=2`);
  });

  test('fixa o link rel="next" na origem do apiUrl (o token não sai do servidor)', async () => {
    const link = '<https://git.publico.test/api/v1/repos/x/y/issues/7/comments?page=2>';
    const pages = [json(comments(1, 1), { link: `${link}; rel="next"` }), json([])];
    const { client, requests } = setup((index) => pages[index] ?? assert.fail('pedido a mais'));
    await client.listIssueComments(REPO, 7);
    const expected = `${API_URL}/api/v1/repos/x/y/issues/7/comments?page=2`;
    assert.equal(requests[1].url, expected);
  });

  test('sem header Link pára quando X-Total-Count já foi lido (Gitea)', async () => {
    const pages = [json(comments(1, 3), { 'x-total-count': '3' })];
    const { client, requests } = setup((index) => pages[index] ?? assert.fail('pedido a mais'));
    await client.listIssueComments(REPO, 7);
    assert.equal(requests.length, 1);
  });

  test('sem header Link continua enquanto X-Total-Count não foi atingido', async () => {
    const total = { 'x-total-count': '4' };
    const pages = [json(comments(1, 2), total), json(comments(3, 2), total)];
    const { client, requests } = setup((index) => pages[index] ?? assert.fail('pedido a mais'));
    await client.listIssueComments(REPO, 7);
    assert.equal(requests.length, 2);
  });

  test('não duplica comentários quando o servidor ignora o parâmetro page', async () => {
    const { client } = setup(() => json(comments(1, 3)));
    const list = await client.listIssueComments(REPO, 7);
    assert.deepEqual(list.map((comment) => comment.id), [1, 2, 3]);
  });

  test('pára na 2.ª página quando o servidor ignora o parâmetro page', async () => {
    const { client, requests } = setup(() => json(comments(1, 3)));
    await client.listIssueComments(REPO, 7);
    assert.equal(requests.length, 2);
  });
});

describe('createGitHubClient: origem do header Link', () => {
  test('um caminho a começar por // não leva o token para outro servidor', async () => {
    const origins = await linkOrigins('<https://api.example.test//attacker.example/steal?page=2>; '
      + 'rel="next"');
    assert.deepEqual(origins, [API_ORIGIN, API_ORIGIN]);
  });

  test('um caminho a começar por /\\ não leva o token para outro servidor', async () => {
    const origins = await linkOrigins('<https://api.example.test/\\attacker.example/x?page=2>; '
      + 'rel="next"');
    assert.deepEqual(origins, [API_ORIGIN, API_ORIGIN]);
  });

  test('um link de outra origem com // no caminho fica na origem do apiUrl', async () => {
    const origins = await linkOrigins('<https://evil.example//attacker.example/x?page=2>; '
      + 'rel="next"');
    assert.deepEqual(origins, [API_ORIGIN, API_ORIGIN]);
  });

  test('copia o caminho com // tal como está para a origem do apiUrl', async () => {
    const link = '<https://gitea.test//api/v1/repos/o/r/issues/7/comments?page=2>; rel="next"';
    const pages = [json(comments(1, 1), { link }), json([])];
    const reply = (/** @type {number} */ index) => pages[index] ?? assert.fail('pedido a mais');
    const { client, requests } = setup(reply, { apiUrl: 'https://gitea.test/api/v1' });
    await client.listIssueComments(REPO, 7);
    assert.equal(requests[1].url, 'https://gitea.test//api/v1/repos/o/r/issues/7/comments?page=2');
  });
});

describe('createGitHubClient: getFileAtRef', () => {
  test('pede o conteúdo com accept raw', async () => {
    const { client, requests } = setup(() => text('{}', 'text/plain'));
    await client.getFileAtRef(REPO, 'quality-baseline.json', 'main');
    assert.equal(requests[0].headers.accept, 'application/vnd.github.raw+json');
  });

  test('codifica o ref no URL do pedido', async () => {
    const { client, requests } = setup(() => text('{}', 'text/plain'));
    await client.getFileAtRef(REPO, 'quality-baseline.json', 'feature/nova');
    assert.match(requests[0].url, /\/contents\/quality-baseline\.json\?ref=feature%2Fnova$/);
  });

  test('devolve o texto tal como vem numa resposta raw', async () => {
    const raw = '{"metrics": []}\n';
    const { client } = setup(() => text(raw, 'application/vnd.github.raw+json; charset=utf-8'));
    assert.equal(await client.getFileAtRef(REPO, 'quality-baseline.json', 'main'), raw);
  });

  test('descodifica o conteúdo base64 de uma resposta JSON (estilo Gitea)', async () => {
    const original = '{\n  "metrics": ["cobertura ç"]\n}\n';
    const encoded = Buffer.from(original, 'utf8').toString('base64').replace(/(.{20})/g, '$1\n');
    const envelope = { type: 'file', encoding: 'base64', content: encoded };
    const { client } = setup(() => json(envelope));
    assert.equal(await client.getFileAtRef(REPO, 'quality-baseline.json', 'main'), original);
  });

  test('devolve o JSON tal como vem quando não é um envelope base64', async () => {
    const raw = '{"version": 2, "metrics": []}';
    const { client } = setup(() => text(raw, 'application/json'));
    assert.equal(await client.getFileAtRef(REPO, 'quality-baseline.json', 'main'), raw);
  });

  test('devolve null quando o ficheiro não existe (404)', async () => {
    const { client } = setup(() => ({ status: 404, body: '{"message":"Not Found"}' }));
    assert.equal(await client.getFileAtRef(REPO, 'quality-baseline.json', 'main'), null);
  });

  test('relança erros que não são 404', async () => {
    const { client } = setup(() => ({ status: 500, body: 'falha' }));
    const error = await captureError(client.getFileAtRef(REPO, 'a.json', 'main'));
    assert.equal(error.status, 500);
  });

  test('remove o BOM UTF-8 do conteúdo base64, como na resposta raw', async () => {
    const encoded = Buffer.from('\uFEFF{"version": 2}', 'utf8').toString('base64');
    const { client } = setup(() => json({ type: 'file', encoding: 'base64', content: encoded }));
    assert.equal(await client.getFileAtRef(REPO, 'a.json', 'main'), '{"version": 2}');
  });

  test('remove o BOM UTF-8 de uma resposta raw', async () => {
    const { client } = setup(() => text('\uFEFF{}', 'application/vnd.github.raw+json'));
    assert.equal(await client.getFileAtRef(REPO, 'a.json', 'main'), '{}');
  });

  test('preserva as quebras de linha CRLF do conteúdo base64', async () => {
    const original = '{\r\n  "version": 2\r\n}\r\n';
    const encoded = Buffer.from(original, 'utf8').toString('base64');
    const { client } = setup(() => json({ type: 'file', encoding: 'base64', content: encoded }));
    assert.equal(await client.getFileAtRef(REPO, 'a.json', 'main'), original);
  });

  test('devolve texto vazio para um ficheiro vazio', async () => {
    const { client } = setup(() => text('', 'application/vnd.github.raw+json'));
    assert.equal(await client.getFileAtRef(REPO, 'vazio.json', 'main'), '');
  });

  test('descodifica um envelope base64 com conteúdo vazio (estilo Gitea)', async () => {
    const { client } = setup(() => json({ type: 'file', encoding: 'base64', content: '' }));
    assert.equal(await client.getFileAtRef(REPO, 'vazio.json', 'main'), '');
  });

  test('resolve os segmentos .. do caminho antes de pedir', async () => {
    const { client, requests } = setup(() => text('x', 'text/plain'));
    await client.getFileAtRef(REPO, 'config/../qa/base.json', 'main');
    assert.match(requests[0].url, /\/repos\/dono\/projecto\/contents\/qa\/base\.json\?ref=main$/);
  });

  test('devolve null sem pedido quando o caminho sai da raiz do repositório', async () => {
    const { client } = setup(() => assert.fail('não devia haver pedido'));
    assert.equal(await client.getFileAtRef(REPO, '../../../user', 'main'), null);
  });

  test('devolve null sem pedido quando o caminho está vazio', async () => {
    const { client } = setup(() => assert.fail('não devia haver pedido'));
    assert.equal(await client.getFileAtRef(REPO, './', 'main'), null);
  });

  test('codifica cada segmento do caminho com espaços e mantém as barras', async () => {
    const { client, requests } = setup(() => text('x', 'text/plain'));
    await client.getFileAtRef(REPO, './docs/relatórios de qa/base #1.json', 'main');
    const expected = '/contents/docs/relat%C3%B3rios%20de%20qa/base%20%231.json?ref=main';
    assert.ok(requests[0].url.endsWith(expected), requests[0].url);
  });
});

describe('createGitHubClient: getPullRequest', () => {
  test('pede o pull request em /repos/<repo>/pulls/<número>', async () => {
    const { client, requests } = setup(() => json(PULL_REQUEST));
    await client.getPullRequest(REPO, 42);
    assert.equal(requests[0].url, `${API_URL}/repos/dono/projecto/pulls/42`);
  });

  test('mapeia labels para nomes, base/head sha e full_name dos repositórios', async () => {
    const { client } = setup(() => json(PULL_REQUEST));
    assert.deepEqual(await client.getPullRequest(REPO, 42), {
      number: 42,
      title: 'feat: nova métrica',
      labels: ['hotfix', 'docs'],
      baseSha: 'aaa111',
      headSha: 'bbb222',
      baseRepo: 'dono/projecto',
      headRepo: 'colaborador/projecto',
    });
  });
});

describe('mapPullRequest', () => {
  test('devolve headRepo vazio quando o fork foi apagado', () => {
    const info = mapPullRequest({ ...PULL_REQUEST, head: { sha: 'bbb222', repo: null } });
    assert.equal(info.headRepo, '');
  });

  test('aceita labels em forma de string', () => {
    const info = mapPullRequest({ ...PULL_REQUEST, labels: ['hotfix', { name: 'docs' }] });
    assert.deepEqual(info.labels, ['hotfix', 'docs']);
  });
});

describe('createGitHubClient: getAuthenticatedLogin', () => {
  test('pede GET /user', async () => {
    const { client, requests } = setup(() => json({ login: 'ana' }));
    await client.getAuthenticatedLogin();
    assert.equal(requests[0].url, `${API_URL}/user`);
  });

  test('devolve o login da identidade do token', async () => {
    const { client } = setup(() => json({ login: 'ana' }));
    assert.equal(await client.getAuthenticatedLogin(), 'ana');
  });

  test('devolve null com 403 (GITHUB_TOKEN e tokens de GitHub Apps)', async () => {
    const message = '{"message":"Resource not accessible by integration"}';
    const { client } = setup(() => ({ status: 403, body: message }));
    assert.equal(await client.getAuthenticatedLogin(), null);
  });

  test('devolve null com 404', async () => {
    const { client } = setup(() => ({ status: 404, body: '{"message":"Not Found"}' }));
    assert.equal(await client.getAuthenticatedLogin(), null);
  });

  test('devolve null com 401', async () => {
    const { client } = setup(() => ({ status: 401, body: '{"message":"Bad credentials"}' }));
    assert.equal(await client.getAuthenticatedLogin(), null);
  });

  test('devolve null quando a resposta não traz login', async () => {
    const { client } = setup(() => json({ id: 3 }));
    assert.equal(await client.getAuthenticatedLogin(), null);
  });

  test('lança GitHubApiError com um 5xx persistente', async () => {
    const { client } = setup(() => ({ status: 500, body: 'falha' }));
    const error = await captureError(client.getAuthenticatedLogin());
    assert.equal(error.status, 500);
  });

  test('lança GitHubApiError numa falha de rede persistente', async () => {
    const { client } = setup(() => { throw new TypeError('fetch failed'); });
    const error = await captureError(client.getAuthenticatedLogin());
    assert.equal(error.status, 0);
  });
});

describe('createGitHubClient: novas tentativas', () => {
  /** Conteúdo raw do ficheiro pedido nos cenários. */
  const FILE = text('{"version": 2}', 'application/vnd.github.raw+json');

  test('repete um GET depois de um 502 e devolve o conteúdo', async () => {
    const { client } = setup(failingFirst([{ status: 502, body: '<html>' }], FILE));
    assert.equal(await client.getFileAtRef(REPO, 'a.json', 'main'), '{"version": 2}');
  });

  test('espera 1 s antes da segunda tentativa', async () => {
    const { client, delays } = setup(failingFirst([{ status: 502, body: '<html>' }], FILE));
    await client.getFileAtRef(REPO, 'a.json', 'main');
    assert.deepEqual(delays, [1000]);
  });

  test('repete depois de uma falha de rede', async () => {
    let failed = false;
    const reply = () => {
      if (failed) return FILE;
      failed = true;
      throw new TypeError('fetch failed');
    };
    const { client } = setup(reply);
    assert.equal(await client.getFileAtRef(REPO, 'a.json', 'main'), '{"version": 2}');
  });

  test('faz no máximo 3 pedidos com 503 seguidos', async () => {
    const { client, requests } = setup(() => ({ status: 503, body: 'indisponível' }));
    await captureError(client.getFileAtRef(REPO, 'a.json', 'main'));
    assert.equal(requests.length, 3);
  });

  test('esgotadas as tentativas lança o erro da última', async () => {
    const { client } = setup(() => ({ status: 503, body: 'indisponível' }));
    const error = await captureError(client.getFileAtRef(REPO, 'a.json', 'main'));
    assert.equal(error.status, 503);
  });

  test('espera 1 s e depois 3 s entre as tentativas', async () => {
    const { client, delays } = setup(() => ({ status: 503, body: 'indisponível' }));
    await captureError(client.getFileAtRef(REPO, 'a.json', 'main'));
    assert.deepEqual(delays, [1000, 3000]);
  });

  test('429 com retry-after espera os segundos pedidos', async () => {
    const limited = { status: 429, body: 'devagar', headers: { 'retry-after': '2' } };
    const { client, delays } = setup(failingFirst([limited], FILE));
    await client.getFileAtRef(REPO, 'a.json', 'main');
    assert.deepEqual(delays, [2000]);
  });

  test('429 sem retry-after usa a espera por omissão', async () => {
    const { client, delays } = setup(failingFirst([{ status: 429, body: 'devagar' }], FILE));
    await client.getFileAtRef(REPO, 'a.json', 'main');
    assert.deepEqual(delays, [1000]);
  });

  test('403 com retry-after (limite secundário) repete', async () => {
    const limited = { status: 403, body: 'secundário', headers: { 'retry-after': '1' } };
    const { client } = setup(failingFirst([limited], FILE));
    assert.equal(await client.getFileAtRef(REPO, 'a.json', 'main'), '{"version": 2}');
  });

  test('403 sem pedidos restantes espera até ao x-ratelimit-reset', async () => {
    const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1000005' };
    const limited = { status: 403, body: 'limite', headers };
    const now = () => 1000000 * 1000;
    const { client, delays } = setup(failingFirst([limited], FILE), { now });
    await client.getFileAtRef(REPO, 'a.json', 'main');
    assert.deepEqual(delays, [5000]);
  });

  test('sem relógio, um limite sem retry-after usa a espera por omissão', async () => {
    const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1000005' };
    const { client, delays } = setup(failingFirst([{ status: 403, body: 'x', headers }], FILE));
    await client.getFileAtRef(REPO, 'a.json', 'main');
    assert.deepEqual(delays, [1000]);
  });

  test('não repete quando a espera pedida passa de 30 s', async () => {
    const limited = { status: 429, body: 'devagar', headers: { 'retry-after': '3600' } };
    const { client, requests } = setup(failingFirst([limited], FILE));
    await captureError(client.getFileAtRef(REPO, 'a.json', 'main'));
    assert.equal(requests.length, 1);
  });

  test('não repete um 403 sem headers de limite (permissões)', async () => {
    const { client, requests } = setup(() => ({ status: 403, body: 'proibido' }));
    await captureError(client.getPullRequest(REPO, 42));
    assert.equal(requests.length, 1);
  });

  test('não repete um 404', async () => {
    const { client, requests } = setup(() => ({ status: 404, body: 'Not Found' }));
    await client.getFileAtRef(REPO, 'a.json', 'main');
    assert.equal(requests.length, 1);
  });

  test('não repete o POST do comentário, para não o duplicar', async () => {
    const created = { ...json({ id: 5 }), status: 201 };
    const { client, requests } = setup(failingFirst([{ status: 502, body: 'x' }], created));
    await captureError(client.createComment(REPO, 42, 'texto'));
    assert.equal(requests.length, 1);
  });

  test('repete o PATCH do comentário', async () => {
    const { client } = setup(failingFirst([{ status: 502, body: 'x' }], json({ id: 9 })));
    assert.deepEqual(await client.updateComment(REPO, 9, 'texto'), { id: 9 });
  });

  test('repete as páginas de uma listagem', async () => {
    const { client } = setup(failingFirst([{ status: 502, body: 'x' }], json(comments(1, 2))));
    const list = await client.listIssueComments(REPO, 7);
    assert.deepEqual(list.map((comment) => comment.id), [1, 2]);
  });

  test('onRetry recebe método, caminho, estado, tentativa e espera', async () => {
    /** @type {unknown[]} */
    const retries = [];
    const onRetry = (/** @type {unknown} */ info) => { retries.push(info); };
    const { client } = setup(failingFirst([{ status: 502, body: 'x' }], FILE), { onRetry });
    await client.getFileAtRef(REPO, 'a.json', 'main');
    const path = '/repos/dono/projecto/contents/a.json?ref=main';
    assert.deepEqual(retries, [{ method: 'GET', path, status: 502, attempt: 1, delayMs: 1000 }]);
  });

  test('onRetry nunca recebe o token', async () => {
    /** @type {unknown[]} */
    const retries = [];
    const onRetry = (/** @type {unknown} */ info) => { retries.push(info); };
    const { client } = setup(() => ({ status: 502, body: `erro ${TOKEN}` }), { onRetry });
    await captureError(client.getFileAtRef(REPO, 'a.json', 'main'));
    assert.equal(JSON.stringify(retries).includes(TOKEN), false);
  });

  test('sem sleep nas dependências espera com um temporizador real', async () => {
    const limited = { status: 429, body: 'devagar', headers: { 'retry-after': '0' } };
    const fake = fakeFetch(failingFirst([limited], FILE));
    const client = createGitHubClient({ fetch: fake.fetch, apiUrl: API_URL, token: TOKEN });
    assert.equal(await client.getFileAtRef(REPO, 'a.json', 'main'), '{"version": 2}');
  });
});
