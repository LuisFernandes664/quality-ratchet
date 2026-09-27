// @ts-check
/**
 * Leitura da linha de comandos. O comando é o primeiro argumento posicional (por omissão
 * `check`) e cada comando só aceita as suas opções, para que uma opção trocada ou com
 * gralha seja rejeitada em vez de ignorada.
 */
import { parseArgs } from 'node:util';

import { ConfigError } from '../core/errors.js';

/**
 * Definição de uma opção, no formato de `util.parseArgs`.
 * @typedef {object} OptionSpec
 * @property {'string'|'boolean'} type
 * @property {string} [short]
 * @property {boolean} [multiple]
 */

/** @typedef {Record<string, string|boolean|string[]|undefined>} OptionValues */

/**
 * @typedef {object} CommandLine
 * @property {string} command comando pedido, ainda por validar
 * @property {string[]} args argumentos sem o comando
 * @property {OptionValues} values opções lidas sem distinguir comandos, para conhecer a
 *   língua antes de validar o comando e as suas opções
 */

/** @typedef {{kind: string, index: number, value?: string}} Token */

/** @type {OptionSpec} */
const TEXT = { type: 'string' };

/** @type {OptionSpec} */
const FLAG = { type: 'boolean' };

/**
 * Lista separada por vírgulas; a opção pode repetir-se.
 * @type {OptionSpec}
 */
const LIST = { type: 'string', multiple: true };

/**
 * Opções aceites por todos os comandos.
 * @type {Readonly<Record<string, OptionSpec>>}
 */
const COMMON = Object.freeze({
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  language: TEXT,
});

/**
 * Opções próprias de cada comando.
 * @type {Readonly<Record<string, Readonly<Record<string, OptionSpec>>>>}
 */
export const COMMAND_OPTIONS = Object.freeze({
  check: Object.freeze({
    baseline: TEXT,
    metrics: TEXT,
    'base-ref': TEXT,
    title: TEXT,
    labels: LIST,
    'bypass-label': TEXT,
    'lower-baseline-pattern': TEXT,
    strict: FLAG,
    name: TEXT,
    format: TEXT,
    'write-baseline': TEXT,
  }),
  update: Object.freeze({ baseline: TEXT, metrics: TEXT, 'allow-lower': FLAG, output: TEXT }),
  init: Object.freeze({ metrics: TEXT, up: LIST, down: LIST, output: TEXT, force: FLAG }),
  migrate: Object.freeze({ baseline: TEXT, output: TEXT }),
});

/** Comando usado quando nenhum é indicado. */
export const DEFAULT_COMMAND = 'check';

/**
 * União das opções de todos os comandos, usada apenas para localizar o comando. Uma opção
 * tem o mesmo tipo em todos os comandos, por isso a leitura dos argumentos é a mesma.
 * @type {Record<string, OptionSpec>}
 */
const ALL_OPTIONS = Object.assign({}, COMMON, ...Object.values(COMMAND_OPTIONS));

/**
 * Separa o comando dos restantes argumentos.
 * @param {string[]} argv argumentos sem o executável nem o script
 * @returns {CommandLine}
 * @throws {ConfigError} cli_option_invalid
 */
export function splitCommand(argv) {
  const { values, tokens } = parse(argv, ALL_OPTIONS, true);
  const token = tokens.find((item) => item.kind === 'positional');
  const command = token?.value ?? DEFAULT_COMMAND;
  const args = token ? argv.filter((_, index) => index !== token.index) : argv;
  return { command, args, values };
}

/**
 * Língua pedida em `--language`, lida sem validar os argumentos, para que os erros das
 * próprias opções saiam na língua pedida. A leitura usa as opções de todos os comandos, como
 * a leitura estrita, para que o valor de outra opção (ex: `--title pt`) não passe por língua.
 * @param {string[]} argv argumentos sem o executável nem o script
 * @returns {string|undefined} a língua pedida, ou undefined quando não foi dada
 */
