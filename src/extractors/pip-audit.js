// @ts-check
/**
 * Extractor da saída de `pip-audit -f json`. Aceita o formato actual (objecto com
 * `dependencies`) e o antigo (array de dependências no topo). Conta as vulnerabilidades
 * distintas de cada dependência: entradas que partilham um `id` ou um dos `aliases` são a
 * mesma vulnerabilidade. O pip-audit 2.10 (serviço PyPI) repete cada vulnerabilidade com o
 * registo PYSEC e o GHSA, ambos com o mesmo `id`.
 */

import { isPlainObject } from '../core/guards.js';
import { because, defineExtractor, parseJson, readPath, unparseable } from './shared.js';

const FORMAT = 'pip-audit';

/** Extractor do formato `pip-audit`. */
export const pipAuditExtractor = defineExtractor({
  format: FORMAT,
  fields: ['count'],
  read: readPipAudit,
});

/**
 * Conta as vulnerabilidades de todas as dependências auditadas. Uma lista de dependências
 * vazia (projecto só com a biblioteca padrão) conta 0, como no `npm audit`: quando não
 * consegue recolher as dependências, o pip-audit termina com erro e não escreve JSON.
 * @param {string} text
 * @returns {number}
 */
function readPipAudit(text) {
  return dependencyList(parseJson(text, FORMAT))
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
  if (!Array.isArray(dependencies)) {
    throw unparseable(FORMAT, because('reason_not_array', { path: 'dependencies' }));
  }
  return dependencies;
}

/**
 * Conta as vulnerabilidades distintas de uma dependência. Dependências ignoradas pelo
 * pip-audit (com `skip_reason` e sem `vulns`) contam zero.
 * @param {unknown} dependency
 * @param {number} index
 * @returns {number}
 */
function vulnerabilityCount(dependency, index) {
  const path = `dependencies[${index}]`;
  if (!isPlainObject(dependency)) throw unparseable(FORMAT, because('reason_not_object', { path }));
  const vulns = dependency.vulns ?? [];
  if (!Array.isArray(vulns)) {
    throw unparseable(FORMAT, because('reason_not_array', { path: `${path}.vulns` }));
  }
  return countDistinct(vulns.map((vuln, position) => (
    vulnerabilityKeys(vuln, `${path}.vulns[${position}]`))));
}

/**
 * Identificadores de uma vulnerabilidade: o `id` e os `aliases` (ex: CVE, GHSA).
 * @param {unknown} vuln
 * @param {string} path posição da entrada no relatório, para a mensagem
 * @returns {string[]}
 */
function vulnerabilityKeys(vuln, path) {
  if (!isPlainObject(vuln)) throw unparseable(FORMAT, because('reason_not_object', { path }));
  if (typeof vuln.id !== 'string') {
    throw unparseable(FORMAT, because('reason_not_string', { path: `${path}.id` }));
  }
  const aliases = Array.isArray(vuln.aliases) ? vuln.aliases : [];
  return [vuln.id, ...aliases.filter((alias) => typeof alias === 'string')];
}

/**
 * Conta os grupos de entradas ligadas por identificadores comuns, directa ou
 * indirectamente (A partilha um alias com B e B com C: os três são um só).
 * @param {string[][]} entries identificadores de cada entrada
 * @returns {number}
 */
function countDistinct(entries) {
  /** @type {Set<string>[]} */
  let groups = [];
  for (const keys of entries) {
    const linked = groups.filter((group) => keys.some((key) => group.has(key)));
    const merged = new Set([...keys, ...linked.flatMap((group) => [...group])]);
    groups = [...groups.filter((group) => !linked.includes(group)), merged];
  }
  return groups.length;
}
