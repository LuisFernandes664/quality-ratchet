// @ts-check
/**
 * Leitura de ficheiros noutra revisão do repositório, com o `git` instalado. Serve a
 * governação na CLI: o baseline do ramo base é o contrato que o PR não pode afrouxar. Por
 * isso só se conclui que o ficheiro não existe nessa revisão quando o git o prova; qualquer
 * outra falha é erro, para que a governação nunca se desligue em silêncio.
 */
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { ConfigError } from '../core/errors.js';

/**
 * @typedef {object} Git
 * @property {(ref: string, filePath: string, cwd: string) => Promise<string|null>} show
 *   conteúdo do ficheiro na revisão `ref`, ou null só quando o git prova que o ficheiro não
 *   existe nessa revisão, ou quando ele fica fora do repositório (como na action, para um
 *   baseline fora da workspace); `filePath` é relativo a `cwd` (ou absoluto)
 */

/**
 * Executor de comandos git: devolve o stdout, ou rejeita com o erro do processo (que traz
 * `code` numérico quando o git terminou com erro, e `stderr`).
 * @typedef {(args: string[], cwd: string) => Promise<string>} GitRunner
 */

/**
 * Caminho real de um caminho existente, sem ligações simbólicas (como `fs.realpath`).
 * @typedef {(filePath: string) => Promise<string>} RealPath
 */

/**
 * Dependências do acesso ao git.
 * @typedef {object} GitAccess
 * @property {GitRunner} run
 * @property {RealPath} realpath
 */

/** Limite do stdout de um comando git. */
const MAX_BUFFER = 16 * 1024 * 1024;

/** Motivo da recusa de uma revisão que o git não leria como revisão. */
const NOT_A_REVISION = Object.freeze({ code: 'reason_not_a_revision', params: {} });

/** Códigos de erro do sistema de ficheiros que significam que o caminho não existe. */
const MISSING = new Set(['ENOENT', 'ENOTDIR']);

const execFileAsync = promisify(execFile);

/**
 * Corre o git real na pasta indicada.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string>} stdout
 */
export async function runGit(args, cwd) {
  const options = { cwd, maxBuffer: MAX_BUFFER, encoding: /** @type {const} */ ('utf8') };
  const { stdout } = await execFileAsync('git', args, options);
  return stdout;
}

/**
 * Cria o acesso ao git usado pela CLI.
 * @param {GitRunner} [run] executor, injectável nos testes
 * @param {RealPath} [resolveReal] caminho real, injectável nos testes
 * @returns {Git}
 */
export function createGit(run = runGit, resolveReal = (filePath) => realpath(filePath)) {
  const access = { run, realpath: resolveReal };
  return { show: (ref, filePath, cwd) => showFile(access, ref, filePath, cwd) };
}

/**
 * Lê um ficheiro numa revisão com `git show <ref>:<caminho na raiz>`. Quando o `show`
 * falha, devolve null só se o `git ls-tree` provar que o caminho não existe na revisão.
 * Um objecto em falta (ex: clone parcial sem acesso ao remote), uma revisão inexistente, uma
 * pasta fora de um repositório ou o git em falta são erros.
 * @param {GitAccess} access
 * @param {string} ref
 * @param {string} filePath
 * @param {string} cwd
 * @returns {Promise<string|null>}
 * @throws {ConfigError} git_show_failed
 */
async function showFile(access, ref, filePath, cwd) {
  const written = toGitPath(cwd, filePath);
  assertRevision(ref, written);
  const location = await guard(ref, written, () => locate(access, cwd, filePath));
  if (location === null) return null;
  try {
    return await access.run(['show', `${ref}:${location}`], cwd);
  } catch (cause) {
    const absent = await guard(ref, location, () => isAbsent(access.run, ref, location, cwd));
    if (absent) return null;
    throw showFailed(ref, location, cause);
  }
}

/**
 * Recusa revisões que o git leria como outra coisa, antes de o correr. Vazia,
 * `git show :<caminho>` lê o índice: o contrato seria o próprio PR e a governação ficava
 * desligada sem aviso. A começar por `-`, seria lida como opção do git (ex: `--output`).
 * @param {string} ref
 * @param {string} relative caminho do ficheiro, para a mensagem
 * @returns {void}
 * @throws {ConfigError} git_show_failed
 */
function assertRevision(ref, relative) {
  if (ref !== '' && !ref.startsWith('-')) return;
  throw new ConfigError('git_show_failed', { ref, path: relative, reason: NOT_A_REVISION });
}

