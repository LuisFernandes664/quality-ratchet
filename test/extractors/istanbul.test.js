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
    test(`calcula total.${field}.covered / total.${field}.total`, () => {
      assert.equal(run(REPORT, String(field)), expected);
    });
  }

  test('devolve covered/total exacto e não o pct truncado pelo istanbul (c8)', () => {
    const text = withTotal('lines', { total: 9, covered: 6, skipped: 0, pct: 66.66 });
    assert.equal(run(text), 200 / 3);
  });

  test('detecta a perda de uma linha coberta que o pct truncado esconde', () => {
    const before = withTotal('lines', { total: 20001, covered: 19998, skipped: 0, pct: 99.98 });
    const after = withTotal('lines', { total: 20001, covered: 19997, skipped: 0, pct: 99.98 });
    assert.deepEqual([run(before), run(after)], [(19998 * 100) / 20001, (19997 * 100) / 20001]);
  });

  test('sem covered nem total usa o pct', () => {
    assert.equal(run(withTotal('lines', { pct: 81.25 })), 81.25);
  });

  test('covered que não é contagem faz usar o pct', () => {
    assert.equal(run(withTotal('lines', { total: 9, covered: '6', pct: 66.66 })), 66.66);
  });

  test('covered maior do que total dá extractor_report_unparseable', () => {
    assert.throws(() => run(withTotal('lines', { total: 10, covered: 11, pct: 100 })), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_hit_exceeds_total', params: { hit: 11, total: 10 } },
      },
    });
  });

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
      params: {
        format: FORMAT,
        reason: { code: 'reason_key_missing', params: { path: 'total.lines' } },
      },
    });
  });

  test('sem contagens, pct que não é número dá extractor_report_unparseable', () => {
    assert.throws(() => run(withTotal('lines', { skipped: 0, pct: '50' })), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_not_number', params: { path: 'total.lines.pct' } },
      },
    });
  });

  test('sem contagens, pct não finito dá extractor_report_unparseable', () => {
    const text = '{"total":{"lines":{"skipped":0,"pct":1e999}}}';
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
