// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extract } from '../../src/extractors/index.js';
import { lcovExtractor } from '../../src/extractors/lcov.js';

const FORMAT = 'lcov';
const UNPARSEABLE = { name: 'ExtractorError', code: 'extractor_report_unparseable' };
const EMPTY = {
  name: 'ExtractorError',
  code: 'extractor_report_empty',
  params: { format: FORMAT },
};

/**
 * Relatório com dois registos, na ordem em que o reporter `lcovonly` do Istanbul (nyc, c8,
 * Jest) os escreve. Totais: linhas 7/8, ramos 2/4, funções 3/4.
 */
const REPORT = [
  'TN:',
  'SF:/home/runner/work/app/app/src/math.js',
  'FN:1,add',
  'FN:5,divide',
  'FNF:2',
  'FNH:1',
  'FNDA:3,add',
  'FNDA:0,divide',
  'DA:1,3',
  'DA:2,3',
  'DA:5,1',
  'DA:6,1',
  'DA:7,0',
  'LF:5',
  'LH:4',
  'BRDA:6,0,0,1',
  'BRDA:6,0,1,0',
  'BRF:2',
  'BRH:1',
  'end_of_record',
  'TN:',
  'SF:/home/runner/work/app/app/src/format.js',
  'FN:1,pad',
  'FN:4,trim',
  'FNF:2',
  'FNH:2',
  'FNDA:2,pad',
  'FNDA:1,trim',
  'DA:1,2',
  'DA:2,2',
  'DA:4,1',
  'LF:3',
  'LH:3',
  'BRDA:2,0,0,2',
  'BRDA:2,0,1,-',
  'BRF:2',
  'BRH:1',
  'end_of_record',
  '',
].join('\n');

/** Registo sem ramos instrumentados, como o `geninfo --no-branch-coverage` produz. */
const NO_BRANCHES = [
  'TN:unit',
  'SF:src/app.c',
  'FNF:0',
  'FNH:0',
  'DA:3,1',
  'DA:4,1',
  'LF:2',
  'LH:2',
  'BRF:0',
  'BRH:0',
  'end_of_record',
].join('\n');

/**
 * @param {string} text
 * @param {string} [field]
 * @returns {number}
 */
function run(text, field) {
  return extract({ format: FORMAT, path: 'coverage/lcov.info', field }, text);
}

describe('lcov', () => {
  test('declara os campos do contrato com lines por omissão', () => {
    assert.deepEqual([lcovExtractor.fields, lcovExtractor.defaultField], [
      ['lines', 'branches', 'functions'],
      'lines',
    ]);
  });

  test('usa lines como campo por omissão', () => {
    assert.equal(run(REPORT), 87.5);
  });

  test('lines soma LH/LF de todos os registos', () => {
    assert.equal(run(REPORT, 'lines'), 87.5);
  });

  test('branches soma BRH/BRF de todos os registos', () => {
    assert.equal(run(REPORT, 'branches'), 50);
  });

  test('functions soma FNH/FNF de todos os registos', () => {
    assert.equal(run(REPORT, 'functions'), 75);
  });

  test('ignora as linhas de detalhe DA e BRDA', () => {
    const text = ['SF:src/a.js', 'DA:1,0', 'DA:2,0', 'LF:2', 'LH:2', 'end_of_record'].join('\n');
    assert.equal(run(text), 100);
  });

  test('aceita fins de linha CRLF', () => {
    assert.equal(run(REPORT.replaceAll('\n', '\r\n')), 87.5);
  });

  test('aceita a marca de ordem de bytes no início do ficheiro', () => {
    assert.equal(run(`\uFEFF${REPORT}`), 87.5);
  });

  test('não acumula erro de vírgula flutuante na percentagem', () => {
    assert.equal(run(['SF:src/a.js', 'LF:100', 'LH:57', 'end_of_record'].join('\n')), 57);
  });

  test('mais linhas atingidas do que encontradas dá extractor_report_unparseable', () => {
    assert.throws(() => run(REPORT.replace('LH:4', 'LH:6')), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: 'hit count 9 exceeds total 8' },
    });
  });

  test('denominador 0 dá extractor_report_empty', () => {
    assert.throws(() => run(NO_BRANCHES, 'branches'), EMPTY);
  });

  test('ficheiro vazio dá extractor_report_empty', () => {
    assert.throws(() => run(''), EMPTY);
  });

  test('ficheiro só com fins de linha dá extractor_report_empty', () => {
    assert.throws(() => run('\r\n\r\n'), EMPTY);
  });

  test('texto sem registos SF dá extractor_report_unparseable', () => {
    assert.throws(() => run('<html><body>Not Found</body></html>'), UNPARSEABLE);
  });

  test('contagem inválida numa linha de resumo dá extractor_report_unparseable', () => {
    assert.throws(() => run(REPORT.replace('LF:5', 'LF:cinco')), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: 'invalid "LF" value: "cinco"' },
    });
  });

  test('campo desconhecido dá extractor_field_unknown', () => {
    assert.throws(() => run(REPORT, 'statements'), {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: { format: FORMAT, field: 'statements', known: 'lines, branches, functions' },
    });
  });
});
