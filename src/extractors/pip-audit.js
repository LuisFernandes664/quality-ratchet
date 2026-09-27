// @ts-check
/**
 * Extractor da saída de `pip-audit -f json`. Aceita o formato actual (objecto com
 * `dependencies`) e o antigo (array de dependências no topo).
 */

import { isPlainObject } from '../core/guards.js';
import { defineExtractor, parseJson, readPath, reportEmpty, unparseable } from './shared.js';

const FORMAT = 'pip-audit';

/** Extractor do formato `pip-audit`. */
export const pipAuditExtractor = defineExtractor({
  format: FORMAT,
  fields: ['count'],
  read: readPipAudit,
});

/**
 * Conta as vulnerabilidades de todas as dependências auditadas.
 * @param {string} text
 * @returns {number}
 */
function readPipAudit(text) {
  const dependencies = dependencyList(parseJson(text, FORMAT));
  if (dependencies.length === 0) throw reportEmpty(FORMAT);
  return dependencies
    .map((dependency, index) => vulnerabilityCount(dependency, index))
    .reduce((sum, count) => sum + count, 0);
}

/**
 * Devolve a lista de dependências, qualquer que seja o formato.
 * @param {unknown} document
 * @returns {unknown[]}
 */
function dependencyList(document) {
  if (Array.isArray(document)) return document;
  const dependencies = readPath(document, ['dependencies'], FORMAT);
  if (!Array.isArray(dependencies)) throw unparseable(FORMAT, '"dependencies" is not an array');
  return dependencies;
}

/**
 * Conta as vulnerabilidades de uma dependência. Dependências ignoradas pelo pip-audit
 * (com `skip_reason` e sem `vulns`) contam zero.
 * @param {unknown} dependency
 * @param {number} index
 * @returns {number}
 */
function vulnerabilityCount(dependency, index) {
  if (!isPlainObject(dependency)) {
    throw unparseable(FORMAT, `"dependencies[${index}]" is not an object`);
  }
  const vulns = dependency.vulns ?? [];
  if (!Array.isArray(vulns)) {
    throw unparseable(FORMAT, `"dependencies[${index}].vulns" is not an array`);
  }
  return vulns.length;
}
