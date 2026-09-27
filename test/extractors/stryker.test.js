// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extract } from '../../src/extractors/index.js';
import { strykerExtractor } from '../../src/extractors/stryker.js';

const FORMAT = 'stryker';
const UNPARSEABLE = { name: 'ExtractorError', code: 'extractor_report_unparseable' };
const EMPTY = {
  name: 'ExtractorError',
  code: 'extractor_report_empty',
  params: { format: FORMAT },
};

/**
 * Mutante no formato do mutation-testing-report-schema.
 * @param {number} line
 * @param {string} status
 * @returns {Record<string, unknown>}
 */
function mutant(line, status) {
  return {
    id: String(line),
    mutatorName: 'ArithmeticOperator',
    replacement: 'a - b',
    location: { start: { line, column: 10 }, end: { line, column: 15 } },
    status,
    statusReason: status === 'Killed' ? 'expected 3 to equal 5' : undefined,
    coveredBy: status === 'NoCoverage' ? [] : ['0'],
    killedBy: status === 'Killed' ? ['0'] : [],
    testsCompleted: 1,
    static: false,
  };
}

/**
 * `mutation.json` do StrykerJS com os estados indicados, um mutante por linha.
 * @param {Record<string, string[]>} files estados dos mutantes de cada ficheiro
 * @returns {string}
 */
function report(files) {
  return JSON.stringify({
    schemaVersion: '1',
    thresholds: { high: 80, low: 60, break: null },
    projectRoot: '/home/runner/work/app/app',
    files: Object.fromEntries(Object.entries(files).map(([path, statuses]) => [path, {
      language: 'javascript',
      source: 'export const add = (a, b) => a + b;\n',
      mutants: statuses.map((status, index) => mutant(index + 1, status)),
    }])),
    testFiles: { 'test/math.test.js': { tests: [{ id: '0', name: 'add soma' }] } },
    framework: { name: 'StrykerJS', version: '8.2.6' },
  });
}

/**
 * Totais: Killed 5, Timeout 1, Survived 2, NoCoverage 2, e um mutante de cada estado que não
 * entra nas pontuações.
 */
const REPORT = report({
  'src/math.js': [
    'Killed', 'Killed', 'Killed', 'Survived', 'NoCoverage', 'Timeout', 'CompileError',
  ],
  'src/format.js': [
    'Killed', 'Killed', 'Survived', 'NoCoverage', 'RuntimeError', 'Ignored', 'Pending',
  ],
});

/**
 * @param {string} text
 * @param {string} [field]
 * @returns {number}
 */
function run(text, field) {
  return extract({ format: FORMAT, path: 'reports/mutation/mutation.json', field }, text);
}

describe('stryker', () => {
  test('declara os campos do contrato com score por omissão', () => {
    assert.deepEqual([strykerExtractor.fields, strykerExtractor.defaultField], [
      ['score', 'score_covered', 'killed', 'survived', 'no_coverage', 'timeout'],
      'score',
    ]);
  });

  test('usa score como campo por omissão', () => {
    assert.equal(run(REPORT), 60);
  });

  test('score é (Killed+Timeout)/(Killed+Timeout+Survived+NoCoverage) x 100', () => {
    assert.equal(run(REPORT, 'score'), 60);
  });

  test('score_covered é (Killed+Timeout)/(Killed+Timeout+Survived) x 100', () => {
    assert.equal(run(REPORT, 'score_covered'), 75);
  });

  for (const [field, expected] of [
    ['killed', 5],
    ['survived', 2],
    ['no_coverage', 2],
    ['timeout', 1],
  ]) {
    test(`${field} devolve a contagem inteira de todos os ficheiros`, () => {
      assert.equal(run(REPORT, String(field)), expected);
    });
  }

  test('ignora CompileError, RuntimeError, Ignored e Pending na pontuação', () => {
    const text = report({ 'a.js': ['Killed', 'Survived', 'CompileError', 'RuntimeError'] });
    assert.equal(run(text), 50);
  });

  test('score sem mutantes pontuáveis dá extractor_report_empty', () => {
    assert.throws(() => run(report({ 'a.js': ['Ignored', 'CompileError'] })), EMPTY);
  });

  test('score_covered só com NoCoverage dá extractor_report_empty', () => {
    assert.throws(() => run(report({ 'a.js': ['NoCoverage'] }), 'score_covered'), EMPTY);
  });

  test('relatório sem mutantes dá extractor_report_empty também nas contagens', () => {
    assert.throws(() => run(report({ 'a.js': [] }), 'survived'), EMPTY);
  });

  test('relatório sem "files" dá extractor_report_unparseable', () => {
    assert.throws(() => run('{"schemaVersion":"1","thresholds":{"high":80,"low":60}}'), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: { code: 'reason_key_missing', params: { path: 'files' } } },
    });
  });

  test('ficheiro sem array de mutantes dá extractor_report_unparseable', () => {
    const text = JSON.stringify({ schemaVersion: '1', files: { 'a.js': { language: 'js' } } });
    assert.throws(() => run(text), UNPARSEABLE);
  });

  test('estado de mutante desconhecido dá extractor_report_unparseable', () => {
    assert.throws(() => run(report({ 'a.js': ['Killed', 'Exploded'] })), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: {
          code: 'reason_mutant_status_unknown',
          params: { status: 'Exploded', path: 'a.js' },
        },
      },
    });
  });

  test('JSON inválido dá extractor_report_unparseable', () => {
    assert.throws(() => run('{"schemaVersion":"1","files":{'), UNPARSEABLE);
  });

  test('campo desconhecido dá extractor_field_unknown', () => {
    assert.throws(() => run(REPORT, 'mutation_score'), {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: {
        format: FORMAT,
        field: 'mutation_score',
        known: 'score, score_covered, killed, survived, no_coverage, timeout',
      },
    });
  });
});
