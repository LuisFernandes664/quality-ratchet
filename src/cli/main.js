// @ts-check
/**
 * CLI da catraca: `check`, `update`, `init` e `migrate`. Recebe todas as dependências
 * (argumentos, ficheiros, consola, relógio, git) para ser testável sem processos reais.
 */
import { ConfigError } from '../core/errors.js';
import { createTranslator, describeError, normaliseLanguage } from '../core/messages.js';
import { peekLanguage, readCommandOptions, splitCommand, stringOption } from './args.js';
import { runCheck } from './commands/check.js';
import { runInit } from './commands/init.js';
import { runMigrate } from './commands/migrate.js';
import { runUpdate } from './commands/update.js';
import { createContext } from './context.js';
import { DEFAULTS, EXIT } from './defaults.js';
import { helpText } from './help.js';

/** @typedef {import('../core/messages.js').Translator} Translator */
/** @typedef {import('./context.js').CliDeps} CliDeps */
/** @typedef {import('./context.js').CommandContext} CommandContext */
/** @typedef {import('./args.js').OptionValues} OptionValues */
/** @typedef {(ctx: CommandContext, values: OptionValues) => Promise<number>} Command */

/**
 * Implementação de cada comando.
 * @type {Readonly<Record<string, Command>>}
 */
const COMMANDS = Object.freeze({
  check: runCheck,
  update: runUpdate,
  init: runInit,
  migrate: runMigrate,
});

/**
 * Corre a CLI. Os erros de utilização e de configuração são escritos no stderr e terminam
 * com o código 2. Saem na língua de `--language` sempre que ela é suportada, incluindo os
 * erros nas próprias opções; com uma língua não suportada saem em inglês.
 * @param {CliDeps} deps
 * @returns {Promise<number>} 0 verde, 1 a catraca falhou, 2 erro de utilização ou configuração
 */
export async function runCli(deps) {
  let t = initialTranslator(deps.argv);
  try {
    const { command, args, values: early } = splitCommand(deps.argv);
    const language = normaliseLanguage(stringOption(early, 'language', DEFAULTS.language));
    t = createTranslator(language);
    const values = readCommandOptions(command, args);
    if (values.help) return print(deps, helpText(language));
    if (values.version) return print(deps, deps.version);
    return await COMMANDS[command](createContext(deps, t), values);
  } catch (error) {
    deps.stderr(`error: ${describeError(error, t)}`);
    return EXIT.usage;
  }
}

/**
 * Tradutor dos erros detectados antes de as opções serem validadas. A língua não suportada
 * não é engolida: a validação das opções volta a lê-la e reporta-a, em inglês.
 * @param {string[]} argv
 * @returns {Translator}
 */
function initialTranslator(argv) {
  try {
    return createTranslator(normaliseLanguage(peekLanguage(argv) ?? DEFAULTS.language));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return createTranslator(DEFAULTS.language);
  }
}

/**
 * Escreve um texto informativo no stdout e termina com sucesso.
 * @param {CliDeps} deps
 * @param {string} text
 * @returns {number}
 */
function print(deps, text) {
  deps.stdout(text);
  return EXIT.ok;
}
