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

/** Funções de `src/prog.c` (linhas FN) e os nomes pela mesma ordem. */
const PROG_FUNCTIONS = ['FN:10,15,main', 'FN:2,6,f', 'FN:7,9,g'];
const PROG_FUNCTION_NAMES = ['main', 'f', 'g'];
/** Linha e bloco de cada ramo de `src/prog.c`, pela ordem das linhas BRDA. */
const PROG_BRANCH_LINES = [3, 3, 8, 8, 8, 8, 12, 12];
const PROG_BRANCH_BLOCKS = [0, 1, 0, 1, 2, 3, 0, 1];
/** Linhas instrumentadas de `src/prog.c`, pela ordem das linhas DA. */
const PROG_LINE_NUMBERS = [2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14];

/**
 * Registo de `src/prog.c` capturado pelo lcov 2.0 (`gcc --coverage`) com o nome de teste
 * indicado: FN, FNDA, BRDA, DA e resumos.
 * @param {string} testName
 * @param {{functions: number[], branches: string[], lines: number[], summary: string[]}} counts
 * @returns {string[]}
 */
function progRecord(testName, counts) {
  const { functions, branches, lines, summary } = counts;
  return [
    `TN:${testName}`,
    'SF:src/prog.c',
    ...PROG_FUNCTIONS,
    ...functions.map((hits, index) => `FNDA:${hits},${PROG_FUNCTION_NAMES[index]}`),
    ...summary.slice(0, 2),
    ...branches.map((taken, index) => (
      `BRDA:${PROG_BRANCH_LINES[index]},0,${PROG_BRANCH_BLOCKS[index]},${taken}`)),
    ...summary.slice(2, 4),
    ...lines.map((count, index) => `DA:${PROG_LINE_NUMBERS[index]},${count}`),
    ...summary.slice(4),
    'end_of_record',
  ];
}

/** Registo de `src/prog.c` do teste unitA (`./prog 1`). */
const UNIT_A = progRecord('unitA', {
  functions: [1, 1, 0],
  branches: ['1', '0', '-', '-', '-', '-', '1', '0'],
  lines: [1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 1],
  summary: ['FNF:3', 'FNH:2', 'BRF:8', 'BRH:2', 'LF:11', 'LH:7'],
});

/** Registo de `src/prog.c` do teste unitB (`./prog 2`). */
const UNIT_B = progRecord('unitB', {
  functions: [1, 0, 1],
  branches: ['-', '-', '1', '0', '1', '0', '0', '1'],
  lines: [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1],
  summary: ['FNF:3', 'FNH:2', 'BRF:8', 'BRH:3', 'LF:11', 'LH:7'],
});

/**
 * Tracefile de `lcov --capture --test-name unitA` e `--test-name unitB` juntos com
 * `lcov -a a.info -a b.info`: o mesmo ficheiro com um registo por teste. O
 * `lcov --summary` dá linhas 90.9% (10 de 11), funções 100% (3 de 3) e ramos 62.5% (5 de 8).
 */
const MULTI_TN = [...UNIT_A, ...UNIT_B, ''].join('\n');

/**
 * Registo mínimo com linhas DA e o resumo correspondente.
 * @param {string} source
 * @param {number[]} counts execuções de cada linha, a partir da linha 1
 * @returns {string[]}
 */
function linesRecord(source, counts) {
  return [
    'TN:',
    `SF:${source}`,
    ...counts.map((count, index) => `DA:${index + 1},${count}`),
    `LF:${counts.length}`,
    `LH:${counts.filter((count) => count > 0).length}`,
    'end_of_record',
  ];
}

/**
 * Registo do lcov 2.2 para as funções: `FNL` com as linhas e `FNA` por nome (alias). A
 * função g tem dois nomes, que contam como uma só função.
 * @param {string} testName
 * @param {[number, number, number]} counts execuções de f, g(int) e g(long)
 * @returns {string[]}
 */
