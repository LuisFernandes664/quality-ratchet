// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extract } from '../../src/extractors/index.js';
import { junitExtractor } from '../../src/extractors/junit.js';

const FORMAT = 'junit';
const UNPARSEABLE = { name: 'ExtractorError', code: 'extractor_report_unparseable' };
const EMPTY = {
  name: 'ExtractorError',
  code: 'extractor_report_empty',
  params: { format: FORMAT },
};

/**
 * Relatório do Maven Surefire: `<testcase/>` auto-fechados e com filhos, CDATA com texto que
 * parece XML, `<flakyFailure>` e um comentário. 5 testes, 1 falha, 1 erro, 1 ignorado.
 */
const SUREFIRE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  [
    '<testsuite xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    ' xsi:noNamespaceSchemaLocation="https://maven.apache.org/surefire/maven-surefire-plugin',
    '/xsd/surefire-test-report-3.0.xsd" version="3.0" name="com.example.CalculatorTest"',
    ' time="0.052" tests="5" errors="1" skipped="1" failures="1">',
  ].join(''),
  '  <properties>',
  '    <property name="java.version" value="17.0.10"/>',
  '  </properties>',
  '  <testcase name="adds" classname="com.example.CalculatorTest" time="0.001"/>',
  '  <testcase name="divides" classname="com.example.CalculatorTest" time="0.004">',
  [
    '    <failure message="expected: &lt;2&gt; but was: &lt;3&gt;"',
    ' type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError:',
    ' expected: <2> but was: <3>\n\tat com.example.CalculatorTest.divides(CalculatorTest.java:21)',
    '\n]]></failure>',
  ].join(''),
  '    <system-out><![CDATA[<testcase name="fake"/> <failure/> escrito pelo teste]]></system-out>',
  '  </testcase>',
  '  <testcase name="parses" classname="com.example.CalculatorTest" time="0.002">',
  [
    '    <error message="Index 3 out of bounds for length 3"',
    ' type="java.lang.ArrayIndexOutOfBoundsException"><![CDATA[java.lang.',
    'ArrayIndexOutOfBoundsException: Index 3 out of bounds for length 3]]></error>',
  ].join(''),
  '  </testcase>',
  '  <testcase name="retries" classname="com.example.CalculatorTest" time="0.010">',
  '    <flakyFailure message="timeout" type="java.lang.AssertionError"/>',
  '    <rerunFailure message="timeout" type="java.lang.AssertionError"/>',
  '  </testcase>',
  '  <testcase name="rounds" classname="com.example.CalculatorTest" time="0">',
  '    <skipped message="@Disabled"/>',
  '  </testcase>',
  '  <!-- <testcase name="removed"><failure/></testcase> -->',
  '</testsuite>',
  '',
].join('\n');

/** Relatório do jest-junit: `<testsuites>` com dois `<testsuite>`. 5 testes, 1 falha. */
const JEST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<testsuites name="jest tests" tests="5" failures="1" errors="0" time="1.284">',
  [
    '  <testsuite name="math" errors="0" failures="1" skipped="1"',
    ' timestamp="2024-05-02T10:21:33" time="0.912" tests="4">',
  ].join(''),
  '    <testcase classname="math add soma" name="math add soma" time="0.003">',
  '    </testcase>',
  '    <testcase classname="math add negativos" name="math add negativos" time="0.001">',
  '    </testcase>',
  '    <testcase classname="math divide zero" name="math divide zero" time="0.006">',
  '      <failure>Error: expect(received).toThrow()',
  '',
  'Received function did not throw',
  '    at Object.&lt;anonymous&gt; (/home/runner/work/app/app/test/math.test.js:14:31)</failure>',
  '    </testcase>',
  '    <testcase classname="math pow" name="math pow" time="0">',
  '      <skipped/>',
  '    </testcase>',
  '  </testsuite>',
  [
    '  <testsuite name="format" errors="0" failures="0" skipped="0"',
    ' timestamp="2024-05-02T10:21:34" time="0.372" tests="1">',
  ].join(''),
  '    <testcase classname="format pad" name="format pad" time="0.002">',
  '    </testcase>',
  '  </testsuite>',
  '</testsuites>',
].join('\n');

