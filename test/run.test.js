import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { BaselineError, MetricsError } from '../src/core/errors.js';
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

  test('metrica que vem do ficheiro e da source e erro', async () => {
    const fs = memoryFs({ 'm.json': '{"cov": 1}', 'coverage/lcov.info': LCOV });

    await assert.rejects(
      collectMeasurements(fs, sourced, { metricsPath: 'm.json', baselineDir: '.' }),
      (error) => error instanceof MetricsError && error.code === 'metric_defined_twice',
    );
  });
});
