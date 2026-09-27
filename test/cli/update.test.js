// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createTranslator } from '../../src/core/messages.js';
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

/** Mensagens em inglês, para não repetir nos testes o texto do catálogo. */
const EN = createTranslator('en');

/** Mensagens em português. */
const PT = createTranslator('pt');

/**
 * Aviso das regressões que o update não baixou, tal como sai no stderr.
 * @param {string} names
 * @returns {string}
 */
function notLowered(names) {
  return `warning: ${EN('cli_update_not_lowered', { names })}`;
}

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

  describe('com melhorias', () => {
    beforeEach(async () => {
      await setup(BASELINE, { coverage: 75, lint: 8 });
    });

    test('aperta as melhorias no proprio baseline', async () => {
      await runIn(dir, ['update']);

      assert.deepEqual((await readJson(dir, 'quality-baseline.json')).metrics, {
        coverage: { value: 75, direction: 'up', tolerance: 0.5 },
        lint: { value: 8, direction: 'down' },
      });
    });

    test('grava a data de hoje em frozen_at', async () => {
      await runIn(dir, ['update']);

      assert.equal((await readJson(dir, 'quality-baseline.json')).frozen_at, TODAY);
    });

    test('sai com 0', async () => {
      assert.equal((await runIn(dir, ['update'])).code, 0);
    });
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

  describe('regressoes sem --allow-lower', () => {
    beforeEach(async () => {
      await setup(BASELINE, { coverage: 60, lint: 12 });
    });

    test('mantem os valores das regressoes', async () => {
      await runIn(dir, ['update']);

      assert.deepEqual((await readJson(dir, 'quality-baseline.json')).metrics, BASELINE.metrics);
    });

    test('nao reescreve frozen_at', async () => {
      await runIn(dir, ['update']);

      assert.equal((await readJson(dir, 'quality-baseline.json')).frozen_at, '2026-05-04');
    });

    test('sai com 0', async () => {
      assert.equal((await runIn(dir, ['update'])).code, 0);
    });

    test('diz que nao ha nada a apertar', async () => {
      const result = await runIn(dir, ['update']);

      assert.equal(result.stdout, EN('cli_nothing_to_update'));
    });

    test('avisa das regressoes que o baseline nao baixou, com os valores', async () => {
      const result = await runIn(dir, ['update']);

      assert.equal(result.stderr, notLowered('coverage (70 -> 60), lint (10 -> 12)'));
    });

    test('o check seguinte continua a falhar, como o aviso diz', async () => {
      await runIn(dir, ['update']);

      assert.equal((await runIn(dir, ['check'])).code, 1);
    });
  });

  describe('melhoria e regressao juntas', () => {
    beforeEach(async () => {
      await setup(BASELINE, { coverage: 75, lint: 25 });
    });

    test('aperta so a melhoria', async () => {
      await runIn(dir, ['update']);

      const { metrics } = await readJson(dir, 'quality-baseline.json');
      assert.deepEqual([metrics.coverage.value, metrics.lint.value], [75, 10]);
    });

    test('descreve a melhoria no stdout', async () => {
      const result = await runIn(dir, ['update']);

      assert.equal(result.stdout, '- coverage: 70 -> 75\nWrote quality-baseline.json.');
    });

    test('avisa so da regressao', async () => {
      const result = await runIn(dir, ['update']);

      assert.equal(result.stderr, notLowered('lint (10 -> 25)'));
    });
  });

  describe('melhoria dentro da tolerancia', () => {
    beforeEach(async () => {
      await setup(BASELINE, { coverage: 70.3, lint: 10 });
    });

    test('nao muda o baseline', async () => {
      const before = await readText(dir, 'quality-baseline.json');

      await runIn(dir, ['update']);

      assert.equal(await readText(dir, 'quality-baseline.json'), before);
    });

    test('diz que nao ha nada a apertar', async () => {
      assert.equal((await runIn(dir, ['update'])).stdout, EN('cli_nothing_to_update'));
    });

    test('nao gera avisos', async () => {
      assert.equal((await runIn(dir, ['update'])).stderr, '');
    });
  });

  test('regressao dentro da tolerancia nao gera aviso', async () => {
    await setup(BASELINE, { coverage: 69.8, lint: 10 });

    assert.equal((await runIn(dir, ['update'])).stderr, '');
  });

  describe('--allow-lower', () => {
    test('recongela tambem as regressoes', async () => {
      await setup(BASELINE, { coverage: 60, lint: 12 });

      await runIn(dir, ['update', '--allow-lower']);

      const { metrics } = await readJson(dir, 'quality-baseline.json');
      assert.deepEqual([metrics.coverage.value, metrics.lint.value], [60, 12]);
    });

    test('grava a data de hoje em frozen_at', async () => {
      await setup(BASELINE, { coverage: 60, lint: 12 });

      await runIn(dir, ['update', '--allow-lower']);

      assert.equal((await readJson(dir, 'quality-baseline.json')).frozen_at, TODAY);
    });

    test('nao avisa das regressoes, porque as baixa', async () => {
      await setup(BASELINE, { coverage: 60, lint: 12 });

      assert.equal((await runIn(dir, ['update', '--allow-lower'])).stderr, '');
    });

    test('sem alteracoes diz que o baseline ja corresponde as medicoes', async () => {
      await setup(BASELINE, { coverage: 70, lint: 10 });

      const result = await runIn(dir, ['update', '--allow-lower']);

      assert.equal(result.stdout, EN('cli_nothing_to_rebaseline'));
    });
  });

  describe('--output', () => {
    /** @type {string} */
    let before;
    /** @type {import('./helpers.js').CliRun} */
    let result;

    beforeEach(async () => {
      await setup(BASELINE, { coverage: 75, lint: 10 });
      before = await readText(dir, 'quality-baseline.json');
      result = await runIn(dir, ['update', '--output', 'next/baseline.json']);
    });

    test('escreve o baseline actualizado no ficheiro indicado', async () => {
      assert.equal((await readJson(dir, 'next/baseline.json')).metrics.coverage.value, 75);
    });

    test('nao altera o baseline original', async () => {
      assert.equal(await readText(dir, 'quality-baseline.json'), before);
    });

    test('indica no stdout o ficheiro escrito', () => {
      assert.match(result.stdout, /Wrote next\/baseline\.json\.$/);
    });
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

  describe('metrica sem medicao', () => {
    beforeEach(async () => {
      await setup(BASELINE, { coverage: 75 });
    });

    test('gera aviso no stderr', async () => {
      const result = await runIn(dir, ['update']);

      assert.equal(result.stderr, 'warning: No measurement for: lint. Their values were kept.');
    });

    test('mantem o valor no baseline', async () => {
      await runIn(dir, ['update']);

      assert.equal((await readJson(dir, 'quality-baseline.json')).metrics.lint.value, 10);
    });
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

  describe('baseline v1', () => {
    beforeEach(async () => {
      await setup(BASELINE_V1, { coverage: 72, lint: 10 });
      await runIn(dir, ['update']);
    });

    test('mantem as metricas no formato v1', async () => {
      const { metrics } = await readJson(dir, 'quality-baseline.json');

      assert.deepEqual(metrics, { coverage: 72, lint: 10, legacy: 3 });
    });

    test('mantem as regras monotonic_*', async () => {
      const { rules } = await readJson(dir, 'quality-baseline.json');

      assert.deepEqual(rules, { monotonic_down: ['lint'], monotonic_up: ['coverage'] });
    });
  });

  test('avisos do baseline aparecem no stderr', async () => {
    await setup({ ...BASELINE, notes: 'x' }, { coverage: 70, lint: 10 });

    const result = await runIn(dir, ['update']);

    assert.match(result.stderr, /^warning: unknown field "notes" at the root of the baseline$/m);
  });

  test('--language pt traduz as mensagens', async () => {
    await setup(BASELINE, { coverage: 70, lint: 10 });

    const result = await runIn(dir, ['update', '--language', 'pt']);

    assert.equal(result.stdout, PT('cli_nothing_to_update'));
  });

  describe('ficheiro de metricas em falta', () => {
    beforeEach(async () => {
      await writeFiles(dir, { 'quality-baseline.json': BASELINE });
    });

    test('sai com 2', async () => {
      assert.equal((await runIn(dir, ['update'])).code, 2);
    });

    test('explica o erro no stderr', async () => {
      const result = await runIn(dir, ['update']);

      assert.match(result.stderr, /^error: the metrics file metrics-current\.json does not exist/);
    });
  });

  for (const option of ['--output', '--baseline', '--metrics']) {
    describe(`${option} vazio`, () => {
      beforeEach(async () => {
        await setup(BASELINE, { coverage: 75, lint: 10 });
      });

      test('sai com 2', async () => {
        assert.equal((await runIn(dir, ['update', `${option}=`])).code, 2);
      });

      test('diz que o valor e obrigatorio', async () => {
        const result = await runIn(dir, ['update', `${option}=`]);

        assert.equal(result.stderr, `error: "${option}" is required`);
      });

      test('nao altera o baseline', async () => {
        const before = await readText(dir, 'quality-baseline.json');

        await runIn(dir, ['update', `${option}=`]);

        assert.equal(await readText(dir, 'quality-baseline.json'), before);
      });
    });
  }

  test('--output so com espacos nao cria um ficheiro com esse nome', async () => {
    await setup(BASELINE, { coverage: 75, lint: 10 });

    await runIn(dir, ['update', '--output', '  ']);

    await assert.rejects(readText(dir, '  '), { code: 'ENOENT' });
  });
});
