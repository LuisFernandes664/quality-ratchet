// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extract } from '../../src/extractors/index.js';
import { trxExtractor } from '../../src/extractors/trx.js';

const FORMAT = 'trx';
const UNPARSEABLE = { name: 'ExtractorError', code: 'extractor_report_unparseable' };
const EMPTY = {
  name: 'ExtractorError',
  code: 'extractor_report_empty',
  params: { format: FORMAT },
};

/** Tipo de teste unitário, igual em todos os TRX. */
const UNIT_TEST_TYPE = '13cdc9d9-ddb5-4fa4-a97d-d965ccfc6d4b';

/** Lista "Results Not in a List", onde o logger TRX põe todos os resultados. */
const NOT_IN_A_LIST = '8c84fa94-04c1-424b-9868-57a2d4851a1d';

/** Máquina do runner. */
const MACHINE = 'fv-az1152-411';

/** Assembly de testes compilado. */
const ASSEMBLY = '/home/runner/work/shop/shop/tests/Shop.Tests/bin/Debug/net8.0/Shop.Tests.dll';

/**
 * Teste da classe CartTests no relatório.
 * @typedef {object} TrxTest
 * @property {string} name nome do método
 * @property {string} outcome
 * @property {string} id doze algarismos hexadecimais que acabam os GUID do teste
 * @property {string[]} [output] linhas do `<Output>` do resultado
 */

/** `<Output>` de um teste que falhou: a mensagem e a pilha da asserção do xUnit. */
const FAILURE_OUTPUT = [
  '        <ErrorInfo>',
  '          <Message>Assert.Equal() Failure: Values differ',
  'Expected: 90',
  'Actual:   100</Message>',
  '          <StackTrace>   at Shop.Tests.CartTests.AppliesDiscount() in '
    + '/home/runner/work/shop/shop/tests/Shop.Tests/CartTests.cs:line 42',
  '   at System.RuntimeMethodHandle.InvokeMethod(Object target, Void** arguments, '
    + 'Signature sig, Boolean isConstructor)</StackTrace>',
  '        </ErrorInfo>',
];

/** `<Output>` de um teste ignorado com `[Fact(Skip = ...)]`: o motivo vem na mensagem. */
const SKIP_OUTPUT = [
  '        <ErrorInfo>',
  '          <Message>Sem ligação ao serviço de pagamentos</Message>',
  '        </ErrorInfo>',
];

/**
 * Cinco testes do xUnit: três passam, um falha e um é ignorado.
 * @type {TrxTest[]}
 */
const TESTS = [
  { name: 'AddsItem', outcome: 'Passed', id: '6a1e2c3d4b5f' },
  { name: 'AppliesDiscount', outcome: 'Failed', id: '7b2f3d4e5c6a', output: FAILURE_OUTPUT },
  { name: 'ChargesCard', outcome: 'NotExecuted', id: '8c3a4e5f6d7b', output: SKIP_OUTPUT },
  { name: 'RemovesItem', outcome: 'Passed', id: '9d4b5f6a7e8c' },
  { name: 'TotalsPrices', outcome: 'Passed', id: 'ae5c6a7b8f9d' },
];

/** Início do relatório: declaração XML, raiz, tempos e definições da execução. */
const HEAD = [
  '<?xml version="1.0" encoding="utf-8"?>',
  [
    '<TestRun id="0e8f4c2a-7b1d-4a39-9c5e-2f6a8b0d1e3c"',
    ` name="runner@${MACHINE} 2024-05-02 10:21:33" runUser="runner"`,
    ' xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">',
  ].join(''),
  [
    '  <Times creation="2024-05-02T10:21:33.8561287+00:00"',
    ' queuing="2024-05-02T10:21:33.8561294+00:00" start="2024-05-02T10:21:32.4121873+00:00"',
    ' finish="2024-05-02T10:21:33.8710345+00:00" />',
  ].join(''),
  '  <TestSettings name="default" id="6c8a5a2d-2e4b-4e1f-9d7a-3b5c7e9f1a2b">',
  `    <Deployment runDeploymentRoot="runner_${MACHINE}_2024-05-02_10_21_33" />`,
  '  </TestSettings>',
];

/** Listas de testes que o logger TRX escreve sempre. */
const TEST_LISTS = [
  '  <TestLists>',
  `    <TestList name="Results Not in a List" id="${NOT_IN_A_LIST}" />`,
  '    <TestList name="All Loaded Results" id="19431567-8539-422a-85d7-44ee4e166bda" />',
  '  </TestLists>',
];

/**
 * O mesmo teste, ignorado.
 * @param {TrxTest} entry
 * @returns {TrxTest}
 */
function skipped(entry) {
  return { ...entry, outcome: 'NotExecuted', output: SKIP_OUTPUT };
}

/**
 * GUID de execução e de teste de um teste.
 * @param {TrxTest} entry
 * @returns {{executionId: string, testId: string}}
 */
function guids(entry) {
  return {
    executionId: `5d7e1f3a-9b2c-4e6d-8a10-${entry.id}`,
    testId: `c4b8e2d6-1f3a-5b7c-9d0e-${entry.id}`,
  };
}

