// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  BASELINE_V1,
  TODAY,
  baselineV2,
  makeTempDir,
  readJson,
  readText,
  removeDir,
  runIn,
  writeFiles,
} from './helpers.js';

/** Baseline v2 com uma métrica de cada direcção. */
const BASELINE = baselineV2({
  coverage: { value: 70, direction: 'up', tolerance: 0.5 },
  lint: { value: 10, direction: 'down' },
});

describe('update', () => {
  /** @type {string} */
  let dir;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  /**
   * Grava o baseline e as métricas com os nomes por omissão.
   * @param {unknown} baseline
   * @param {Record<string, unknown>} metrics
   * @returns {Promise<void>}
   */
  function setup(baseline, metrics) {
    return writeFiles(dir, { 'quality-baseline.json': baseline, 'metrics-current.json': metrics });
  }

  test('aperta as melhorias no proprio baseline e grava a data de hoje', async () => {
    await setup(BASELINE, { coverage: 75, lint: 8 });

    const result = await runIn(dir, ['update']);
    const written = await readJson(dir, 'quality-baseline.json');

    assert.equal(result.code, 0);
    assert.deepEqual(written.metrics, {
      coverage: { value: 75, direction: 'up', tolerance: 0.5 },
      lint: { value: 8, direction: 'down' },
    });
    assert.equal(written.frozen_at, TODAY);
  });

  test('descreve cada alteracao e o ficheiro escrito', async () => {
    await setup(BASELINE, { coverage: 75, lint: 10 });

    const result = await runIn(dir, ['update']);

    assert.equal(result.stdout, '- coverage: 70 -> 75\nWrote quality-baseline.json.');
  });

  test('escreve JSON indentado a dois espacos com fim de linha', async () => {
    await setup(BASELINE, { coverage: 75, lint: 10 });

    await runIn(dir, ['update']);
    const text = await readText(dir, 'quality-baseline.json');

    assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  });

  test('nao afrouxa regressoes sem --allow-lower', async () => {
    await setup(BASELINE, { coverage: 60, lint: 12 });

    const result = await runIn(dir, ['update']);

    assert.equal(result.code, 0);
    assert.equal(result.stdout,
      'Nothing to tighten: the baseline already matches the measurements.');
    assert.equal((await readJson(dir, 'quality-baseline.json')).frozen_at, '2026-05-04');
  });

  test('melhoria dentro da tolerancia nao muda o baseline', async () => {
    await setup(BASELINE, { coverage: 70.3, lint: 10 });

    const result = await runIn(dir, ['update']);

    assert.match(result.stdout, /^Nothing to tighten/);
  });

  test('--allow-lower recongela tambem as regressoes', async () => {
    await setup(BASELINE, { coverage: 60, lint: 12 });

    await runIn(dir, ['update', '--allow-lower']);
    const written = await readJson(dir, 'quality-baseline.json');

    assert.deepEqual([written.metrics.coverage.value, written.metrics.lint.value], [60, 12]);
    assert.equal(written.frozen_at, TODAY);
  });

  test('--output escreve noutro ficheiro e mantem o original', async () => {
    await setup(BASELINE, { coverage: 75, lint: 10 });
    const before = await readText(dir, 'quality-baseline.json');

    const result = await runIn(dir, ['update', '--output', 'next/baseline.json']);

    assert.equal((await readJson(dir, 'next/baseline.json')).metrics.coverage.value, 75);
    assert.equal(await readText(dir, 'quality-baseline.json'), before);
    assert.match(result.stdout, /Wrote next\/baseline\.json\.$/);
  });

  test('--baseline e --metrics escolhem os ficheiros', async () => {
    await writeFiles(dir, { 'b.json': BASELINE, 'm.json': { coverage: 80, lint: 10 } });

    await runIn(dir, ['update', '--baseline', 'b.json', '--metrics', 'm.json']);

    assert.equal((await readJson(dir, 'b.json')).metrics.coverage.value, 80);
  });

  test('preenche valores vazios', async () => {
    await setup(baselineV2({ coverage: { value: null, direction: 'up' } }), { coverage: 42 });

    await runIn(dir, ['update']);

    assert.equal((await readJson(dir, 'quality-baseline.json')).metrics.coverage.value, 42);
  });

  test('metrica sem medicao gera aviso e mantem o valor', async () => {
    await setup(BASELINE, { coverage: 75 });

    const result = await runIn(dir, ['update']);

    assert.equal(result.stderr, 'warning: No measurement for: lint. Their values were kept.');
    assert.equal((await readJson(dir, 'quality-baseline.json')).metrics.lint.value, 10);
  });

  test('relatorio de uma source em falta gera aviso com o motivo', async () => {
    const baseline = baselineV2({
      coverage: { value: 70, direction: 'up', source: { format: 'lcov', path: 'lcov.info' } },
    });
    await writeFiles(dir, { 'quality-baseline.json': baseline });

    const result = await runIn(dir, ['update']);

    assert.match(result.stderr, /^warning: coverage: report not found: lcov\.info$/m);
  });

  test('le as sources relativamente a pasta do baseline', async () => {
    const baseline = baselineV2({
      coverage: { value: 70, direction: 'up', source: { format: 'lcov', path: 'lcov.info' } },
    });
    await writeFiles(dir, {
      'pkg/quality-baseline.json': baseline,
      'pkg/lcov.info': 'SF:a.js\nLF:4\nLH:3\nend_of_record\n',
    });

    await runIn(dir, ['update', '--baseline', 'pkg/quality-baseline.json']);

    assert.equal((await readJson(dir, 'pkg/quality-baseline.json')).metrics.coverage.value, 75);
  });

  test('metricas medidas que o baseline nao segue geram aviso', async () => {
    await setup(BASELINE, { coverage: 70, lint: 10, extra: 1 });

    const result = await runIn(dir, ['update']);

    assert.match(result.stderr, /^warning: Measured but not tracked by the baseline: extra\.$/m);
  });

  test('baseline v1 mantem o formato v1', async () => {
    await setup(BASELINE_V1, { coverage: 72, lint: 10 });

    await runIn(dir, ['update']);
    const written = await readJson(dir, 'quality-baseline.json');

    assert.deepEqual(written.metrics, { coverage: 72, lint: 10, legacy: 3 });
    assert.deepEqual(written.rules, { monotonic_down: ['lint'], monotonic_up: ['coverage'] });
  });

  test('avisos do baseline aparecem no stderr', async () => {
    await setup({ ...BASELINE, notes: 'x' }, { coverage: 70, lint: 10 });

    const result = await runIn(dir, ['update']);

    assert.match(result.stderr, /^warning: unknown field "notes" at the root of the baseline$/m);
  });

  test('--language pt traduz as mensagens', async () => {
    await setup(BASELINE, { coverage: 70, lint: 10 });

    const result = await runIn(dir, ['update', '--language', 'pt']);

    assert.equal(result.stdout, 'Nada a apertar: o baseline já corresponde às medições.');
  });

  test('ficheiro de metricas em falta sai com 2', async () => {
    await writeFiles(dir, { 'quality-baseline.json': BASELINE });

    const result = await runIn(dir, ['update']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /^error: the metrics file metrics-current\.json does not exist/);
  });
});
