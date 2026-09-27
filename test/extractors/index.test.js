// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EXTRACTORS, extract, listFormats } from '../../src/extractors/index.js';

const FORMATS = [
  'lcov',
  'istanbul',
  'cobertura',
  'stryker',
  'sarif',
  'eslint',
  'jscpd',
  'npm-audit',
  'pip-audit',
  'junit',
  'json',
];

const LCOV = ['SF:src/a.js', 'LF:4', 'LH:3', 'BRF:4', 'BRH:1', 'end_of_record', ''].join('\n');

describe('EXTRACTORS', () => {
  test('regista os formatos do contrato', () => {
    assert.deepEqual(Object.keys(EXTRACTORS).sort(), [...FORMATS].sort());
  });

  test('está congelado', () => {
    assert.ok(Object.isFrozen(EXTRACTORS));
  });

  test('cada extractor está registado com o seu próprio formato', () => {
    assert.ok(Object.entries(EXTRACTORS).every(([format, entry]) => entry.format === format));
  });

  test('o campo por omissão de cada extractor é o primeiro da lista de campos', () => {
    const extractors = Object.values(EXTRACTORS);
    assert.ok(extractors.every((entry) => entry.defaultField === entry.fields[0]));
  });
});

describe('listFormats', () => {
  test('lista os formatos pela ordem da tabela do contrato', () => {
    assert.deepEqual(listFormats(), FORMATS);
  });

  test('devolve uma cópia que pode ser alterada sem afectar o registo', () => {
    listFormats().pop();
    assert.equal(listFormats().length, FORMATS.length);
  });
});

describe('extract', () => {
  test('delega no extractor do formato', () => {
    assert.equal(extract({ format: 'lcov', path: 'lcov.info', field: 'branches' }, LCOV), 25);
  });

  test('sem field usa o campo por omissão do formato', () => {
    assert.equal(extract({ format: 'lcov', path: 'lcov.info' }, LCOV), 75);
  });

  test('formato desconhecido dá extractor_format_unknown com a lista de formatos', () => {
    assert.throws(() => extract({ format: 'clover', path: 'clover.xml' }, '<coverage/>'), {
      name: 'ExtractorError',
      code: 'extractor_format_unknown',
      params: { format: 'clover', known: FORMATS.join(', ') },
    });
  });

  test('nomes herdados de Object não são formatos', () => {
    for (const format of ['constructor', '__proto__', 'toString']) {
      assert.throws(() => extract({ format, path: 'r' }, '{}'), {
        code: 'extractor_format_unknown',
      });
    }
  });

  test('campo desconhecido dá extractor_field_unknown', () => {
    assert.throws(() => extract({ format: 'lcov', path: 'lcov.info', field: 'total' }, LCOV), {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: { format: 'lcov', field: 'total', known: 'lines, branches, functions' },
    });
  });

  test('nunca devolve Infinity: dá extractor_report_unparseable', () => {
    const source = { format: 'json', path: 'm.json', pointer: '/value' };
    assert.throws(() => extract(source, '{"value": -1e999}'), {
      name: 'ExtractorError',
      code: 'extractor_report_unparseable',
    });
  });

  test('ficheiro vazio dá extractor_report_empty em todos os formatos', () => {
    for (const format of FORMATS) {
      assert.throws(() => extract({ format, path: 'r', pointer: '/value' }, ' \n'), {
        name: 'ExtractorError',
        code: 'extractor_report_empty',
        params: { format },
      });
    }
  });

  test('erros de relatório indicam o formato', () => {
    assert.throws(() => extract({ format: 'eslint', path: 'eslint.json' }, '[]'), {
      name: 'ExtractorError',
      code: 'extractor_report_empty',
      params: { format: 'eslint' },
    });
  });
});
