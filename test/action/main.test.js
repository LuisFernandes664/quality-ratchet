// @ts-check
import assert from 'node:assert/strict';
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { runAction } from '../../src/action/main.js';
import { ConfigError } from '../../src/core/errors.js';
import { createTranslator } from '../../src/core/messages.js';

/** @typedef {import('../../src/action/main.js').ActionDeps} ActionDeps */
/** @typedef {import('../../src/action/proxy.js').ProxyMode} ProxyMode */

const API_URL = 'https://api.test';
const NOW = new Date('2026-09-27T10:00:00Z');
const REPO = 'o/r';
const PR_NUMBER = 7;
const BASE_SHA = 'base1';
const AUTHORISED_TITLE = 'chore: lower baseline for the legacy module';

const CONTENTS = `GET /repos/${REPO}/contents/quality-baseline.json?ref=${BASE_SHA}`;
const PULL = `GET /repos/${REPO}/pulls/${PR_NUMBER}`;
const LIST_COMMENTS = `GET /repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100&page=1`;
const LIST_COMMENTS_PAGE_2 = LIST_COMMENTS.replace(/page=1$/, 'page=2');
const CREATE_COMMENT = `POST /repos/${REPO}/issues/${PR_NUMBER}/comments`;
const USER = 'GET /user';
const MARKER = '<!-- quality-ratchet -->';

/** Baseline v2 usado na maioria dos cenários. */
const BASELINE = Object.freeze({
  version: 2,
  frozen_at: '2026-05-04',
  metrics: {
    coverage: { value: 80, direction: 'up' },
    lint: { value: 10, direction: 'down' },
  },
});

/** Mesmo baseline, com a cobertura baixada de 80 para 70. */
const LOWERED = Object.freeze({
  ...BASELINE,
  metrics: { ...BASELINE.metrics, coverage: { value: 70, direction: 'up' } },
});

/** Baseline cuja cobertura vem de um lcov relativo à pasta do baseline. */
const LCOV_BASELINE = Object.freeze({
  version: 2,
  metrics: {
    coverage: { value: 80, direction: 'up', source: { format: 'lcov', path: 'cov/lcov.info' } },
  },
});

const EN = createTranslator('en');

/** Versão do Node indicada às mensagens nos cenários. */
const OLD_NODE = 'v16.20.2';

/**
 * @typedef {object} Reply
 * @property {number} [status]
 * @property {string} [body]
 * @property {Record<string, string>} [headers]
 */

/** @typedef {Record<string, Reply|Reply[]|undefined>} Routes */

/**
 * @typedef {object} Scenario
 * @property {Record<string, unknown>} [files] caminho relativo à pasta temporária -> conteúdo
 * @property {Record<string, string|undefined>} [env] variáveis extra (undefined apaga)
 * @property {Routes} [routes] 'MÉTODO /caminho' -> resposta, ou respostas por ordem (a
 *   última repete-se)
 * @property {unknown} [event] payload do evento, escrito em event.json
 * @property {string} [workspace] subpasta usada como GITHUB_WORKSPACE (omissão: a raiz)
 * @property {Partial<typeof realFs>} [fs] substitui operações do sistema de ficheiros
 * @property {(ms: number) => Promise<void>} [sleep] espera entre tentativas (omissão: nenhuma)
 * @property {() => ProxyMode} [proxy] configuração do proxy (omissão: 'none')
 * @property {null} [fetch] null simula um Node sem fetch (omissão: a API falsa)
 */

/**
 * Indica se o ficheiro existe; só "não existe" devolve false, o resto propaga-se.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (/** @type {{code?: unknown}} */ (error).code === 'ENOENT') return false;
    throw error;
  }
}

/** Sistema de ficheiros real, restrito pelos testes à pasta temporária. */
const realFs = {
  readText: (/** @type {string} */ filePath) => readFile(filePath, 'utf8'),
  exists: fileExists,
  writeText: (/** @type {string} */ filePath, /** @type {string} */ text) => (
    writeFile(filePath, text, 'utf8')),
  appendText: (/** @type {string} */ filePath, /** @type {string} */ text) => (
    appendFile(filePath, text, 'utf8')),
};

/**
 * Resposta JSON da API falsa.
 * @param {unknown} data
 * @param {number} [status]
 * @returns {Reply}
 */
function json(data, status = 200) {
  return { status, body: JSON.stringify(data), headers: { 'content-type': 'application/json' } };
}

/**
 * Conteúdo de um ficheiro devolvido em raw pela API de conteúdos.
 * @param {unknown} data
 * @returns {Reply}
 */
function raw(data) {
  const headers = { 'content-type': 'application/vnd.github.raw' };
  return { body: JSON.stringify(data), headers };
}

/**
 * Pull request tal como aparece no payload do evento e na API.
 * @param {{title?: string, labels?: string[]}} [options]
 * @returns {Record<string, unknown>}
 */
function pullRequest({ title = 'feat: add things', labels = [] } = {}) {
  return {
    number: PR_NUMBER,
    title,
    labels: labels.map((name) => ({ name })),
    base: { sha: BASE_SHA, repo: { full_name: REPO } },
    head: { sha: 'head1', repo: { full_name: REPO } },
  };
}

/**
 * Evento pull_request com o pull request indicado.
 * @param {{title?: string, labels?: string[]}} [options]
 * @returns {Record<string, unknown>}
 */
function pullRequestEvent(options) {
  return { action: 'opened', pull_request: pullRequest(options) };
}

/**
 * Rotas da API para um pull request: baseline do ramo base, PR e comentários.
 * @param {{base?: unknown, title?: string, labels?: string[]}} [options]
 * @returns {Routes}
 */
function prRoutes({ base = BASELINE, title, labels } = {}) {
  return {
    [CONTENTS]: raw(base),
    [PULL]: json(pullRequest({ title, labels })),
    [LIST_COMMENTS]: json([]),
    [CREATE_COMMENT]: json({ id: 1 }, 201),
  };
}

/** Ambiente de uma execução com token num pull request. */
const WITH_TOKEN = Object.freeze({ INPUT_TOKEN: 'tkn', GITHUB_REPOSITORY: REPO });

/**
 * Resposta de uma rota ao n-ésimo pedido: uma lista responde por ordem e repete a última.
 * @param {Reply|Reply[]|undefined} entry
 * @param {number} index pedidos anteriores à mesma rota
 * @returns {Reply|undefined}
 */
function replyAt(entry, index) {
  return Array.isArray(entry) ? entry[Math.min(index, entry.length - 1)] : entry;
}

/**
 * API falsa: responde pelas rotas dadas e 404 a tudo o resto; regista os pedidos.
 * @param {Routes} routes
 */
