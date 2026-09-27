// @ts-check
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createNodeFileSystem } from '../../src/cli/node-fs.js';
import { makeTempDir, readText, removeDir, writeFiles } from './helpers.js';

describe('createNodeFileSystem', () => {
  /** @type {string} */
  let dir;
  const fs = createNodeFileSystem();

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  test('le ficheiros em UTF-8', async () => {
    await writeFiles(dir, { 'a.txt': 'métrica' });

    assert.equal(await fs.readText(path.join(dir, 'a.txt')), 'métrica');
  });

  test('exists devolve true para um ficheiro existente', async () => {
    await writeFiles(dir, { 'a.txt': 'x' });

    assert.equal(await fs.exists(path.join(dir, 'a.txt')), true);
  });

  test('exists devolve false para um caminho inexistente', async () => {
    assert.equal(await fs.exists(path.join(dir, 'none.txt')), false);
  });

  test('exists devolve false quando uma pasta do caminho e um ficheiro', async () => {
    await writeFiles(dir, { 'a.txt': 'x' });

    assert.equal(await fs.exists(path.join(dir, 'a.txt', 'b.txt')), false);
  });

  test('writeText cria as pastas em falta', async () => {
    await fs.writeText(path.join(dir, 'x', 'y', 'z.json'), '{}\n');

    assert.equal(await readText(dir, 'x/y/z.json'), '{}\n');
  });
});
