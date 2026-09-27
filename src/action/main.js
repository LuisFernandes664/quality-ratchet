// @ts-check
/**
 * Orquestração da action: lê os inputs, o evento e o baseline do ramo base, corre a catraca
 * e publica o resultado (sumário do job, outputs, comentário no pull request e logs). Todas
 * as dependências externas (ambiente, rede, ficheiros, relógio) chegam por parâmetro.
 */
import path from 'node:path';

import { parseBaseline, serializeBaseline } from '../core/baseline.js';
import { BaselineError, ConfigError, GitHubApiError, RatchetError } from '../core/errors.js';
import { createTranslator, describeError } from '../core/messages.js';
import { runRatchet } from '../core/ratchet.js';
import { renderSummary, reportLogEntries } from '../core/summary.js';
import { createGitHubClient } from '../github/client.js';
import { commentMarker, upsertComment } from '../github/comment.js';
import { collectMeasurements, loadBaseline, parseJsonText, readJsonFile } from '../run.js';
import { readPullRequestFromEvent } from './context.js';
import { createActionIO, readBooleanInput, readInput, readOptionalInput } from './io.js';

/** @typedef {import('./io.js').ActionIO} ActionIO */
/** @typedef {import('./io.js').Env} Env */
/** @typedef {import('../core/messages.js').Translator} Translator */
/** @typedef {import('../core/types.js').Baseline} Baseline */
/** @typedef {import('../core/types.js').Issue} Issue */
/** @typedef {import('../core/types.js').MetricResult} MetricResult */
/** @typedef {import('../core/types.js').Report} Report */
/** @typedef {import('../github/client.js').GitHubClient} GitHubClient */
/** @typedef {import('../github/client.js').PullRequestInfo} PullRequestInfo */

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
 * @property {typeof fetch} fetch
 * @property {ActionFileSystem} fs
 * @property {(line: string) => void} write escreve uma linha no stdout, sem terminador
 * @property {() => Date} now relógio
 * @property {() => string} randomId identificador aleatório para delimitadores heredoc
 */

/**
 * Inputs da action já interpretados; os caminhos vêm resolvidos face à workspace.
 * @typedef {object} ActionInputs
 * @property {string} workspace pasta do checkout (GITHUB_WORKSPACE ou '.')
 * @property {string} baseline
 * @property {string} metrics
 * @property {string} token
 * @property {boolean} comment
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
 * @throws {ConfigError} input booleano inválido
 */
function readInputs(env) {
  const workspace = env.GITHUB_WORKSPACE ?? '.';
  const writeBaseline = readInput(env, 'write-baseline');
  return {
    workspace,
    baseline: resolvePath(workspace, readInput(env, 'baseline', DEFAULTS.baseline)),
    metrics: resolvePath(workspace, readInput(env, 'metrics', DEFAULTS.metrics)),
    token: readInput(env, 'token'),
    comment: readBooleanInput(env, 'comment', true),
    name: readInput(env, 'name'),
    bypassLabel: readOptionalInput(env, 'bypass-label', DEFAULTS.bypassLabel),
    lowerBaselinePattern: readOptionalInput(env, 'lower-baseline-pattern', DEFAULTS.lowerPattern),
    strict: readBooleanInput(env, 'strict', false),
    writeBaseline: writeBaseline === '' ? '' : resolvePath(workspace, writeBaseline),
  };
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
 * Cria o cliente da API quando há token; sem token não há chamadas à API.
 * @param {ActionDeps} deps
 * @param {ActionIO} io
 * @param {Translator} t
 * @param {ActionInputs} inputs
 * @returns {GitHubClient|null}
 */
function createClient(deps, io, t, inputs) {
  if (inputs.token === '') return null;
  return createGitHubClient({
    fetch: deps.fetch,
    apiUrl: deps.env.GITHUB_API_URL || DEFAULT_API_URL,
    token: inputs.token,
    onTruncated: (info) => io.warning(t('log_pagination_truncated', { ...info })),
  });
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
  const collected = await measure(run, head);
  const options = { ...ratchetOptions(run.inputs), frozenAt: isoDate(run.deps.now()) };
  const report = runRatchet({ head, base, ...collected, context, options });
  const summary = renderSummary(report, run.t, { name: run.inputs.name, notes: run.notes });
  await publishResults(run, report, summary);
  if (pr) await publishComment(run, pr, summary);
  logReport(run, report);
  return report.ok ? 0 : 1;
}

/**
 * Reúne as medições: ficheiro de métricas e relatórios das sources, estes relativos à
 * pasta do baseline.
 * @param {ActionRun} run
 * @param {Baseline} head
 * @returns {ReturnType<typeof collectMeasurements>}
 */
function measure(run, head) {
  const baselineDir = path.dirname(run.inputs.baseline);
  return collectMeasurements(run.deps.fs, head, { metricsPath: run.inputs.metrics, baselineDir });
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
  const repoPath = repositoryPath(run.inputs.workspace, run.inputs.baseline);
  const text = repoPath.startsWith('../')
    ? null
    : await run.client.getFileAtRef(requireRepository(run.deps.env), repoPath, pr.baseSha);
  if (text === null) return withNote(run, 'note_base_missing', { path: repoPath });
  return parseBaseBaseline(run, text, repoPath);
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
 * Caminho de um ficheiro no repositório: relativo à workspace, com '/' e sem './'.
 * @param {string} workspace
 * @param {string} filePath
 * @returns {string}
 */
function repositoryPath(workspace, filePath) {
  const relative = path.relative(workspace, filePath).split(path.sep).join('/');
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
 * o gate.
 * @param {ActionRun} run
 * @param {PullRequestInfo} pr
 * @param {string} summary
 * @returns {Promise<void>}
 */
async function publishComment(run, pr, summary) {
  if (!run.inputs.comment || run.client === null) return;
  const request = {
    repo: requireRepository(run.deps.env),
    number: pr.number,
    marker: commentMarker(run.inputs.name),
    body: summary,
  };
  try {
    const result = await upsertComment(run.client, request);
    run.io.notice(run.t(`log_comment_${result}`, { number: pr.number }));
  } catch (error) {
    if (!(error instanceof GitHubApiError)) throw error;
    run.io.warning(run.t('log_comment_failed', { reason: describeError(error, run.t) }));
  }
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