export function peekLanguage(argv) {
  const { values } = parseArgs({
    args: argv,
    options: ALL_OPTIONS,
    strict: false,
    allowPositionals: true,
  });
  return typeof values.language === 'string' ? values.language : undefined;
}

/**
 * Valida o comando e lê as suas opções, rejeitando as que pertencem a outros comandos.
 * @param {string} command
 * @param {string[]} args argumentos sem o comando
 * @returns {OptionValues}
 * @throws {ConfigError} cli_command_unknown ou cli_option_invalid
 */
export function readCommandOptions(command, args) {
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    throw new ConfigError('cli_command_unknown', { command });
  }
  return parse(args, { ...COMMON, ...COMMAND_OPTIONS[command] }, false).values;
}

/**
 * Lê os argumentos em modo estrito, convertendo os erros do parseArgs em ConfigError.
 * @param {string[]} args
 * @param {Record<string, OptionSpec>} options
 * @param {boolean} allowPositionals
 * @returns {{values: OptionValues, tokens: Token[]}}
 */
function parse(args, options, allowPositionals) {
  try {
    const result = parseArgs({ args, options, strict: true, allowPositionals, tokens: true });
    return { values: /** @type {OptionValues} */ (result.values), tokens: result.tokens };
  } catch (cause) {
    if (!isParseError(cause)) throw cause;
    throw new ConfigError('cli_option_invalid', { reason: cause.message });
  }
}

/**
 * Indica se o erro veio da validação de argumentos do parseArgs.
 * @param {unknown} cause
 * @returns {cause is TypeError}
 */
function isParseError(cause) {
  const code = /** @type {{code?: unknown}} */ (cause).code;
  return cause instanceof TypeError && String(code).startsWith('ERR_PARSE_ARGS');
}

/**
 * Valor de uma opção de texto, ou o valor por omissão. Um texto vazio explícito é mantido
 * (ex: `--bypass-label ""` desliga o perdão); para caminhos usar `nonEmptyOption`.
 * @template {string|undefined} F
 * @param {OptionValues} values
 * @param {string} name
 * @param {F} fallback
 * @returns {string|F}
 */
export function stringOption(values, name, fallback) {
  const value = values[name];
  return typeof value === 'string' ? value : fallback;
}

/**
 * Valor de uma opção que não pode ficar vazia (caminhos e revisão git), ou o valor por
 * omissão quando a opção não foi dada. Um valor vazio ou só com espaços vem quase sempre de
 * uma variável de CI por definir: seguir com ele leria a pasta de trabalho como ficheiro,
 * criaria um ficheiro com nome de espaços, ou ignoraria o pedido em silêncio (ex:
 * `--write-baseline ""` num job de lock-in ficaria verde sem escrever nada).
 * @template {string|undefined} F
 * @param {OptionValues} values
 * @param {string} name
 * @param {F} fallback
 * @returns {string|F}
 * @throws {ConfigError} config_input_required
 */
export function nonEmptyOption(values, name, fallback) {
  const value = stringOption(values, name, undefined);
  if (value === undefined) return fallback;
  if (value.trim() !== '') return value;
  throw new ConfigError('config_input_required', { input: `--${name}` });
}

/**
 * Valor de uma opção booleana.
 * @param {OptionValues} values
 * @param {string} name
 * @returns {boolean}
 */
export function flagOption(values, name) {
  return values[name] === true;
}

/**
 * Valores de uma opção de lista: separa por vírgulas, junta repetições da opção, retira
 * espaços, entradas vazias e duplicados, mantendo a ordem.
 * @param {OptionValues} values
 * @param {string} name
 * @returns {string[]}
 */
export function listOption(values, name) {
  const value = values[name];
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const items = parts.flatMap((part) => part.split(',')).map((item) => item.trim());
  return [...new Set(items.filter((item) => item !== ''))];
}