function fakeApi(routes) {
  /** @type {Array<{method: string, route: string, body: unknown}>} */
  const calls = [];
  /** @type {typeof globalThis.fetch} */
  const fakeFetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const route = String(url).slice(API_URL.length);
    const index = calls.filter((call) => call.method === method && call.route === route).length;
    calls.push({ method, route, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const reply = replyAt(routes[`${method} ${route}`], index);
    if (!reply) return new Response('{"message":"Not Found"}', { status: 404 });
    const { status = 200, body = null, headers } = reply;
    return new Response(body, { status, headers });
  };
  return { fetch: fakeFetch, calls };
}

/**
 * Escreve os ficheiros do cenário na workspace, criando as pastas.
 * @param {string} dir
 * @param {Record<string, unknown>} files
 * @returns {Promise<void>}
 */
async function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
}

/**
 * Variáveis de ambiente do runner para um cenário.
 * @param {string} dir pasta temporária do cenário
 * @param {Scenario} scenario
 * @returns {Record<string, string|undefined>}
 */
function scenarioEnv(dir, { workspace = '', event, env = {} }) {
  return {
    GITHUB_WORKSPACE: path.join(dir, workspace),
    GITHUB_OUTPUT: path.join(dir, 'output.txt'),
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
    GITHUB_API_URL: API_URL,
    ...(event === undefined ? {} : { GITHUB_EVENT_PATH: path.join(dir, 'event.json') }),
    ...env,
  };
}

/**
 * Dependências de runAction com os fakes do cenário.
 * @param {string} dir pasta temporária do cenário
 * @param {Scenario} scenario
 * @param {typeof globalThis.fetch} fetch
 * @param {string[]} lines recebe cada linha escrita no stdout
 * @returns {ActionDeps}
 */
function scenarioDeps(dir, scenario, fetch, lines) {
  return {
    env: scenarioEnv(dir, scenario),
    fetch: scenario.fetch === null ? null : fetch,
    nodeVersion: OLD_NODE,
    fs: { ...realFs, ...scenario.fs },
    write: (line) => { lines.push(line); },
    now: () => NOW,
    randomId: () => 'id',
    sleep: scenario.sleep ?? (async () => {}),
    proxy: scenario.proxy ?? (() => 'none'),
  };
}

/**
 * Corre a action numa workspace temporária, apagada no fim do teste.
 * @param {import('node:test').TestContext} t
 * @param {Scenario} scenario
 */
async function runScenario(t, scenario = {}) {
  const { files = {}, routes = {}, event } = scenario;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quality-ratchet-action-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFiles(dir, event === undefined ? files : { ...files, 'event.json': event });
  const api = fakeApi(routes);
  /** @type {string[]} */
  const lines = [];
  const code = await runAction(scenarioDeps(dir, scenario, api.fetch, lines));
  const read = (/** @type {string} */ name) => readFile(path.join(dir, name), 'utf8');
  return { code, lines, calls: api.calls, dir, read };
}

/**
 * Interpreta o ficheiro GITHUB_OUTPUT (formato heredoc).
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseOutputs(text) {
  /** @type {Record<string, string>} */
  const outputs = {};
  for (const match of text.matchAll(/^(.+?)<<(\S+)\n([\s\S]*?)\n\2\n/gm)) {
    outputs[match[1]] = match[3];
  }
  return outputs;
}

/**
 * Linhas de um workflow command (ex: 'error').
 * @param {string[]} lines
 * @param {string} level
 * @returns {string[]}
 */
function commands(lines, level) {
  return lines.filter((line) => line.startsWith(`::${level}::`));
}

/** Ficheiros de uma execução verde. */
const GREEN = Object.freeze({
  'quality-baseline.json': BASELINE,
  'metrics-current.json': { coverage: 80, lint: 10 },
});

/** Ficheiros de uma execução com regressão da cobertura. */
const RED = Object.freeze({
  'quality-baseline.json': BASELINE,
  'metrics-current.json': { coverage: 75, lint: 10 },
});

/** PR que baixa o baseline de 80 para 70 e mede 72. */
const LOWERING = Object.freeze({
  'quality-baseline.json': LOWERED,
  'metrics-current.json': { coverage: 72, lint: 10 },
});

describe('runAction: resultado do gate', () => {
  test('sem pull request e sem regressões termina com 0', async (t) => {
    const { code } = await runScenario(t, { files: GREEN });

    assert.equal(code, 0);
  });

  test('uma regressão termina com 1 e emite ::error::', async (t) => {
    const { code, lines } = await runScenario(t, { files: RED });

    assert.equal(code, 1);
    assert.ok(commands(lines, 'error').some((line) => line.includes('coverage')));
  });

  test('escreve o sumário no GITHUB_STEP_SUMMARY', async (t) => {
    const { read } = await runScenario(t, { files: GREEN });

    assert.match(await read('summary.md'), /^## Quality ratchet/);
  });

  test('language pt produz o sumário em português', async (t) => {
    const { read } = await runScenario(t, { files: GREEN, env: { INPUT_LANGUAGE: 'pt' } });

    assert.match(await read('summary.md'), /Catraca verde/);
  });

  test('sources (lcov) são lidas relativamente à pasta do baseline', async (t) => {
    const files = {
      'pkg/quality-baseline.json': LCOV_BASELINE,
      'pkg/cov/lcov.info': 'SF:a.js\nLF:10\nLH:9\nend_of_record\n',
    };
    const env = { INPUT_BASELINE: 'pkg/quality-baseline.json' };

    const { code, read } = await runScenario(t, { files, env });

    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(parseOutputs(await read('output.txt')).improvements), [
      { name: 'coverage', status: 'improved', before: 80, after: 90, delta: 10 },
    ]);
  });
});

describe('runAction: inputs', () => {
  test('strict true falha quando uma melhoria não foi fixada no baseline', async (t) => {
    const files = { ...GREEN, 'metrics-current.json': { coverage: 85, lint: 10 } };

    const { code } = await runScenario(t, { files, env: { INPUT_STRICT: 'true' } });

    assert.equal(code, 1);
  });

  test('lower-baseline-pattern personalizado autoriza o título correspondente', async (t) => {
    const title = 'baseline: accept the legacy coverage';
    const env = { ...WITH_TOKEN, 'INPUT_LOWER-BASELINE-PATTERN': '^baseline:' };

    const { code } = await runScenario(t, {
      files: LOWERING, env, event: pullRequestEvent({ title }), routes: prRoutes({ title }),
    });

    assert.equal(code, 0);
  });

  test('lower-baseline-pattern inválido termina com 1 e explica o erro', async (t) => {
    const env = { 'INPUT_LOWER-BASELINE-PATTERN': '(' };

    const { code, lines } = await runScenario(t, { files: GREEN, env });

    assert.equal(code, 1);
    const prefix = EN('config_pattern_invalid', { pattern: '(', reason: '' });
    assert.ok(commands(lines, 'error').some((line) => line.startsWith(`::error::${prefix}`)));
  });

  test('bypass-label personalizado perdoa a falha, sem distinguir maiúsculas', async (t) => {
    const env = { ...WITH_TOKEN, 'INPUT_BYPASS-LABEL': 'emergency' };

    const { code } = await runScenario(t, {
      files: RED, env, event: pullRequestEvent(), routes: prRoutes({ labels: ['Emergency'] }),
    });

    assert.equal(code, 0);
  });

  test('bypass-label vazio desliga o perdão de hotfix', async (t) => {
    const env = { ...WITH_TOKEN, 'INPUT_BYPASS-LABEL': '' };

    const { code } = await runScenario(t, {
      files: RED,
      env,
      event: pullRequestEvent(),
      routes: prRoutes({ labels: ['hotfix-bypass-ratchet'] }),
    });

    assert.equal(code, 1);
  });

  test('lower-baseline-pattern vazio impede qualquer descida do baseline', async (t) => {
    const env = { ...WITH_TOKEN, 'INPUT_LOWER-BASELINE-PATTERN': '' };

    const { code } = await runScenario(t, {
      files: LOWERING,
      env,
      event: pullRequestEvent({ title: AUTHORISED_TITLE }),
      routes: prRoutes({ title: AUTHORISED_TITLE }),
    });

    assert.equal(code, 1);
  });

  test('sem GITHUB_WORKSPACE usa os caminhos absolutos tal como estão', async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'quality-ratchet-abs-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFiles(dir, GREEN);
    const env = {
      GITHUB_WORKSPACE: undefined,
      INPUT_BASELINE: path.join(dir, 'quality-baseline.json'),
      INPUT_METRICS: path.join(dir, 'metrics-current.json'),
    };

    const { code } = await runScenario(t, { env });

    assert.equal(code, 0);
  });
});

