// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { SCHEMA_URL } from '../../src/cli/defaults.js';
import { TODAY, makeTempDir, readJson, readText, removeDir, runIn, writeFiles } from './helpers.js';

describe('init', () => {
  /** @type {string} */
  let dir;

  beforeEach(async () => {
    dir = await makeTempDir();
    await writeFiles(dir, { 'm.json': { coverage: 71.5, lint: 12, duplication: '2.5' } });
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  test('gera um baseline v2 com $schema, version e frozen_at de hoje', async () => {
    const result = await runIn(dir, ['init', '--metrics', 'm.json', '--up', 'coverage']);
    const written = await readJson(dir, 'quality-baseline.json');

    assert.equal(result.code, 0);
    assert.deepEqual(written, {
      $schema: SCHEMA_URL,
      version: 2,
      frozen_at: TODAY,
      metrics: { coverage: { value: 71.5, direction: 'up' } },
    });
  });

  test('--up e --down definem a direccao, com as de --up primeiro', async () => {
    await runIn(dir, ['init', '--metrics', 'm.json', '--down', 'lint', '--up', 'coverage']);
    const { metrics } = await readJson(dir, 'quality-baseline.json');

    assert.deepEqual(Object.entries(metrics), [
      ['coverage', { value: 71.5, direction: 'up' }],
      ['lint', { value: 12, direction: 'down' }],
    ]);
  });

  test('--up aceita listas separadas por virgulas e repeticoes da opcao', async () => {
    const argv = ['init', '--metrics', 'm.json', '--up', 'coverage, lint', '--up', 'duplication'];

    await runIn(dir, argv);
    const { metrics } = await readJson(dir, 'quality-baseline.json');

    assert.deepEqual(Object.keys(metrics), ['coverage', 'lint', 'duplication']);
  });

  test('valores numericos em texto sao convertidos em numeros', async () => {
    await runIn(dir, ['init', '--metrics', 'm.json', '--down', 'duplication']);

    const { metrics } = await readJson(dir, 'quality-baseline.json');

    assert.equal(metrics.duplication.value, 2.5);
  });

  test('confirma o ficheiro escrito no stdout', async () => {
    const result = await runIn(dir, ['init', '--metrics', 'm.json', '--up', 'coverage']);

    assert.equal(result.stdout, 'Wrote quality-baseline.json.');
  });

  test('--language pt traduz as mensagens', async () => {
    const argv = ['init', '--metrics', 'm.json', '--up', 'coverage', '--language', 'pt'];

    const result = await runIn(dir, argv);

    assert.equal(result.stdout, 'Escrito quality-baseline.json.');
  });

  test('metricas do ficheiro nao escolhidas geram aviso', async () => {
    const result = await runIn(dir, ['init', '--metrics', 'm.json', '--up', 'coverage']);

    assert.equal(result.stderr,
      'warning: Metrics in the file without a direction were ignored: lint, duplication.');
  });

  test('--output escolhe o ficheiro a escrever', async () => {
    await runIn(dir, ['init', '--metrics', 'm.json', '--up', 'coverage', '--output', 'q/b.json']);

    assert.equal((await readJson(dir, 'q/b.json')).version, 2);
  });

  test('sem --metrics sai com 2', async () => {
    const result = await runIn(dir, ['init', '--up', 'coverage']);

    assert.equal(result.code, 2);
    assert.equal(result.stderr, 'error: "--metrics" is required');
  });

  test('sem metricas escolhidas sai com 2', async () => {
    const result = await runIn(dir, ['init', '--metrics', 'm.json']);

    assert.equal(result.code, 2);
    assert.equal(result.stderr, 'error: no metrics selected; use --up and/or --down');
  });

  test('metrica escolhida ausente do ficheiro sai com 2', async () => {
    const result = await runIn(dir, ['init', '--metrics', 'm.json', '--up', 'coverage,branches']);

    assert.equal(result.code, 2);
    assert.equal(result.stderr, 'error: metric "branches" is not in the metrics file');
  });

  test('a mesma metrica em --up e --down sai com 2', async () => {
    const argv = ['init', '--metrics', 'm.json', '--up', 'lint', '--down', 'lint'];

    const result = await runIn(dir, argv);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /^error: .*lint/);
    await assert.rejects(readText(dir, 'quality-baseline.json'), { code: 'ENOENT' });
  });

  test('valor nao numerico sai com 2', async () => {
    await writeFiles(dir, { 'bad.json': { coverage: 'n/a' } });

    const result = await runIn(dir, ['init', '--metrics', 'bad.json', '--up', 'coverage']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /coverage.*is not a number/);
  });

  test('ficheiro de metricas inexistente sai com 2', async () => {
    const result = await runIn(dir, ['init', '--metrics', 'none.json', '--up', 'coverage']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /^error: could not read none\.json/);
  });

  test('ficheiro de saida existente sem --force sai com 2 e fica intacto', async () => {
    await writeFiles(dir, { 'quality-baseline.json': '{"keep": true}' });

    const result = await runIn(dir, ['init', '--metrics', 'm.json', '--up', 'coverage']);

    assert.equal(result.code, 2);
    assert.equal(result.stderr,
      'error: quality-baseline.json already exists; use --force to overwrite it');
    assert.equal(await readText(dir, 'quality-baseline.json'), '{"keep": true}');
  });

  test('--force substitui o ficheiro existente', async () => {
    await writeFiles(dir, { 'quality-baseline.json': '{"keep": true}' });

    const result = await runIn(dir, ['init', '--metrics', 'm.json', '--up', 'coverage', '--force']);

    assert.equal(result.code, 0);
    assert.equal((await readJson(dir, 'quality-baseline.json')).version, 2);
  });

  test('o baseline gerado passa o check com as mesmas metricas', async () => {
    await writeFiles(dir, { 'metrics-current.json': { coverage: 71.5, lint: 12 } });
    await runIn(dir, ['init', '--metrics', 'metrics-current.json', '--up', 'coverage',
      '--down', 'lint']);

    const result = await runIn(dir, ['check']);

    assert.equal(result.code, 0);
  });
});
