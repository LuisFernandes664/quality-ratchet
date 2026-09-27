// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extract } from '../../src/extractors/index.js';
import { istanbulExtractor } from '../../src/extractors/istanbul.js';

const FORMAT = 'istanbul';
const UNPARSEABLE = { name: 'ExtractorError', code: 'extractor_report_unparseable' };
const EMPTY = {
  name: 'ExtractorError',
  code: 'extractor_report_empty',
  params: { format: FORMAT },
};

/** `coverage-summary.json` do reporter `json-summary`: o total e uma entrada por ficheiro. */
const SUMMARY = {
  total: {
    lines: { total: 320, covered: 260, skipped: 0, pct: 81.25 },
    statements: { total: 345, covered: 276, skipped: 0, pct: 80 },
    functions: { total: 48, covered: 42, skipped: 0, pct: 87.5 },
    branches: { total: 96, covered: 60, skipped: 0, pct: 62.5 },
    branchesTrue: { total: 0, covered: 0, skipped: 0, pct: 100 },
  },
  '/home/runner/work/app/app/src/math.js': {
    lines: { total: 20, covered: 10, skipped: 0, pct: 50 },
    functions: { total: 4, covered: 2, skipped: 0, pct: 50 },
    statements: { total: 22, covered: 11, skipped: 0, pct: 50 },
    branches: { total: 8, covered: 2, skipped: 0, pct: 25 },
  },
};
const REPORT = JSON.stringify(SUMMARY);

/** Resumo escrito pelo nyc quando nenhum ficheiro foi instrumentado. */
const UNKNOWN = JSON.stringify({
  total: Object.fromEntries(
    ['lines', 'statements', 'functions', 'branches', 'branchesTrue'].map((key) => [
      key,
      { total: 0, covered: 0, skipped: 0, pct: 'Unknown' },
    ]),
  ),
});

/**
 * @param {string} text
 * @param {string} [field]
 * @returns {number}
 */
function run(text, field) {
  return extract({ format: FORMAT, path: 'coverage/coverage-summary.json', field }, text);
}

/**
 * Relatório igual ao de referência com outros contadores no total de um campo.
 * @param {string} field
 * @param {Record<string, unknown>} counters
 * @returns {string}
 */
function withTotal(field, counters) {
  return JSON.stringify({ ...SUMMARY, total: { ...SUMMARY.total, [field]: counters } });
}

describe('istanbul', () => {
  test('declara os campos do contrato com lines por omissão', () => {
    assert.deepEqual([istanbulExtractor.fields, istanbulExtractor.defaultField], [
      ['lines', 'statements', 'functions', 'branches'],
      'lines',
    ]);
  });

  test('usa lines como campo por omissão', () => {
    assert.equal(run(REPORT), 81.25);
  });

  for (const [field, expected] of [
    ['lines', 81.25],
    ['statements', 80],
    ['functions', 87.5],
    ['branches', 62.5],
  ]) {
    test(`lê total.${field}.pct`, () => {
      assert.equal(run(REPORT, String(field)), expected);
    });
  }

  test('pct "Unknown" dá extractor_report_empty', () => {
    assert.throws(() => run(UNKNOWN), EMPTY);
  });

  test('total 0 dá extractor_report_empty mesmo com pct 100', () => {
    const text = withTotal('branches', { total: 0, covered: 0, skipped: 0, pct: 100 });
    assert.throws(() => run(text, 'branches'), EMPTY);
  });

  test('relatório sem "total" dá extractor_report_unparseable', () => {
    const { total: _total, ...files } = SUMMARY;
    assert.throws(() => run(JSON.stringify(files)), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: 'missing "total.lines"' },
    });
  });

  test('pct que não é número dá extractor_report_unparseable', () => {
    const text = withTotal('lines', { total: 10, covered: 5, skipped: 0, pct: '50' });
    assert.throws(() => run(text), UNPARSEABLE);
  });

  test('pct não finito dá extractor_report_unparseable', () => {
    const text = '{"total":{"lines":{"total":10,"covered":5,"skipped":0,"pct":1e999}}}';
    assert.throws(() => run(text), UNPARSEABLE);
  });

  test('JSON inválido dá extractor_report_unparseable', () => {
    assert.throws(() => run('{"total": {"lines": '), UNPARSEABLE);
  });

  test('documento que não é objecto dá extractor_report_unparseable', () => {
    assert.throws(() => run('[81.25]'), UNPARSEABLE);
  });

  test('campo desconhecido dá extractor_field_unknown, mesmo existindo no relatório', () => {
    assert.throws(() => run(REPORT, 'branchesTrue'), {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: {
        format: FORMAT,
        field: 'branchesTrue',
        known: 'lines, statements, functions, branches',
      },
    });
  });
});