/** Relatório do pytest (`--junitxml`), numa só linha. 4 testes, 1 falha, 1 erro, 1 ignorado. */
const PYTEST = [
  '<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="1"',
  ' failures="1" skipped="1" tests="4" time="0.412" timestamp="2024-05-02T10:21:33.123456"',
  ' hostname="runner"><testcase classname="tests.test_api" name="test_list" time="0.004" />',
  '<testcase classname="tests.test_api" name="test_delete" time="0.005"><failure',
  ' message="assert 404 == 204">def test_delete(client):\n&gt;       assert 404 == 204\nE',
  '       assert 404 == 204</failure></testcase><testcase classname="tests.test_api"',
  ' name="test_upload" time="0.000"><skipped type="pytest.skip" message="sem rede">',
  '/home/runner/work/app/tests/test_api.py:31: sem rede</skipped></testcase><testcase',
  ' classname="tests.test_db" name="test_migrate" time="0.001"><error message="failed on',
  ' setup with &quot;OperationalError&quot;">E   OperationalError: no such table</error>',
  '</testcase></testsuite></testsuites>',
].join('');

/**
 * @param {string} text
 * @param {string} [field]
 * @returns {number}
 */
function run(text, field) {
  return extract({ format: FORMAT, path: 'target/surefire-reports/TEST-app.xml', field }, text);
}

describe('junit', () => {
  test('declara os campos do contrato com tests por omissão', () => {
    assert.deepEqual([junitExtractor.fields, junitExtractor.defaultField], [
      ['tests', 'failures', 'errors', 'skipped'],
      'tests',
    ]);
  });

  test('usa tests como campo por omissão', () => {
    assert.equal(run(SUREFIRE), 5);
  });

  test('tests conta os <testcase>', () => {
    assert.equal(run(JEST, 'tests'), 5);
  });

  test('failures conta os <failure>', () => {
    assert.equal(run(JEST, 'failures'), 1);
  });

  test('errors conta os <error>', () => {
    assert.equal(run(PYTEST, 'errors'), 1);
  });

  test('skipped conta os <skipped/> auto-fechados', () => {
    assert.equal(run(SUREFIRE, 'skipped'), 1);
  });

  test('skipped conta os <skipped> com conteúdo', () => {
    assert.equal(run(PYTEST, 'skipped'), 1);
  });

  test('conta <testcase ... /> auto-fechados', () => {
    assert.equal(run('<testsuite><testcase name="a"/><testcase name="b" /></testsuite>'), 2);
  });

  test('conta <testcase> com filhos uma única vez', () => {
    assert.equal(run('<testsuite><testcase name="a">\n</testcase></testsuite>'), 1);
  });

  test('lê relatórios numa só linha', () => {
    assert.equal(run(PYTEST), 4);
  });

  test('ignora elementos dentro de comentários e de CDATA', () => {
    assert.equal(run(SUREFIRE, 'failures'), 1);
  });

  test('não confunde <flakyFailure> e <rerunFailure> com <failure>', () => {
    const text = SUREFIRE.replace(/<failure [\s\S]*?<\/failure>/, '');
    assert.equal(run(text, 'failures'), 0);
  });

  test('relatório sem <testcase> dá extractor_report_empty', () => {
    const text = '<?xml version="1.0"?>\n<testsuites tests="0" failures="0" errors="0" time="0">'
      + '\n</testsuites>\n';
    assert.throws(() => run(text), EMPTY);
  });

  test('documento sem <testsuite> nem <testsuites> dá extractor_report_unparseable', () => {
    assert.throws(() => run('<html><body><testcase/></body></html>'), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: 'no <testsuites> or <testsuite> element found' },
    });
  });

  test('ficheiro vazio dá extractor_report_empty', () => {
    assert.throws(() => run(''), EMPTY);
  });

  test('ficheiro só com espaços e fins de linha dá extractor_report_empty', () => {
    assert.throws(() => run('\r\n  \r\n'), EMPTY);
  });

  test('aceita a marca de ordem de bytes e fins de linha CRLF', () => {
    assert.equal(run(`\uFEFF${JEST.replaceAll('\n', '\r\n')}`, 'failures'), 1);
  });

  test('campo desconhecido dá extractor_field_unknown', () => {
    assert.throws(() => run(JEST, 'passed'), {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: { format: FORMAT, field: 'passed', known: 'tests, failures, errors, skipped' },
    });
  });
});
