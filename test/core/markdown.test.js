// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { codeSpan, oneLine, tableCode } from '../../src/core/markdown.js';

describe('oneLine', () => {
  test('troca quebras de linha por espacos', () => {
    assert.equal(oneLine('a\r\nb\nc'), 'a  b c');
  });

  test('troca outros caracteres de controlo por espacos', () => {
    assert.equal(oneLine('a\u0000b\u007fc'), 'a b c');
  });
});

describe('codeSpan', () => {
  test('texto simples fica entre crases', () => {
    assert.equal(codeSpan('coverage'), '`coverage`');
  });

  test('uma crase no texto pede uma cerca de duas', () => {
    assert.equal(codeSpan('a`b'), '``a`b``');
  });

  test('duas crases seguidas pedem uma cerca de tres', () => {
    assert.equal(codeSpan('a``b'), '```a``b```');
  });

  test('texto que comeca em crase leva espacos nas pontas', () => {
    assert.equal(codeSpan('`a'), '`` `a ``');
  });

  test('texto com quebras de linha fica numa so linha', () => {
    assert.equal(codeSpan('x\n\n<!--'), '`x  <!--`');
  });

  test('mencoes e HTML ficam dentro do code span', () => {
    assert.equal(codeSpan('@org/team <b>x</b>'), '`@org/team <b>x</b>`');
  });
});

describe('tableCode', () => {
  test('escapa o separador de colunas', () => {
    assert.equal(tableCode('a|b'), '`a\\|b`');
  });
});