/**
 * `<UnitTestResult>` de um teste, com os atributos que o logger TRX escreve.
 * @param {TrxTest} entry
 * @returns {string[]}
 */
function resultLines(entry) {
  const { executionId, testId } = guids(entry);
  const tag = [
    `    <UnitTestResult executionId="${executionId}" testId="${testId}"`,
    ` testName="Shop.Tests.CartTests.${entry.name}" computerName="${MACHINE}"`,
    ' duration="00:00:00.0021934" startTime="2024-05-02T10:21:33.6417711+00:00"',
    ' endTime="2024-05-02T10:21:33.6439645+00:00"',
    ` testType="${UNIT_TEST_TYPE}" outcome="${entry.outcome}" testListId="${NOT_IN_A_LIST}"`,
    ` relativeResultsDirectory="${executionId}"`,
  ].join('');
  if (!entry.output) return [`${tag} />`];
  return [`${tag}>`, '      <Output>', ...entry.output, '      </Output>', '    </UnitTestResult>'];
}

/**
 * `<UnitTest>` da definição de um teste, com o mesmo nome do resultado.
 * @param {TrxTest} entry
 * @returns {string[]}
 */
function definitionLines(entry) {
  const { executionId, testId } = guids(entry);
  return [
    `    <UnitTest name="Shop.Tests.CartTests.${entry.name}" storage="${ASSEMBLY.toLowerCase()}"`
      + ` id="${testId}">`,
    `      <Execution id="${executionId}" />`,
    `      <TestMethod codeBase="${ASSEMBLY}" adapterTypeName="executor://xunit/VsTestRunner2/`
      + `netcoreapp" className="Shop.Tests.CartTests" name="${entry.name}" />`,
    '    </UnitTest>',
  ];
}

/**
 * `<TestEntry>` de um teste.
 * @param {TrxTest} entry
 * @returns {string}
 */
function entryLine(entry) {
  const { executionId, testId } = guids(entry);
  return `    <TestEntry testId="${testId}" executionId="${executionId}"`
    + ` testListId="${NOT_IN_A_LIST}" />`;
}

/**
 * `<Counters>` como o logger TRX do VSTest os calcula: `total` conta todos os resultados,
 * `executed` só os que passaram ou falharam, e os outros atributos ficam a 0.
 * @param {TrxTest[]} tests
 * @returns {string}
 */
function countersLine(tests) {
  const passed = tests.filter((entry) => entry.outcome === 'Passed').length;
  const failed = tests.filter((entry) => entry.outcome === 'Failed').length;
  return `    <Counters total="${tests.length}" executed="${passed + failed}" passed="${passed}"`
    + ` failed="${failed}" error="0" timeout="0" aborted="0" inconclusive="0"`
    + ' passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0"'
    + ' completed="0" inProgress="0" pending="0" />';
}

/**
 * Mensagens de um teste que falhou ou foi ignorado: as do adaptador do xUnit e, para um
 * teste ignorado, a do logger TRX.
 * @param {TrxTest} entry
 * @returns {string[]}
 */
function eventLines(entry) {
  const name = `Shop.Tests.CartTests.${entry.name}`;
  if (entry.outcome === 'Failed') return [`[xUnit.net 00:00:00.28]     ${name} [FAIL]`];
  return [
    `[xUnit.net 00:00:00.31]     ${name} [SKIP]`,
    `Test '${name}' was skipped in the test run.`,
  ];
}

/**
 * `<Output>` do `<ResultSummary>`, com as mensagens da execução.
 * @param {TrxTest[]} tests
 * @returns {string[]}
 */
function summaryOutputLines(tests) {
  return [
    '    <Output>',
    '      <StdOut>[xUnit.net 00:00:00.00] xUnit.net VSTest Adapter v2.5.8+8f5cd05a1b (64-bit '
      + '.NET 8.0.4)',
    '[xUnit.net 00:00:00.15]   Starting:    Shop.Tests',
    ...tests.filter((entry) => entry.outcome !== 'Passed').flatMap(eventLines),
    '[xUnit.net 00:00:00.35]   Finished:    Shop.Tests',
    '</StdOut>',
    '    </Output>',
  ];
}

/**
 * Relatório de `dotnet test --logger trx` (VSTest 17, xUnit 2, Linux) com os testes indicados.
 * @param {TrxTest[]} tests
 * @returns {string}
 */
function trxReport(tests) {
  const outcome = tests.some((entry) => entry.outcome === 'Failed') ? 'Failed' : 'Completed';
  return [
    ...HEAD,
    '  <Results>', ...tests.flatMap(resultLines), '  </Results>',
    '  <TestDefinitions>', ...tests.flatMap(definitionLines), '  </TestDefinitions>',
    '  <TestEntries>', ...tests.map(entryLine), '  </TestEntries>',
    ...TEST_LISTS,
    `  <ResultSummary outcome="${outcome}">`,
    countersLine(tests),
    ...summaryOutputLines(tests),
    '  </ResultSummary>',
    '</TestRun>',
    '',
  ].join('\n');
}

