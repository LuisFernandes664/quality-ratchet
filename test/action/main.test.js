// @ts-check
import assert from 'node:assert/strict';
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { runAction } from '../../src/action/main.js';
import { createTranslator } from '../../src/core/messages.js';

const API_URL = 'https://api.test';
const NOW = new Date('2026-09-27T10:00:00Z');
const REPO = 'o/r';
const PR_NUMBER = 7;
const BASE_SHA = 'base1';
const AUTHORISED_TITLE = 'chore: lower baseline for the legacy module';

const CONTENTS = `GET /repos/${REPO}/contents/quality-baseline.json?ref=${BASE_SHA}`;
const PULL = `GET /repos/${REPO}/pulls/${PR_NUMBER}`;
const LIST_COMMENTS = `GET /repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100&page=1`;
const CREATE_COMMENT = `POST /repos/${REPO}/issues/${PR_NUMBER}/comments`;

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

const EN = createTranslator('en');

/**
 * @typedef {object} Reply
 * @property {number} [status]
 * @property {string} [body]
 * @property {Record<string, string>} [headers]
 */

/**
 * @typedef {object} Scenario
 * @property {Record<string, unknown>} [files] caminho relativo à pasta temporária -> conteúdo
 * @property {Record<string, string|undefined>} [env] variáveis extra (undefined apaga)
 * @property {Record<string, Reply|undefined>} [routes] 'MÉTODO /caminho' -> resposta
 * @property {unknown} [event] payload do evento, escrito em event.json
 * @property {string} [workspace] subpasta usada como GITHUB_WORKSPACE (omissão: a raiz)
 * @property {Partial<typeof realFs>} [fs] substitui operações do sistema de ficheiros
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
 * @returns {Record<string, Reply|undefined>}
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
 * API falsa: responde pelas rotas dadas e 404 a tudo o resto; regista os pedidos.
 * @param {Record<string, Reply|undefined>} routes
 */
function fakeApi(routes) {
  /** @type {Array<{method: string, route: string, body: unknown}>} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const route = String(url).slice(API_URL.length);
    calls.push({ method, route, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const reply = routes[`${method} ${route}`];
    if (!reply) return new Response('{"message":"Not Found"}', { status: 404 });
    const status = reply.status ?? 200;
    return new Response(reply.body ?? null, { status, headers: reply.headers });
  };
  return { fetch, calls };
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
 * Corre a action numa workspace temporária, apagada no fim do teste.
 * @param {import('node:test').TestContext} t
 * @param {Scenario} scenario
 */
async function runScenario(t, scenario = {}) {
  const { files = {}, env = {}, routes = {}, event, workspace = '', fs = {} } = scenario;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quality-ratchet-action-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFiles(dir, event === undefined ? files : { ...files, 'event.json': event });
  const api = fakeApi(routes);
  /** @type {string[]} */
  const lines = [];
  const code = await runAction({
    env: {
      GITHUB_WORKSPACE: path.join(dir, workspace),
      GITHUB_OUTPUT: path.join(dir, 'output.txt'),
      GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
      GITHUB_API_URL: API_URL,
      ...(event === undefined ? {} : { GITHUB_EVENT_PATH: path.join(dir, 'event.json') }),
      ...env,
    },
    fetch: api.fetch,
    fs: { ...realFs, ...fs },
    write: (line) => lines.push(line),
    now: () => NOW,
    randomId: () => 'id',
  });
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
    const baseline = {
      version: 2,
      metrics: {
        coverage: {
          value: 80, direction: 'up', source: { format: 'lcov', path: 'cov/lcov.info' },
        },
      },
    };
    const files = {
      'pkg/quality-baseline.json': baseline,
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
    const existing = [{ id: 42, body: '<!-- quality-ratchet -->\nold', user: { login: 'bot' } }];
    const routes = {
      ...prRoutes(),
      [LIST_COMMENTS]: json(existing),
      [`GET /repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100&page=2`]: json([]),
      [`PATCH /repos/${REPO}/issues/comments/42`]: json({ id: 42 }),
    };

    const { calls } = await runScenario(t, {
      files: GREEN, env: WITH_TOKEN, event: pullRequestEvent(), routes,
    });

    assert.deepEqual(calls.filter((call) => call.method !== 'GET').map((call) => call.method), [
      'PATCH',
    ]);
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
