// @ts-check
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createTranslator } from '../../src/core/messages.js';

const execFileAsync = promisify(execFile);

const EN = createTranslator('en');

/** Este Node consegue aplicar HTTP_PROXY ao fetch sem NODE_USE_ENV_PROXY (Node 24). */
const NATIVE_PROXY = typeof Reflect.get(http, 'setGlobalProxyFromEnv') === 'function';

/** Ponto de entrada da action. */
const ENTRY = fileURLToPath(new URL('../../src/index.js', import.meta.url));

/** Manifesto da action. */
const MANIFEST = fileURLToPath(new URL('../../action.yml', import.meta.url));

/** Baseline v2 usado nos cenários. */
const BASELINE = Object.freeze({
  version: 2,
  frozen_at: '2026-05-04',
  metrics: { coverage: { value: 80, direction: 'up' } },
});

/** Ficheiros de uma execução verde. */
const GREEN = Object.freeze({
  'quality-baseline.json': BASELINE,
  'metrics-current.json': { coverage: 80 },
});

/** Evento pull_request mínimo. */
const PR_EVENT = Object.freeze({
  pull_request: {
    number: 7,
    title: 'feat: x',
    labels: [],
    base: { sha: 'base1', repo: { full_name: 'o/r' } },
    head: { sha: 'head1', repo: { full_name: 'o/r' } },
  },
});

/**
 * @typedef {object} EntryScenario
 * @property {Record<string, unknown>} files nome na workspace -> conteúdo (em JSON)
 * @property {Record<string, string>} [inputs] nome do input -> valor
 * @property {(dir: string) => Record<string, string>} [env] variáveis extra, a partir da
 *   pasta da workspace
 */

/**
 * Tira as aspas de um escalar YAML simples.
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  return value;
}

/**
 * Lê o action.yml como mapa de caminhos com pontos (ex: 'inputs.baseline.default'). Chega
 * para o formato do manifesto: chaves indentadas a 2 espaços e escalares numa só linha.
 * @returns {Promise<Map<string, string>>}
 */
async function readManifest() {
  /** @type {Map<string, string>} */
  const values = new Map();
  /** @type {string[]} */
  const keys = [];
  for (const line of (await readFile(MANIFEST, 'utf8')).split('\n')) {
    const match = /^( *)([\w-]+):(?: (.*))?$/.exec(line);
    if (!match) continue;
    keys.length = match[1].length / 2;
    keys.push(match[2]);
    values.set(keys.join('.'), unquote(match[3] ?? ''));
  }
  return values;
}

/**
 * Nomes declarados numa secção do manifesto ('inputs' ou 'outputs').
 * @param {Map<string, string>} manifest
 * @param {string} section
 * @returns {string[]}
 */
function declared(manifest, section) {
  const pattern = new RegExp(`^${section}\\.([^.]+)\\.description$`);
  return [...manifest.keys()].flatMap((key) => pattern.exec(key)?.[1] ?? []).sort();
}

/**
 * Variáveis INPUT_* tal como o runner as define: todos os inputs com o valor por omissão
 * do manifesto, sem token (nenhum pedido à rede), mais os valores dados.
 * @param {Map<string, string>} manifest
 * @param {Record<string, string>} given nome do input -> valor
 * @returns {Record<string, string>}
 */
function runnerInputs(manifest, given) {
  /** @type {Record<string, string>} */
  const env = {};
  const values = { ...defaults(manifest), token: '', ...given };
  for (const [name, value] of Object.entries(values)) {
    env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value;
  }
  return env;
}

/**
 * Valores por omissão dos inputs do manifesto.
 * @param {Map<string, string>} manifest
 * @returns {Record<string, string>}
 */
function defaults(manifest) {
  const names = declared(manifest, 'inputs');
  return Object.fromEntries(
    names.map((name) => [name, manifest.get(`inputs.${name}.default`) ?? '']),
  );
}

/**
 * Corre o ponto de entrada num processo novo, com o mesmo Node dos testes, numa pasta
 * temporária e com um ambiente limpo (sem herdar as variáveis GITHUB_* de quem corre os
 * testes). src/index.js nunca escreve no stderr: tudo passa por workflow commands no
 * stdout, e um erro dentro de runAction vira ::error:: com a stack em ::debug::. Texto no
 * stderr é por isso um crash fora de runAction, e a asserção mostra-o.
 * @param {import('node:test').TestContext} t
 * @param {EntryScenario} scenario
 */
async function runEntry(t, { files, inputs = {}, env = () => ({}) }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quality-ratchet-entry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), JSON.stringify(content));
  }
  const result = await spawnEntry(dir, {
    GITHUB_WORKSPACE: dir,
    GITHUB_OUTPUT: path.join(dir, 'output.txt'),
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
    ...runnerInputs(await readManifest(), inputs),
    ...env(dir),
  });
  assert.equal(result.stderr, '');
  const read = (/** @type {string} */ name) => readFile(path.join(dir, name), 'utf8');
  return { ...result, read };
}

/**
 * Lança o ponto de entrada. Uma saída com código de erro é um resultado; uma falha a lançar
 * o processo (ENOENT, maxBuffer) ou uma morte por sinal propagam-se tal como vieram.
 * @param {string} cwd
 * @param {Record<string, string>} env
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function spawnEntry(cwd, env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [ENTRY], { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const failure = /** @type {{code?: unknown, stdout: string, stderr: string}} */ (cause);
    if (typeof failure.code !== 'number') throw cause;
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

/**
 * Servidor HTTP local que regista cada pedido ('MÉTODO URL') e responde 404. Serve de API
 * falsa ou de proxy: aceita um CONNECT e responde ele próprio aos pedidos do túnel (em
 * HTTP simples). Fecha no fim do teste.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{url: string, requests: string[]}>}
 */
