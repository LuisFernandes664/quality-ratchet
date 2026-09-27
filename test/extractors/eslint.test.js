// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { eslintExtractor } from '../../src/extractors/eslint.js';
import { extract } from '../../src/extractors/index.js';

const FORMAT = 'eslint';
const UNPARSEABLE = { name: 'ExtractorError', code: 'extractor_report_unparseable' };

/**
 * Mensagem de uma regra, tal como o formatter `json` a escreve.
 * @param {string|null} ruleId
 * @param {1|2} severity
 * @param {number} line
 * @returns {Record<string, unknown>}
 */
function message(ruleId, severity, line) {
  return {
    ruleId,
    severity,
    message: ruleId === null ? 'Parsing error: Unexpected token }' : `Violação de ${ruleId}.`,
    line,
    column: 7,
    nodeType: ruleId === null ? undefined : 'Identifier',
    fatal: ruleId === null ? true : undefined,
    endLine: line,
    endColumn: 12,
  };
}

/**
 * Resultado de um ficheiro. As contagens são calculadas a partir das mensagens.
 * @param {string} filePath
 * @param {Record<string, unknown>[]} messages
 * @param {Record<string, unknown>[]} [suppressedMessages]
 * @returns {Record<string, unknown>}
 */
function file(filePath, messages, suppressedMessages = []) {
  const bySeverity = (/** @type {number} */ severity) => messages
    .filter((entry) => entry.severity === severity).length;
  return {
    filePath: `/home/runner/work/app/app/${filePath}`,
    messages,
    suppressedMessages,
    errorCount: bySeverity(2),
    fatalErrorCount: messages.filter((entry) => entry.fatal === true).length,
    warningCount: bySeverity(1),
    fixableErrorCount: 0,
    fixableWarningCount: 0,
    usedDeprecatedRules: [],
  };
}

/** Saída de `eslint -f json` com 3 erros (um fatal) e 4 avisos em três ficheiros. */
const REPORT = JSON.stringify([
  file('src/app.js', [message('no-unused-vars', 2, 3), message('no-console', 1, 9)]),
  file('src/util.js', [
    message(null, 2, 40),
    message('eqeqeq', 2, 12),
    message('prefer-const', 1, 4),
    message('no-console', 1, 18),
    message('no-console', 1, 22),
  ]),
  file('src/clean.js', [], [
    { ...message('no-alert', 2, 5), suppressions: [{ kind: 'directive', justification: '' }] },
  ]),
]);

/**
 * @param {string} text
 * @param {string} [field]
 * @returns {number}
 */
function run(text, field) {
  return extract({ format: FORMAT, path: 'eslint-report.json', field }, text);
}

describe('eslint', () => {
  test('declara os campos do contrato com total por omissão', () => {
    assert.deepEqual([eslintExtractor.fields, eslintExtractor.defaultField], [
      ['total', 'errors', 'warnings'],
      'total',
    ]);
  });

  test('usa total como campo por omissão', () => {
    assert.equal(run(REPORT), 7);
  });

  test('total é a soma de errorCount e warningCount de todos os ficheiros', () => {
    assert.equal(run(REPORT, 'total'), 7);
  });

  test('errors soma errorCount, incluindo erros fatais', () => {
    assert.equal(run(REPORT, 'errors'), 3);
  });

  test('warnings soma warningCount', () => {
    assert.equal(run(REPORT, 'warnings'), 4);
  });

  test('não conta suppressedMessages', () => {
    assert.equal(run(JSON.stringify([JSON.parse(REPORT)[2]])), 0);
  });

  test('array vazio dá extractor_report_empty', () => {
    assert.throws(() => run('[]'), {
      name: 'ExtractorError',
      code: 'extractor_report_empty',
      params: { format: FORMAT },
    });
  });

  test('documento que não é array dá extractor_report_unparseable', () => {
    assert.throws(() => run('{"errorCount":1,"warningCount":0}'), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: { code: 'reason_eslint_not_array', params: {} } },
    });
  });

  test('ficheiro sem errorCount dá extractor_report_unparseable', () => {
    assert.throws(() => run('[{"filePath":"/a.js","messages":[],"warningCount":0}]'), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_key_missing', params: { path: 'errorCount' } },
      },
    });
  });

  test('contagem não finita dá extractor_report_unparseable', () => {
    const text = '[{"filePath":"/a.js","errorCount":1e999,"warningCount":0}]';
    assert.throws(() => run(text), UNPARSEABLE);
  });

  test('JSON inválido dá extractor_report_unparseable', () => {
    assert.throws(() => run('Oops! Something went wrong! :('), UNPARSEABLE);
  });

  test('campo desconhecido dá extractor_field_unknown', () => {
    assert.throws(() => run(REPORT, 'fatal'), {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: { format: FORMAT, field: 'fatal', known: 'total, errors, warnings' },
    });
  });
});
