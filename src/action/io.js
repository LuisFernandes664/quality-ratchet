// @ts-check
/**
 * Comunicação com o runner do GitHub Actions: inputs, outputs, resumo do job e workflow
 * commands. O ambiente, as escritas em ficheiro e o stdout são injectados.
 */

import { ConfigError } from '../core/errors.js';

const OUTPUT_FILE_VAR = 'GITHUB_OUTPUT';
const SUMMARY_FILE_VAR = 'GITHUB_STEP_SUMMARY';
const DELIMITER_PREFIX = 'ghadelimiter_';

/** @typedef {Record<string, string|undefined>} Env */

/**
 * @typedef {object} ActionIODeps
 * @property {Env} env variáveis de ambiente do runner
 * @property {(path: string, text: string) => Promise<void>} appendFile acrescenta texto
 * @property {(line: string) => void} write escreve uma linha no stdout; a linha chega sem
 *   terminador e quem implementa acrescenta o fim de linha (ex: console.log)
 * @property {() => string} randomId identificador aleatório para delimitadores heredoc
 */

/**
 * @typedef {object} ActionIO
 * @property {(name: string, value: string) => Promise<void>} setOutput
 * @property {(markdown: string) => Promise<void>} appendSummary
 * @property {(message: string) => void} debug
 * @property {(message: string) => void} notice
 * @property {(message: string) => void} warning
 * @property {(message: string) => void} error
 */

/**
 * Lê um input da action. O runner expõe-o como INPUT_<NOME>, com espaços convertidos em
 * `_` e em maiúsculas (os hífenes mantêm-se). Valor vazio ou ausente devolve o fallback.
 * @param {Env} env
 * @param {string} name nome do input tal como no action.yml (ex: 'bypass-label')
 * @param {string} [fallback] por omissão ''
 * @returns {string}
 */
export function readInput(env, name, fallback = '') {
  const value = env[inputKey(name)]?.trim() ?? '';
  return value === '' ? fallback : value;
}

/**
 * Lê um input booleano: 'true' ou 'false' sem distinguir maiúsculas. Vazio devolve o
 * fallback; qualquer outro valor lança ConfigError('config_boolean_invalid').
 * @param {Env} env
 * @param {string} name
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function readBooleanInput(env, name, fallback) {
  const raw = readInput(env, name);
  if (raw === '') return fallback;
  const normalized = raw.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new ConfigError('config_boolean_invalid', { input: name, value: raw });
}

/**
 * Cria as operações de saída da action sobre as dependências injectadas.
 * @param {ActionIODeps} deps
 * @returns {ActionIO}
 */
export function createActionIO(deps) {
  return {
    setOutput: (name, value) => setOutput(deps, name, value),
    appendSummary: (markdown) => appendSummary(deps, markdown),
    debug: (message) => deps.write(workflowCommand('debug', message)),
    notice: (message) => deps.write(workflowCommand('notice', message)),
    warning: (message) => deps.write(workflowCommand('warning', message)),
    error: (message) => deps.write(workflowCommand('error', message)),
  };
}

/**
 * Nome da variável de ambiente de um input.
 * @param {string} name
 * @returns {string}
 */
function inputKey(name) {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
}

/**
 * Acrescenta um output ao ficheiro GITHUB_OUTPUT em formato heredoc. Sem a variável, não
 * escreve nada.
 * @param {ActionIODeps} deps
 * @param {string} name
 * @param {string} value
 * @returns {Promise<void>}
 */
async function setOutput(deps, name, value) {
  const file = deps.env[OUTPUT_FILE_VAR];
  if (!file) return;
  const delimiter = pickDelimiter(deps.randomId, value);
  await deps.appendFile(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/**
 * Escolhe um delimitador que não aparece no valor. Cada tentativa alonga o delimitador,
 * por isso o ciclo termina sempre.
 * @param {() => string} randomId
 * @param {string} value
 * @returns {string}
 */
function pickDelimiter(randomId, value) {
  let delimiter = `${DELIMITER_PREFIX}${randomId()}`;
  while (value.includes(delimiter)) delimiter = `${delimiter}_${randomId()}`;
  return delimiter;
}

/**
 * Acrescenta markdown ao resumo do job (GITHUB_STEP_SUMMARY). Sem a variável, não faz nada.
 * @param {ActionIODeps} deps
 * @param {string} markdown
 * @returns {Promise<void>}
 */
async function appendSummary(deps, markdown) {
  const file = deps.env[SUMMARY_FILE_VAR];
  if (!file) return;
  await deps.appendFile(file, `${markdown}\n`);
}

/**
 * Formata um workflow command (ex: `::warning::mensagem`).
 * @param {string} command
 * @param {string} message
 * @returns {string}
 */
function workflowCommand(command, message) {
  return `::${command}::${escapeData(message)}`;
}

/**
 * Escapa os caracteres com significado especial nos dados de um workflow command.
 * @param {string} text
 * @returns {string}
 */
function escapeData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
