// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { BaselineError, MetricsError } from '../src/core/errors.js';
import { runRatchet } from '../src/core/ratchet.js';
import { collectMeasurements, loadBaseline, parseJsonText } from '../src/run.js';
import { v2 } from './helpers.js';

/**
 * Sistema de ficheiros em memória.
 * @param {Record<string, string>} files caminho absoluto ou relativo -> conteúdo
 */
function memoryFs(files) {
  const resolved = new Map(Object.entries(files).map(([p, text]) => [path.resolve(p), text]));
  return {
    exists: async (/** @type {string} */ p) => resolved.has(path.resolve(p)),
    readText: async (/** @type {string} */ p) => {
      const text = resolved.get(path.resolve(p));
      if (text === undefined) throw new Error(`ENOENT: ${p}`);
      return text;
    },
  };
}

const LCOV = 'SF:a.js\nLF:10\nLH:7\nend_of_record\n';

/** Relatório lcov com 50% de linhas cobertas. */
const LCOV_HALF = 'SF:a.js\nLF:10\nLH:5\nend_of_record\n';

/** Relatório JUnit do Vitest: um teste falhado com três `expect.soft`, um `<failure>` cada. */
const JUNIT_ONE_FAILED = '<testsuites><testsuite name="a" tests="2" failures="1">'
  + '<testcase name="soft"><failure message="1"/><failure message="2"/>'
  + '<failure message="3"/></testcase><testcase name="ok"/></testsuite></testsuites>';

/** Relatório JUnit com dois testes falhados, cada um com um só `<failure>`. */
const JUNIT_TWO_FAILED = '<testsuites><testsuite name="a" tests="2" failures="2">'
  + '<testcase name="soft"><failure message="1"/></testcase>'
  + '<testcase name="ok"><failure message="1"/></testcase></testsuite></testsuites>';

/**
 * Relatório de uma métrica com source, lido por collectMeasurements e avaliado pela catraca.
 * @param {Record<string, unknown>} rule regra da métrica, sem a source
 * @param {{format: string, path: string, field?: string}} source
 * @param {string} report conteúdo do relatório
 * @returns {Promise<import('../src/core/types.js').Report>}
 */
async function ratchetFromReport(rule, source, report) {
  const head = v2({ m: { ...rule, source } });
  const fs = memoryFs({ [source.path]: report });
  const { measurements } = await collectMeasurements(fs, head, { baselineDir: '.' });
  return runRatchet({ head, base: null, measurements });
}

describe('parseJsonText', () => {
  test('ignora o BOM UTF-8 inicial', () => {
    assert.deepEqual(parseJsonText('﻿{"a":1}', 'x.json', MetricsError), { a: 1 });
  });

  test('JSON invalido lanca a classe de erro indicada', () => {
    assert.throws(
      () => parseJsonText('{', 'x.json', BaselineError),
      (error) => error instanceof BaselineError && error.code === 'json_invalid',
    );
  });
});

describe('loadBaseline', () => {
  test('le e valida o baseline', async () => {
    const fs = memoryFs({ 'q.json': '{"metrics":{"a":{"value":1,"direction":"up"}}}' });

    assert.equal((await loadBaseline(fs, 'q.json')).metrics[0].name, 'a');
  });

  test('ficheiro inexistente e erro de baseline ilegivel', async () => {
    await assert.rejects(
      loadBaseline(memoryFs({}), 'q.json'),
      (error) => error instanceof BaselineError && error.code === 'file_unreadable',
    );
  });
});

