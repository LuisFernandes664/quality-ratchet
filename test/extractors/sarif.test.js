// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extract } from '../../src/extractors/index.js';
import { sarifExtractor } from '../../src/extractors/sarif.js';

const FORMAT = 'sarif';
const UNPARSEABLE = { name: 'ExtractorError', code: 'extractor_report_unparseable' };
const LEVELS_INVALID = {
  name: 'ExtractorError',
  code: 'extractor_option_invalid',
  params: {
    format: FORMAT,
    option: 'levels',
    reason: { code: 'reason_levels_invalid', params: { known: 'error, warning, note, none' } },
  },
};

/**
 * Resultado SARIF com localização física.
 * @param {string} ruleId
 * @param {string|undefined} level undefined omite a propriedade
 * @param {object[]} [suppressions] undefined omite a propriedade
 * @returns {Record<string, unknown>}
 */
function result(ruleId, level, suppressions) {
  return {
    ruleId,
    level,
    message: { text: `Ocorrência de ${ruleId}.` },
    locations: [{
      physicalLocation: {
        artifactLocation: { uri: 'src/app.js', uriBaseId: '%SRCROOT%' },
        region: { startLine: 12, startColumn: 5, endColumn: 20 },
      },
    }],
    partialFingerprints: { primaryLocationLineHash: `${ruleId}:1` },
    suppressions,
  };
}

/**
 * Run SARIF de uma ferramenta.
 * @param {string} name
 * @param {Record<string, unknown>[]|undefined} results undefined omite a propriedade
 * @returns {Record<string, unknown>}
 */
function run(name, results) {
  return {
    tool: { driver: { name, informationUri: 'https://example.com', rules: [] } },
    results,
    columnKind: 'utf16CodeUnits',
  };
}

/**
 * Registo SARIF 2.1.0 com os runs indicados.
 * @param {Record<string, unknown>[]} runs
 * @returns {string}
 */
function log(runs) {
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs,
  });
}

/**
 * Três runs (CodeQL, Semgrep e um sem resultados). Não suprimidos: 2 error, 2 warning (um
 * sem `level`), 1 note e 1 none.
 */
const REPORT = log([
  run('CodeQL', [
    result('js/sql-injection', 'error'),
    result('js/unused-local-variable', 'warning'),
    result('js/useless-assignment-to-local', undefined),
    result('js/todo-comment', 'note'),
    result('js/xss', 'error', [{ kind: 'external', status: 'accepted', justification: 'teste' }]),
  ]),
  run('Semgrep OSS', [
    result('javascript.lang.security.audit.eval-detected', 'error', []),
    result('generic.secrets.gitleaks.generic-api-key', 'none'),
    result('javascript.express.security.audit.xss', 'warning', [{ kind: 'inSource' }]),
  ]),
  run('Trivy', []),
]);

/**
 * Regra com o nível por omissão indicado (undefined omite `defaultConfiguration`).
 * @param {string} id
 * @param {string|undefined} level
 * @returns {Record<string, unknown>}
 */
function rule(id, level) {
  return {
    id,
    shortDescription: { text: `Regra ${id}.` },
    defaultConfiguration: level === undefined ? undefined : { enabled: true, level },
    properties: { tags: ['security'], precision: 'high' },
  };
}

/** Regras do pacote de consultas do CodeQL, com o nível por omissão de cada uma. */
const CODEQL_RULES = [
  rule('js/sql-injection', 'error'),
  rule('js/unused-local-variable', 'note'),
  rule('js/xss', 'error'),
  rule('js/useless-assignment-to-local', 'warning'),
];

/**
 * Resultado do CodeQL: sem `level`, só com a referência à regra do pacote de consultas.
 * @param {number} index posição da regra em CODEQL_RULES
 * @returns {Record<string, unknown>}
 */
function codeqlResult(index) {
  const id = String(CODEQL_RULES[index].id);
  const reference = { id, index, toolComponent: { index: 0 } };
  return { ...result(id, undefined), ruleIndex: index, rule: reference };
}

/**
 * Registo do CodeQL: as regras estão em `tool.extensions` e o driver não tem nenhuma.
 * Resultados: 2 error (sql-injection e xss), 1 note e 1 warning.
 */
const CODEQL = log([{
  tool: {
    driver: { name: 'CodeQL', semanticVersion: '2.17.0', rules: [] },
    extensions: [{ name: 'codeql/javascript-queries', rules: CODEQL_RULES }],
  },
  results: [0, 2, 1, 3].map(codeqlResult),
}]);

