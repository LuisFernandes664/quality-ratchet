// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { compareAll, evaluate, Status } from '../../src/core/compare.js';
import { CLEAN, measured, v1, v2 } from '../helpers.js';

/**
 * Resultado de uma métrica pelo nome.
 * @param {import('../../src/core/types.js').Outcome} outcome
 * @param {string} name
 */
const find = (outcome, name) => outcome.results.find((r) => r.name === name);

describe('compareAll', () => {
  test('passa quando nenhuma metrica se mexe', () => {
    const outcome = compareAll(v1(), measured(CLEAN));

    assert.equal(outcome.passed, true);
  });

  test('falha quando uma metrica monotonic_down sobe', () => {
    const outcome = compareAll(v1(), measured({ ...CLEAN, lint_violations_total: 484 }));

    assert.deepEqual(outcome.failures.map((r) => [r.name, r.delta]), [
      ['lint_violations_total', 1],
    ]);
  });

  test('falha quando uma metrica monotonic_up desce, nem que seja 0.1 pp', () => {
    const outcome = compareAll(v1(), measured({ ...CLEAN, coverage_line_pct: 6.9 }));

    assert.equal(find(outcome, 'coverage_line_pct')?.status, Status.REGRESSED);
  });

  test('aceita melhorias nas duas direccoes', () => {
    const current = { ...CLEAN, lint_violations_total: 400, coverage_line_pct: 12.5 };

    const outcome = compareAll(v1(), measured(current));

    assert.deepEqual([outcome.passed, outcome.improvements.length], [true, 2]);
  });

  test('metrica em falta conta como falha, para nao haver verde mentiroso', () => {
    const { duplication_pct: _, ...withoutDuplication } = CLEAN;

    const outcome = compareAll(v1(), measured(withoutDuplication));

    assert.equal(find(outcome, 'duplication_pct')?.status, Status.MISSING);
  });

  test('ruido de virgula flutuante nao conta como regressao', () => {
    const outcome = compareAll(v1(), measured({ ...CLEAN, coverage_line_pct: 7.0 - 1e-12 }));

    assert.equal(find(outcome, 'coverage_line_pct')?.status, Status.UNCHANGED);
  });

  test('valor em string numerica e comparado como numero', () => {
    const outcome = compareAll(v1(), measured({ ...CLEAN, coverage_line_pct: '7.0' }));

    assert.equal(outcome.passed, true);
  });

  test('valor nao numerico e invalido e nao em falta', () => {
    const outcome = compareAll(v1(), measured({ ...CLEAN, coverage_line_pct: 'n/a' }));

    assert.equal(find(outcome, 'coverage_line_pct')?.status, Status.INVALID);
  });

  test('medicoes com chaves do prototipo nao contam como valores', () => {
    const baseline = v2({ constructor: { value: 1, direction: 'up' } });

    assert.equal(compareAll(baseline, {}).results[0].status, Status.MISSING);
  });

  test('modo estrito falha com melhorias por fixar', () => {
    const outcome = compareAll(v1(), measured({ ...CLEAN, coverage_line_pct: 8 }), {
      strict: true,
    });

    assert.deepEqual([outcome.passed, outcome.unlocked.map((r) => r.name)], [
      false,
      ['coverage_line_pct'],
    ]);
  });

  test('modo estrito ignora melhorias dentro da tolerancia', () => {
    const baseline = v2({ c: { value: 7, direction: 'up', tolerance: 0.5 } });

    const outcome = compareAll(baseline, measured({ c: 7.3 }), { strict: true });

    assert.equal(outcome.passed, true);
  });
});

describe('evaluate', () => {
  const rule = v2({ c: { value: 70, direction: 'up', tolerance: 0.5, min: 60, target: 90 } })
    .metrics[0];

  test('regressao dentro da tolerancia e tolerada e passa', () => {
    assert.equal(evaluate(rule, { value: 69.6, origin: 'file' }).status, Status.TOLERATED);
  });

  test('regressao acima da tolerancia falha', () => {
    assert.equal(evaluate(rule, { value: 69.4, origin: 'file' }).status, Status.REGRESSED);
  });

  test('valor abaixo do minimo absoluto falha mesmo que o delta seja pequeno', () => {
    const low = v2({ c: { value: 60, direction: 'up', tolerance: 5, min: 60 } }).metrics[0];

    assert.equal(evaluate(low, { value: 59, origin: 'file' }).status, Status.LIMIT);
  });

  test('valor acima do maximo absoluto falha', () => {
    const vulns = v2({ v: { value: 0, direction: 'down', max: 0 } }).metrics[0];

    assert.deepEqual(evaluate(vulns, { value: 1, origin: 'file' }).detail, {
      code: 'above_max',
      params: { name: 'v', value: 1, limit: 0 },
    });
  });

  test('limite violado prevalece sobre melhoria', () => {
    const vulns = v2({ v: { value: 5, direction: 'down', max: 0 } }).metrics[0];

    assert.equal(evaluate(vulns, { value: 3, origin: 'file' }).status, Status.LIMIT);
  });

  test('erro na medicao aparece como detalhe da metrica em falta', () => {
    const error = { code: 'report_not_found', params: { path: 'x' } };

    assert.deepEqual(evaluate(rule, { error, origin: 'source' }).detail, error);
  });

  test('o objectivo acompanha o resultado', () => {
    assert.equal(evaluate(rule, { value: 70, origin: 'file' }).target, 90);
  });

  test('string que transborda para infinito e invalida', () => {
    const result = evaluate(rule, { value: '1e400', origin: 'file' });

    assert.deepEqual([result.status, result.detail?.params], [
      Status.INVALID,
      { value: '"1e400"' },
    ]);
  });

  test('numero infinito aparece como Infinity no motivo', () => {
    const result = evaluate(rule, { value: Infinity, origin: 'file' });

    assert.deepEqual(result.detail?.params, { value: 'Infinity' });
  });

  test('regra sem valor fica em falta com o motivo', () => {
    const empty = { ...rule, value: null };

    assert.equal(evaluate(empty, { value: 70, origin: 'file' }).detail?.code, 'rule_without_value');
  });
});
