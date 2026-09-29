// @ts-check
/**
 * Orquestração da action: lê os inputs, o evento e o baseline do ramo base, corre a catraca
 * e publica o resultado (sumário do job, outputs, comentário no pull request e logs). Todas
 * as dependências externas (ambiente, rede, ficheiros, relógio) chegam por parâmetro.
 */
import path from 'node:path';

import { parseBaseline, serializeBaseline } from '../core/baseline.js';
import { Status } from '../core/compare.js';
import { BaselineError, ConfigError, GitHubApiError, RatchetError } from '../core/errors.js';
import { createTranslator, describeError } from '../core/messages.js';
import { runRatchet } from '../core/ratchet.js';
import { renderSummary, reportLogEntries } from '../core/summary.js';
import { createGitHubClient } from '../github/client.js';
import {
  MAX_COMMENT_LENGTH,
  commentMarker,
  customMarker,
  upsertComment,
} from '../github/comment.js';
import { collectMeasurements, loadBaseline, parseJsonText, readJsonFile } from '../run.js';
import { readPullRequestFromEvent } from './context.js';
import { createActionIO, readBooleanInput, readInput, readOptionalInput } from './io.js';

/** @typedef {import('./io.js').ActionIO} ActionIO */
/** @typedef {import('./io.js').Env} Env */
/** @typedef {import('../core/messages.js').Translator} Translator */
/** @typedef {import('../core/types.js').Baseline} Baseline */
/** @typedef {import('../core/types.js').BaselineChange} BaselineChange */
/** @typedef {import('../core/types.js').Issue} Issue */
/** @typedef {import('../core/types.js').MetricResult} MetricResult */
/** @typedef {import('../core/types.js').Report} Report */
/** @typedef {import('../github/client.js').GitHubClient} GitHubClient */
/** @typedef {import('../github/client.js').PullRequestInfo} PullRequestInfo */
/** @typedef {import('../github/client.js').RetryInfo} RetryInfo */
/** @typedef {import('../github/comment.js').UpsertRequest} UpsertRequest */
/** @typedef {import('./proxy.js').ProxyMode} ProxyMode */

const DEFAULT_API_URL = 'https://api.github.com';
const DEFAULT_LANGUAGE = 'en';

/** Valores por omissão dos inputs, iguais aos da CLI. */
const DEFAULTS = Object.freeze({
  baseline: 'quality-baseline.json',
  metrics: 'metrics-current.json',
  bypassLabel: 'hotfix-bypass-ratchet',
  lowerPattern: '^chore(\\([^)]*\\))?: lower baseline',
});

/**
 * Estados de erro ao comentar que indicam um token sem permissão de escrita, como o dos
 * pull requests de forks.
 */
const READ_ONLY_STATUSES = new Set([403, 404]);

/** Estados de linhas da tabela que o comentário abreviado omite. */
const QUIET_STATUSES = new Set([Status.IMPROVED, Status.UNCHANGED]);

/** Nota que acompanha um comentário abreviado para caber no limite da API. */
/** Utilizador em nome do qual o Gitea Actions publica com o token do workflow. */
const GITEA_ACTIONS_USER = 'gitea-actions';

const ABBREVIATED_NOTE = Object.freeze({ code: 'note_comment_abbreviated', params: {} });

/**
 * Reduções do relatório para o comentário, pela ordem em que se acumulam até o texto
 * caber: sem o baseline novo (está no output new-baseline e no sumário do job), sem a
 * lista de métricas não seguidas, só com as alterações ao baseline que o afrouxam, e só
 * com as linhas da tabela que pedem atenção.
 * @type {ReadonlyArray<(report: Report) => Report>}
 */
const COMMENT_REDUCTIONS = [
  (report) => ({ ...report, tightened: [] }),
  (report) => ({ ...report, untracked: [] }),
  (report) => ({ ...report, changes: looseningChanges(report) }),
  (report) => ({ ...report, outcome: { ...report.outcome, results: notableRows(report) } }),
];