function aliasRecord(testName, counts) {
  const hit = (counts[0] > 0 ? 1 : 0) + (counts[1] + counts[2] > 0 ? 1 : 0);
  return [
    `TN:${testName}`,
    'SF:src/g.cpp',
    'FNL:0,2,6',
    `FNA:0,${counts[0]},f`,
    'FNL:1,7,9',
    `FNA:1,${counts[1]},g(int)`,
    `FNA:1,${counts[2]},g(long)`,
    'FNF:2',
    `FNH:${hit}`,
    'end_of_record',
  ];
}

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

  test('um registo por ficheiro usa o resumo e não as linhas de detalhe DA', () => {
    const text = ['SF:src/a.js', 'DA:1,0', 'DA:2,0', 'LF:2', 'LH:2', 'end_of_record'].join('\n');
    assert.equal(run(text), 100);
  });

  test('lines junta os registos de cada TN do mesmo ficheiro pela união (lcov -a)', () => {
    assert.equal(run(MULTI_TN, 'lines'), 1000 / 11);
  });

  test('branches junta os registos de cada TN pela união, com "-" como não atingido', () => {
    assert.equal(run(MULTI_TN, 'branches'), 62.5);
  });

  test('functions junta os registos de cada TN pela união dos FNDA', () => {
    assert.equal(run(MULTI_TN, 'functions'), 100);
  });

  test('o mesmo ficheiro repetido por concatenação, com TN vazio, junta-se pela união', () => {
    const text = [...UNIT_A, ...UNIT_B].join('\n').replaceAll(/^TN:\w+$/gm, 'TN:');
    assert.equal(run(text, 'lines'), 1000 / 11);
  });

  test('um novo teste que cobre menos linhas do que a média não baixa lines', () => {
    const unitC = progRecord('unitC', {
      functions: [1, 0, 0],
      branches: ['-', '-', '-', '-', '-', '-', '0', '0'],
      lines: [0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0],
      summary: ['FNF:3', 'FNH:1', 'BRF:8', 'BRH:0', 'LF:11', 'LH:2'],
    });
    assert.equal(run([...UNIT_A, ...UNIT_B, ...unitC].join('\n'), 'lines'), 1000 / 11);
  });

  test('ficheiros diferentes com o mesmo SF relativo (monorepo) somam-se', () => {
    const text = [
      ...linesRecord('src/index.js', [1, 0]),
      ...linesRecord('src/index.js', [1, 1, 1, 0]),
    ].join('\n');
    assert.equal(run(text), (4 * 100) / 6);
  });

  test('o mesmo SF repetido só com resumos e o mesmo total conta o ficheiro uma vez', () => {
    const text = [
      'SF:src/a.js', 'LF:10', 'LH:4', 'end_of_record',
      'SF:src/a.js', 'LF:10', 'LH:7', 'end_of_record',
    ].join('\n');
    assert.equal(run(text), 70);
  });

  test('FNA com o mesmo índice FNL (lcov 2.2) são uma só função, unida entre os TN', () => {
    const text = [...aliasRecord('unitA', [1, 0, 0]), ...aliasRecord('unitB', [0, 0, 2])];
    assert.equal(run(text.join('\n'), 'functions'), 100);
  });

  test('registo sem end_of_record no fim do ficheiro conta', () => {
    assert.equal(run(['SF:src/a.js', 'LF:4', 'LH:3'].join('\n')), 75);
  });

  test('linha DA inválida dá extractor_report_unparseable', () => {
    assert.throws(() => run(REPORT.replace('DA:7,0', 'DA:sete,0')), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_lcov_invalid_value', params: { key: 'DA', value: 'sete,0' } },
      },
    });
  });

  test('linha BRDA sem o número de vezes dá extractor_report_unparseable', () => {
    const text = REPORT.replace('BRDA:6,0,1,0', 'BRDA:6,0,1');
    assert.throws(() => run(text), (/** @type {any} */ error) => (
      error.params.reason.code === 'reason_lcov_invalid_value'
      && error.params.reason.params.key === 'BRDA'));
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
      params: {
        format: FORMAT,
        reason: { code: 'reason_hit_exceeds_total', params: { hit: 9, total: 8 } },
      },
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
    assert.throws(() => run('<html><body>Not Found</body></html>'), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: { code: 'reason_lcov_no_record', params: {} } },
    });
  });

  test('contagem inválida numa linha de resumo dá extractor_report_unparseable', () => {
    assert.throws(() => run(REPORT.replace('LF:5', 'LF:cinco')), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_lcov_invalid_value', params: { key: 'LF', value: 'cinco' } },
      },
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