describe('collectMeasurements', () => {
  const plain = v2({ a: { value: 1, direction: 'up' } });
  const sourced = v2({
    cov: { value: 1, direction: 'up', source: { format: 'lcov', path: 'coverage/lcov.info' } },
  });

  test('le o ficheiro de metricas plano', async () => {
    const fs = memoryFs({ 'm.json': '{"a": 2}' });

    const { measurements } = await collectMeasurements(fs, plain, {
      metricsPath: 'm.json', baselineDir: '.',
    });

    assert.deepEqual(measurements, { a: { value: 2, origin: 'file' } });
  });

  test('lista as metricas medidas que o baseline nao segue', async () => {
    const fs = memoryFs({ 'm.json': '{"a": 2, "b": 3}' });

    const { untracked } = await collectMeasurements(fs, plain, {
      metricsPath: 'm.json', baselineDir: '.',
    });

    assert.deepEqual(untracked, ['b']);
  });

  test('ficheiro de metricas em falta com metricas sem source e erro', async () => {
    await assert.rejects(
      collectMeasurements(memoryFs({}), plain, { metricsPath: 'm.json', baselineDir: '.' }),
      (error) => error instanceof MetricsError && error.code === 'metrics_file_missing',
    );
  });

  test('ficheiro de metricas pode faltar quando todas tem source', async () => {
    const fs = memoryFs({ 'pkg/coverage/lcov.info': LCOV });

    const { measurements } = await collectMeasurements(fs, sourced, {
      metricsPath: 'm.json', baselineDir: 'pkg',
    });

    assert.deepEqual(measurements.cov, { origin: 'source', value: 70 });
  });

  test('a source e resolvida a partir da pasta do baseline', async () => {
    const fs = memoryFs({ 'coverage/lcov.info': LCOV });

    const { measurements } = await collectMeasurements(fs, sourced, { baselineDir: 'pkg' });

    assert.equal(measurements.cov.error?.code, 'report_not_found');
  });

  test('relatorio ilegivel fica como metrica em falta com o motivo', async () => {
    const fs = memoryFs({ 'coverage/lcov.info': 'lixo sem totais' });

    const { measurements } = await collectMeasurements(fs, sourced, { baselineDir: '.' });

    assert.equal(measurements.cov.error?.code, 'extractor_report_unparseable');
  });

  test('caminho da source com * nao e expandido: relatorio nao encontrado', async () => {
    const junit = { format: 'junit', path: 'target/TEST-*.xml' };
    const fs = memoryFs({ 'target/TEST-a.xml': JUNIT_TWO_FAILED });

    const { measurements } = await collectMeasurements(
      fs,
      v2({ tests: { value: 1, direction: 'up', source: junit } }),
      { baselineDir: '.' },
    );

    assert.deepEqual(measurements.tests.error, {
      code: 'report_not_found',
      params: { path: 'target/TEST-*.xml' },
    });
  });

  test('metrica que vem do ficheiro e da source e erro', async () => {
    const fs = memoryFs({ 'm.json': '{"cov": 1}', 'coverage/lcov.info': LCOV });

    await assert.rejects(
      collectMeasurements(fs, sourced, { metricsPath: 'm.json', baselineDir: '.' }),
      (error) => error instanceof MetricsError && error.code === 'metric_defined_twice',
    );
  });
});

