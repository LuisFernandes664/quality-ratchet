// @ts-check
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

describe('mensagens', () => {
  const limit = { name: 'mut', value: 50, field: 'min', limit: 60 };

  test('o aviso de valor fora do limite nao promete falha permanente', () => {
    assert.equal(
      createTranslator('en')('value_violates_limit', limit),
      'the baseline value of "mut" (50) already breaks its min of 60; runs fail while the '
        + 'measured value stays outside it',
    );
  });

  test('em portugues o aviso de valor fora do limite tambem nao', () => {
    assert.equal(
      createTranslator('pt')('value_violates_limit', limit),
      'o valor de "mut" no baseline (50) já viola o min de 60; as execuções falham enquanto o '
        + 'valor medido estiver fora dele',
    );
  });

  test('o titulo do pull request aparece num code span', () => {
    const text = createTranslator('en')('reason_title', { title: 'chore: lower @org/team' });

    assert.equal(text, 'pull request title `chore: lower @org/team`');
  });

  test('o titulo do pull request com crases continua num code span', () => {
    const text = createTranslator('pt')('reason_title', { title: 'fix `x`' });

    assert.equal(text, 'título do pull request `` fix `x` ``');
  });

  test('o veredicto verde nao nega regressoes toleradas', () => {
    assert.equal(
      createTranslator('en')('verdict_passed'),
      'Ratchet green. No metric regressed beyond its tolerance.',
    );
  });

  test('em portugues o veredicto verde tambem nao', () => {
    assert.equal(
      createTranslator('pt')('verdict_passed'),
      'Catraca verde. Nenhuma métrica regrediu além da tolerância.',
    );
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
