// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extract } from '../../src/extractors/index.js';
import { jsonExtractor } from '../../src/extractors/json.js';

const FORMAT = 'json';
const UNPARSEABLE = { name: 'ExtractorError', code: 'extractor_report_unparseable' };
const POINTER_INVALID = { name: 'ExtractorError', code: 'extractor_option_invalid' };

/** Relatório de métricas próprio de um projecto, com vários tipos de valor. */
const REPORT = JSON.stringify({
  bundle: { sizes: { 'main.js': 183422, 'vendor.js': '402113' } },
  lighthouse: { categories: { performance: { score: 0.92 } } },
  series: [10, 20, 30],
  todo: ['migrar módulo de pagamentos', 'remover flag antiga', 'rever logs'],
  'a/b': { 'm~n': 7 },
  flags: { strict: true, owner: null, note: 'n/a', size: '12px', nested: {} },
});

/**
 * @param {string} text
 * @param {Partial<import('../../src/core/types.js').MetricSource>} options
 * @returns {number}
 */
function run(text, options) {
  return extract({ format: FORMAT, path: 'metrics/custom.json', ...options }, text);
}

/**
 * Espera extractor_report_unparseable para o ponteiro indicado sobre REPORT.
 * @param {string} pointer
 * @returns {void}
 */
function assertUnparseable(pointer) {
  assert.throws(() => run(REPORT, { pointer }), UNPARSEABLE);
}

describe('json', () => {
  test('declara apenas o campo value', () => {
    assert.deepEqual([jsonExtractor.fields, jsonExtractor.defaultField], [['value'], 'value']);
  });

  test('usa value como campo por omissão', () => {
    assert.equal(run(REPORT, { pointer: '/lighthouse/categories/performance/score' }), 0.92);
  });

  test('value lê um número', () => {
    assert.equal(run(REPORT, { field: 'value', pointer: '/bundle/sizes/main.js' }), 183422);
  });

  test('value converte uma string numérica estrita', () => {
    assert.equal(run(REPORT, { pointer: '/bundle/sizes/vendor.js' }), 402113);
  });

  test('value conta os elementos de um array', () => {
    assert.equal(run(REPORT, { pointer: '/todo' }), 3);
  });

  test('segue índices de array', () => {
    assert.equal(run(REPORT, { pointer: '/series/2' }), 30);
  });

  test('desfaz os escapes ~1 e ~0 da RFC 6901', () => {
    assert.equal(run(REPORT, { pointer: '/a~1b/m~0n' }), 7);
  });

  test('o ponteiro vazio refere o documento inteiro', () => {
    assert.equal(run('[1, 2, 3, 4]', { pointer: '' }), 4);
  });

  test('ponteiro em falta dá extractor_option_invalid', () => {
    assert.throws(() => run(REPORT, {}), {
      ...POINTER_INVALID,
      params: { format: FORMAT, option: 'pointer', reason: 'missing' },
    });
  });

  test('ponteiro sem "/" inicial dá extractor_option_invalid', () => {
    assert.throws(() => run(REPORT, { pointer: 'bundle.sizes' }), POINTER_INVALID);
  });

  test('ponteiro com escape inválido dá extractor_option_invalid', () => {
    assert.throws(() => run(REPORT, { pointer: '/a~2b' }), POINTER_INVALID);
  });

  test('valida o ponteiro antes de interpretar o relatório', () => {
    assert.throws(() => run('{"a":', { pointer: 'a' }), POINTER_INVALID);
  });

  test('caminho inexistente dá extractor_report_unparseable', () => {
    assert.throws(() => run(REPORT, { pointer: '/bundle/sizes/app.js' }), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: 'pointer "/bundle/sizes/app.js" does not exist' },
    });
  });

  test('índice fora do array dá extractor_report_unparseable', () => {
    assertUnparseable('/series/3');
  });

  test('propriedade herdada dá extractor_report_unparseable', () => {
    assertUnparseable('/bundle/constructor');
  });

  test('booleano dá extractor_report_unparseable', () => {
    assertUnparseable('/flags/strict');
  });

  test('null dá extractor_report_unparseable', () => {
    assertUnparseable('/flags/owner');
  });

  test('objecto dá extractor_report_unparseable', () => {
    assert.throws(() => run(REPORT, { pointer: '/flags/nested' }), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: 'value at "/flags/nested" is not numeric (found object)' },
    });
  });

  test('string não numérica dá extractor_report_unparseable', () => {
    assertUnparseable('/flags/note');
  });

  test('string com número e texto dá extractor_report_unparseable', () => {
    assertUnparseable('/flags/size');
  });

  test('número não finito dá extractor_report_unparseable', () => {
    assert.throws(() => run('{"total": 1e999}', { pointer: '/total' }), UNPARSEABLE);
  });

  test('string numérica não finita dá extractor_report_unparseable', () => {
    assert.throws(() => run('{"total": "1e999"}', { pointer: '/total' }), UNPARSEABLE);
  });

  test('JSON inválido dá extractor_report_unparseable', () => {
    assert.throws(() => run("{'total': 3}", { pointer: '/total' }), UNPARSEABLE);
  });

  test('campo desconhecido dá extractor_field_unknown', () => {
    assert.throws(() => run(REPORT, { field: 'count', pointer: '/todo' }), {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: { format: FORMAT, field: 'count', known: 'value' },
    });
  });
});