/**
 * Acesso ao sistema de ficheiros usado pela action.
 * @typedef {object} ActionFileSystem
 * @property {(filePath: string) => Promise<string>} readText
 * @property {(filePath: string) => Promise<boolean>} exists
 * @property {(filePath: string, text: string) => Promise<void>} writeText substitui o ficheiro
 * @property {(filePath: string, text: string) => Promise<void>} appendText acrescenta ao
 *   ficheiro (GITHUB_OUTPUT, GITHUB_STEP_SUMMARY)
 */

/**
 * Dependências externas da action.
 * @typedef {object} ActionDeps
 * @property {Env} env variáveis de ambiente do runner
 * @property {typeof fetch|null} fetch null quando este Node não tem fetch
 * @property {string} nodeVersion versão do Node que corre a action, para as mensagens
 * @property {ActionFileSystem} fs
 * @property {(line: string) => void} write escreve uma linha no stdout, sem terminador
 * @property {() => Date} now relógio
 * @property {() => string} randomId identificador aleatório para delimitadores heredoc
 * @property {(ms: number) => Promise<void>} sleep espera entre tentativas de um pedido à API
 * @property {() => ProxyMode} proxy aplica as variáveis de proxy do ambiente ao fetch e
 *   devolve o modo; só é chamado quando há token
 */

/**
 * Inputs da action já interpretados; os caminhos vêm resolvidos face à workspace.
 * @typedef {object} ActionInputs
 * @property {string} workspace pasta do checkout (GITHUB_WORKSPACE ou '.')
 * @property {string} baseline
 * @property {string} metrics
 * @property {string} token
 * @property {boolean} comment
 * @property {string} commentAuthor login dos comentários a actualizar ('' descobre-o)
 * @property {string} marker marcador HTML do comentário
 * @property {string} baseRef referência do contrato ('' usa a merge base ou base.sha)
 * @property {string} name
 * @property {string} bypassLabel
 * @property {string} lowerBaselinePattern
 * @property {boolean} strict
 * @property {string} writeBaseline caminho onde gravar o baseline apertado ('' desliga)
 */

/**
 * Estado de uma execução, partilhado pelos passos.
 * @typedef {object} ActionRun
 * @property {ActionDeps} deps
 * @property {ActionIO} io
 * @property {Translator} t
 * @property {ActionInputs} inputs
 * @property {GitHubClient|null} client null quando não há token
 * @property {Issue[]} notes notas a mostrar no sumário
 */

/**
 * Corre a action de ponta a ponta. Qualquer erro é registado no log e resulta em falha.
 * @param {ActionDeps} deps
 * @returns {Promise<number>} 0 quando a catraca passa (ou é perdoada), 1 caso contrário
 */
export async function runAction(deps) {
  const { env, fs, write, randomId } = deps;
  const io = createActionIO({ env, appendFile: fs.appendText, write, randomId });
  let t = createTranslator(DEFAULT_LANGUAGE);
  try {
    t = createTranslator(readInput(env, 'language', DEFAULT_LANGUAGE));
    const inputs = readInputs(env);
    const client = createClient(deps, io, t, inputs);
    return await execute({ deps, io, t, inputs, client, notes: [] });
  } catch (error) {
    reportFailure(io, t, error);
    return 1;
  }
}

/**
 * Regista o erro que interrompeu a execução. Um erro inesperado (sem código do catálogo)
 * deixa também a stack no log de debug, para se poder diagnosticar.
 * @param {ActionIO} io
 * @param {Translator} t
 * @param {unknown} error
 * @returns {void}
 */
function reportFailure(io, t, error) {
  io.error(describeError(error, t));
  if (error instanceof RatchetError || !(error instanceof Error)) return;
  if (error.stack) io.debug(error.stack);
}

/**
 * Lê e valida os inputs da action.
 * @param {Env} env
 * @returns {ActionInputs}
 * @throws {ConfigError} input booleano ou marcador inválido
 */