describe('collectMeasurements com o baseline do ramo base', () => {
  const lcov = { format: 'lcov', path: 'coverage/lcov.info' };
  const fake = { format: 'json', path: 'fake.json', pointer: '/v' };
  const base = v2({
    cov: { value: 80, direction: 'up', source: lcov },
    lint: { value: 3, direction: 'down' },
  });
  const files = { 'coverage/lcov.info': LCOV_HALF, 'fake.json': '{"v": 99}', 'm.json': '{}' };

  /**
   * Medições de um PR com o baseline indicado.
   * @param {Record<string, Record<string, unknown>>} metrics
   * @param {Record<string, string>} [extraFiles]
   */
  const collect = (metrics, extraFiles = {}) => collectMeasurements(
    memoryFs({ ...files, ...extraFiles }),
    v2(metrics),
    { metricsPath: 'm.json', baselineDir: '.', base },
  );

  test('sem baseline do ramo base nao ha medicoes do ramo base', async () => {
    const { baseMeasurements } = await collectMeasurements(memoryFs(files), base, {
      metricsPath: 'm.json', baselineDir: '.',
    });

    assert.deepEqual(baseMeasurements, {});
  });

  test('a source que o PR trocou e medida tambem com a source do ramo base', async () => {
    const { baseMeasurements } = await collect({
      cov: { value: 80, direction: 'up', source: fake },
      lint: { value: 3, direction: 'down' },
    });

    assert.deepEqual(baseMeasurements.cov, { origin: 'source', value: 50 });
  });

  test('a medicao com a source do PR continua nas medicoes normais', async () => {
    const { measurements } = await collect({
      cov: { value: 80, direction: 'up', source: fake },
      lint: { value: 3, direction: 'down' },
    });

    assert.deepEqual(measurements.cov, { origin: 'source', value: 99 });
  });

  test('a source que o PR retirou e medida com a source do ramo base', async () => {
    const { baseMeasurements } = await collect(
      { cov: { value: 80, direction: 'up' }, lint: { value: 3, direction: 'down' } },
      { 'm.json': '{"cov": 99}' },
    );

    assert.deepEqual(baseMeasurements.cov, { origin: 'source', value: 50 });
  });

  test('metrica retirada pelo PR com source e medida pela source do ramo base', async () => {
    const { baseMeasurements } = await collect({ lint: { value: 3, direction: 'down' } });

    assert.deepEqual(baseMeasurements.cov, { origin: 'source', value: 50 });
  });

  test('metrica a que o PR acrescentou source fica sem valor do ficheiro', async () => {
    const { baseMeasurements } = await collect({
      cov: { value: 80, direction: 'up', source: lcov },
      lint: { value: 3, direction: 'down', source: fake },
    });

    assert.deepEqual(baseMeasurements.lint, { origin: 'file' });
  });

  test('source igual nao e medida outra vez', async () => {
    const { baseMeasurements } = await collect({
      cov: { value: 80, direction: 'up', source: lcov },
      lint: { value: 3, direction: 'down' },
    });

    assert.deepEqual(baseMeasurements, {});
  });

  test('relatorio da source do ramo base em falta fica com o motivo', async () => {
    const { baseMeasurements } = await collectMeasurements(
      memoryFs({ 'fake.json': '{"v": 99}', 'm.json': '{}' }),
      v2({ cov: { value: 80, direction: 'up', source: fake } }),
      { metricsPath: 'm.json', baselineDir: '.', base },
    );

    assert.equal(baseMeasurements.cov.error?.code, 'report_not_found');
  });
});

describe('collectMeasurements e runRatchet de ponta a ponta', () => {
  const junit = { format: 'junit', path: 'report.xml', field: 'failures' };

  test('junit: de um teste falhado para dois e regressao', async () => {
    const base = await ratchetFromReport({ value: 0, direction: 'down' }, junit, JUNIT_ONE_FAILED);
    const value = base.outcome.results[0].after;

    const report = await ratchetFromReport({ value, direction: 'down' }, junit, JUNIT_TWO_FAILED);

    const row = report.outcome.results[0];
    assert.deepEqual([row.status, row.before, row.after], ['regressed', 1, 2]);
  });

  test('cobertura: 20002 de 20003 linhas com line-rate 1 fica abaixo do minimo 100', async () => {
    const xml = '<?xml version="1.0" ?><coverage version="7.6" line-rate="1" '
      + 'lines-covered="20002" lines-valid="20003" branch-rate="0"></coverage>';
    const cobertura = { format: 'cobertura', path: 'coverage.xml' };

    const report = await ratchetFromReport({ value: 100, direction: 'up', min: 100 }, cobertura,
      xml);

    assert.equal(report.outcome.results[0].detail?.code, 'below_min');
  });

  test('pip-audit: projecto sem dependencias passa com max 0', async () => {
    const pipAudit = { format: 'pip-audit', path: 'pip-audit.json' };

    const report = await ratchetFromReport({ value: 0, direction: 'down', max: 0 }, pipAudit,
      '{"dependencies":[],"fixes":[]}');

    assert.equal(report.passed, true);
  });
});
