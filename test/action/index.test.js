// @ts-check
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
  return Object.fromEntries(names.map((name) => [name, manifest.get(`inputs.${name}.default`)]));
}

/**
 * Corre o ponto de entrada num processo novo, com o mesmo Node dos testes, numa pasta
 * temporária e com um ambiente limpo (sem herdar as variáveis GITHUB_* de quem corre os
 * testes).
 * @param {import('node:test').TestContext} t
 * @param {{files: Record<string, unknown>, inputs?: Record<string, string>}} scenario
 */
async function runEntry(t, { files, inputs = {} }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quality-ratchet-entry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), JSON.stringify(content));
  }
  const env = {
    GITHUB_WORKSPACE: dir,
    GITHUB_OUTPUT: path.join(dir, 'output.txt'),
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
    ...runnerInputs(await readManifest(), inputs),
  };
  const read = (/** @type {string} */ name) => readFile(path.join(dir, name), 'utf8');
  return { ...(await spawnEntry(dir, env)), read };
}

/**
 * @param {string} cwd
 * @param {Record<string, string>} env
 * @returns {Promise<{code: number, stdout: string}>}
 */
async function spawnEntry(cwd, env) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [ENTRY], { cwd, env });
    return { code: 0, stdout };
  } catch (cause) {
    const failure = /** @type {{code: number, stdout: string}} */ (cause);
    return { code: failure.code, stdout: failure.stdout };
  }
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

  test('write-baseline cria as pastas em falta', async (t) => {
    const files = { 'quality-baseline.json': BASELINE, 'metrics-current.json': { coverage: 90 } };
    const inputs = { 'write-baseline': 'out/nested/quality-baseline.json' };

    const { read } = await runEntry(t, { files, inputs });

    const written = JSON.parse(await read('out/nested/quality-baseline.json'));
    assert.equal(written.metrics.coverage.value, 90);
  });
});