describe('runAction: outputs', () => {
  test('escreve passed, bypassed e regressions no GITHUB_OUTPUT', async (t) => {
    const { read } = await runScenario(t, { files: RED });

    const outputs = parseOutputs(await read('output.txt'));

    assert.deepEqual(
      { passed: outputs.passed, bypassed: outputs.bypassed },
      { passed: 'false', bypassed: 'false' },
    );
    assert.deepEqual(JSON.parse(outputs.regressions), [
      { name: 'coverage', status: 'regressed', before: 80, after: 75, delta: -5 },
    ]);
  });

  test('escreve summary, loosened, tightened e new-baseline', async (t) => {
    const files = { ...GREEN, 'metrics-current.json': { coverage: 85, lint: 10 } };
    const { read } = await runScenario(t, { files });

    const outputs = parseOutputs(await read('output.txt'));

    assert.match(outputs.summary, /^## Quality ratchet/);
    assert.deepEqual(JSON.parse(outputs.loosened), []);
    assert.deepEqual(JSON.parse(outputs.tightened), ['coverage']);
    assert.equal(JSON.parse(outputs['new-baseline']).metrics.coverage.value, 85);
  });

  test('new-baseline vem indentado a 2 espaços', async (t) => {
    const { read } = await runScenario(t, { files: GREEN });

    const outputs = parseOutputs(await read('output.txt'));

    assert.equal(outputs['new-baseline'], JSON.stringify(BASELINE, null, 2));
  });
});

describe('runAction: write-baseline', () => {
  test('grava o baseline apertado quando há melhorias', async (t) => {
    const files = { ...GREEN, 'metrics-current.json': { coverage: 85, lint: 10 } };
    const env = { 'INPUT_WRITE-BASELINE': 'new-baseline.json' };

    const { read } = await runScenario(t, { files, env });

    const written = JSON.parse(await read('new-baseline.json'));
    assert.equal(written.metrics.coverage.value, 85);
    assert.equal(written.frozen_at, '2026-09-27');
  });

  test('regista um notice com o caminho gravado', async (t) => {
    const files = { ...GREEN, 'metrics-current.json': { coverage: 85, lint: 10 } };
    const env = { 'INPUT_WRITE-BASELINE': 'new-baseline.json' };

    const { lines } = await runScenario(t, { files, env });

    const notices = commands(lines, 'notice');
    assert.equal(notices.filter((line) => line.endsWith('new-baseline.json.')).length, 1);
  });

  test('não grava nada quando não há melhorias', async (t) => {
    const env = { 'INPUT_WRITE-BASELINE': 'new-baseline.json' };

    const { dir } = await runScenario(t, { files: GREEN, env });

    await assert.rejects(access(path.join(dir, 'new-baseline.json')), { code: 'ENOENT' });
  });
});

/** Rota do baseline no repositório, sem a referência. */
const CONTENTS_ROUTE = `/repos/${REPO}/contents/quality-baseline.json`;

/** Pedido do baseline na merge base 'mb1'. */
const CONTENTS_AT_MERGE_BASE = `GET ${CONTENTS_ROUTE}?ref=mb1`;

/** Cobertura do contrato depois de o ramo base a apertar. */
const TIGHT = { value: 85, direction: 'up' };

/**
 * Referências em que o baseline foi pedido à API.
 * @param {Array<{method: string, route: string}>} calls
 * @returns {string[]}
 */
function contentRefs(calls) {
  return calls
    .filter((call) => call.route.startsWith(`${CONTENTS_ROUTE}?ref=`))
    .map((call) => call.route.slice(`${CONTENTS_ROUTE}?ref=`.length));
}

describe('runAction: governação do baseline', () => {
  test('baixar o baseline sem título autorizado falha', async (t) => {
    const { code, read } = await runScenario(t, {
      files: LOWERING, env: WITH_TOKEN, event: pullRequestEvent(), routes: prRoutes(),
    });

    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(parseOutputs(await read('output.txt')).loosened), ['coverage']);
  });

  test('baixar o baseline com título autorizado passa', async (t) => {
    const routes = prRoutes({ title: AUTHORISED_TITLE });
    const event = pullRequestEvent({ title: AUTHORISED_TITLE });

    const { code } = await runScenario(t, { files: LOWERING, env: WITH_TOKEN, event, routes });

    assert.equal(code, 0);
  });

  test('pede o baseline do ramo base pelo caminho relativo à workspace', async (t) => {
    const files = { 'pkg/quality-baseline.json': BASELINE, 'm.json': { coverage: 80, lint: 10 } };
    const env = {
      ...WITH_TOKEN, INPUT_BASELINE: 'pkg/quality-baseline.json', INPUT_METRICS: 'm.json',
    };

    const { calls } = await runScenario(t, { files, env, event: pullRequestEvent(), routes: {} });

    const route = `/repos/${REPO}/contents/pkg/quality-baseline.json?ref=${BASE_SHA}`;
    assert.ok(calls.some((call) => call.route === route));
  });

  test('com merge_base (Gitea, Forgejo) lê o contrato na merge base', async (t) => {
    const event = { action: 'opened', pull_request: { ...pullRequest(), merge_base: 'mb1' } };
    const routes = { ...prRoutes(), [CONTENTS_AT_MERGE_BASE]: raw(BASELINE) };

    const { calls } = await runScenario(t, { files: GREEN, env: WITH_TOKEN, event, routes });

    assert.deepEqual(contentRefs(calls), ['mb1']);
  });

  test('um ramo atrasado não afrouxa o que o ramo base apertou depois', async (t) => {
    const tightened = { ...BASELINE, metrics: { ...BASELINE.metrics, coverage: TIGHT } };
    const event = { action: 'opened', pull_request: { ...pullRequest(), merge_base: 'mb1' } };
    const routes = {
      ...prRoutes({ base: tightened }), [CONTENTS_AT_MERGE_BASE]: raw(BASELINE),
    };

    const { code } = await runScenario(t, { files: GREEN, env: WITH_TOKEN, event, routes });

    assert.equal(code, 0);
  });

  test('o input base-ref prevalece sobre a merge base e o base.sha', async (t) => {
    const event = { action: 'opened', pull_request: { ...pullRequest(), merge_base: 'mb1' } };
    const env = { ...WITH_TOKEN, 'INPUT_BASE-REF': 'v1.2.3' };
    const routes = { ...prRoutes(), [`GET ${CONTENTS_ROUTE}?ref=v1.2.3`]: raw(BASELINE) };

    const { calls } = await runScenario(t, { files: GREEN, env, event, routes });

    assert.deepEqual(contentRefs(calls), ['v1.2.3']);
  });

  test('baseline inexistente no ramo base gera aviso e segue sem governação', async (t) => {
    const routes = { ...prRoutes(), [CONTENTS]: undefined };

    const { code, lines } = await runScenario(t, {
      files: LOWERING, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    assert.equal(code, 0);
    const note = EN('note_base_missing', { path: 'quality-baseline.json' });
    assert.ok(commands(lines, 'warning').includes(`::warning::${note}`));
  });

  test('erro da API ao ler o baseline do ramo base faz falhar', async (t) => {
    const routes = { ...prRoutes(), [CONTENTS]: json({ message: 'boom' }, 500) };

    const { code } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    assert.equal(code, 1);
  });

  test('token vazio não chama a API', async (t) => {
    const { calls } = await runScenario(t, {
      files: LOWERING, event: pullRequestEvent(), routes: prRoutes(),
    });

    assert.deepEqual(calls, []);
  });

  test('token vazio deixa uma nota no sumário', async (t) => {
    const { read } = await runScenario(t, {
      files: LOWERING, event: pullRequestEvent(), routes: prRoutes(),
    });

    assert.ok((await read('summary.md')).includes(EN('note_no_token')));
  });

  test('sem GITHUB_REPOSITORY num pull request com token falha', async (t) => {
    const { code, lines } = await runScenario(t, {
      files: GREEN, env: { INPUT_TOKEN: 'tkn' }, event: pullRequestEvent(), routes: prRoutes(),
    });

    assert.equal(code, 1);
    assert.ok(commands(lines, 'error').includes(`::error::${EN('github_repository_missing')}`));
  });

  test('sem pull request no evento não chama a API', async (t) => {
    const { calls } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: { ref: 'refs/heads/main' }, routes: prRoutes(),
    });

    assert.deepEqual(calls, []);
  });

  test('payload do evento ilegível gera aviso e segue sem pull request', async (t) => {
    const { code, lines } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: '{ not json', routes: prRoutes(),
    });

    assert.equal(code, 0);
    assert.equal(commands(lines, 'warning').length, 1);
  });

  test('evento merge_group não tem pull request e não chama a API', async (t) => {
    const event = { merge_group: { base_sha: BASE_SHA, head_sha: 'head1' } };

    const { calls } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event, routes: prRoutes(),
    });

    assert.deepEqual(calls, []);
  });

  test('token vazio também deixa um aviso no log', async (t) => {
    const { lines } = await runScenario(t, {
      files: LOWERING, event: pullRequestEvent(), routes: prRoutes(),
    });

    assert.ok(commands(lines, 'warning').includes(`::warning::${EN('note_no_token')}`));
  });

  test('baseline inválido no ramo base segue sem governação', async (t) => {
    const routes = { ...prRoutes(), [CONTENTS]: raw({ version: 2, metrics: {} }) };

    const { code } = await runScenario(t, {
      files: LOWERING, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    assert.equal(code, 0);
  });

  test('baseline inválido no ramo base deixa nota no sumário', async (t) => {
    const routes = { ...prRoutes(), [CONTENTS]: { body: '{ not json' } };

    const { read } = await runScenario(t, {
      files: LOWERING, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    assert.match(await read('summary.md'), /^> .*\(base:quality-baseline\.json is not valid JSON/m);
  });

  test('baseline fora da workspace não é pedido à API e deixa aviso', async (t) => {
    const env = {
      ...WITH_TOKEN,
      INPUT_BASELINE: '../quality-baseline.json',
      INPUT_METRICS: '../metrics-current.json',
    };

    const { calls, lines } = await runScenario(t, {
      files: GREEN, env, workspace: 'ws', event: pullRequestEvent(), routes: prRoutes(),
    });

    assert.ok(!calls.some((call) => call.route.includes('/contents/')));
    const note = EN('note_base_missing', { path: '../quality-baseline.json' });
    assert.ok(commands(lines, 'warning').includes(`::warning::${note}`));
  });

  test('sem autorização, o output new-baseline mantém o valor do contrato', async (t) => {
    const { read } = await runScenario(t, {
      files: LOWERING, env: WITH_TOKEN, event: pullRequestEvent(), routes: prRoutes(),
    });

    const newBaseline = JSON.parse(parseOutputs(await read('output.txt'))['new-baseline']);
    assert.equal(newBaseline.metrics.coverage.value, 80);
  });

  test('sem autorização, uma medição entre os dois valores não aperta nada', async (t) => {
    const { read } = await runScenario(t, {
      files: LOWERING, env: WITH_TOKEN, event: pullRequestEvent(), routes: prRoutes(),
    });

    assert.equal(parseOutputs(await read('output.txt')).tightened, '[]');
  });
});

describe('runAction: source trocada ou retirada no pull request', () => {
  /** Relatório lcov gerado pelo CI: 50% das linhas cobertas, abaixo dos 80 do contrato. */
  const HALF_LCOV = 'SF:a.js\nLF:10\nLH:5\nend_of_record\n';

  /** PR que troca a source da cobertura por um ficheiro commitado com 99. */
  const SWAPPED = Object.freeze({
    'quality-baseline.json': {
      version: 2,
      metrics: {
        coverage: {
          value: 80, direction: 'up', source: { format: 'json', path: 'fake.json', pointer: '/v' },
        },
      },
    },
    'fake.json': { v: 99 },
    'cov/lcov.info': HALF_LCOV,
  });

  /** PR que retira a source da cobertura e commita um ficheiro de métricas com 99. */
  const DROPPED = Object.freeze({
    'quality-baseline.json': { version: 2, metrics: { coverage: { value: 80, direction: 'up' } } },
    'metrics-current.json': { coverage: 99 },
    'cov/lcov.info': HALF_LCOV,
  });

  /** PR que retira a métrica de cobertura do baseline e passa a seguir só o lint. */
  const REMOVED = Object.freeze({
    'quality-baseline.json': { version: 2, metrics: { lint: { value: 10, direction: 'down' } } },
    'metrics-current.json': { lint: 10 },
    'cov/lcov.info': HALF_LCOV,
  });

  /**
   * Corre um pull request cujo ramo base mede a cobertura pelo lcov.
   * @param {import('node:test').TestContext} t
   * @param {Record<string, unknown>} files
   * @param {string} [title] título do pull request
   */
  async function runAgainstLcovBase(t, files, title) {
    const routes = prRoutes({ base: LCOV_BASELINE, title });
    const event = pullRequestEvent({ title });
    const result = await runScenario(t, { files, env: WITH_TOKEN, event, routes });
    const post = result.calls.find((call) => call.method === 'POST');
    return { ...result, comment: /** @type {{body: string}} */ (post?.body).body };
  }

  test('trocar a source sem autorização termina com 1', async (t) => {
    const { code } = await runAgainstLcovBase(t, SWAPPED);

    assert.equal(code, 1);
  });

  test('trocar a source sem autorização emite o ::error:: de afrouxamento', async (t) => {
    const { lines } = await runAgainstLcovBase(t, SWAPPED);

    const message = EN('note_loosen_unauthorised', { names: '`coverage`' });
    assert.ok(commands(lines, 'error').some((line) => line.startsWith(`::error::${message}`)));
  });

  test('o comentário mostra a source como campo afrouxado', async (t) => {
    const { comment } = await runAgainstLcovBase(t, SWAPPED);

    assert.ok(comment.split('\n').includes('| `coverage` | loosened | source |'), comment);
  });

  test('com a source trocada, a métrica é medida com a source do ramo base', async (t) => {
    const { read } = await runAgainstLcovBase(t, SWAPPED);

    assert.deepEqual(JSON.parse(parseOutputs(await read('output.txt')).regressions), [
      { name: 'coverage', status: 'regressed', before: 80, after: 50, delta: -30 },
    ]);
  });

  test('trocar a source com título autorizado passa', async (t) => {
    const { code } = await runAgainstLcovBase(t, SWAPPED, AUTHORISED_TITLE);

    assert.equal(code, 0);
  });

  test('retirar a source e commitar o ficheiro de métricas termina com 1', async (t) => {
    const { code } = await runAgainstLcovBase(t, DROPPED);

    assert.equal(code, 1);
  });

  test('com a source retirada, a regressão usa o relatório do ramo base', async (t) => {
    const { lines } = await runAgainstLcovBase(t, DROPPED);

    const message = EN('log_regressed', { name: 'coverage', before: 80, after: 50 });
    assert.ok(commands(lines, 'error').includes(`::error::${message}`));
  });

  test('com a métrica retirada, a regressão usa o relatório do ramo base', async (t) => {
    const { lines } = await runAgainstLcovBase(t, REMOVED);

    const message = EN('log_regressed', { name: 'coverage', before: 80, after: 50 });
    assert.ok(commands(lines, 'error').includes(`::error::${message}`));
  });
});

describe('runAction: segurança', () => {
  test('o token não aparece nos logs mesmo quando a API o devolve no erro', async (t) => {
    const token = 'ghs_secret_value_123';
    const routes = { ...prRoutes(), [PULL]: json({ message: `bad ${token}` }, 502) };

    const { lines } = await runScenario(t, {
      files: GREEN, env: { ...WITH_TOKEN, INPUT_TOKEN: token }, event: pullRequestEvent(), routes,
    });

    assert.deepEqual(lines.filter((line) => line.includes(token)), []);
  });
});

describe('runAction: contexto do pull request', () => {
  test('a label de hotfix lida da API prevalece sobre o payload', async (t) => {
    const routes = prRoutes({ labels: ['hotfix-bypass-ratchet'] });

    const { code, read } = await runScenario(t, {
      files: RED, env: WITH_TOKEN, event: pullRequestEvent({ labels: [] }), routes,
    });

    assert.equal(code, 0);
    assert.equal(parseOutputs(await read('output.txt')).bypassed, 'true');
  });

  test('o título lido da API prevalece sobre o payload', async (t) => {
    const routes = prRoutes({ title: AUTHORISED_TITLE });

    const { code } = await runScenario(t, {
      files: LOWERING, env: WITH_TOKEN, event: pullRequestEvent({ title: 'wip' }), routes,
    });

    assert.equal(code, 0);
  });

  test('falha ao ler o pull request da API gera aviso e usa o payload', async (t) => {
    const routes = { ...prRoutes(), [PULL]: json({ message: 'boom' }, 502) };
    const event = pullRequestEvent({ title: AUTHORISED_TITLE });

    const { code, lines } = await runScenario(t, {
      files: LOWERING, env: WITH_TOKEN, event, routes,
    });

    assert.equal(code, 0);
    assert.ok(commands(lines, 'warning').some((line) => line.includes('502')));
  });
});

describe('runAction: comentário', () => {
  test('cria o comentário com o marcador do name', async (t) => {
    const { calls } = await runScenario(t, {
      files: GREEN,
      env: { ...WITH_TOKEN, INPUT_NAME: 'api' },
      event: pullRequestEvent(),
      routes: prRoutes(),
    });

    const post = calls.find((call) => call.method === 'POST');
    const body = /** @type {{body: string}} */ (post?.body).body;
    assert.ok(body.startsWith('<!-- quality-ratchet:api -->\n## Quality ratchet - api'));
  });

  test('actualiza o comentário existente em vez de criar outro', async (t) => {
    const existing = [{ id: 42, body: `${MARKER}\nold`, user: { login: 'github-actions[bot]' } }];
    const routes = {
      ...prRoutes(),
      [LIST_COMMENTS]: json(existing),
      [LIST_COMMENTS_PAGE_2]: json([]),
      [`PATCH /repos/${REPO}/issues/comments/42`]: json({ id: 42 }),
    };

    const { calls } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    assert.deepEqual(calls.filter((call) => call.method !== 'GET').map((call) => call.method), [
      'PATCH',
    ]);
  });

  test('comment-marker assume o comentário de outro gate', async (t) => {
    const bot = { login: 'github-actions[bot]' };
    const existing = [{ id: 42, body: '<!-- quality-gate -->\nold', user: bot }];
    const routes = {
      ...prRoutes(),
      [LIST_COMMENTS]: json(existing),
      [LIST_COMMENTS_PAGE_2]: json([]),
      [`PATCH /repos/${REPO}/issues/comments/42`]: json({ id: 42 }),
    };
    const env = { ...WITH_TOKEN, 'INPUT_COMMENT-MARKER': 'quality-gate' };

    const { calls } = await runScenario(t, {
      files: GREEN, env, event: pullRequestEvent(), routes,
    });

    const patch = calls.find((call) => call.method === 'PATCH');
    const body = /** @type {{body: string}} */ (patch?.body).body;
    assert.ok(body.startsWith('<!-- quality-gate -->\n## Quality ratchet'));
  });

  test('comment-marker inválido termina com 1 e explica o erro', async (t) => {
    const env = { ...WITH_TOKEN, 'INPUT_COMMENT-MARKER': 'a --> b' };

    const { code, lines } = await runScenario(t, { files: GREEN, env });

    assert.equal(code, 1);
    assert.ok(commands(lines, 'error').some((line) => line.includes('comment-marker')));
  });

  test('comment false não publica comentário', async (t) => {
    const { calls } = await runScenario(t, {
      files: GREEN,
      env: { ...WITH_TOKEN, INPUT_COMMENT: 'false' },
      event: pullRequestEvent(),
      routes: prRoutes(),
    });

    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  });

  test('403 ao comentar gera aviso e o exit segue o gate', async (t) => {
    const routes = { ...prRoutes(), [CREATE_COMMENT]: json({ message: 'Forbidden' }, 403) };

    const { code, lines } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    assert.equal(code, 0);
    assert.ok(commands(lines, 'warning').some((line) => line.includes('403')));
  });

  test('publica o comentário mesmo quando o gate falha', async (t) => {
    const { calls } = await runScenario(t, {
      files: RED, env: WITH_TOKEN, event: pullRequestEvent(), routes: prRoutes(),
    });

    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  });

  test('regista um notice com o comentário criado', async (t) => {
    const { lines } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes: prRoutes(),
    });

    const notice = EN('log_comment_created', { number: PR_NUMBER });
    assert.ok(commands(lines, 'notice').includes(`::notice::${notice}`));
  });
});

describe('runAction: erros inesperados', () => {
  /** Execução com melhorias e write-baseline, cuja escrita falha com um erro sem código. */
  const FAILING_WRITE = Object.freeze({
    files: { ...GREEN, 'metrics-current.json': { coverage: 85, lint: 10 } },
    env: { 'INPUT_WRITE-BASELINE': 'new-baseline.json' },
    fs: { writeText: async () => { throw new Error('disk full'); } },
  });

  test('um erro sem código do catálogo termina com 1 e mostra a mensagem', async (t) => {
    const { code, lines } = await runScenario(t, FAILING_WRITE);

    assert.equal(code, 1);
    assert.deepEqual(commands(lines, 'error'), ['::error::disk full']);
  });

  test('um erro sem código do catálogo deixa a stack no log de debug', async (t) => {
    const { lines } = await runScenario(t, FAILING_WRITE);

    const debug = commands(lines, 'debug');
    assert.ok(debug.some((line) => line.startsWith('::debug::Error: disk full%0A')));
  });

  test('um erro com código do catálogo não deixa stack no debug', async (t) => {
    const { lines } = await runScenario(t, { files: GREEN, env: { INPUT_STRICT: 'talvez' } });

    assert.deepEqual(commands(lines, 'debug'), []);
  });
});

describe('runAction: configuração inválida', () => {
  test('input booleano inválido termina com 1 e explica o erro', async (t) => {
    const { code, lines } = await runScenario(t, { files: GREEN, env: { INPUT_COMMENT: 'sim' } });

    assert.equal(code, 1);
    const message = EN('config_boolean_invalid', { input: 'comment', value: 'sim' });
    assert.deepEqual(commands(lines, 'error'), [`::error::${message}`]);
  });

  test('língua inválida termina com 1 e reporta em inglês', async (t) => {
    const { code, lines } = await runScenario(t, { files: GREEN, env: { INPUT_LANGUAGE: 'fr' } });

    assert.equal(code, 1);
    const message = EN('config_language_unsupported', { language: 'fr', supported: 'en, pt' });
    assert.deepEqual(commands(lines, 'error'), [`::error::${message}`]);
  });

  test('baseline inexistente termina com 1', async (t) => {
    const { code } = await runScenario(t, { files: { 'metrics-current.json': {} } });

    assert.equal(code, 1);
  });
});

describe('runAction: checkout numa subpasta', () => {
  /** Ficheiros do projecto numa subpasta `app/` da workspace. */
  const APP_FILES = Object.freeze({
    'app/quality-baseline.json': BASELINE,
    'app/metrics-current.json': { coverage: 80, lint: 10 },
  });
  /** Repositório em `app/` (actions/checkout com `path: app`). */
  const IN_APP = Object.freeze({ ...APP_FILES, 'app/.git/HEAD': 'ref: refs/heads/main\n' });
  const APP_ENV = Object.freeze({
    ...WITH_TOKEN,
    INPUT_BASELINE: 'app/quality-baseline.json',
    INPUT_METRICS: 'app/metrics-current.json',
  });

  test('pede o baseline pelo caminho relativo à raiz do repositório', async (t) => {
    const { calls } = await runScenario(t, {
      files: IN_APP, env: APP_ENV, event: pullRequestEvent(), routes: prRoutes(),
    });

    assert.ok(calls.some((call) => `${call.method} ${call.route}` === CONTENTS));
  });

  test('baixar o baseline sem título autorizado falha', async (t) => {
    const files = { ...IN_APP, 'app/quality-baseline.json': LOWERED };

    const { code } = await runScenario(t, {
      files, env: APP_ENV, event: pullRequestEvent(), routes: prRoutes(),
    });

    assert.equal(code, 1);
  });

  test('um .git em ficheiro (worktree, submódulo) marca a raiz', async (t) => {
    const files = { ...APP_FILES, 'app/.git': 'gitdir: ../.git/worktrees/app\n' };

    const { calls } = await runScenario(t, {
      files, env: APP_ENV, event: pullRequestEvent(), routes: prRoutes(),
    });

    assert.ok(calls.some((call) => `${call.method} ${call.route}` === CONTENTS));
  });

  test('num monorepo com .git na raiz mantém o caminho do pacote', async (t) => {
    const files = {
      '.git/HEAD': 'ref: refs/heads/main\n',
      'packages/api/quality-baseline.json': BASELINE,
      'm.json': { coverage: 80, lint: 10 },
    };
    const env = {
      ...WITH_TOKEN, INPUT_BASELINE: 'packages/api/quality-baseline.json', INPUT_METRICS: 'm.json',
    };

    const { calls } = await runScenario(t, { files, env, event: pullRequestEvent(), routes: {} });

    const route = `/repos/${REPO}/contents/packages/api/quality-baseline.json?ref=${BASE_SHA}`;
    assert.ok(calls.some((call) => call.route === route));
  });

  test('ignora um .git acima da workspace', async (t) => {
    const files = {
      '.git/HEAD': 'ref: refs/heads/main\n',
      'ws/quality-baseline.json': BASELINE,
      'ws/metrics-current.json': { coverage: 80, lint: 10 },
    };

    const { calls } = await runScenario(t, {
      files, env: WITH_TOKEN, workspace: 'ws', event: pullRequestEvent(), routes: prRoutes(),
    });

    assert.ok(calls.some((call) => `${call.method} ${call.route}` === CONTENTS));
  });
});

describe('runAction: autor do comentário', () => {
  const PATCH_42 = `PATCH /repos/${REPO}/issues/comments/42`;
  const PATCH_43 = `PATCH /repos/${REPO}/issues/comments/43`;

  /**
   * Rotas com dois comentários marcados, dos autores indicados (ids 42 e 43).
   * @param {string} first autor do comentário 42
   * @param {string} second autor do comentário 43
   * @returns {Routes}
   */
  function markedBy(first, second) {
    const existing = [
      { id: 42, body: `${MARKER}\nold`, user: { login: first } },
      { id: 43, body: `${MARKER}\nfake green`, user: { login: second } },
    ];
    return {
      ...prRoutes(),
      [LIST_COMMENTS]: json(existing),
      [LIST_COMMENTS_PAGE_2]: json([]),
      [USER]: json({ message: 'Resource not accessible by integration' }, 403),
      [PATCH_42]: json({ id: 42 }),
      [PATCH_43]: json({ id: 43 }),
    };
  }

  /**
   * Pedidos que alteram comentários ('MÉTODO /caminho').
   * @param {Array<{method: string, route: string}>} calls
   * @returns {string[]}
   */
  function writes(calls) {
    return calls.filter((call) => call.method !== 'GET').map((c) => `${c.method} ${c.route}`);
  }

  test('ignora um comentário marcado mais recente de outro utilizador', async (t) => {
    const routes = markedBy('github-actions[bot]', 'mallory');

    const { calls } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    assert.deepEqual(writes(calls), [PATCH_42]);
  });

  test('actualiza todos os comentários marcados do bot (execuções simultâneas)', async (t) => {
    const routes = markedBy('github-actions[bot]', 'github-actions[bot]');

    const { calls } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    assert.deepEqual(writes(calls), [PATCH_42, PATCH_43]);
  });

  test('usa o login devolvido por GET /user', async (t) => {
    const routes = { ...markedBy('github-actions[bot]', 'ana'), [USER]: json({ login: 'ana' }) };

    const { calls } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    assert.deepEqual(writes(calls), [PATCH_43]);
  });

  test('comment-author escolhe o autor dos comentários a actualizar', async (t) => {
    const env = { ...WITH_TOKEN, 'INPUT_COMMENT-AUTHOR': 'my-app[bot]' };
    const routes = markedBy('github-actions[bot]', 'my-app[bot]');

    const { calls } = await runScenario(t, {
      files: GREEN, env, event: pullRequestEvent(), routes,
    });

    assert.deepEqual(writes(calls), [PATCH_43]);
  });

  test('com comment-author não pede GET /user', async (t) => {
    const env = { ...WITH_TOKEN, 'INPUT_COMMENT-AUTHOR': 'my-app[bot]' };
    const routes = markedBy('github-actions[bot]', 'my-app[bot]');

    const { calls } = await runScenario(t, {
      files: GREEN, env, event: pullRequestEvent(), routes,
    });

    assert.equal(calls.some((call) => call.route === '/user'), false);
  });

  test('no Gitea Actions sem login actualiza os comentários de gitea-actions', async (t) => {
    const env = { ...WITH_TOKEN, GITEA_ACTIONS: 'true' };
    const routes = markedBy('mallory', 'gitea-actions');

    const { calls } = await runScenario(t, {
      files: GREEN, env, event: pullRequestEvent(), routes,
    });

    assert.deepEqual(writes(calls), [PATCH_43]);
  });

  test('no Gitea Actions o login devolvido por GET /user prevalece', async (t) => {
    const env = { ...WITH_TOKEN, GITEA_ACTIONS: 'true' };
    const routes = { ...markedBy('ana', 'gitea-actions'), [USER]: json({ login: 'ana' }) };

    const { calls } = await runScenario(t, {
      files: GREEN, env, event: pullRequestEvent(), routes,
    });

    assert.deepEqual(writes(calls), [PATCH_42]);
  });

  test('fora do Gitea Actions gitea-actions não é autor por omissão', async (t) => {
    const routes = markedBy('mallory', 'gitea-actions');

    const { calls } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    assert.deepEqual(writes(calls), [CREATE_COMMENT]);
  });

  test('uma falha de GET /user só gera aviso e o exit segue o gate', async (t) => {
    const routes = { ...markedBy('github-actions[bot]', 'ana'), [USER]: json({ m: 'x' }, 500) };

    const { code } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    assert.equal(code, 0);
  });
});

describe('runAction: falhas ao comentar', () => {
  /**
   * Linha de aviso esperada para uma falha do POST do comentário.
   * @param {string} code código da mensagem
   * @param {number} status
   * @param {string} body
   * @returns {string}
   */
  function commentWarning(code, status, body) {
    const path = `/repos/${REPO}/issues/${PR_NUMBER}/comments`;
    const reason = EN('github_api_failed', { method: 'POST', path, status, body });
    return `::warning::${EN(code, { reason })}`;
  }

  test('um 403 aponta para o token só de leitura dos forks', async (t) => {
    const body = JSON.stringify({ message: 'Forbidden' });
    const routes = { ...prRoutes(), [CREATE_COMMENT]: { status: 403, body } };

    const { lines } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    assert.ok(commands(lines, 'warning').includes(commentWarning('log_comment_failed', 403, body)));
  });

  test('um 422 gera o aviso sem a explicação dos forks', async (t) => {
    const body = JSON.stringify({ message: 'Validation Failed' });
    const routes = { ...prRoutes(), [CREATE_COMMENT]: { status: 422, body } };

    const { lines } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    const expected = commentWarning('log_comment_failed_generic', 422, body);
    assert.ok(commands(lines, 'warning').includes(expected));
  });
});

describe('runAction: tamanho do comentário', () => {
  /**
   * Ficheiros com `count` métricas: a primeira regride e as restantes melhoram.
   * @param {number} count
   * @param {number} [failing] quantas métricas regridem, a começar pela primeira
   * @returns {Record<string, unknown>}
   */
  function manyMetrics(count, failing = 1) {
    /** @type {Record<string, unknown>} */
    const metrics = {};
    /** @type {Record<string, number>} */
    const measured = {};
    for (let index = 0; index < count; index += 1) {
      metrics[`metric_${index}`] = { value: 80, direction: 'up' };
      measured[`metric_${index}`] = index < failing ? 50 : 90;
    }
    return { 'quality-baseline.json': { version: 2, metrics }, 'metrics-current.json': measured };
  }

  /**
   * Corre um pull request com os ficheiros indicados e devolve o body do comentário criado.
   * @param {import('node:test').TestContext} t
   * @param {Record<string, unknown>} files
   */
  async function commentFor(t, files) {
    const result = await runScenario(t, {
      files, env: WITH_TOKEN, event: pullRequestEvent(), routes: prRoutes(),
    });
    const post = result.calls.find((call) => call.method === 'POST');
    return { ...result, body: /** @type {{body: string}} */ (post?.body).body };
  }

  test('um sumário acima do limite gera um comentário que cabe no limite da API', async (t) => {
    const { body } = await commentFor(t, manyMetrics(2000));

    assert.ok(body.length <= 65536, String(body.length));
  });

  test('o comentário abreviado começa pelo marcador', async (t) => {
    const { body } = await commentFor(t, manyMetrics(2000));

    assert.ok(body.startsWith(`${MARKER}\n`));
  });

  test('o comentário abreviado mantém a métrica que falhou', async (t) => {
    const { body } = await commentFor(t, manyMetrics(2000));

    assert.ok(body.includes('`metric_0`'));
  });

  test('o comentário abreviado omite as métricas melhoradas', async (t) => {
    const { body } = await commentFor(t, manyMetrics(2000));

    assert.equal(body.includes('`metric_1999`'), false);
  });

  test('o comentário abreviado mantém as alterações que afrouxam o baseline', async (t) => {
    const { body } = await commentFor(t, manyMetrics(2000));

    assert.ok(body.includes('| `coverage` |'));
  });

  test('o comentário abreviado omite as alterações que não afrouxam o baseline', async (t) => {
    const { body } = await commentFor(t, manyMetrics(2000));

    assert.equal(body.includes('| `metric_1999` |'), false);
  });

  test('o comentário abreviado leva uma nota a indicar o sumário do job', async (t) => {
    const { body } = await commentFor(t, manyMetrics(2000));

    assert.ok(body.includes(EN('note_comment_abbreviated')));
  });

  test('o sumário do job fica completo, com o baseline novo', async (t) => {
    const { read } = await commentFor(t, manyMetrics(2000));

    assert.ok((await read('summary.md')).includes('`metric_1999`'));
  });

  test('o output summary fica completo', async (t) => {
    const { read } = await commentFor(t, manyMetrics(2000));

    assert.ok(parseOutputs(await read('output.txt')).summary.includes('<details>'));
  });

  test('quando basta tirar o baseline novo, a tabela fica completa', async (t) => {
    const { body } = await commentFor(t, manyMetrics(700));

    assert.ok(body.includes('`metric_699`'));
  });

  test('quando basta tirar o baseline novo, o comentário não o inclui', async (t) => {
    const { body } = await commentFor(t, manyMetrics(700));

    assert.equal(body.includes('<details>'), false);
  });

  test('um sumário dentro do limite vai completo para o comentário', async (t) => {
    const { body, read } = await commentFor(t, manyMetrics(3));

    assert.equal(body, `${MARKER}\n${parseOutputs(await read('output.txt')).summary}`);
  });

  test('com demasiadas falhas o comentário é cortado para caber no limite', async (t) => {
    const { body } = await commentFor(t, manyMetrics(3000, 3000));

    assert.ok(body.length <= 65536, String(body.length));
  });
});

describe('runAction: novas tentativas à API', () => {
  const RETRIED = Object.freeze({ status: 502, body: '<html>bad gateway</html>' });

  test('repete a leitura do baseline do ramo base depois de um 502', async (t) => {
    const routes = { ...prRoutes(), [CONTENTS]: [RETRIED, raw(BASELINE)] };

    const { read } = await runScenario(t, {
      files: LOWERING, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    assert.deepEqual(JSON.parse(parseOutputs(await read('output.txt')).loosened), ['coverage']);
  });

  test('regista um aviso por cada nova tentativa', async (t) => {
    const routes = { ...prRoutes(), [CONTENTS]: [RETRIED, raw(BASELINE)] };

    const { lines } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    const path = `/repos/${REPO}/contents/quality-baseline.json?ref=${BASE_SHA}`;
    const params = { method: 'GET', path, status: 502, attempt: 1, seconds: 1 };
    assert.ok(commands(lines, 'warning').includes(`::warning::${EN('log_api_retry', params)}`));
  });

  test('espera entre as tentativas com o sleep injectado', async (t) => {
    /** @type {number[]} */
    const delays = [];
    const sleep = async (/** @type {number} */ ms) => { delays.push(ms); };
    const routes = { ...prRoutes(), [CONTENTS]: RETRIED };

    await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes, sleep,
    });

    assert.deepEqual(delays, [1000, 3000]);
  });

  test('um limite sem pedidos restantes espera até ao reset, pelo relógio injectado', async (t) => {
    /** @type {number[]} */
    const delays = [];
    const sleep = async (/** @type {number} */ ms) => { delays.push(ms); };
    const reset = String(NOW.getTime() / 1000 + 5);
    const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset };
    const routes = { ...prRoutes(), [CONTENTS]: [{ status: 403, headers }, raw(BASELINE)] };

    await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes, sleep,
    });

    assert.deepEqual(delays, [5000]);
  });
});