/**
 * Caminho do ficheiro na árvore do repositório (relativo à raiz, com `/`), ou null quando
 * fica fora do repositório. Um caminho que já está dentro da raiz é usado tal como foi
 * escrito: as ligações simbólicas dentro do repositório não são seguidas, porque o PR
 * controla-as e podia desviar a leitura do contrato para outro ficheiro. Fora da raiz (ex:
 * `$PWD` lógico por uma ligação simbólica, ou `/tmp`, que no macOS é `/private/tmp`),
 * procura-se a pasta por onde o caminho entra no repositório.
 * @param {GitAccess} access
 * @param {string} cwd
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function locate(access, cwd, filePath) {
  const output = await access.run(['rev-parse', '--show-toplevel'], cwd);
  const top = await access.realpath(output.trim());
  const resolved = path.resolve(cwd, filePath);
  return within(top, resolved) ?? enterRepository(access.realpath, top, resolved);
}

/**
 * Percorre as pastas de `resolved` da raiz do sistema para baixo e pára na primeira cujo
 * caminho real está dentro do repositório; o resto do caminho fica tal como foi escrito.
 * Null quando nenhuma entra no repositório (uma pasta inexistente também não entra).
 * @param {RealPath} resolveReal
 * @param {string} top raiz do repositório (caminho real)
 * @param {string} resolved caminho absoluto do ficheiro
 * @returns {Promise<string|null>}
 */
async function enterRepository(resolveReal, top, resolved) {
  for (const prefix of ancestry(resolved)) {
    const real = await realOrNull(resolveReal, prefix);
    if (real === null) return null;
    const inside = within(top, real);
    if (inside !== null) return toPosix(path.join(inside, path.relative(prefix, resolved)));
  }
  return null;
}

/**
 * Caminho e as suas pastas, da raiz do sistema até ele próprio.
 * @param {string} filePath caminho absoluto
 * @returns {string[]}
 */
function ancestry(filePath) {
  const parent = path.dirname(filePath);
  return parent === filePath ? [filePath] : [...ancestry(parent), filePath];
}

/**
 * Caminho real, ou null quando o caminho não existe. Outras falhas propagam.
 * @param {RealPath} resolveReal
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function realOrNull(resolveReal, filePath) {
  try {
    return await resolveReal(filePath);
  } catch (cause) {
    if (MISSING.has(String(/** @type {{code?: unknown}} */ (cause)?.code))) return null;
    throw cause;
  }
}

/**
 * Caminho relativo a `top`, com `/`, ou null quando fica fora de `top`.
 * @param {string} top
 * @param {string} candidate caminho absoluto
 * @returns {string|null}
 */
function within(top, candidate) {
  const relative = path.relative(top, candidate);
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
  return outside ? null : toPosix(relative);
}

/**
 * Indica se o git prova que o caminho não existe na revisão. O `ls-tree` lista a entrada
 * sem ler o conteúdo do ficheiro: sem saída, o caminho não existe; com saída, existe mas
 * não pôde ser lido (ex: objecto em falta num clone parcial). O `ls-tree` falha quando a
 * revisão não existe ou falta uma pasta do caminho. O stderr não é interpretado, porque o
 * git traduz as mensagens conforme a língua do sistema.
 * @param {GitRunner} run
 * @param {string} ref
 * @param {string} location caminho relativo à raiz do repositório
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
async function isAbsent(run, ref, location, cwd) {
  const args = ['--literal-pathspecs', 'ls-tree', '--full-tree', ref, '--', location];
  return (await run(args, cwd)).trim() === '';
}

/**
 * Corre um passo e converte as suas falhas em git_show_failed, com a revisão e o caminho.
 * @template T
 * @param {string} ref
 * @param {string} filePath caminho, para a mensagem
 * @param {() => Promise<T>} step
 * @returns {Promise<T>}
 * @throws {ConfigError} git_show_failed
 */
async function guard(ref, filePath, step) {
  try {
    return await step();
  } catch (cause) {
    throw showFailed(ref, filePath, cause);
  }
}

/**
 * Erro de leitura de um ficheiro numa revisão, com o motivo dado pelo git.
 * @param {string} ref
 * @param {string} filePath
 * @param {unknown} cause
 * @returns {ConfigError}
 */
function showFailed(ref, filePath, cause) {
  return new ConfigError('git_show_failed', { ref, path: filePath, reason: gitReason(cause) });
}

/**
 * Caminho relativo à pasta de trabalho, com `/` em qualquer sistema operativo.
 * @param {string} cwd
 * @param {string} filePath
 * @returns {string}
 */
function toGitPath(cwd, filePath) {
  return toPosix(path.relative(cwd, path.resolve(cwd, filePath)));
}

/**
 * Caminho com `/` em qualquer sistema operativo.
 * @param {string} filePath
 * @returns {string}
 */
function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

/**
 * Motivo legível de uma falha do git: a mensagem do próprio git, sem o prefixo `fatal:` ou
 * `error:`.
 * @param {unknown} cause
 * @returns {string}
 */
function gitReason(cause) {
  const stderr = /** @type {{stderr?: unknown}} */ (cause)?.stderr;
  const text = typeof stderr === 'string' ? stderr.trim() : '';
  if (text !== '') return text.replace(/^(fatal|error):\s*/, '');
  return cause instanceof Error ? cause.message : String(cause);
}
