// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extract } from '../../src/extractors/index.js';
import { jscpdExtractor } from '../../src/extractors/jscpd.js';

const FORMAT = 'jscpd';
const UNPARSEABLE = { name: 'ExtractorError', code: 'extractor_report_unparseable' };
const EMPTY = {
  name: 'ExtractorError',
  code: 'extractor_report_empty',
  params: { format: FORMAT },
};

/**
 * Estatísticas no formato do jscpd.
 * @param {Record<string, number|null>} overrides
 * @returns {Record<string, number|null>}
 */
function statistics(overrides) {
  return {
    lines: 1600,
    tokens: 12000,
    sources: 14,
    clones: 3,
    duplicatedLines: 40,
    duplicatedTokens: 310,
    percentage: 2.5,
    percentageTokens: 2.58,
    newDuplicatedLines: 0,
    newClones: 0,
    ...overrides,
  };
}

const LOCATION = { line: 10, column: 1, position: 84 };

/** Clone detectado entre dois ficheiros. */
const DUPLICATE = {
  format: 'javascript',
  lines: 12,
  fragment: 'const total = items.reduce((sum, item) => sum + item.price, 0);',
  tokens: 96,
  firstFile: { name: 'src/a.js', start: 10, end: 22, startLoc: LOCATION, endLoc: LOCATION },
  secondFile: { name: 'src/b.js', start: 30, end: 42, startLoc: LOCATION, endLoc: LOCATION },
};

/**
 * `jscpd-report.json` com os totais indicados.
 * @param {Record<string, number|null>} [overrides]
 * @returns {string}
 */
function report(overrides = {}) {
  const sources = { 'src/a.js': statistics({ lines: 120, sources: 1, clones: 1 }) };
  return JSON.stringify({
    statistics: {
      detectionDate: '2024-05-02T10:21:33.123Z',
      formats: { javascript: { sources, total: statistics({}) } },
      total: statistics(overrides),
    },
    duplicates: [DUPLICATE],
  });
}

const REPORT = report();

/**
 * @param {string} text
 * @param {string} [field]
 * @returns {number}
 */
function run(text, field) {
  return extract({ format: FORMAT, path: 'report/jscpd-report.json', field }, text);
}

describe('jscpd', () => {
  test('declara os campos do contrato com percentage por omissão', () => {
    assert.deepEqual([jscpdExtractor.fields, jscpdExtractor.defaultField], [
      ['percentage', 'clones', 'duplicated_lines'],
      'percentage',
    ]);
  });

  test('usa percentage como campo por omissão', () => {
    assert.equal(run(REPORT), 2.5);
  });

  test('percentage lê statistics.total.percentage', () => {
    assert.equal(run(REPORT, 'percentage'), 2.5);
  });

  test('clones lê statistics.total.clones', () => {
    assert.equal(run(REPORT, 'clones'), 3);
  });

  test('duplicated_lines lê statistics.total.duplicatedLines', () => {
    assert.equal(run(REPORT, 'duplicated_lines'), 40);
  });

  test('relatório sem ficheiros analisados dá extractor_report_empty', () => {
    const text = report({ lines: 0, sources: 0, clones: 0, duplicatedLines: 0, percentage: null });
    assert.throws(() => run(text), EMPTY);
  });

  test('relatório sem statistics.total dá extractor_report_unparseable', () => {
    assert.throws(() => run('{"statistics":{"formats":{}},"duplicates":[]}'), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_key_missing', params: { path: 'statistics.total' } },
      },
    });
  });

  test('percentage null dá extractor_report_unparseable', () => {
    assert.throws(() => run(report({ percentage: null })), UNPARSEABLE);
  });

  test('percentage não finita dá extractor_report_unparseable', () => {
    const text = '{"statistics":{"total":{"lines":10,"sources":1,"percentage":1e999}}}';
    assert.throws(() => run(text), UNPARSEABLE);
  });

  test('JSON inválido dá extractor_report_unparseable', () => {
    assert.throws(() => run('{"statistics":'), UNPARSEABLE);
  });

  test('campo desconhecido dá extractor_field_unknown', () => {
    assert.throws(() => run(REPORT, 'duplicatedLines'), {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: {
        format: FORMAT,
        field: 'duplicatedLines',
        known: 'percentage, clones, duplicated_lines',
      },
    });
  });
});
