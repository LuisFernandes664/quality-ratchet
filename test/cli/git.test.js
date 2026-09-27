// @ts-check
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { promisify } from 'node:util';

import { createGit } from '../../src/cli/git.js';
import { ConfigError } from '../../src/core/errors.js';
import { makeTempDir, removeDir, runIn, writeFiles } from './helpers.js';

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

/** Testes com o git real e ligações simbólicas de pastas, que no Windows exigem privilégios. */
const linkTest = (await hasGit()) && process.platform !== 'win32' ? test : test.skip;

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

/**
 * Cria um repositório temporário com os ficheiros dados num primeiro commit.
 * @param {Record<string, string>} files
 * @returns {Promise<string>} pasta do repositório
 */
async function commitRepository(files) {
  const repo = await makeTempDir();
  await git(repo, ['init', '--quiet']);
  await writeFiles(repo, files);
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '--quiet', '--no-verify', '-m', 'primeiro']);
  return repo;
}

/**
 * Apaga um objecto solto do repositório, como faltaria num clone parcial sem acesso ao
 * remote.
 * @param {string} repo
 * @param {string} spec `<revisão>:<caminho>` do objecto
 * @returns {Promise<void>}
 */
async function dropObject(repo, spec) {
  const id = (await git(repo, ['rev-parse', spec])).trim();
  await rm(path.join(repo, '.git', 'objects', id.slice(0, 2), id.slice(2)));
}

/**
 * Indica se o erro é um git_show_failed.
 * @param {unknown} error
 * @returns {boolean}
 */
function isShowFailed(error) {
  return error instanceof ConfigError && error.code === 'git_show_failed';
}

