import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseBaseline } from '../../src/core/baseline.js';
import { rebaseline, tightenBaseline } from '../../src/core/tighten.js';
import { CLEAN, measured, v1, v2 } from '../helpers.js';

describe('tightenBaseline', () => {
  test('fixa as melhorias nas duas direccoes', () => {
    const current = measured({ ...CLEAN, lint_violations_total: 400, coverage_line_pct: 9 });

    const { tightened } = tightenBaseline(v1(), current);

    assert.deepEqual(tightened, ['lint_violations_total', 'coverage_line_pct']);
  });

  test('o novo baseline guarda os valores medidos', () => {
    const current = measured({ ...CLEAN, coverage_line_pct: 9 });

    const { baseline } = tightenBaseline(v1(), current);

    assert.equal(baseline.metrics.find((r) => r.name === 'coverage_line_pct')?.value, 9);
  });

  test('nunca afrouxa com regressoes', () => {
    const { tightened } = tightenBaseline(v1(), measured({ ...CLEAN, coverage_line_pct: 6 }));

    assert.deepEqual(tightened, []);
  });

  test('melhorias dentro da tolerancia nao apertam, para nao perseguir ruido', () => {
    const baseline = v2({ c: { value: 7, direction: 'up', tolerance: 0.5 } });

    assert.deepEqual(tightenBaseline(baseline, measured({ c: 7.3 })).tightened, []);
  });

  test('preenche valores vazios', () => {
    const empty = parseBaseline(
      { metrics: { c: { value: null, direction: 'up' } } },
      { allowEmptyValues: true },
    );

    assert.equal(tightenBaseline(empty, measured({ c: 5 })).baseline.metrics[0].value, 5);
  });

  test('actualiza a data so quando algo muda', () => {
    const { baseline } = tightenBaseline(v1(), measured(CLEAN), { frozenAt: '2026-09-27' });

    assert.equal(baseline.frozenAt, '2026-05-04');
  });

  test('actualiza a data quando aperta', () => {
    const current = measured({ ...CLEAN, coverage_line_pct: 9 });

    const { baseline } = tightenBaseline(v1(), current, { frozenAt: '2026-09-27' });

    assert.equal(baseline.frozenAt, '2026-09-27');
  });

  test('ignora medicoes com erro', () => {
    const current = { c: { error: { code: 'report_not_found', params: {} }, origin: 'source' } };
    const baseline = v2({ c: { value: 7, direction: 'up' } });

    assert.deepEqual(tightenBaseline(baseline, /** @type {any} */ (current)).tightened, []);
  });
});

describe('rebaseline', () => {
  test('aceita descidas quando autorizadas', () => {
    const { baseline } = rebaseline(v1(), measured({ ...CLEAN, coverage_line_pct: 5 }));

    assert.equal(baseline.metrics.find((r) => r.name === 'coverage_line_pct')?.value, 5);
  });

  test('lista as metricas sem medicao', () => {
    const { duplication_pct: _, ...rest } = CLEAN;

    assert.deepEqual(rebaseline(v1(), measured(rest)).missing, ['duplication_pct']);
  });

  test('lista apenas as metricas que mudaram', () => {
    const { changed } = rebaseline(v1(), measured({ ...CLEAN, duplication_pct: 3 }));

    assert.deepEqual(changed, ['duplication_pct']);
  });
});
