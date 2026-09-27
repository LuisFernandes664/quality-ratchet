// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { MetricsError } from '../../src/core/errors.js';
import { parseMetricsFile, toNumber } from '../../src/core/measurements.js';

describe('toNumber', () => {
  test('aceita numeros finitos', () => {
    assert.equal(toNumber(7.5), 7.5);
  });

  test('aceita strings numericas vindas de scripts de shell', () => {
    assert.equal(toNumber(' 7.0\n'), 7);
  });

  test('aceita notacao cientifica', () => {
    assert.equal(toNumber('1e-3'), 0.001);
  });

  test('rejeita strings com texto', () => {
    assert.equal(toNumber('7%'), null);
  });

  test('rejeita string vazia', () => {
    assert.equal(toNumber(''), null);
  });

  test('rejeita NaN e infinito', () => {
    assert.deepEqual([toNumber(Number.NaN), toNumber(Infinity)], [null, null]);
  });

  test('rejeita strings que transbordam para infinito', () => {
    assert.deepEqual([toNumber('1e400'), toNumber('-1e999'), toNumber(' 1e309 ')], [
      null,
      null,
      null,
    ]);
  });

  test('aceita o maior numero finito escrito como string', () => {
    assert.equal(toNumber('1.7976931348623157e308'), Number.MAX_VALUE);
  });

  test('rejeita null e booleanos', () => {
    assert.deepEqual([toNumber(null), toNumber(true)], [null, null]);
  });
});

describe('parseMetricsFile', () => {
  test('converte cada entrada numa medicao vinda do ficheiro', () => {
    assert.deepEqual(parseMetricsFile({ a: 1 }, 'm.json'), { a: { value: 1, origin: 'file' } });
  });

  test('rejeita arrays', () => {
    assert.throws(
      () => parseMetricsFile([1], 'm.json'),
      (error) => error instanceof MetricsError && error.code === 'metrics_not_object',
    );
  });
});