describe('createGit com o git real', () => {
  /** @type {string} */
  let repo;
  /** @type {string} */
  let link;

  before(async () => {
    if (!(await hasGit())) return;
    repo = await commitRepository({
      'quality-baseline.json': '{"v": 1}\n',
      'pkg/b.json': '{"v": 2}\n',
      'cfg/b.json': '{"v": 4}\n',
    });
    await writeFiles(repo, { 'quality-baseline.json': '{"v": 3}\n', 'other/b.json': '{"v": 5}\n' });
    await rm(path.join(repo, 'cfg'), { recursive: true });
    if (process.platform === 'win32') return;
    await symlink('other', path.join(repo, 'cfg'), 'dir');
    link = `${repo}-link`;
    await symlink(repo, link, 'dir');
  });

  after(async () => {
    if (link) await rm(link);
    if (repo) await removeDir(repo);
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

  gitTest('ficheiro numa pasta inexistente nessa revisao devolve null', async () => {
    assert.equal(await createGit().show('HEAD', 'none/b.json', repo), null);
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
      await assert.rejects(createGit().show('HEAD', 'a.json', outside), isShowFailed);
    } finally {
      await removeDir(outside);
    }
  });

  gitTest('ficheiro fora do repositorio devolve null, como na action', async () => {
    const outside = await makeTempDir();
    try {
      await writeFiles(outside, { 'b.json': '{}' });
      assert.equal(await createGit().show('HEAD', path.join(outside, 'b.json'), repo), null);
    } finally {
      await removeDir(outside);
    }
  });

  linkTest('caminho absoluto por uma ligacao simbolica ao repositorio le a revisao', async () => {
    const text = await createGit().show('HEAD', path.join(link, 'quality-baseline.json'), repo);

    assert.equal(text, '{"v": 1}\n');
  });

  linkTest('pasta de trabalho por uma ligacao simbolica le a revisao', async () => {
    const text = await createGit().show('HEAD', 'quality-baseline.json', link);

    assert.equal(text, '{"v": 1}\n');
  });

  linkTest('ligacao simbolica dentro do repositorio nao e seguida', async () => {
    const text = await createGit().show('HEAD', path.join(link, 'cfg', 'b.json'), repo);

    assert.equal(text, '{"v": 4}\n');
  });
});

describe('createGit com objectos em falta no repositorio', () => {
  /** @type {string} */
  let repo;

  beforeEach(async () => {
    if (!(await hasGit())) return;
    repo = await commitRepository({ 'quality-baseline.json': '{"v": 1}\n', 'pkg/b.json': '{}' });
  });

  afterEach(async () => {
    if (repo) await removeDir(repo);
  });

  gitTest('ficheiro sem objecto lanca git_show_failed em vez de devolver null', async () => {
    await dropObject(repo, 'HEAD:quality-baseline.json');

    await assert.rejects(createGit().show('HEAD', 'quality-baseline.json', repo), isShowFailed);
  });

  gitTest('pasta sem objecto lanca git_show_failed em vez de devolver null', async () => {
    await dropObject(repo, 'HEAD:pkg');

    await assert.rejects(createGit().show('HEAD', 'pkg/b.json', repo), isShowFailed);
  });
});

/**
 * Erro de um comando git que terminou com código de saída.
 * @param {number} code
 * @param {string} stderr
 * @returns {Error}
 */
function gitFailure(code, stderr) {
  return Object.assign(new Error('Command failed'), { code, stderr });
}

/**
 * Executor falso: responde a cada subcomando do git com o texto dado, ou falha com o erro
 * dado, e regista os argumentos de cada chamada.
 * @param {Record<string, string|Error>} [replies] resposta por subcomando
 * @returns {{calls: string[][], run: (args: string[]) => Promise<string>}}
 */
function fakeRunner(replies = {}) {
  /** @type {Record<string, string|Error>} */
  const answers = { 'rev-parse': '/repo\n', show: 'conteudo', 'ls-tree': '', ...replies };
  /** @type {string[][]} */
  const calls = [];
  const run = async (/** @type {string[]} */ args) => {
    calls.push(args);
    const reply = answers[String(args.find((arg) => !arg.startsWith('-')))];
    if (reply instanceof Error) throw reply;
    return reply ?? '';
  };
  return { calls, run };
}

/**
 * Caminho real falso: troca os caminhos indicados e regista cada pedido.
 * @param {Record<string, string|Error>} [links] caminho real (ou erro) por caminho
 * @returns {{calls: string[], realpath: (filePath: string) => Promise<string>}}
 */
function fakeRealpath(links = {}) {
  /** @type {string[]} */
  const calls = [];
  const realpath = async (/** @type {string} */ filePath) => {
    calls.push(filePath);
    const target = links[filePath];
    if (target instanceof Error) throw target;
    return target ?? filePath;
  };
  return { calls, realpath };
}

/**
 * Argumentos das chamadas a um subcomando do git.
 * @param {string[][]} calls
 * @param {string} command
 * @returns {string[][]}
 */
function callsOf(calls, command) {
  return calls.filter((args) => args.includes(command));
}

describe('createGit com executor falso', () => {
  test('pede ao git o caminho relativo a raiz do repositorio', async () => {
    const { calls, run } = fakeRunner();

    await createGit(run, fakeRealpath().realpath).show('main', path.join('a', 'b.json'), '/repo');

    assert.deepEqual(callsOf(calls, 'show'), [['show', 'main:a/b.json']]);
  });

  test('numa subpasta pede o caminho relativo a raiz do repositorio', async () => {
    const { calls, run } = fakeRunner();

    await createGit(run, fakeRealpath().realpath).show('main', 'b.json', '/repo/pkg');

    assert.deepEqual(callsOf(calls, 'show'), [['show', 'main:pkg/b.json']]);
  });

  test('revisao vazia lanca git_show_failed sem correr o git, em vez de ler o indice', async () => {
    const { calls, run } = fakeRunner();

    await assert.rejects(createGit(run).show('', 'b.json', '/repo'), isShowFailed);
    assert.deepEqual(calls, []);
  });

  test('revisao que comeca por - lanca git_show_failed sem correr o git', async () => {
    const { calls, run } = fakeRunner();

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

  test('show falhado pergunta ao ls-tree pelo caminho literal a partir da raiz', async () => {
    const { calls, run } = fakeRunner({ show: gitFailure(128, 'fatal: bad object') });

    await createGit(run, fakeRealpath().realpath).show('main', 'a/b.json', '/repo');

    assert.deepEqual(callsOf(calls, 'ls-tree'),
      [['--literal-pathspecs', 'ls-tree', '--full-tree', 'main', '--', 'a/b.json']]);
  });

  test('show falhado sem entrada no ls-tree devolve null', async () => {
    const { run } = fakeRunner({ show: gitFailure(128, 'fatal: path does not exist') });

    const text = await createGit(run, fakeRealpath().realpath).show('main', 'b.json', '/repo');

    assert.equal(text, null);
  });

  test('show falhado com a entrada no ls-tree lanca git_show_failed com o motivo', async () => {
    const { run } = fakeRunner({
      show: gitFailure(128, 'fatal: bad object main:b.json'),
      'ls-tree': '100644 blob 59cae28ac9ee\tb.json\n',
    });

    await assert.rejects(
      createGit(run, fakeRealpath().realpath).show('main', 'b.json', '/repo'),
      (error) => error instanceof ConfigError && error.params.reason === 'bad object main:b.json',
    );
  });

  test('show e ls-tree falhados lancam git_show_failed com o motivo do ls-tree', async () => {
    const { run } = fakeRunner({
      show: gitFailure(128, 'fatal: path exists on disk, but not in main'),
      'ls-tree': gitFailure(1, 'error: Could not read 93ac9ff'),
    });

    await assert.rejects(
      createGit(run, fakeRealpath().realpath).show('main', 'pkg/b.json', '/repo'),
      (error) => error instanceof ConfigError && error.params.reason === 'Could not read 93ac9ff',
    );
  });

  test('caminho fora do repositorio devolve null', async () => {
    const git = createGit(fakeRunner().run, fakeRealpath().realpath);

    const text = await git.show('main', '/else/b.json', '/repo');

    assert.equal(text, null);
  });

  test('caminho fora do repositorio nao e pedido ao git', async () => {
    const { calls, run } = fakeRunner();

    await createGit(run, fakeRealpath().realpath).show('main', '/else/b.json', '/repo');

    assert.deepEqual(callsOf(calls, 'show'), []);
  });

  test('entra no repositorio pelo caminho real de uma ligacao simbolica exterior', async () => {
    const { calls, run } = fakeRunner();
    const { realpath } = fakeRealpath({ '/link': '/repo' });

    await createGit(run, realpath).show('main', '/link/cfg/b.json', '/repo');

    assert.deepEqual(callsOf(calls, 'show'), [['show', 'main:cfg/b.json']]);
  });

  test('nao pede o caminho real das pastas dentro do repositorio', async () => {
    const { run } = fakeRunner();
    const { calls, realpath } = fakeRealpath({ '/link': '/repo' });

    await createGit(run, realpath).show('main', '/link/cfg/b.json', '/repo');

    assert.ok(!calls.includes('/link/cfg'));
  });

  test('falha ao obter um caminho real lanca git_show_failed', async () => {
    const { run } = fakeRunner();
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const { realpath } = fakeRealpath({ '/link': denied });

    await assert.rejects(createGit(run, realpath).show('main', '/link/b.json', '/repo'),
      isShowFailed);
  });
});

/**
 * Baseline v2 com a cobertura no valor dado, em JSON.
 * @param {number} value
 * @returns {string}
 */
function coverageBaseline(value) {
  return JSON.stringify({ version: 2, metrics: { coverage: { value, direction: 'up' } } });
}

/**
 * Repositório com um ramo atrasado face ao destino, como num merge request do GitLab: o
 * `feature` sai do `main` com a cobertura a 80 e só muda outro ficheiro; depois o `main`
 * aperta a cobertura para 85. O checkout fica no `feature`, com a medição a 82.
 * @returns {Promise<string>} pasta do repositório
 */
async function branchBehindTarget() {
  const repo = await commitRepository({
    'quality-baseline.json': coverageBaseline(80),
    'src/a.txt': 'a\n',
  });
  await git(repo, ['checkout', '--quiet', '-b', 'feature']);
  await writeFiles(repo, { 'src/a.txt': 'b\n' });
  await git(repo, ['commit', '--quiet', '--no-verify', '-am', 'feature']);
  await git(repo, ['checkout', '--quiet', 'main']);
  await writeFiles(repo, { 'quality-baseline.json': coverageBaseline(85) });
  await git(repo, ['commit', '--quiet', '--no-verify', '-am', 'apertar']);
  await git(repo, ['checkout', '--quiet', 'feature']);
  await writeFiles(repo, { 'metrics-current.json': '{"coverage": 82}' });
  return repo;
}

/**
 * Corre o check em JSON contra a revisão dada, com o git real.
 * @param {string} repo
 * @param {string} ref
 * @returns {Promise<{code: number, loosened: string[]}>}
 */
async function checkAgainst(repo, ref) {
  const argv = ['check', '--format', 'json', '--base-ref', ref];
  const result = await runIn(repo, argv, { git: createGit() });
  return { code: result.code, loosened: JSON.parse(result.stdout).loosened };
}

describe('check com o git real num ramo atrasado face ao destino', () => {
  /** @type {string} */
  let repo;
  /** @type {{code: number, loosened: string[]}} */
  let mergeBase;
  /** @type {{code: number, loosened: string[]}} */
  let targetTip;

  before(async () => {
    if (!(await hasGit())) return;
    repo = await branchBehindTarget();
    mergeBase = await checkAgainst(repo, (await git(repo, ['merge-base', 'main', 'HEAD'])).trim());
    targetTip = await checkAgainst(repo, 'main');
  });

  after(async () => {
    if (repo) await removeDir(repo);
  });

  gitTest('contra a merge base passa', () => {
    assert.equal(mergeBase.code, 0);
  });

  gitTest('contra a merge base nao ve afrouxamento', () => {
    assert.deepEqual(mergeBase.loosened, []);
  });

  gitTest('contra a ponta do destino falha', () => {
    assert.equal(targetTip.code, 1);
  });

  gitTest('contra a ponta do destino ve os apertos do destino como afrouxamento', () => {
    assert.deepEqual(targetTip.loosened, ['coverage']);
  });
});
