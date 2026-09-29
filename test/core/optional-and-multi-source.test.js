// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseBaseline, serializeBaseline } from '../../src/core/baseline.js';
import { compareAll, evaluate, Status } from '../../src/core/compare.js';
import { BaselineError } from '../../src/core/errors.js';
import { diffBaselines, resolveContract, sourceKey } from '../../src/core/governance.js';
import { createTranslator } from '../../src/core/messages.js';
import { runRatchet } from '../../src/core/ratchet.js';
import { renderSummary } from '../../src/core/summary.js';
import { measured, v2 } from '../helpers.js';

const LCOV = { format: 'lcov', path: 'coverage/lcov.info' };
const TRX_A = { format: 'junit', path: 'a.xml', field: 'tests' };
const TRX_B = { format: 'junit', path: 'b.xml', field: 'tests' };

/** Métrica opcional: mutação do código alterado, só medida em alguns PRs. */
const OPTIONAL = v2({ mutation: { value: 80, direction: 'up', when_missing: 'skip' } });

/**
 * Códigos dos problemas de um BaselineError lançado por `fn`.
 * @param {() => unknown} fn
 * @returns {string[]}
 */
function issueCodes(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BaselineError);
    return /** @type {Array<{code: string}>} */ (error.params.issues).map((i) => i.code);
  }
  assert.fail('era esperado um BaselineError');
}

/**
 * Regra da métrica `mutation` com when_missing dado.
 * @param {string|undefined} whenMissing
 */
function mutationRule(whenMissing) {
  return v2({ mutation: { value: 80, direction: 'up', when_missing: whenMissing } }).metrics[0];
}

describe('when_missing no baseline', () => {
  test('le skip', () => {
    assert.equal(OPTIONAL.metrics[0].whenMissing, 'skip');
  });

  test('valor desconhecido e erro', () => {
    const raw = { metrics: { m: { value: 1, direction: 'up', when_missing: 'ignore' } } };

    assert.deepEqual(issueCodes(() => parseBaseline(raw)), ['when_missing_invalid']);
  });

  test('e reescrito tal como estava', () => {
    const metrics = /** @type {any} */ (serializeBaseline(OPTIONAL).metrics);

    assert.equal(metrics.mutation.when_missing, 'skip');
  });
});

describe('when_missing na comparacao', () => {
  test('skip sem medicao fica nao medida e nao falha', () => {
    const outcome = compareAll(OPTIONAL, {});

    assert.deepEqual([outcome.results[0].status, outcome.passed], [Status.SKIPPED, true]);
  });

  test('skip com relatorio inexistente fica nao medida', () => {
    const error = { code: 'report_not_found', params: { path: 'm.json' } };

    assert.equal(evaluate(mutationRule('skip'), { error, origin: 'source' }).status,
      Status.SKIPPED);
  });

  test('skip com relatorio ilegivel continua a falhar', () => {
    const error = { code: 'extractor_report_unparseable', params: { format: 'x', reason: 'y' } };

    assert.equal(evaluate(mutationRule('skip'), { error, origin: 'source' }).status,
      Status.MISSING);
  });

  test('skip com medicao e comparado normalmente', () => {
    assert.equal(compareAll(OPTIONAL, measured({ mutation: 70 })).results[0].status,
      Status.REGRESSED);
  });

  test('fail explicito sem medicao falha', () => {
    assert.equal(evaluate(mutationRule('fail'), undefined).status, Status.MISSING);
  });

  test('o sumario mostra a metrica como nao medida e o motivo', () => {
    const report = runRatchet({ head: OPTIONAL, base: null, measurements: {} });

    const markdown = renderSummary(report, createTranslator('en'), {});

    assert.match(markdown, /\| ⏭️ \| `mutation` \| 80 \| not measured \|/);
    assert.match(markdown, /`mutation`: not measured in this run \(when_missing: skip\)/);
  });

  test('uma metrica nao medida nao e apertada', () => {
    assert.deepEqual(runRatchet({ head: OPTIONAL, base: null, measurements: {} }).tightened, []);
  });
});

describe('when_missing na governacao', () => {
  test('passar de fail para skip afrouxa', () => {
    const base = v2({ mutation: { value: 80, direction: 'up' } });

    const [change] = diffBaselines(base, OPTIONAL);

    assert.deepEqual([change.kind, change.loosenedFields], ['loosened', ['when_missing']]);
  });

  test('passar de skip para fail aperta', () => {
    const head = v2({ mutation: { value: 80, direction: 'up', when_missing: 'fail' } });

    assert.equal(diffBaselines(OPTIONAL, head)[0].kind, 'tightened');
  });

  test('sem autorizacao o skip acrescentado pelo PR nao vale', () => {
    const base = v2({ mutation: { value: 80, direction: 'up' } });

    assert.equal(resolveContract(base, OPTIONAL, false).metrics[0].whenMissing, undefined);
  });

  test('sem autorizacao o skip mantido dos dois lados continua a valer', () => {
    assert.equal(resolveContract(OPTIONAL, OPTIONAL, false).metrics[0].whenMissing, 'skip');
  });
});

describe('varias sources numa metrica', () => {
  test('le uma lista de sources', () => {
    const baseline = v2({ tests: { value: 10, direction: 'up', source: [TRX_A, TRX_B] } });

    assert.deepEqual(baseline.metrics[0].source, [TRX_A, TRX_B]);
  });

  test('lista vazia e erro', () => {
    const raw = { metrics: { t: { value: 1, direction: 'up', source: [] } } };

    assert.deepEqual(issueCodes(() => parseBaseline(raw)), ['source_invalid']);
  });

  test('um elemento invalido na lista e erro', () => {
    const raw = { metrics: { t: { value: 1, direction: 'up', source: [TRX_A, { path: 'x' }] } } };

    assert.deepEqual(issueCodes(() => parseBaseline(raw)), ['source_invalid']);
  });

  test('chave desconhecida num elemento indica a posicao', () => {
    const source = [TRX_A, { ...TRX_B, feild: 'tests' }];

    assert.deepEqual(v2({ t: { value: 1, direction: 'up', source } }).warnings, [
      { code: 'unknown_field', params: { name: 't', field: 'source[1].feild' } },
    ]);
  });

  test('a lista e reescrita como lista', () => {
    const baseline = v2({ tests: { value: 10, direction: 'up', source: [TRX_A, TRX_B] } });

    const metrics = /** @type {any} */ (serializeBaseline(baseline).metrics);

    assert.deepEqual(metrics.tests.source, [TRX_A, TRX_B]);
  });

  test('uma lista de um elemento tem a mesma identidade que o objecto', () => {
    const list = v2({ c: { value: 1, direction: 'up', source: [LCOV] } }).metrics[0];
    const single = v2({ c: { value: 1, direction: 'up', source: LCOV } }).metrics[0];

    assert.equal(sourceKey(list), sourceKey(single));
  });

  test('a ordem das sources nao conta', () => {
    const ab = v2({ t: { value: 1, direction: 'up', source: [TRX_A, TRX_B] } }).metrics[0];
    const ba = v2({ t: { value: 1, direction: 'up', source: [TRX_B, TRX_A] } }).metrics[0];

    assert.equal(sourceKey(ab), sourceKey(ba));
  });

  test('retirar uma source da lista afrouxa', () => {
    const base = v2({ t: { value: 1, direction: 'up', source: [TRX_A, TRX_B] } });
    const head = v2({ t: { value: 1, direction: 'up', source: [TRX_A] } });

    assert.deepEqual(diffBaselines(base, head)[0].loosenedFields, ['source']);
  });
});
