import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { BaselineError, ConfigError } from '../../src/core/errors.js';
import {
  catalogKeys,
  createTranslator,
  describeError,
  normaliseLanguage,
} from '../../src/core/messages.js';

describe('catalogo', () => {
  test('ingles e portugues tem exactamente os mesmos codigos', () => {
    const { en, pt } = catalogKeys();

    assert.deepEqual(pt, en);
  });
});

describe('normaliseLanguage', () => {
  test('aceita variantes regionais', () => {
    assert.deepEqual([normaliseLanguage('pt-PT'), normaliseLanguage('EN_us')], ['pt', 'en']);
  });

  test('lingua desconhecida e erro de configuracao', () => {
    assert.throws(() => normaliseLanguage('fr'), ConfigError);
  });
});

describe('createTranslator', () => {
  test('interpola os parametros', () => {
    const text = createTranslator('pt')('report_not_found', { path: 'a' });

    assert.equal(text, 'relatório não encontrado: a');
  });

  test('codigo desconhecido devolve o codigo e os parametros', () => {
    assert.equal(createTranslator('en')('nope', { a: 1 }), 'nope {"a":1}');
  });

  test('codigo herdado do prototipo nao e tratado como mensagem', () => {
    assert.equal(createTranslator('en')('toString'), 'toString {}');
  });
});

describe('describeError', () => {
  test('erros do projecto passam pelo catalogo, com a lista de problemas', () => {
    const error = new BaselineError('baseline_invalid', {
      issues: [{ code: 'baseline_no_metrics', params: {} }],
    });

    assert.equal(
      describeError(error, createTranslator('en')),
      'The baseline is invalid:\n- the baseline has no metrics',
    );
  });

  test('outros erros mantem a mensagem', () => {
    assert.equal(describeError(new TypeError('x'), createTranslator('en')), 'x');
  });
});