describe('runAction: proxy', () => {
  test('com token, um proxy que o Node não aplica ao fetch gera aviso', async (t) => {
    const { lines } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, proxy: () => 'unsupported',
    });

    assert.ok(commands(lines, 'warning').includes(`::warning::${EN('log_proxy_unsupported')}`));
  });

  test('um proxy que o Node não aplica não impede a execução', async (t) => {
    const { code } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, proxy: () => 'unsupported',
    });

    assert.equal(code, 0);
  });

  for (const mode of /** @type {const} */ (['none', 'native', 'enabled'])) {
    test(`com o proxy em modo ${mode} não há aviso`, async (t) => {
      const { lines } = await runScenario(t, { files: GREEN, env: WITH_TOKEN, proxy: () => mode });

      assert.deepEqual(commands(lines, 'warning'), []);
    });
  }

  test('sem token não configura o proxy', async (t) => {
    let configured = false;
    const proxy = () => {
      configured = true;
      return /** @type {ProxyMode} */ ('enabled');
    };

    await runScenario(t, { files: GREEN, proxy });

    assert.equal(configured, false);
  });

  test('uma configuração de proxy recusada termina com 1 e explica o erro', async (t) => {
    const proxy = () => { throw new ConfigError('proxy_invalid', { reason: 'bad url' }); };

    const { lines } = await runScenario(t, { files: GREEN, env: WITH_TOKEN, proxy });

    const message = EN('proxy_invalid', { reason: 'bad url' });
    assert.deepEqual(commands(lines, 'error'), [`::error::${message}`]);
  });
});

