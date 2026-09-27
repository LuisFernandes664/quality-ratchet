// @ts-check
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';

import { createLineWriter } from '../../src/cli/output.js';

/**
 * Stream falsa que regista o texto escrito.
 * @returns {EventEmitter & {writes: string[], write: (text: string) => boolean}}
 */
function fakeStream() {
  /** @type {string[]} */
  const writes = [];
  const write = (/** @type {string} */ text) => {
    writes.push(text);
    return true;
  };
  return Object.assign(new EventEmitter(), { writes, write });
}

/**
 * Erro de stream com código.
 * @param {string} code
 * @returns {Error}
 */
function streamError(code) {
  return Object.assign(new Error(`write ${code}`), { code });
}

describe('createLineWriter', () => {
  test('escreve cada linha terminada com fim de linha', () => {
    const stream = fakeStream();

    createLineWriter(stream)('a');

    assert.deepEqual(stream.writes, ['a\n']);
  });

  test('o leitor fechado (EPIPE) nao lanca excepcao', () => {
    const stream = fakeStream();
    createLineWriter(stream);

    assert.doesNotThrow(() => stream.emit('error', streamError('EPIPE')));
  });

  test('depois de o leitor fechar (EPIPE) descarta as linhas seguintes', () => {
    const stream = fakeStream();
    const writeLine = createLineWriter(stream);

    stream.emit('error', streamError('EPIPE'));
    writeLine('b');

    assert.deepEqual(stream.writes, []);
  });

  test('stream destruida depois do EPIPE nao lanca excepcao', () => {
    const stream = fakeStream();
    createLineWriter(stream);

    assert.doesNotThrow(() => stream.emit('error', streamError('ERR_STREAM_DESTROYED')));
  });

  test('outros erros da stream propagam', () => {
    const stream = fakeStream();
    createLineWriter(stream);

    assert.throws(() => stream.emit('error', streamError('EIO')), { code: 'EIO' });
  });
});
