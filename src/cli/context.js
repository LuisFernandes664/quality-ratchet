// @ts-check
/**
 * Contexto partilhado pelos comandos da CLI: ficheiros com caminhos relativos à pasta de
 * trabalho, tradução, data de hoje, git e saída para a consola.
 */
import path from 'node:path';

/** @typedef {import('../core/messages.js').Translator} Translator */
/** @typedef {import('../core/types.js').Issue} Issue */
/** @typedef {import('./git.js').Git} Git */
/** @typedef {'error'|'warning'|'notice'} LogLevel */

/**
 * Acesso ao sistema de ficheiros.
 * @typedef {object} CliFileSystem
 * @property {(filePath: string) => Promise<string>} readText
 * @property {(filePath: string) => Promise<boolean>} exists
 * @property {(filePath: string, text: string) => Promise<void>} writeText
 */

/**
 * Dependências da CLI, ligadas pelo ponto de entrada.
 * @typedef {object} CliDeps
 * @property {string[]} argv argumentos sem o executável nem o script
 * @property {string} cwd pasta de trabalho, base dos caminhos relativos
 * @property {Record<string, string|undefined>} env variáveis de ambiente
 * @property {CliFileSystem} fs
 * @property {(line: string) => void} stdout escreve texto no stdout (sem fim de linha)
 * @property {(line: string) => void} stderr escreve texto no stderr (sem fim de linha)
 * @property {() => Date} now
 * @property {Git} git
 * @property {string} version versão do pacote
 */

/**
 * Contexto de execução de um comando.
 * @typedef {object} CommandContext
 * @property {CliFileSystem} fs caminhos relativos resolvidos a partir de `cwd`
 * @property {string} cwd
 * @property {Translator} t
 * @property {string} today data de hoje (AAAA-MM-DD), gravada em `frozen_at`
 * @property {Git} git
 * @property {(text: string) => void} stdout resultado do comando
 * @property {(level: LogLevel, text: string) => void} log mensagem no stderr com o nível
 */

/**
 * Cria o contexto dos comandos a partir das dependências.
 * @param {CliDeps} deps
 * @param {Translator} t
 * @returns {CommandContext}
 */
export function createContext(deps, t) {
  return {
    fs: scopedFileSystem(deps.fs, deps.cwd),
    cwd: deps.cwd,
    t,
    today: deps.now().toISOString().slice(0, 10),
    git: deps.git,
    stdout: deps.stdout,
    log: (level, text) => deps.stderr(`${level}: ${text}`),
  };
}

/**
 * Sistema de ficheiros que resolve os caminhos relativos a partir da pasta de trabalho.
 * Assim as mensagens mostram os caminhos tal como foram escritos na linha de comandos.
 * @param {CliFileSystem} fs
 * @param {string} cwd
 * @returns {CliFileSystem}
 */
export function scopedFileSystem(fs, cwd) {
  const resolve = (/** @type {string} */ filePath) => path.resolve(cwd, filePath);
  return {
    readText: (filePath) => fs.readText(resolve(filePath)),
    exists: (filePath) => fs.exists(resolve(filePath)),
    writeText: (filePath, text) => fs.writeText(resolve(filePath), text),
  };
}

/**
 * Pasta do baseline, base dos caminhos das sources.
 * @param {CommandContext} ctx
 * @param {string} baselinePath
 * @returns {string} caminho absoluto
 */
export function baselineDir(ctx, baselinePath) {
  return path.dirname(path.resolve(ctx.cwd, baselinePath));
}

/**
 * Escreve JSON indentado a dois espaços, terminado com fim de linha.
 * @param {CommandContext} ctx
 * @param {string} filePath
 * @param {unknown} data
 * @returns {Promise<void>}
 */
export async function writeJson(ctx, filePath, data) {
  await ctx.fs.writeText(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Regista uma mensagem por problema, traduzida.
 * @param {CommandContext} ctx
 * @param {LogLevel} level
 * @param {Issue[]} issues
 * @returns {void}
 */
export function logIssues(ctx, level, issues) {
  for (const issue of issues) ctx.log(level, ctx.t(issue.code, issue.params));
}

/**
 * Avisa das métricas medidas que o baseline não segue, quando as há.
 * @param {CommandContext} ctx
 * @param {string[]} names
 * @returns {void}
 */
export function warnUntracked(ctx, names) {
  if (names.length === 0) return;
  ctx.log('warning', ctx.t('warning_untracked', { names: names.join(', ') }));
}