describe('runAction: Node sem fetch', () => {
  test('com token termina com 1', async (t) => {
    const { code } = await runScenario(t, { files: GREEN, env: WITH_TOKEN, fetch: null });

    assert.equal(code, 1);
  });

  test('com token explica que é preciso o Node.js 20 e a versão em uso', async (t) => {
    const { lines } = await runScenario(t, { files: GREEN, env: WITH_TOKEN, fetch: null });

    const message = EN('error_node_unsupported', { version: OLD_NODE });
    assert.deepEqual(commands(lines, 'error'), [`::error::${message}`]);
  });

  test('a mensagem segue o input language', async (t) => {
    const env = { ...WITH_TOKEN, INPUT_LANGUAGE: 'pt' };

    const { lines } = await runScenario(t, { files: GREEN, env, fetch: null });

    const message = createTranslator('pt')('error_node_unsupported', { version: OLD_NODE });
    assert.deepEqual(commands(lines, 'error'), [`::error::${message}`]);
  });

  test('não configura o proxy', async (t) => {
    let configured = false;
    const proxy = () => { configured = true; return /** @type {ProxyMode} */ ('none'); };

    await runScenario(t, { files: GREEN, env: WITH_TOKEN, fetch: null, proxy });

    assert.equal(configured, false);
  });

  test('sem token não precisa do fetch e segue o gate', async (t) => {
    const { code } = await runScenario(t, { files: GREEN, fetch: null });

    assert.equal(code, 0);
  });
});
