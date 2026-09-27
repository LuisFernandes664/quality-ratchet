// @ts-check
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';

import { createGit } from '../../src/cli/git.js';
import { ConfigError } from '../../src/core/errors.js';
import { makeTempDir, removeDir, writeFiles } from './helpers.js';

const execFileAsync = promisify(execFile);

/**
 * Isola os comandos git deste processo de testes de qualquer repositório exterior. Dentro
 * de um hook do git (ex: testes corridos no pre-commit), GIT_DIR e GIT_INDEX_FILE apontam
 * para o repositório real, e o `git add` e o `git commit` do teste iriam parar lá. O
 * limite de pesquisa impede também que uma pasta temporária encontre um repositório acima.
 * @returns {void}
 */
function isolateFromOuterRepository() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_')) delete process.env[name];
  }
  process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
}

isolateFromOuterRepository();

/**
 * Indica se o git está disponível no PATH.
 * @returns {Promise<boolean>}
 */
async function hasGit() {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch (cause) {
    const code = /** @type {{code?: unknown}} */ (cause).code;
    if (code === 'ENOENT') return false;
    throw cause;
  }
}

/** Testes que precisam do git real: saltados só quando o git não existe no PATH. */
const gitTest = (await hasGit()) ? test : test.skip;

/**
 * Corre o git num repositório de teste, isolado da configuração do utilizador.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function git(cwd, args) {
  const config = ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
  const { stdout } = await execFileAsync('git', [...config, ...args], { cwd });
  return stdout;
}

describe('createGit com o git real', () => {
  /** @type {string} */
  let repo;

  before(async () => {
    repo = await makeTempDir();
    if (!(await hasGit())) return;
    await git(repo, ['init', '--quiet']);
    await writeFiles(repo, { 'quality-baseline.json': '{"v": 1}\n', 'pkg/b.json': '{"v": 2}\n' });
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '--quiet', '--no-verify', '-m', 'primeiro']);
    await writeFiles(repo, { 'quality-baseline.json': '{"v": 3}\n' });
  });

  after(async () => {
    await removeDir(repo);
  });

  gitTest('le o ficheiro tal como esta na revisao, e nao na pasta de trabalho', async () => {
    const text = await createGit().show('HEAD', 'quality-baseline.json', repo);

    assert.equal(text, '{"v": 1}\n');
  });

  gitTest('le caminhos relativos a uma subpasta do repositorio', async () => {
    const text = await createGit().show('HEAD', 'b.json', path.join(repo, 'pkg'));

    assert.equal(text, '{"v": 2}\n');
  });

  gitTest('aceita caminhos absolutos', async () => {
    const text = await createGit().show('HEAD', path.join(repo, 'pkg', 'b.json'), repo);

    assert.equal(text, '{"v": 2}\n');
  });

  gitTest('ficheiro inexistente nessa revisao devolve null', async () => {
    assert.equal(await createGit().show('HEAD', 'none.json', repo), null);
  });

  gitTest('revisao inexistente lanca git_show_failed com o motivo do git', async () => {
    await assert.rejects(
      createGit().show('no-such-branch', 'quality-baseline.json', repo),
      (error) => error instanceof ConfigError && error.code === 'git_show_failed'
        && error.params.ref === 'no-such-branch'
        && error.params.path === 'quality-baseline.json'
        && /no-such-branch/.test(String(error.params.reason)),
    );
  });

  gitTest('pasta fora de um repositorio lanca git_show_failed', async () => {
    const outside = await makeTempDir();
    try {
      await assert.rejects(
        createGit().show('HEAD', 'a.json', outside),
        (error) => error instanceof ConfigError && error.code === 'git_show_failed',
      );
    } finally {
      await removeDir(outside);
    }
  });
});

/**
 * Executor falso que regista os argumentos de cada chamada e devolve sempre o mesmo texto.
 * @returns {{calls: string[][], run: (args: string[]) => Promise<string>}}
 */
function recordingRunner() {
  /** @type {string[][]} */
  const calls = [];
  const run = async (/** @type {string[]} */ args) => {
    calls.push(args);
    return 'conteudo';
  };
  return { calls, run };
}

describe('createGit com executor falso', () => {
  test('pede ao git o caminho relativo a pasta de trabalho, com ./', async () => {
    const { calls, run } = recordingRunner();

    await createGit(run).show('main', path.join('a', 'b.json'), '/repo');

    assert.deepEqual(calls, [['show', 'main:./a/b.json']]);
  });

  test('revisao vazia lanca git_show_failed sem correr o git, em vez de ler o indice', async () => {
    const { calls, run } = recordingRunner();

    await assert.rejects(
      createGit(run).show('', 'b.json', '/repo'),
      (error) => error instanceof ConfigError && error.code === 'git_show_failed',
    );
    assert.deepEqual(calls, []);
  });

  test('revisao que comeca por - lanca git_show_failed sem correr o git', async () => {
    const { calls, run } = recordingRunner();

    await assert.rejects(
      createGit(run).show('--output=/tmp/x', 'b.json', '/repo'),
      (error) => error instanceof ConfigError && error.params.ref === '--output=/tmp/x',
    );
    assert.deepEqual(calls, []);
  });

  test('git em falta no PATH lanca git_show_failed', async () => {
    const run = async () => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    };

    await assert.rejects(
      createGit(run).show('main', 'b.json', '/repo'),
      (error) => error instanceof ConfigError && error.params.reason === 'spawn git ENOENT',
    );
  });
});
