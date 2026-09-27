// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ExtractorError } from '../../src/core/errors.js';
import {
  countTags,
  defineExtractor,
  ensureFinite,
  parseJson,
  parsePointer,
  parseStrictNumber,
  percentage,
  readCount,
  readNumber,
  requireContent,
  resolvePointer,
} from '../../src/extractors/shared.js';

const UNPARSEABLE = { name: 'ExtractorError', code: 'extractor_report_unparseable' };
const EMPTY = { name: 'ExtractorError', code: 'extractor_report_empty' };
const POINTER_INVALID = {
  name: 'ExtractorError',
  code: 'extractor_option_invalid',
  params: { format: 'json', option: 'pointer', reason: 'missing' },
};

/**
 * Extractor de teste que devolve o valor fixo recebido e regista o campo pedido.
 * @param {number} value
 * @param {string[]} seen campos entregues à leitura
 */
function fakeExtractor(value, seen = []) {
  return defineExtractor({
    format: 'fake',
    fields: ['first', 'second'],
    read: (_text, request) => {
      seen.push(request.field);
      return value;
    },
  });
}

describe('parseJson', () => {
  test('interpreta um documento JSON válido', () => {
    assert.deepEqual(parseJson('{"a":[1,2]}', 'x'), { a: [1, 2] });
  });

  test('ignora a marca de ordem de bytes no início do ficheiro', () => {
    assert.deepEqual(parseJson('\uFEFF{"a":1}', 'x'), { a: 1 });
  });

  test('ficheiro vazio dá extractor_report_empty e não um erro de JSON', () => {
    assert.throws(() => parseJson('', 'eslint'), { ...EMPTY, params: { format: 'eslint' } });
  });

  test('converte JSON inválido em extractor_report_unparseable com motivo e causa', () => {
    assert.throws(() => parseJson('{"a":', 'eslint'), (error) => {
      assert.ok(error instanceof ExtractorError);
      assert.equal(error.code, 'extractor_report_unparseable');
      assert.equal(error.params.format, 'eslint');
      assert.equal(typeof error.params.reason, 'string');
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    });
  });
});

describe('percentage', () => {
  test('devolve a percentagem entre 0 e 100', () => {
    assert.equal(percentage(7, 8, 'x'), 87.5);
  });

  test('não arredonda o resultado', () => {
    assert.ok(Math.abs(percentage(1, 3, 'x') - 100 / 3) < 1e-12);
  });

  test('devolve o número mais próximo do valor exacto (57/100 dá 57)', () => {
    assert.equal(percentage(57, 100, 'x'), 57);
  });

  test('denominador 0 dá extractor_report_empty', () => {
    assert.throws(() => percentage(0, 0, 'lcov'), { ...EMPTY, params: { format: 'lcov' } });
  });

  test('parte maior do que o total dá extractor_report_unparseable', () => {
    assert.throws(() => percentage(5, 4, 'lcov'), {
      ...UNPARSEABLE,
      params: { format: 'lcov', reason: 'hit count 5 exceeds total 4' },
    });
  });
});

describe('requireContent', () => {
  test('devolve o texto sem alterações quando não há marca de ordem de bytes', () => {
    assert.equal(requireContent(' SF:a\n', 'x'), ' SF:a\n');
  });

  test('remove a marca de ordem de bytes inicial', () => {
    assert.equal(requireContent('\uFEFF{}', 'x'), '{}');
  });

  test('texto vazio dá extractor_report_empty', () => {
    assert.throws(() => requireContent('', 'junit'), { ...EMPTY, params: { format: 'junit' } });
  });

  test('texto só com espaços e fins de linha dá extractor_report_empty', () => {
    assert.throws(() => requireContent(' \r\n\t\n', 'x'), EMPTY);
  });

  test('texto só com a marca de ordem de bytes dá extractor_report_empty', () => {
    assert.throws(() => requireContent('\uFEFF\n', 'x'), EMPTY);
  });
});

