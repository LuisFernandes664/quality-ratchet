// @ts-check
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { makeTempDir, readJson, removeDir, writeFiles } from './helpers.js';

const execFileAsync = promisify(execFile);

/** Caminho do executável da CLI. */
const BIN = fileURLToPath(new URL('../../bin/quality-ratchet.js', import.meta.url));

/**
 * Corre o executável num processo novo, com o mesmo Node dos testes.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function runBin(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const failure = /** @type {{code: number, stdout: string, stderr: string}} */ (cause);
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

describe('bin/quality-ratchet.js', () => {
  /** @type {string} */
  let dir;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  test('--version mostra a versao do package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

    const result = await runBin(dir, ['--version']);

    assert.deepEqual(result, { code: 0, stdout: `${pkg.version}\n`, stderr: '' });
  });

  test('init e check correm de ponta a ponta com ficheiros reais', async () => {
    await writeFiles(dir, { 'metrics-current.json': { coverage: 70, lint: 3 } });
    await runBin(dir, ['init', '--metrics', 'metrics-current.json', '--up', 'coverage',
      '--down', 'lint']);
    await writeFiles(dir, { 'metrics-current.json': { coverage: 69, lint: 3 } });

    const result = await runBin(dir, ['check']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /^error: coverage regressed: 70 -> 69$/m);
  });

  test('update escreve o baseline apertado', async () => {
    await writeFiles(dir, {
      'quality-baseline.json': { version: 2, metrics: { lint: { value: 5, direction: 'down' } } },
      'metrics-current.json': { lint: 2 },
    });

    const result = await runBin(dir, ['update']);

    assert.equal(result.code, 0);
    assert.equal((await readJson(dir, 'quality-baseline.json')).metrics.lint.value, 2);
  });

  test('erro de utilizacao sai com 2', async () => {
    const result = await runBin(dir, ['deploy']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /^error: unknown command "deploy"/);
  });
});