function readInputs(env) {
  const workspace = env.GITHUB_WORKSPACE ?? '.';
  const writeBaseline = readInput(env, 'write-baseline');
  return {
    workspace,
    baseline: resolvePath(workspace, readInput(env, 'baseline', DEFAULTS.baseline)),
    metrics: resolvePath(workspace, readInput(env, 'metrics', DEFAULTS.metrics)),
    token: readInput(env, 'token'),
    ...readCommentInputs(env),
    baseRef: readInput(env, 'base-ref'),
    name: readInput(env, 'name'),
    bypassLabel: readOptionalInput(env, 'bypass-label', DEFAULTS.bypassLabel),
    lowerBaselinePattern: readOptionalInput(env, 'lower-baseline-pattern', DEFAULTS.lowerPattern),
    strict: readBooleanInput(env, 'strict', false),
    writeBaseline: writeBaseline === '' ? '' : resolvePath(workspace, writeBaseline),
  };
}

/**
 * Inputs do comentário de sumário.
 * @param {Env} env
 * @returns {Pick<ActionInputs, 'comment'|'commentAuthor'|'marker'>}
 * @throws {ConfigError} input booleano ou marcador inválido
 */
function readCommentInputs(env) {
  return {
    comment: readBooleanInput(env, 'comment', true),
    commentAuthor: readInput(env, 'comment-author'),
    marker: markerInput(readInput(env, 'comment-marker'), readInput(env, 'name')),
  };
}

/**
 * Marcador do comentário: o input comment-marker ou, sem ele, o de omissão com o nome.
 * @param {string} custom valor do input comment-marker
 * @param {string} name valor do input name
 * @returns {string}
 * @throws {ConfigError} config_marker_invalid
 */
function markerInput(custom, name) {
  return custom === '' ? commentMarker(name) : customMarker(custom);
}

/**
 * Resolve um caminho relativo face à workspace; caminhos absolutos ficam como estão.
 * @param {string} workspace
 * @param {string} filePath
 * @returns {string}
 */
function resolvePath(workspace, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(workspace, filePath);
}

/**
 * Cria o cliente da API quando há token; sem token não há chamadas à API. Um proxy que
 * este Node não consegue aplicar ao fetch gera um aviso: com NO_PROXY a API pode estar
 * acessível na mesma, mas sem ele os pedidos falham e o aviso explica porquê.
 * @param {ActionDeps} deps
 * @param {ActionIO} io
 * @param {Translator} t
 * @param {ActionInputs} inputs
 * @returns {GitHubClient|null}
 * @throws {ConfigError} proxy_invalid quando a configuração do proxy é recusada;
 *   error_node_unsupported quando este Node não tem fetch
 */
function createClient(deps, io, t, inputs) {
  if (inputs.token === '') return null;
  const fetch = requireFetch(deps);
  if (deps.proxy() === 'unsupported') io.warning(t('log_proxy_unsupported'));
  return createGitHubClient({
    fetch,
    apiUrl: deps.env.GITHUB_API_URL || DEFAULT_API_URL,
    token: inputs.token,
    sleep: deps.sleep,
    now: () => deps.now().getTime(),
    onTruncated: (info) => io.warning(t('log_pagination_truncated', { ...info })),
    onRetry: (info) => io.warning(t('log_api_retry', retryParams(info))),
  });
}

/**
 * O fetch do Node, necessário para falar com a API. Só falta num Node anterior aos
 * suportados: nos runners do Gitea e do Forgejo a action corre com o node da imagem do
 * job, que pode ser antigo.
 * @param {ActionDeps} deps
 * @returns {typeof fetch}
 * @throws {ConfigError} error_node_unsupported quando não há fetch
 */
function requireFetch(deps) {
  if (typeof deps.fetch === 'function') return deps.fetch;
  throw new ConfigError('error_node_unsupported', { version: deps.nodeVersion });
}

/**
 * Parâmetros da mensagem de nova tentativa, com a espera em segundos.
 * @param {RetryInfo} info
 * @returns {Record<string, unknown>}
 */