/**
 * Registo de um run cujo driver declara as regras indicadas.
 * @param {Record<string, unknown>[]} rules
 * @param {Record<string, unknown>[]} results
 * @returns {string}
 */
function withRules(rules, results) {
  return log([{ tool: { driver: { name: 'Semgrep OSS', rules } }, results }]);
}

/**
 * Registo do formatador SARIF do ESLint (@microsoft/eslint-formatter-sarif 3.1.0) quando um
 * ficheiro tem um erro de sintaxe: esse ficheiro não tem resultados, o erro fica nas
 * notificações da invocação e a execução é marcada como falhada. Só os 2 problemas de
 * `ok.js` aparecem em `results`.
 */
const ESLINT_PARSE_ERROR = log([{
  tool: { driver: { name: 'ESLint', informationUri: 'https://eslint.org', version: '9.39.1' } },
  artifacts: [{ location: { uri: 'file:///home/runner/work/app/app/a.js' } }],
  results: [result('no-unused-vars', 'error'), result('no-console', 'warning')],
  invocations: [{
    toolConfigurationNotifications: [{
      level: 'error',
      message: { text: 'Parsing error: Unexpected token =' },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: 'file:///home/runner/work/app/app/a.js', index: 0 },
          region: { startLine: 4, startColumn: 7 },
        },
      }],
      descriptor: { id: 'ESL0999' },
    }],
    executionSuccessful: false,
  }],
}]);

/**
 * Registo de um run com as invocações indicadas e um resultado.
 * @param {Record<string, unknown>[]} invocations
 * @returns {Record<string, unknown>}
 */
function invoked(invocations) {
  return { ...run('Semgrep OSS', [result('a', 'error')]), invocations };
}

/**
 * ErrorLog do compilador C# no formato por omissão (SARIF 1.0.0, como o `dotnet build
 * -p:ErrorLog=build.sarif` o escreve): 3 diagnósticos, 2 suprimidos no código com
 * `suppressionStates`, que o SARIF 2.1.0 não tem.
 */
const ROSLYN_V1 = JSON.stringify({
  $schema: 'http://json.schemastore.org/sarif-1.0.0',
  version: '1.0.0',
  runs: [{
    tool: {
      name: 'Microsoft (R) Visual C# Compiler',
      version: '4.12.0.0',
      fileVersion: '4.12.0',
      semanticVersion: '4.12.0',
      language: 'en-US',
    },
    results: ['CA1822', 'CS0168', 'CA2007'].map((ruleId, index) => ({
      ruleId,
      level: 'warning',
      message: `Diagnóstico ${ruleId}.`,
      suppressionStates: index === 0 ? undefined : ['suppressedInSource'],
      locations: [{ resultFile: { uri: 'file:///src/A.cs', region: { startLine: index + 3 } } }],
    })),
    rules: { CA1822: { id: 'CA1822', defaultLevel: 'warning' } },
  }],
});

/**
 * @param {string} text
 * @param {Partial<import('../../src/core/types.js').MetricSource>} [options]
 * @returns {number}
 */
function count(text, options = {}) {
  return extract({ format: FORMAT, path: 'results.sarif', ...options }, text);
}

