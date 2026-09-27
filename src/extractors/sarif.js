// @ts-check
/**
 * Extractor de relatórios SARIF 2.1.0 (CodeQL, Semgrep, ESLint, Trivy, ...). Conta os
 * resultados activos e não suprimidos de todos os runs, opcionalmente filtrados por nível.
 * Rejeita outras versões do SARIF (a 1.0.0 marca as supressões de outra forma) e os runs em
 * que a própria ferramenta declara que a execução falhou, porque nesse caso os resultados
 * estão incompletos (ex: o ESLint não analisa um ficheiro com erro de sintaxe).
 */

import { isPlainObject } from '../core/guards.js';
import {
  because,
  defineExtractor,
  invalidOption,
  parseJson,
  readPath,
  reportEmpty,
  unparseable,
} from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */
/** @typedef {Record<string, unknown>} SarifObject */

const FORMAT = 'sarif';

/** Única versão do SARIF suportada. */
const SUPPORTED_VERSION = '2.1.0';

/** Listas de notificações de uma invocação que podem explicar uma execução falhada. */
const NOTIFICATION_LISTS = ['toolConfigurationNotifications', 'toolExecutionNotifications'];

/** Níveis de resultado definidos pela especificação SARIF. */
const LEVELS = ['error', 'warning', 'note', 'none'];

/** Nível efectivo de um resultado sem `level` e sem nível por omissão na regra. */
const DEFAULT_LEVEL = 'warning';

/**
 * Estados de supressão que não suprimem o resultado: a supressão está em revisão ou foi
 * rejeitada. Sem `status`, ou com "accepted", a supressão é válida.
 * @type {Set<unknown>}
 */
const INEFFECTIVE_SUPPRESSIONS = new Set(['underReview', 'rejected']);

/** Extractor do formato `sarif`. */
export const sarifExtractor = defineExtractor({
  format: FORMAT,
  fields: ['count'],
  read: readSarif,
});

/**
 * Conta os resultados activos cujo nível está em `source.levels` (todos, se omitido).
 * Só aceita SARIF 2.1.0, e cada run tem de ter corrido com sucesso.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readSarif(text, request) {
  const levels = parseLevels(request.source.levels);
  const log = parseJson(text, FORMAT);
  checkVersion(log);
  const runs = readPath(log, ['runs'], FORMAT);
  if (!Array.isArray(runs)) {
    throw unparseable(FORMAT, because('reason_not_array', { path: 'runs' }));
  }
  if (runs.length === 0) throw reportEmpty(FORMAT);
  return runs.reduce((total, run, index) => total + countRun(run, index, levels), 0);
}

/**
 * Exige a versão 2.1.0. O SARIF 1.0.0 (ex: o ErrorLog do compilador C# por omissão) marca
 * os diagnósticos suprimidos com `suppressionStates`, que esta versão não conhece: contá-los
 * como activos daria um valor errado sem nenhum aviso.
 * @param {unknown} log documento SARIF já interpretado
 * @returns {void}
 */
function checkVersion(log) {
  if (!isPlainObject(log) || log.version === SUPPORTED_VERSION) return;
  if (log.version === undefined) throw unparseable(FORMAT, because('reason_sarif_version_missing'));
  throw unparseable(FORMAT, because('reason_sarif_version', { version: String(log.version) }));
}

/**
 * Valida a opção `levels`.
 * @param {unknown} levels
 * @returns {unknown[]|null} null quando todos os níveis contam
 */
function parseLevels(levels) {
  if (levels === undefined) return null;
  if (!Array.isArray(levels) || levels.length === 0) {
    throw invalidOption(FORMAT, 'levels', because('reason_levels_invalid', {
      known: LEVELS.join(', '),
    }));
  }
  const unknown = levels.find((level) => !LEVELS.includes(level));
  if (unknown !== undefined) {
    throw invalidOption(FORMAT, 'levels', because('reason_level_unknown', {
      level: String(unknown),
    }));
  }
  return levels;
}

/**
 * Conta os resultados de um run que são activos e têm um dos níveis pedidos.
 * @param {unknown} run
 * @param {number} index
 * @param {unknown[]|null} levels
 * @returns {number}
 */
function countRun(run, index, levels) {
  if (!isPlainObject(run)) {
    throw unparseable(FORMAT, because('reason_not_object', { path: `runs[${index}]` }));
  }
  rejectFailedExecution(run, index);
  return runResults(run, index)
    .filter((result) => isActive(result))
    .filter((result) => levels === null || levels.includes(effectiveLevel(result, run)))
    .length;
}

/**
 * Devolve os resultados de um run. Um run sem `results` (ex: só exporta as regras) não
 * contribui com nada.
 * @param {SarifObject} run
 * @param {number} index
 * @returns {SarifObject[]}
 */
function runResults(run, index) {
  const results = run.results ?? [];
  const valid = Array.isArray(results) && results.every((result) => isPlainObject(result));
  if (!valid) {
    const path = `runs[${index}].results`;
    throw unparseable(FORMAT, because('reason_not_array_of_objects', { path }));
  }
  return results;
}