function retryParams({ method, path: route, status, attempt, delayMs }) {
  return { method, path: route, status, attempt, seconds: Math.ceil(delayMs / 1000) };
}

/**
 * Passos da action, pela ordem em que correm.
 * @param {ActionRun} run
 * @returns {Promise<number>}
 */
async function execute(run) {
  const head = await loadBaseline(run.deps.fs, run.inputs.baseline);
  const pr = await readEventPullRequest(run);
  const base = pr ? await loadBaseBaseline(run, pr) : null;
  const context = pr ? await refreshContext(run, pr) : {};
  const collected = await measure(run, head, base);
  const options = { ...ratchetOptions(run.inputs), frozenAt: isoDate(run.deps.now()) };
  const report = runRatchet({ head, base, ...collected, context, options });
  const summary = renderSummary(report, run.t, { name: run.inputs.name, notes: run.notes });
  await publishResults(run, report, summary);
  if (pr) await publishComment(run, pr, report, summary);
  logReport(run, report);
  return report.ok ? 0 : 1;
}

/**
 * Reúne as medições: ficheiro de métricas e relatórios das sources, estes relativos à
 * pasta do baseline. Com o baseline do ramo base, as métricas cuja source o PR mudou ou
 * retirou são medidas também com a source do ramo base, que é a do contrato enquanto a
 * mudança não for autorizada.
 * @param {ActionRun} run
 * @param {Baseline} head
 * @param {Baseline|null} base baseline do ramo base (null sem governação)
 * @returns {ReturnType<typeof collectMeasurements>}
 */
function measure(run, head, base) {
  const baselineDir = path.dirname(run.inputs.baseline);
  const options = { metricsPath: run.inputs.metrics, baselineDir, base };
  return collectMeasurements(run.deps.fs, head, options);
}

/**
 * Lê o pull request do payload do evento. Um payload que existe mas não se consegue ler
 * gera um aviso e a execução segue sem pull request.
 * @param {ActionRun} run
 * @returns {Promise<PullRequestInfo|null>}
 */
async function readEventPullRequest(run) {
  const eventPath = run.deps.env.GITHUB_EVENT_PATH ?? '';
  if (eventPath === '' || !(await run.deps.fs.exists(eventPath))) return null;
  try {
    return readPullRequestFromEvent(await readJsonFile(run.deps.fs, eventPath, ConfigError));
  } catch (error) {
    if (!(error instanceof RatchetError)) throw error;
    run.io.warning(run.t('log_event_unreadable', { reason: describeError(error, run.t) }));
    return null;
  }
}

/**
 * Lê o baseline do ramo base, que é o contrato a governar. Sem token, sem ficheiro no
 * ramo base ou com um ficheiro inválido, a governação fica desligada com uma nota
 * visível. Os erros da API propagam-se: a governação não se desliga em silêncio.
 * @param {ActionRun} run
 * @param {PullRequestInfo} pr
 * @returns {Promise<Baseline|null>}
 */
async function loadBaseBaseline(run, pr) {
  if (run.client === null) return withNote(run, 'note_no_token', {});
  const repoPath = repositoryPath(await checkoutRoot(run), run.inputs.baseline);
  const text = repoPath.startsWith('../')
    ? null
    : await readContract(run, run.client, repoPath, pr);
  if (text === null) return withNote(run, 'note_base_missing', { path: repoPath });
  return parseBaseBaseline(run, text, repoPath);
}

/**
 * Conteúdo do baseline na referência do contrato, ou null quando não existe lá.
 * @param {ActionRun} run
 * @param {GitHubClient} client
 * @param {string} repoPath caminho do baseline no repositório
 * @param {PullRequestInfo} pr
 * @returns {Promise<string|null>}
 */
function readContract(run, client, repoPath, pr) {
  const repo = requireRepository(run.deps.env);
  return client.getFileAtRef(repo, repoPath, contractRef(run, pr));
}