/**
 * Relatório com cinco testes: o ignorado conta em `total` mas não em `executed`, e
 * `notExecuted` fica a 0.
 */
const REPORT = trxReport(TESTS);

/**
 * Execução em que o `--filter` não escolheu nenhum teste: sem resultados, contagens a 0 e o
 * aviso do VSTest em `<RunInfos>`.
 */
const NO_TESTS = [
  ...HEAD,
  ...TEST_LISTS,
  '  <ResultSummary outcome="Completed">',
  countersLine([]),
  '    <RunInfos>',
  `      <RunInfo computerName="${MACHINE}" outcome="Warning"`
    + ' timestamp="2024-05-02T10:21:33.4518262+00:00">',
  '        <Text>No test matches the given testcase filter `FullyQualifiedName~Checkout` in '
    + `${ASSEMBLY}</Text>`,
  '      </RunInfo>',
  '    </RunInfos>',
  '  </ResultSummary>',
  '</TestRun>',
  '',
].join('\n');

/**
 * @param {string} text
 * @param {string} [field]
 * @returns {number}
 */
function run(text, field) {
  return extract({ format: FORMAT, path: 'reports/tests.trx', field }, text);
}

describe('trx', () => {
  test('declara os campos do contrato com tests por omissão', () => {
    assert.deepEqual([trxExtractor.fields, trxExtractor.defaultField], [
      ['tests', 'executed', 'passed', 'failed', 'skipped'],
      'tests',
    ]);
  });

  test('usa tests como campo por omissão', () => {
    assert.equal(run(REPORT), 5);
  });

  test('tests lê o total de <Counters>, que inclui o teste ignorado', () => {
    assert.equal(run(REPORT, 'tests'), 5);
  });

  test('executed lê o executed de <Counters>', () => {
    assert.equal(run(REPORT, 'executed'), 4);
  });

  test('passed lê o passed de <Counters>', () => {
    assert.equal(run(REPORT, 'passed'), 3);
  });

  test('failed lê o failed de <Counters>', () => {
    assert.equal(run(REPORT, 'failed'), 1);
  });

  test('skipped conta os <UnitTestResult> com outcome="NotExecuted" e não o notExecuted', () => {
    assert.equal(run(REPORT, 'skipped'), 1);
  });

  test('skipped é 0 quando nenhum teste foi ignorado', () => {
    const passing = TESTS.filter((entry) => entry.outcome === 'Passed');
    assert.equal(run(trxReport(passing), 'skipped'), 0);
  });

  test('skipped conta cada teste ignorado', () => {
    assert.equal(run(trxReport(TESTS.map(skipped)), 'skipped'), 5);
  });

  test('aceita a marca de ordem de bytes e fins de linha CRLF', () => {
    assert.equal(run(`﻿${REPORT.replaceAll('\n', '\r\n')}`, 'skipped'), 1);
  });

  test('relatório sem testes (total="0") dá extractor_report_empty', () => {
    assert.throws(() => run(NO_TESTS), EMPTY);
  });

  test('ficheiro vazio dá extractor_report_empty', () => {
    assert.throws(() => run('\r\n'), EMPTY);
  });

  test('raiz que não é <TestRun> dá reason_xml_root', () => {
    const junit = '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n  <testsuite '
      + 'name="Shop.Tests.dll" tests="5" skipped="1" failures="1" errors="0" time="0.35">\n'
      + '  </testsuite>\n</testsuites>\n';
    assert.throws(() => run(junit), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_xml_root', params: { found: 'testsuites', expected: 'TestRun' } },
      },
    });
  });

  test('texto sem elementos XML dá reason_xml_no_element', () => {
    const text = 'Failed!  - Failed:     1, Passed:     3, Skipped:     1, Total:     5, '
      + 'Duration: 350 ms - Shop.Tests.dll (net8.0)\n';
    assert.throws(() => run(text), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: { code: 'reason_xml_no_element', params: {} } },
    });
  });

  test('relatório sem <Counters> dá reason_trx_no_counters', () => {
    const text = REPORT.replace(countersLine(TESTS), '');
    assert.throws(() => run(text), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: { code: 'reason_trx_no_counters', params: {} } },
    });
  });

  test('atributo de <Counters> em falta dá reason_attribute_missing', () => {
    assert.throws(() => run(REPORT.replace(' executed="4"', ''), 'executed'), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: {
          code: 'reason_attribute_missing',
          params: { name: 'executed', element: 'Counters' },
        },
      },
    });
  });

  test('atributo de <Counters> que não é contagem dá reason_attribute_not_count', () => {
    assert.throws(() => run(REPORT.replace('failed="1"', 'failed="-1"'), 'failed'), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: {
          code: 'reason_attribute_not_count',
          params: { name: 'failed', value: '-1' },
        },
      },
    });
  });

  test('campo desconhecido dá extractor_field_unknown', () => {
    assert.throws(() => run(REPORT, 'errors'), {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: {
        format: FORMAT,
        field: 'errors',
        known: 'tests, executed, passed, failed, skipped',
      },
    });
  });
});