/**
 * Rejeita um run cuja ferramenta declara `invocations[].executionSuccessful: false`. O
 * formatador SARIF do ESLint, por exemplo, não escreve resultados para um ficheiro com erro
 * de sintaxe: põe o erro nas notificações e marca a execução como falhada. Contar só os
 * resultados daria uma descida falsa. Sem `invocations`, ou com `true`, o run é aceite.
 * @param {SarifObject} run
 * @param {number} index
 * @returns {void}
 */
function rejectFailedExecution(run, index) {
  const invocations = Array.isArray(run.invocations) ? run.invocations : [];
  const failed = invocations.filter((invocation) => isPlainObject(invocation)
    && invocation.executionSuccessful === false);
  if (failed.length === 0) return;
  const details = [...new Set(failed.flatMap(errorNotifications))].join('; ');
  throw unparseable(FORMAT, because('reason_sarif_execution_failed', {
    run: `runs[${index}]`,
    details,
  }));
}

/**
 * Textos das notificações de nível "error" de uma invocação.
 * @param {SarifObject} invocation
 * @returns {string[]}
 */
function errorNotifications(invocation) {
  return NOTIFICATION_LISTS
    .flatMap((key) => (Array.isArray(invocation[key]) ? invocation[key] : []))
    .filter((notification) => isPlainObject(notification) && notification.level === 'error')
    .map((notification) => messageText(notification.message))
    .filter((text) => text !== '');
}

/**
 * Texto de uma mensagem SARIF (`message.text`), sem espaços nas pontas.
 * @param {unknown} message
 * @returns {string}
 */
function messageText(message) {
  const text = isPlainObject(message) ? message.text : undefined;
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * Indica se um resultado é um problema actual. Não conta quando a comparação com a linha
 * de base da ferramenta o dá como desaparecido (`baselineState: "absent"`) nem quando está
 * suprimido: `suppressions` não vazio sem nenhuma supressão em revisão ou rejeitada.
 * @param {SarifObject} result
 * @returns {boolean}
 */
function isActive(result) {
  if (result.baselineState === 'absent') return false;
  const { suppressions } = result;
  if (!Array.isArray(suppressions) || suppressions.length === 0) return true;
  return suppressions.some((entry) => isPlainObject(entry)
    && INEFFECTIVE_SUPPRESSIONS.has(entry.status));
}

/**
 * Nível efectivo de um resultado (SARIF 2.1.0, secção 3.27.10): o `level` do resultado;
 * "none" quando `kind` existe e não é "fail"; o `defaultConfiguration.level` da regra;
 * por fim "warning". O CodeQL, por exemplo, só declara o nível nas regras.
 * @param {SarifObject} result
 * @param {SarifObject} run
 * @returns {unknown}
 */
function effectiveLevel(result, run) {
  if (result.level !== undefined) return result.level;
  if (result.kind !== undefined && result.kind !== 'fail') return 'none';
  return ruleDefaultLevel(result, run) ?? DEFAULT_LEVEL;
}

/**
 * Lê o `defaultConfiguration.level` da regra do resultado, procurada pelo índice
 * (`rule.index` ou `ruleIndex`) ou, sem índice válido, pelo identificador.
 * @param {SarifObject} result
 * @param {SarifObject} run
 * @returns {unknown} undefined quando a regra ou o nível não existem
 */
function ruleDefaultLevel(result, run) {
  /** @type {SarifObject} */
  const reference = isPlainObject(result.rule) ? result.rule : {};
  const rules = componentRules(run, reference.toolComponent);
  const index = reference.index ?? result.ruleIndex;
  const id = reference.id ?? result.ruleId;
  const rule = (typeof index === 'number' ? rules[index] : undefined)
    ?? rules.find((candidate) => id !== undefined && isPlainObject(candidate)
      && candidate.id === id);
  const configuration = isPlainObject(rule) ? rule.defaultConfiguration : undefined;
  return isPlainObject(configuration) ? configuration.level : undefined;
}

/**
 * Devolve as regras do componente da ferramenta referido pelo resultado: uma extensão
 * quando há `rule.toolComponent` (o CodeQL guarda as regras nos pacotes de consultas,
 * em `tool.extensions`), senão o `tool.driver`.
 * @param {SarifObject} run
 * @param {unknown} reference `result.rule.toolComponent`
 * @returns {unknown[]}
 */
function componentRules(run, reference) {
  /** @type {SarifObject} */
  const tool = isPlainObject(run.tool) ? run.tool : {};
  const component = isPlainObject(reference) ? findComponent(tool, reference) : tool.driver;
  return isPlainObject(component) && Array.isArray(component.rules) ? component.rules : [];
}

/**
 * Localiza o componente de uma referência `toolComponent`: `index` aponta para
 * `tool.extensions`; sem índice, procura pelo `guid` ou pelo `name` no driver e nas extensões.
 * @param {SarifObject} tool
 * @param {SarifObject} reference
 * @returns {unknown}
 */
function findComponent(tool, reference) {
  const extensions = Array.isArray(tool.extensions) ? tool.extensions : [];
  if (typeof reference.index === 'number') return extensions[reference.index];
  return [tool.driver, ...extensions].find((component) => isPlainObject(component)
    && ((reference.guid !== undefined && component.guid === reference.guid)
      || (reference.name !== undefined && component.name === reference.name)));
}