/**
 * Referência onde se lê o contrato: o input base-ref, a merge base quando o servidor a
 * indica (Gitea e Forgejo, onde `base.sha` é a ponta actual do ramo base e não o ponto de
 * onde o ramo saiu) ou, no GitHub, `base.sha`.
 * @param {ActionRun} run
 * @param {PullRequestInfo} pr
 * @returns {string}
 */
function contractRef(run, pr) {
  return run.inputs.baseRef || pr.mergeBase || pr.baseSha;
}

/**
 * Interpreta o baseline do ramo base. O pull request não consegue alterar esse ficheiro:
 * se estiver inválido, falhar bloquearia todos os pull requests, incluindo o que o
 * corrige. Por isso a governação fica desligada, com nota no sumário e aviso no log.
 * @param {ActionRun} run
 * @param {string} text conteúdo do ficheiro no ramo base
 * @param {string} repoPath caminho no repositório, para as mensagens
 * @returns {Baseline|null}
 */
function parseBaseBaseline(run, text, repoPath) {
  try {
    return parseBaseline(parseJsonText(text, `base:${repoPath}`, BaselineError));
  } catch (error) {
    if (!(error instanceof BaselineError)) throw error;
    return withNote(run, 'note_base_invalid', { reason: oneLine(describeError(error, run.t)) });
  }
}

/**
 * Junta um texto de várias linhas numa só, para caber numa nota do sumário.
 * @param {string} text
 * @returns {string}
 */
function oneLine(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
}

/**
 * Regista uma nota no sumário e o mesmo texto como aviso no log.
 * @param {ActionRun} run
 * @param {string} code
 * @param {Record<string, unknown>} params
 * @returns {null}
 */
function withNote(run, code, params) {
  run.notes.push({ code, params });
  run.io.warning(run.t(code, params));
  return null;
}

/**
 * Raiz do checkout que contém o baseline: a pasta mais próxima com uma entrada `.git`
 * (pasta, ou ficheiro nos worktrees e submódulos), subindo da pasta do baseline até à
 * workspace, inclusive. Com `actions/checkout` e `path:` o repositório fica numa
 * subpasta da workspace. Sem `.git` (checkout pela API REST), ou com o baseline fora da
 * workspace, a raiz é a própria workspace; nunca se procura acima dela.
 * @param {ActionRun} run
 * @returns {Promise<string>}
 */
async function checkoutRoot(run) {
  const { workspace, baseline } = run.inputs;
  for (let dir = path.dirname(baseline); isWithin(workspace, dir); dir = path.dirname(dir)) {
    if (await run.deps.fs.exists(path.join(dir, '.git'))) return dir;
    if (path.relative(workspace, dir) === '') break;
  }
  return workspace;
}

/**
 * Indica se a pasta é a workspace ou está dentro dela.
 * @param {string} workspace
 * @param {string} dir
 * @returns {boolean}
 */
