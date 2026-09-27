// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { HELP } from '../../src/cli/help.js';
import { VERSION, baselineV2, makeTempDir, removeDir, runIn, writeFiles } from './helpers.js';

describe('runCli', () => {
  /** @type {string} */
  let dir;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  test('--help mostra a ajuda em ingles e sai com 0', async () => {
    const result = await runIn(dir, ['--help']);

    assert.equal(result.code, 0);
    assert.ok(result.stdout.startsWith(HELP.en.usage));
  });

  test('-h e o atalho de --help', async () => {
    const result = await runIn(dir, ['-h']);

    assert.equal(result.code, 0);
    assert.ok(result.stdout.startsWith(HELP.en.usage));
  });

  test('--help com --language pt mostra a ajuda em portugues', async () => {
    const result = await runIn(dir, ['--help', '--language', 'pt']);

    assert.ok(result.stdout.startsWith(HELP.pt.usage));
  });

  test('--help depois de um comando mostra a ajuda', async () => {
    const result = await runIn(dir, ['init', '--help']);

    assert.equal(result.code, 0);
    assert.ok(result.stdout.startsWith(HELP.en.usage));
  });

  test('a ajuda documenta todos os comandos', async () => {
    const { stdout } = await runIn(dir, ['--help']);

    for (const command of ['check', 'update', 'init', 'migrate']) {
      assert.match(stdout, new RegExp(`^  ${command} `, 'm'));
    }
  });

  test('--version mostra a versao e sai com 0', async () => {
    const result = await runIn(dir, ['--version']);

    assert.deepEqual(result, { code: 0, stdout: VERSION, stderr: '' });
  });

  test('-v e o atalho de --version', async () => {
    assert.equal((await runIn(dir, ['-v'])).stdout, VERSION);
  });

  test('comando desconhecido sai com 2', async () => {
    const result = await runIn(dir, ['deploy']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /^error: unknown command "deploy"/);
  });

  test('opcao desconhecida sai com 2', async () => {
    const result = await runIn(dir, ['--nope']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /^error: invalid options: .*--nope/);
  });

  test('opcao de outro comando e rejeitada', async () => {
    const result = await runIn(dir, ['init', '--strict']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /invalid options: .*--strict/);
  });

  test('opcao de texto sem valor sai com 2', async () => {
    const result = await runIn(dir, ['check', '--baseline']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /invalid options: .*--baseline/);
  });

  test('argumento posicional a mais sai com 2', async () => {
    const result = await runIn(dir, ['check', 'extra']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /invalid options: .*extra/);
  });

  test('lingua nao suportada sai com 2 e mensagem em ingles', async () => {
    const result = await runIn(dir, ['--language', 'fr']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /^error: unsupported language "fr"/);
  });

  test('erros na lingua pedida', async () => {
    const result = await runIn(dir, ['deploy', '--language', 'pt-PT']);

    assert.match(result.stderr, /^error: comando desconhecido "deploy"/);
  });

  test('sem comando corre o check', async () => {
    await writeFiles(dir, {
      'quality-baseline.json': baselineV2({ a: { value: 1, direction: 'up' } }),
      'metrics-current.json': { a: 1 },
    });

    const result = await runIn(dir, []);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /^## Quality ratchet/);
  });

  test('o comando pode vir depois das opcoes', async () => {
    await writeFiles(dir, { 'm.json': { a: 1 } });

    const result = await runIn(dir, ['--metrics', 'm.json', '--up', 'a', 'init']);

    assert.equal(result.code, 0);
  });

  test('erro inesperado do sistema de ficheiros sai com 2 e mostra a mensagem', async () => {
    await writeFiles(dir, { 'm.json': { a: 1 } });
    const fs = {
      readText: async () => '{"a": 1}',
      exists: async () => false,
      writeText: async () => {
        throw new Error('EACCES: permission denied');
      },
    };

    const result = await runIn(dir, ['init', '--metrics', 'm.json', '--up', 'a'], { fs });

    assert.equal(result.code, 2);
    assert.equal(result.stderr, 'error: EACCES: permission denied');
  });
});