describe('sarif', () => {
  test('declara apenas o campo count', () => {
    assert.deepEqual([sarifExtractor.fields, sarifExtractor.defaultField], [['count'], 'count']);
  });

  test('usa count como campo por omissão', () => {
    assert.equal(count(REPORT), 6);
  });

  test('count soma os resultados não suprimidos de todos os runs', () => {
    assert.equal(count(REPORT, { field: 'count' }), 6);
  });

  test('ignora resultados com suppressions não vazio', () => {
    const text = log([run('CodeQL', [result('a', 'error', [{ kind: 'inSource' }])])]);
    assert.equal(count(text), 0);
  });

  test('conta resultados com suppressions vazio', () => {
    assert.equal(count(log([run('CodeQL', [result('a', 'error', [])])])), 1);
  });

  test('filtra pelos níveis de source.levels', () => {
    assert.equal(count(REPORT, { levels: ['error'] }), 2);
  });

  test('resultado sem level conta como warning', () => {
    assert.equal(count(REPORT, { levels: ['warning'] }), 2);
  });

  test('aceita vários níveis em source.levels', () => {
    assert.equal(count(REPORT, { levels: ['note', 'none'] }), 2);
  });

  test('resultado sem level usa o nível por omissão da regra em tool.extensions (CodeQL)', () => {
    assert.equal(count(CODEQL, { levels: ['error'] }), 2);
  });

  test('sem source.levels conta os resultados do CodeQL de todos os níveis', () => {
    assert.equal(count(CODEQL), 4);
  });

  test('encontra a regra do driver por ruleIndex', () => {
    const results = [{ ...result('b', undefined), ruleIndex: 1 }];
    const text = withRules([rule('a', 'error'), rule('b', 'note')], results);
    assert.equal(count(text, { levels: ['note'] }), 1);
  });

  test('encontra a regra do driver por ruleId quando não há índice', () => {
    const text = withRules([rule('a', 'note'), rule('b', 'error')], [result('b', undefined)]);
    assert.equal(count(text, { levels: ['error'] }), 1);
  });

  test('o level do resultado prevalece sobre o nível por omissão da regra', () => {
    const text = withRules([rule('a', 'error')], [result('a', 'note')]);
    assert.equal(count(text, { levels: ['error'] }), 0);
  });

  test('regra sem defaultConfiguration deixa o resultado como warning', () => {
    const text = withRules([rule('a', undefined)], [result('a', undefined)]);
    assert.equal(count(text, { levels: ['warning'] }), 1);
  });

  test('resultado sem level com kind diferente de fail tem o nível none', () => {
    const text = withRules([rule('a', 'error')], [{ ...result('a', undefined), kind: 'pass' }]);
    assert.equal(count(text, { levels: ['none'] }), 1);
  });

  test('resultado com kind fail e sem level usa o nível da regra', () => {
    const text = withRules([rule('a', 'error')], [{ ...result('a', undefined), kind: 'fail' }]);
    assert.equal(count(text, { levels: ['error'] }), 1);
  });

  test('supressão em revisão não suprime o resultado', () => {
    const suppressions = [{ kind: 'external', status: 'underReview' }];
    assert.equal(count(log([run('CodeQL', [result('a', 'error', suppressions)])])), 1);
  });

  test('supressão rejeitada não suprime o resultado', () => {
    const suppressions = [{ kind: 'inSource' }, { kind: 'external', status: 'rejected' }];
    assert.equal(count(log([run('CodeQL', [result('a', 'error', suppressions)])])), 1);
  });

  test('supressão aceite suprime o resultado', () => {
    const suppressions = [{ kind: 'external', status: 'accepted' }];
    assert.equal(count(log([run('CodeQL', [result('a', 'error', suppressions)])])), 0);
  });

  test('resultado com baselineState absent (já corrigido) não conta', () => {
    const results = [{ ...result('a', 'error'), baselineState: 'absent' }];
    assert.equal(count(log([run('CodeQL', results)])), 0);
  });

  test('resultado com baselineState unchanged conta', () => {
    const results = [{ ...result('a', 'error'), baselineState: 'unchanged' }];
    assert.equal(count(log([run('CodeQL', results)])), 1);
  });

  test('aceita a marca de ordem de bytes no início do ficheiro', () => {
    assert.equal(count(`\uFEFF${REPORT}`), 6);
  });

  test('run sem results não contribui com resultados', () => {
    assert.equal(count(log([run('ESLint', undefined), run('CodeQL', [result('a', 'note')])])), 1);
  });

  test('registo sem nenhum resultado devolve 0', () => {
    assert.equal(count(log([run('CodeQL', [])])), 0);
  });

  test('runs vazio dá extractor_report_empty', () => {
    assert.throws(() => count(log([])), {
      name: 'ExtractorError',
      code: 'extractor_report_empty',
      params: { format: FORMAT },
    });
  });

  test('registo sem runs dá extractor_report_unparseable', () => {
    assert.throws(() => count('{"version":"2.1.0"}'), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: { code: 'reason_key_missing', params: { path: 'runs' } } },
    });
  });

  test('runs que não é array dá extractor_report_unparseable', () => {
    assert.throws(() => count('{"version":"2.1.0","runs":{}}'), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: { code: 'reason_not_array', params: { path: 'runs' } } },
    });
  });

  test('results que não é array dá extractor_report_unparseable', () => {
    const text = log([{ tool: { driver: { name: 'x' } }, results: { count: 1 } }]);
    assert.throws(() => count(text), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_not_array_of_objects', params: { path: 'runs[0].results' } },
      },
    });
  });

  test('execução falhada (erro de sintaxe no ESLint) dá extractor_report_unparseable', () => {
    assert.throws(() => count(ESLINT_PARSE_ERROR), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: {
          code: 'reason_sarif_execution_failed',
          params: { run: 'runs[0]', details: 'Parsing error: Unexpected token =' },
        },
      },
    });
  });

  test('execução falhada sem notificações de erro dá o motivo sem detalhes', () => {
    const text = log([invoked([{
      executionSuccessful: false,
      toolExecutionNotifications: [{ level: 'warning', message: { text: 'lento' } }],
    }])]);
    assert.throws(() => count(text), (error) => error.params.reason.params.details === '');
  });

  test('junta as notificações de erro de configuração e de execução, sem repetidos', () => {
    const notification = { level: 'error', message: { text: 'sem memória' } };
    const text = log([invoked([{
      executionSuccessful: false,
      toolConfigurationNotifications: [notification, { message: { text: 'aviso' } }],
      toolExecutionNotifications: [notification, { level: 'error', message: { text: 'abortou' } }],
    }])]);
    assert.throws(() => count(text), (error) => (
      error.params.reason.params.details === 'sem memória; abortou'));
  });

  test('o motivo da execução falhada indica o run', () => {
    const text = log([invoked([{ executionSuccessful: true }]), invoked([{
      executionSuccessful: false,
    }])]);
    assert.throws(() => count(text), (error) => error.params.reason.params.run === 'runs[1]');
  });

  test('execução com sucesso e notificações de erro (Semgrep) conta os resultados', () => {
    const text = log([invoked([{
      executionSuccessful: true,
      toolExecutionNotifications: [{ level: 'error', message: { text: 'Syntax error' } }],
    }])]);
    assert.equal(count(text), 1);
  });

  test('run sem invocations (ruff) conta os resultados', () => {
    assert.equal(count(log([run('ruff', [result('F401', 'error')])])), 1);
  });

  test('SARIF 1.0.0 (ErrorLog do C# por omissão) dá extractor_report_unparseable', () => {
    assert.throws(() => count(ROSLYN_V1), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_sarif_version', params: { version: '1.0.0' } },
      },
    });
  });

  test('SARIF 2.0.0 dá extractor_report_unparseable', () => {
    const text = JSON.stringify({ version: '2.0.0', runs: [run('x', [])] });
    assert.throws(() => count(text), (error) => (
      error.params.reason.code === 'reason_sarif_version'));
  });

  test('registo sem version dá extractor_report_unparseable e não extractor_report_empty', () => {
    assert.throws(() => count('{"runs":[]}'), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: { code: 'reason_sarif_version_missing', params: {} } },
    });
  });

  test('os mesmos diagnósticos em SARIF 2.1.0 com suppressions contam só o activo', () => {
    const results = [
      result('CA1822', 'warning'),
      result('CS0168', 'warning', [{ kind: 'inSource' }]),
      result('CA2007', 'warning', [{ kind: 'inSource' }]),
    ];
    assert.equal(count(log([run('csc', results)])), 1);
  });

  test('JSON inválido dá extractor_report_unparseable', () => {
    assert.throws(() => count('{"version":"2.1.0","runs":[{'), UNPARSEABLE);
  });

  test('levels vazio dá extractor_option_invalid', () => {
    assert.throws(() => count(REPORT, { levels: [] }), LEVELS_INVALID);
  });

  test('levels que não é array dá extractor_option_invalid', () => {
    const levels = /** @type {string[]} */ (/** @type {unknown} */ ('error'));
    assert.throws(() => count(REPORT, { levels }), LEVELS_INVALID);
  });

  test('nível desconhecido em levels dá extractor_option_invalid', () => {
    assert.throws(() => count(REPORT, { levels: ['error', 'info'] }), {
      ...LEVELS_INVALID,
      params: {
        format: FORMAT,
        option: 'levels',
        reason: { code: 'reason_level_unknown', params: { level: 'info' } },
      },
    });
  });

  test('campo desconhecido dá extractor_field_unknown', () => {
    assert.throws(() => count(REPORT, { field: 'errors' }), {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: { format: FORMAT, field: 'errors', known: 'count' },
    });
  });
});
