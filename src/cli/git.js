// @ts-check
/**
 * Leitura de ficheiros noutra revisão do repositório, com o `git` instalado. Serve a
 * governação na CLI: o baseline do ramo base é o contrato que o PR não pode afrouxar.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { ConfigError } from '../core/errors.js';

/**
 * @typedef {object} Git
 * @property {(ref: string, filePath: string, cwd: string) => Promise<string|null>} show
 *   conteúdo do ficheiro na revisão `ref`, ou null quando o ficheiro não existe nessa
 *   revisão; `filePath` é relativo a `cwd` (ou absoluto)
 */

/**
 * Executor de comandos git: devolve o stdout, ou rejeita com o erro do processo (que traz
 * `code` numérico quando o git terminou com erro, e `stderr`).
 * @typedef {(args: string[], cwd: string) => Promise<string>} GitRunner
 */

/** Limite do stdout de um comando git. */
const MAX_BUFFER = 16 * 1024 * 1024;

/** Motivo da recusa de uma revisão que o git não leria como revisão. */
const NOT_A_REVISION = 'not a revision: it is empty or starts with "-"';

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
 * @returns {Git}
 */
export function createGit(run = runGit) {
  return { show: (ref, filePath, cwd) => showFile(run, ref, filePath, cwd) };
}

/**
 * Lê um ficheiro numa revisão com `git show <ref>:./<caminho>`. Quando o git falha e a
 * revisão existe, é o ficheiro que não existe nela: devolve null. As outras falhas
 * (revisão inexistente, pasta fora de um repositório, git em falta) são erros.
 * @param {GitRunner} run
 * @param {string} ref
 * @param {string} filePath
 * @param {string} cwd
 * @returns {Promise<string|null>}
 * @throws {ConfigError} git_show_failed
 */
async function showFile(run, ref, filePath, cwd) {
  const relative = toGitPath(cwd, filePath);
  assertRevision(ref, relative);
  try {
    return await run(['show', `${ref}:./${relative}`], cwd);
  } catch (cause) {
    if (exitCode(cause) !== null && await isCommit(run, ref, cwd)) return null;
    throw new ConfigError('git_show_failed', { ref, path: relative, reason: gitReason(cause) });
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
 * Indica se a revisão existe. O `rev-parse --verify` termina com erro quando não existe,
 * e esse é o sinal que interessa; outras falhas propagam.
 * @param {GitRunner} run
 * @param {string} ref
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
async function isCommit(run, ref, cwd) {
  try {
    await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    return true;
  } catch (cause) {
    if (exitCode(cause) !== null) return false;
    throw cause;
  }
}

/**
 * Caminho relativo à pasta de trabalho, com `/` em qualquer sistema operativo.
 * @param {string} cwd
 * @param {string} filePath
 * @returns {string}
 */
function toGitPath(cwd, filePath) {
  return path.relative(cwd, path.resolve(cwd, filePath)).split(path.sep).join('/');
}

/**
 * Código de saída do git, ou null quando o processo nem chegou a correr.
 * @param {unknown} cause
 * @returns {number|null}
 */
function exitCode(cause) {
  const code = /** @type {{code?: unknown}} */ (cause)?.code;
  return typeof code === 'number' ? code : null;
}

/**
 * Motivo legível de uma falha do git: a mensagem do próprio git, sem o prefixo `fatal:`.
 * @param {unknown} cause
 * @returns {string}
 */
function gitReason(cause) {
  const stderr = /** @type {{stderr?: unknown}} */ (cause)?.stderr;
  const text = typeof stderr === 'string' ? stderr.trim() : '';
  if (text !== '') return text.replace(/^fatal:\s*/, '');
  return cause instanceof Error ? cause.message : String(cause);
}