function isWithin(workspace, dir) {
  const relative = path.relative(workspace, dir);
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`);
  return !outside && !path.isAbsolute(relative);
}

/**
 * Caminho de um ficheiro no repositório: relativo à raiz do checkout, com '/' e sem './'.
 * @param {string} root raiz do checkout
 * @param {string} filePath
 * @returns {string}
 */
function repositoryPath(root, filePath) {
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  return path.posix.normalize(relative).replace(/^(\.\/)+/, '');
}

/**
 * Repositório 'dono/repo' do workflow.
 * @param {Env} env
 * @returns {string}
 * @throws {ConfigError} quando GITHUB_REPOSITORY não está definido
 */
function requireRepository(env) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  if (repo === '') throw new ConfigError('github_repository_missing', {});
  return repo;
}

/**
 * Título e labels actuais do pull request. O payload de uma nova execução é o original, por
 * isso uma label acrescentada depois só conta se for lida da API. Se a API falhar, usa-se
 * o payload, com aviso.
 * @param {ActionRun} run
 * @param {PullRequestInfo} pr
 * @returns {Promise<{title: string, labels: string[]}>}
 */
async function refreshContext(run, pr) {
  const fallback = { title: pr.title, labels: pr.labels };
  if (run.client === null) return fallback;
  try {
    const fresh = await run.client.getPullRequest(requireRepository(run.deps.env), pr.number);
    return { title: fresh.title, labels: fresh.labels };
  } catch (error) {
    if (!(error instanceof GitHubApiError)) throw error;
    run.io.warning(run.t('log_pr_refresh_failed', { reason: describeError(error, run.t) }));
    return fallback;
  }
}

/**
 * Opções da catraca a partir dos inputs.
 * @param {ActionInputs} inputs
 * @returns {{strict: boolean, bypassLabel: string, lowerBaselinePattern: string}}
 */
function ratchetOptions(inputs) {
  const { strict, bypassLabel, lowerBaselinePattern } = inputs;
  return { strict, bypassLabel, lowerBaselinePattern };
}

/**
 * Data no formato AAAA-MM-DD (UTC).
 * @param {Date} date
 * @returns {string}
 */
function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Publica o sumário do job, os outputs e, se pedido, o baseline apertado.
 * @param {ActionRun} run
 * @param {Report} report
 * @param {string} summary
 * @returns {Promise<void>}
 */
async function publishResults(run, report, summary) {
  await run.io.appendSummary(summary);
  for (const [name, value] of outputEntries(report, summary)) {
    await run.io.setOutput(name, value);
  }
  await writeBaselineFile(run, report);
}

/**
 * Outputs da action, pela ordem em que são escritos.
 * @param {Report} report
 * @param {string} summary
 * @returns {Array<[string, string]>}
 */
function outputEntries(report, summary) {
  return [
    ['passed', String(report.passed)],
    ['bypassed', String(report.bypass.granted)],
    ['summary', summary],
    ['regressions', JSON.stringify(report.outcome.failures.map(resultOutput))],
    ['improvements', JSON.stringify(report.outcome.improvements.map(resultOutput))],
    ['loosened', JSON.stringify(report.loosened.map((change) => change.name))],
    ['tightened', JSON.stringify(report.tightened)],
    ['new-baseline', baselineJson(report.newBaseline)],
  ];
}

/**
 * Forma pública de uma métrica nos outputs.
 * @param {MetricResult} row
 * @returns {{name: string, status: string, before: number|null, after: number|null,
 *   delta: number|null}}
 */
function resultOutput(row) {
  const { name, status, before, after, delta } = row;
  return { name, status, before, after, delta };
}

/**
 * Baseline em JSON indentado a 2 espaços, no formato original do ficheiro.
 * @param {Baseline} baseline
 * @returns {string}
 */
function baselineJson(baseline) {
  return JSON.stringify(serializeBaseline(baseline), null, 2);
}

/**
 * Grava o baseline apertado quando o input write-baseline está definido e há melhorias.
 * @param {ActionRun} run
 * @param {Report} report
 * @returns {Promise<void>}
 */
async function writeBaselineFile(run, report) {
  const target = run.inputs.writeBaseline;
  if (target === '' || report.tightened.length === 0) return;
  await run.deps.fs.writeText(target, `${baselineJson(report.newBaseline)}\n`);
  run.io.notice(run.t('log_baseline_written', { path: target }));
}

/**
 * Cria ou actualiza o comentário do pull request. Uma falha da API só gera aviso: os
 * pull requests de forks recebem um token só de leitura e o comentário não pode chumbar
 * o gate. Só os erros de permissão (403, 404) apontam para essa causa.
 * @param {ActionRun} run
 * @param {PullRequestInfo} pr
 * @param {Report} report
 * @param {string} summary sumário completo
 * @returns {Promise<void>}
 */
async function publishComment(run, pr, report, summary) {
  const client = run.client;
  if (!run.inputs.comment || client === null) return;
  try {
    const request = await commentRequest(run, client, pr, commentBody(run, report, summary));
    const result = await upsertComment(client, request);
    run.io.notice(run.t(`log_comment_${result}`, { number: pr.number }));
  } catch (error) {
    if (!(error instanceof GitHubApiError)) throw error;
    const code = READ_ONLY_STATUSES.has(error.status) ? 'log_comment_failed'
      : 'log_comment_failed_generic';
    run.io.warning(run.t(code, { reason: describeError(error, run.t) }));
  }
}

/**
 * Pedido de upsert do comentário, com o autor dado por commentAuthor. Comentários de outras
 * pessoas com o mesmo marcador nunca são alvo.
 * @param {ActionRun} run
 * @param {GitHubClient} client
 * @param {PullRequestInfo} pr
 * @param {string} body
 * @returns {Promise<UpsertRequest>}
 */
async function commentRequest(run, client, pr, body) {
  return {
    repo: requireRepository(run.deps.env),
    number: pr.number,
    marker: run.inputs.marker,
    author: await commentAuthor(run, client),
    body,
  };
}

/**
 * Autor dos comentários a actualizar: o input comment-author ou o login do token. No Gitea
 * Actions o token do workflow não revela o login (GET /user é recusado) e os comentários
 * saem em nome de `gitea-actions`, que não termina em `[bot]`: sem este caso, cada
 * execução publicaria um comentário novo.
 * @param {ActionRun} run
 * @param {GitHubClient} client
 * @returns {Promise<string|null>} null aceita só contas de bot
 */
async function commentAuthor(run, client) {
  if (run.inputs.commentAuthor) return run.inputs.commentAuthor;
  const login = await client.getAuthenticatedLogin();
  if (login !== null) return login;
  return run.deps.env.GITEA_ACTIONS === 'true' ? GITEA_ACTIONS_USER : null;
}

/**
 * Texto do comentário: o sumário completo quando cabe no limite da API; senão uma versão
 * abreviada, com nota, e em último caso cortada numa quebra de linha. O sumário do job e
 * o output summary ficam sempre completos.
 * @param {ActionRun} run
 * @param {Report} report
 * @param {string} summary sumário completo
 * @returns {string}
 */
function commentBody(run, report, summary) {
  const limit = MAX_COMMENT_LENGTH - run.inputs.marker.length - 1;
  const options = { name: run.inputs.name, notes: [...run.notes, ABBREVIATED_NOTE] };
  let text = summary;
  let reduced = report;
  for (const reduce of COMMENT_REDUCTIONS) {
    if (text.length <= limit) return text;
    reduced = reduce(reduced);
    text = renderSummary(reduced, run.t, options);
  }
  return text.length <= limit ? text : cutAtLine(text, limit);
}

/**
 * Linhas da tabela que pedem atenção: falhas, regressões toleradas e melhorias por fixar.
 * @param {Report} report
 * @returns {MetricResult[]}
 */
function notableRows(report) {
  const unlocked = new Set(report.outcome.unlocked.map((row) => row.name));
  return report.outcome.results.filter((row) => (
    !QUIET_STATUSES.has(row.status) || unlocked.has(row.name)));
}

/**
 * Alterações ao baseline que o afrouxam, as únicas que a governação precisa de mostrar.
 * @param {Report} report
 * @returns {BaselineChange[]}
 */
function looseningChanges(report) {
  const loosened = new Set(report.loosened.map((change) => change.name));
  return report.changes.filter((change) => loosened.has(change.name));
}

/**
 * Corta o texto na última quebra de linha que cabe no limite.
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function cutAtLine(text, limit) {
  const end = text.lastIndexOf('\n', limit);
  return text.slice(0, end > 0 ? end : limit);
}

/**
 * Emite as mensagens do relatório como workflow commands.
 * @param {ActionRun} run
 * @param {Report} report
 * @returns {void}
 */
function logReport(run, report) {
  for (const entry of reportLogEntries(report, run.t)) run.io[entry.level](entry.text);
}
