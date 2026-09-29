// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extract } from '../../src/extractors/index.js';
import { stylelintExtractor } from '../../src/extractors/stylelint.js';

const FORMAT = 'stylelint';
const UNPARSEABLE = { name: 'ExtractorError', code: 'extractor_report_unparseable' };

/**
 * Entrada de `warnings` de uma regra, tal como o formatter `json` a escreve: o texto acaba
 * com o nome da regra entre parênteses.
 * @param {string} rule
 * @param {'error'|'warning'} severity
 * @param {number} line
 * @param {string} message mensagem da regra, sem o nome
 * @returns {Record<string, unknown>}
 */
function warning(rule, severity, line, message) {
  return {
    line,
    column: 3,
    endLine: line,
    endColumn: 14,
    rule,
    severity,
    text: `${message} (${rule})`,
  };
}

/**
 * Resultado de um ficheiro. `errored` é true quando alguma entrada é um erro.
 * @param {string} source caminho relativo ao repositório
 * @param {Record<string, unknown>[]} warnings
 * @returns {Record<string, unknown>}
 */
function file(source, warnings) {
  return {
    source: `/home/runner/work/app/app/${source}`,
    deprecations: [],
    invalidOptionWarnings: [],
    parseErrors: [],
    errored: warnings.some((entry) => entry.severity === 'error'),
    warnings,
  };
}

/** Erro de sintaxe do CSS (bloco por fechar): o stylelint escreve-o como uma entrada. */
const SYNTAX_ERROR = {
  line: 12,
  column: 1,
  rule: 'CssSyntaxError',
  severity: 'error',
  text: 'Unclosed block (CssSyntaxError)',
};

/**
 * Saída de `stylelint --formatter json` com 3 erros (um deles de sintaxe) e 2 avisos em
 * quatro ficheiros, um deles sem problemas.
 */
const REPORT = JSON.stringify([
  file('src/styles/button.css', [
    warning('color-no-invalid-hex', 'error', 3, 'Unexpected invalid hex color "#ffz"'),
    warning('declaration-block-no-duplicate-properties', 'error', 8,
      'Unexpected duplicate "color"'),
    warning('length-zero-no-unit', 'warning', 9, 'Unexpected unit'),
  ]),
  file('src/styles/card.css', [warning('block-no-empty', 'warning', 21, 'Unexpected empty block')]),
  file('src/styles/layout.css', [SYNTAX_ERROR]),
  file('src/styles/reset.css', []),
]);

/**
 * Ficheiro sem problemas analisado pelo stylelint 15 com uma regra obsoleta e uma opção
 * inválida na configuração.
 */
const CONFIG_NOTICES = {
  ...file('src/styles/theme.css', []),
  deprecations: [{
    text: 'The "color-hex-case" rule is deprecated.',
    reference: 'https://stylelint.io/migration-guide/to-15',
  }],
  invalidOptionWarnings: [
    { text: 'Invalid option value "always-single" for rule "comment-empty-line-before"' },
  ],
  errored: true,
};

/**
 * @param {string} text
 * @param {string} [field]
 * @returns {number}
 */
function run(text, field) {
  return extract({ format: FORMAT, path: 'reports/stylelint.json', field }, text);
}

describe('stylelint', () => {
  test('declara os campos do contrato com total por omissão', () => {
    assert.deepEqual([stylelintExtractor.fields, stylelintExtractor.defaultField], [
      ['total', 'errors', 'warnings'],
      'total',
    ]);
  });

  test('usa total como campo por omissão', () => {
    assert.equal(run(REPORT), 5);
  });

  test('total conta as entradas de warnings de todos os ficheiros', () => {
    assert.equal(run(REPORT, 'total'), 5);
  });

  test('errors conta as entradas com severity "error"', () => {
    assert.equal(run(REPORT, 'errors'), 3);
  });

  test('warnings conta as entradas com severity "warning"', () => {
    assert.equal(run(REPORT, 'warnings'), 2);
  });

  test('um erro de sintaxe do CSS conta como erro', () => {
    assert.equal(run(JSON.stringify([file('src/styles/layout.css', [SYNTAX_ERROR])]), 'errors'), 1);
  });

  test('não conta deprecations', () => {
    const deprecatedOnly = { ...CONFIG_NOTICES, invalidOptionWarnings: [], errored: false };
    assert.equal(run(JSON.stringify([deprecatedOnly])), 0);
  });

  test('regras com opções inválidas rejeitam o relatório, com os textos uma vez cada', () => {
    const text = JSON.stringify([CONFIG_NOTICES, { ...CONFIG_NOTICES, source: 'b.css' }]);
    assert.throws(() => run(text), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: {
          code: 'reason_stylelint_invalid_options',
          params: {
            details: 'Invalid option value "always-single" for rule "comment-empty-line-before"',
          },
        },
      },
    });
  });

  test('array vazio devolve 0', () => {
    assert.equal(run('[]'), 0);
  });

  test('documento que não é array dá reason_stylelint_not_array', () => {
    assert.throws(() => run('{"extends":"stylelint-config-standard"}'), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: { code: 'reason_stylelint_not_array', params: {} } },
    });
  });

  test('ficheiro sem warnings dá reason_not_array com a posição do ficheiro', () => {
    const { warnings, ...withoutWarnings } = file('src/b.css', []);
    const text = JSON.stringify([file('src/a.css', []), withoutWarnings]);
    assert.throws(() => run(text), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_not_array', params: { path: '[1].warnings' } },
      },
    });
  });

  test('severidade desconhecida dá reason_severity_unknown com a posição da entrada', () => {
    const entry = warning('block-no-empty', 'warning', 4, 'Unexpected empty block');
    const text = JSON.stringify([file('src/a.css', [{ ...entry, severity: 'info' }])]);
    assert.throws(() => run(text), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: {
          code: 'reason_severity_unknown',
          params: { severity: 'info', path: '[0].warnings[0]', known: 'error, warning' },
        },
      },
    });
  });

  test('saída do formatter string em vez de JSON dá extractor_report_unparseable', () => {
    const text = '\nsrc/styles/button.css\n  3:10  ✖  Unexpected invalid hex color "#ffz"'
      + '  color-no-invalid-hex\n';
    assert.throws(() => run(text), UNPARSEABLE);
  });

  test('campo desconhecido dá extractor_field_unknown', () => {
    assert.throws(() => run(REPORT, 'fatal'), {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: { format: FORMAT, field: 'fatal', known: 'total, errors, warnings' },
    });
  });
});
