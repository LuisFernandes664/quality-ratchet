// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BaselineError, ConfigError } from '../../src/core/errors.js';
import {
  catalogKeys,
  createTranslator,
  describeError,
  normaliseLanguage,
} from '../../src/core/messages.js';
import { REASON_CODES } from '../../src/extractors/shared.js';

/** Pasta do código de produção. */
const SOURCE_DIR = fileURLToPath(new URL('../../src/', import.meta.url));

/**
 * Formas de uso de um código de mensagem no código de produção: `new <Classe>Error(`
 * (incluindo a classe recebida por parâmetro, `new ErrorClass(`), `t(`, `code:`,
 * `because(`, e os auxiliares do core `note(`, `issue(`, `log.error(` e `log.warn(`.
 */
const CALL_SHAPES = [
  String.raw`\bnew\s+\w*Error\w*\(`,
  String.raw`\bt\(`,
  String.raw`\bcode:`,
  String.raw`\bbecause\(`,
  String.raw`\bnote\(`,
  String.raw`\bissue\(`,
  String.raw`\blog\.(?:error|warn)\(`,
];

/** Código passado como literal numa das formas de uso. */
const USED_CODE = new RegExp(`(?:${CALL_SHAPES.join('|')})\\s*'([^']*)'`, 'g');

/** Comentários de bloco (JSDoc), que podem ter exemplos que não são código. */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

/**
 * Códigos de mensagem usados no código de produção (src/**\/*.js), sem repetições.
 * @returns {Promise<string[]>}
 */
async function usedCodes() {
  const names = (await readdir(SOURCE_DIR, { recursive: true })).filter((name) => (
    name.endsWith('.js')));
  const texts = await Promise.all(names.map((name) => readFile(path.join(SOURCE_DIR, name),
    'utf8')));
  const source = texts.join('\n').replace(BLOCK_COMMENT, '');
  return [...new Set([...source.matchAll(USED_CODE)].map(([, code]) => code))].sort();
}

describe('catalogo', () => {
  test('ingles e portugues tem exactamente os mesmos codigos', () => {
    const { en, pt } = catalogKeys();

    assert.deepEqual(pt, en);
  });

  test('os motivos dos extractors existem no catalogo ingles', () => {
    const { en } = catalogKeys();

    assert.deepEqual(REASON_CODES.filter((code) => !en.includes(code)), []);
  });

  test('os motivos dos extractors existem no catalogo portugues', () => {
    const { pt } = catalogKeys();

    assert.deepEqual(REASON_CODES.filter((code) => !pt.includes(code)), []);
  });

  test('a recolha de codigos no codigo de producao encontra cada forma de uso', async () => {
    const used = await usedCodes();
    const expected = ['baseline_invalid', 'metrics_file_missing', 'log_passed',
      'report_not_found', 'reason_not_array', 'note_bypassed', 'metric_not_reported',
      'baseline_no_rules', 'metric_without_rule'];

    assert.deepEqual(expected.filter((code) => !used.includes(code)), []);
  });

  test('os codigos usados no codigo de producao existem no catalogo ingles', async () => {
    const { en } = catalogKeys();

    assert.deepEqual((await usedCodes()).filter((code) => !en.includes(code)), []);
  });

  test('os codigos usados no codigo de producao existem no catalogo portugues', async () => {
    const { pt } = catalogKeys();

    assert.deepEqual((await usedCodes()).filter((code) => !pt.includes(code)), []);
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

describe('motivos dos erros dos extractors', () => {
  const sarifArray = {
    format: 'sarif',
    reason: { code: 'reason_not_array', params: { path: 'runs' } },
  };

  test('o motivo do catalogo sai traduzido em portugues', () => {
    assert.equal(
      createTranslator('pt')('extractor_report_unparseable', sarifArray),
      'não foi possível interpretar o relatório sarif: "runs" não é uma lista',
    );
  });

  test('em portugues o motivo nao sai em ingles nem como objecto', () => {
    const text = createTranslator('pt')('extractor_report_unparseable', sarifArray);

    assert.doesNotMatch(text, /is not an array|\[object Object\]/);
  });

  test('um motivo em texto sai sem alteracoes', () => {
    const reason = 'Unexpected token } in JSON at position 1';
    const params = { format: 'json', reason };

    assert.equal(
      createTranslator('pt')('extractor_report_unparseable', params),
      `não foi possível interpretar o relatório json: ${reason}`,
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