describe('readNumber', () => {
  test('lê um número aninhado', () => {
    assert.equal(readNumber({ a: { b: 2.5 } }, ['a', 'b'], 'x'), 2.5);
  });

  test('chave em falta dá extractor_report_unparseable com o caminho', () => {
    assert.throws(() => readNumber({ a: {} }, ['a', 'b'], 'x'), {
      ...UNPARSEABLE,
      params: { format: 'x', reason: 'missing "a.b"' },
    });
  });

  test('ignora propriedades herdadas', () => {
    assert.throws(() => readNumber({}, ['toString'], 'x'), UNPARSEABLE);
  });

  test('rejeita valores não finitos', () => {
    assert.throws(() => readNumber({ a: Infinity }, ['a'], 'x'), UNPARSEABLE);
  });

  test('rejeita strings numéricas', () => {
    assert.throws(() => readNumber({ a: '3' }, ['a'], 'x'), UNPARSEABLE);
  });
});

describe('readCount', () => {
  test('lê um inteiro não negativo', () => {
    assert.equal(readCount({ a: 4 }, ['a'], 'x'), 4);
  });

  test('rejeita contagens negativas', () => {
    assert.throws(() => readCount({ a: -1 }, ['a'], 'x'), UNPARSEABLE);
  });

  test('rejeita contagens fraccionárias', () => {
    assert.throws(() => readCount({ a: 1.5 }, ['a'], 'x'), UNPARSEABLE);
  });
});

describe('ensureFinite', () => {
  test('devolve números finitos sem alteração', () => {
    assert.equal(ensureFinite(-0.25, 'x'), -0.25);
  });

  test('NaN dá extractor_report_unparseable', () => {
    assert.throws(() => ensureFinite(Number.NaN, 'x'), UNPARSEABLE);
  });

  test('Infinity dá extractor_report_unparseable', () => {
    assert.throws(() => ensureFinite(-Infinity, 'x'), UNPARSEABLE);
  });
});

describe('parseStrictNumber', () => {
  test('aceita inteiros, decimais, negativos e expoentes', () => {
    const values = ['42', '0.85', '-3', '1e2', '2.5E-1'].map(parseStrictNumber);
    assert.deepEqual(values, [42, 0.85, -3, 100, 0.25]);
  });

  test('rejeita espaços, hexadecimal, vírgula decimal e texto adicional', () => {
    const values = ['', ' 1', '1 ', '0x10', '1,5', '12px', '+1', '.5'].map(parseStrictNumber);
    assert.ok(values.every((value) => value === null));
  });

  test('rejeita NaN e Infinity escritos por extenso', () => {
    assert.deepEqual(['NaN', 'Infinity'].map(parseStrictNumber), [null, null]);
  });
});

describe('parsePointer', () => {
  test('o ponteiro vazio refere o documento inteiro', () => {
    assert.deepEqual(parsePointer('', 'json'), []);
  });

  test('separa os tokens de referência', () => {
    assert.deepEqual(parsePointer('/a/b/0', 'json'), ['a', 'b', '0']);
  });

  test('"/" refere a chave vazia', () => {
    assert.deepEqual(parsePointer('/', 'json'), ['']);
  });

  test('desfaz "~1" antes de "~0"', () => {
    assert.deepEqual(parsePointer('/a~1b/m~0n/~01', 'json'), ['a/b', 'm~n', '~1']);
  });

  test('ponteiro em falta dá extractor_option_invalid', () => {
    assert.throws(() => parsePointer(undefined, 'json'), POINTER_INVALID);
  });

  test('ponteiro que não é string dá extractor_option_invalid', () => {
    assert.throws(() => parsePointer(3, 'json'), {
      ...POINTER_INVALID,
      params: { format: 'json', option: 'pointer', reason: 'must be a string' },
    });
  });

  test('ponteiro sem "/" inicial dá extractor_option_invalid', () => {
    assert.throws(() => parsePointer('a/b', 'json'), { code: 'extractor_option_invalid' });
  });

  test('"~" sem "0" nem "1" a seguir dá extractor_option_invalid', () => {
    assert.throws(() => parsePointer('/a~2b', 'json'), { code: 'extractor_option_invalid' });
  });

  test('"~" no fim do ponteiro dá extractor_option_invalid', () => {
    assert.throws(() => parsePointer('/a~', 'json'), { code: 'extractor_option_invalid' });
  });
});