async function recordingServer(t) {
  /** @type {string[]} */
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"x"}');
  });
  server.on('connect', (request, socket, head) => {
    requests.push(`CONNECT ${request.url}`);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) socket.unshift(head);
    server.emit('connection', socket);
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(null)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, requests };
}

/**
 * Ambiente de um pull request com token contra a API indicada, com proxy.
 * @param {string} apiUrl
 * @param {Record<string, string>} proxy variáveis de proxy
 * @returns {(dir: string) => Record<string, string>}
 */
function proxiedPullRequest(apiUrl, proxy) {
  return (dir) => ({
    GITHUB_API_URL: apiUrl,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_EVENT_PATH: path.join(dir, 'event.json'),
    ...proxy,
  });
}

/**
 * Nomes dos outputs escritos no ficheiro GITHUB_OUTPUT (formato heredoc).
 * @param {string} text
 * @returns {string[]}
 */
function outputNames(text) {
  return [...text.matchAll(/^(.+?)<<(\S+)\n[\s\S]*?\n\2\n/gm)].map((match) => match[1]).sort();
}

describe('action.yml', () => {
  test('corre em node24 a partir de src/index.js', async () => {
    const manifest = await readManifest();

    assert.deepEqual([manifest.get('runs.using'), manifest.get('runs.main')], [
      'node24', 'src/index.js',
    ]);
  });

  test('os valores por omissão dos inputs são os combinados para a action e a CLI', async () => {
    const manifest = await readManifest();

    assert.deepEqual(defaults(manifest), {
      baseline: 'quality-baseline.json',
      'bypass-label': 'hotfix-bypass-ratchet',
      comment: 'true',
      language: 'en',
      'lower-baseline-pattern': '^chore(\\([^)]*\\))?: lower baseline',
      metrics: 'metrics-current.json',
      name: '',
      'comment-author': '',
      strict: 'false',
      token: '${{ github.token }}',
      'write-baseline': '',
    });
  });

  test('declara exactamente os outputs que a action escreve', async (t) => {
    const files = { 'quality-baseline.json': BASELINE, 'metrics-current.json': { coverage: 80 } };
    const { read } = await runEntry(t, { files });

    const written = outputNames(await read('output.txt'));
    assert.deepEqual(written, declared(await readManifest(), 'outputs'));
  });
});

describe('src/index.js', () => {
  test('sem regressões termina com 0', async (t) => {
    const files = { 'quality-baseline.json': BASELINE, 'metrics-current.json': { coverage: 80 } };

    const { code } = await runEntry(t, { files });

    assert.equal(code, 0);
  });

  test('uma regressão termina com 1 e escreve ::error:: no stdout', async (t) => {
    const files = { 'quality-baseline.json': BASELINE, 'metrics-current.json': { coverage: 70 } };

    const { code, stdout } = await runEntry(t, { files });

    assert.equal(code, 1);
    assert.match(stdout, /^::error::coverage regressed: 80 -> 70$/m);
  });

  test('um input inválido termina com 1', async (t) => {
    const { code } = await runEntry(t, { files: GREEN, inputs: { strict: 'talvez' } });

    assert.equal(code, 1);
  });

  test('um input inválido é reportado com ::error:: no stdout', async (t) => {
    const { stdout } = await runEntry(t, { files: GREEN, inputs: { strict: 'talvez' } });

    const message = EN('config_boolean_invalid', { input: 'strict', value: 'talvez' });
    assert.ok(stdout.split('\n').includes(`::error::${message}`), stdout);
  });

  test('write-baseline cria as pastas em falta', async (t) => {
    const files = { 'quality-baseline.json': BASELINE, 'metrics-current.json': { coverage: 90 } };
    const inputs = { 'write-baseline': 'out/nested/quality-baseline.json' };

    const { read } = await runEntry(t, { files, inputs });

    const written = JSON.parse(await read('out/nested/quality-baseline.json'));
    assert.equal(written.metrics.coverage.value, 90);
  });
});

describe('src/index.js: proxy', () => {
  test('avisa quando este Node não aplica o proxy ao fetch', { skip: NATIVE_PROXY }, async (t) => {
    const env = () => ({ HTTPS_PROXY: 'http://127.0.0.1:9' });

    const { stdout } = await runEntry(t, { files: GREEN, inputs: { token: 'x' }, env });

    assert.ok(stdout.split('\n').includes(`::warning::${EN('log_proxy_unsupported')}`));
  });

  test('os pedidos à API passam pelo proxy do ambiente', { skip: !NATIVE_PROXY }, async (t) => {
    const proxy = await recordingServer(t);
    const env = proxiedPullRequest('http://ghe.invalid/api/v3', { HTTP_PROXY: proxy.url });
    const files = { ...GREEN, 'event.json': PR_EVENT };

    await runEntry(t, { files, inputs: { token: 'x' }, env });

    assert.ok(proxy.requests.includes('CONNECT ghe.invalid:80'), JSON.stringify(proxy.requests));
  });

  test('o NO_PROXY deixa a API fora do proxy', { skip: !NATIVE_PROXY }, async (t) => {
    const proxy = await recordingServer(t);
    const api = await recordingServer(t);
    const variables = { HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1' };
    const env = proxiedPullRequest(`${api.url}/api/v3`, variables);
    const files = { ...GREEN, 'event.json': PR_EVENT };

    await runEntry(t, { files, inputs: { token: 'x' }, env });

    const route = 'GET /api/v3/repos/o/r/contents/quality-baseline.json?ref=base1';
    assert.ok(api.requests.includes(route), JSON.stringify(api.requests));
  });
});
