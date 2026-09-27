// @ts-check
/**
 * Extractor de relatórios SARIF 2.1.0 (CodeQL, Semgrep, ESLint, Trivy, ...). Conta os
 * resultados activos e não suprimidos de todos os runs, opcionalmente filtrados por nível.
 */

import { isPlainObject } from '../core/guards.js';
import {
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
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readSarif(text, request) {
  const levels = parseLevels(request.source.levels);
  const runs = readPath(parseJson(text, FORMAT), ['runs'], FORMAT);
  if (!Array.isArray(runs)) throw unparseable(FORMAT, '"runs" is not an array');
  if (runs.length === 0) throw reportEmpty(FORMAT);
  return runs.reduce((total, run, index) => total + countRun(run, index, levels), 0);
}

/**
 * Valida a opção `levels`.
 * @param {unknown} levels
 * @returns {unknown[]|null} null quando todos os níveis contam
 */
function parseLevels(levels) {
  if (levels === undefined) return null;
  if (!Array.isArray(levels) || levels.length === 0) {
    throw invalidOption(FORMAT, 'levels', `must be a non-empty array of ${LEVELS.join(', ')}`);
  }
  const unknown = levels.find((level) => !LEVELS.includes(level));
  if (unknown !== undefined) {
    throw invalidOption(FORMAT, 'levels', `unknown level "${String(unknown)}"`);
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
  if (!isPlainObject(run)) throw unparseable(FORMAT, `"runs[${index}]" is not an object`);
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
    throw unparseable(FORMAT, `"runs[${index}].results" is not an array of objects`);
  }
  return results;
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