describe('resolvePointer', () => {
  const document = { a: { list: [10, 20, { deep: true }] }, '': 'vazio' };

  test('segue objectos e arrays', () => {
    assert.deepEqual(resolvePointer(document, ['a', 'list', '2', 'deep']), {
      found: true,
      value: true,
    });
  });

  test('sem tokens devolve o documento inteiro', () => {
    assert.deepEqual(resolvePointer(document, []), { found: true, value: document });
  });

  test('resolve a chave vazia', () => {
    assert.deepEqual(resolvePointer(document, ['']), { found: true, value: 'vazio' });
  });

  test('chave inexistente não é encontrada', () => {
    assert.deepEqual(resolvePointer(document, ['a', 'missing']), { found: false });
  });

  test('índice fora do array não é encontrado', () => {
    assert.deepEqual(resolvePointer(document, ['a', 'list', '3']), { found: false });
  });

  test('"-" (posição depois do último elemento) não é encontrado', () => {
    assert.deepEqual(resolvePointer(document, ['a', 'list', '-']), { found: false });
  });

  test('índices com zeros à esquerda não são encontrados', () => {
    assert.deepEqual(resolvePointer(document, ['a', 'list', '01']), { found: false });
  });

  test('propriedades herdadas não são encontradas', () => {
    assert.deepEqual(resolvePointer(document, ['a', 'constructor']), { found: false });
  });
});

describe('countTags', () => {
  test('conta tags de abertura, com e sem atributos', () => {
    assert.equal(countTags('<r><item>a</item><item id="2">b</item></r>', 'item'), 2);
  });

  test('conta tags auto-fechadas, com e sem espaço antes de "/>"', () => {
    assert.equal(countTags('<r><item/><item name="x" /></r>', 'item'), 2);
  });

  test('aceita quebras de linha entre o nome e os atributos', () => {
    assert.equal(countTags('<r><item\n  name="x"/></r>', 'item'), 1);
  });

  test('não conta tags de fecho', () => {
    assert.equal(countTags('<r></item></item></r>', 'item'), 0);
  });

  test('não conta elementos cujo nome apenas começa pelo pedido', () => {
    assert.equal(countTags('<items><item-list/><itemx/></items>', 'item'), 0);
  });

  test('ignora comentários e secções CDATA', () => {
    const xml = '<r><!-- <item/> --><x><![CDATA[<item/>]]></x></r>';
    assert.equal(countTags(xml, 'item'), 0);
  });

  test('trata o nome como texto literal e não como expressão regular', () => {
    assert.equal(countTags('<r><a.b/><axb/></r>', 'a.b'), 1);
  });
});

describe('defineExtractor', () => {
  test('usa o primeiro campo como campo por omissão', () => {
    assert.equal(fakeExtractor(1).defaultField, 'first');
  });

  test('devolve um extractor congelado, incluindo a lista de campos', () => {
    const extractor = fakeExtractor(1);
    assert.ok(Object.isFrozen(extractor) && Object.isFrozen(extractor.fields));
  });

  test('entrega à leitura o campo por omissão quando a origem não o indica', () => {
    /** @type {string[]} */
    const seen = [];
    fakeExtractor(1, seen).extract('', { format: 'fake', path: 'r' });
    assert.deepEqual(seen, ['first']);
  });

  test('campo desconhecido dá extractor_field_unknown com os campos conhecidos', () => {
    const run = () => fakeExtractor(1).extract('', { format: 'fake', path: 'r', field: 'x' });
    assert.throws(run, {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: { format: 'fake', field: 'x', known: 'first, second' },
    });
  });

  test('valor não finito devolvido pela leitura dá extractor_report_unparseable', () => {
    const run = () => fakeExtractor(Number.NaN).extract('', { format: 'fake', path: 'r' });
    assert.throws(run, UNPARSEABLE);
  });

  test('conteúdo que não é texto dá extractor_report_unparseable', () => {
    const text = /** @type {string} */ (/** @type {unknown} */ (Buffer.from('1')));
    assert.throws(() => fakeExtractor(1).extract(text, { format: 'fake', path: 'r' }), UNPARSEABLE);
  });
});
