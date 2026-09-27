// @ts-check
/**
 * Extractor da saída de `npm audit --json`. Lê `metadata.vulnerabilities`, presente tanto no
 * formato do npm 7+ (`auditReportVersion: 2`, com `total`) como no do npm 6 (sem `total`).
 */

import { isPlainObject } from '../core/guards.js';
import { defineExtractor, parseJson, readCount, readPath, unparseable } from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

const FORMAT = 'npm-audit';

/** Caminho das contagens por severidade no relatório. */
const VULNERABILITIES = ['metadata', 'vulnerabilities'];

/** Severidades do npm, da mais grave para a menos grave. */
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'];

/**
 * Severidades somadas por cada campo; `total` usa o valor do relatório quando existe.
 * @type {Record<string, string[]>}
 */
const FIELD_SEVERITIES = {
  total: SEVERITIES,
  critical: ['critical'],
  high: ['high'],
  moderate: ['moderate'],
  low: ['low'],
  info: ['info'],
  'high+': ['critical', 'high'],
  'moderate+': ['critical', 'high', 'moderate'],
  'low+': ['critical', 'high', 'moderate', 'low'],
};

/** Extractor do formato `npm-audit`. */
export const npmAuditExtractor = defineExtractor({
  format: FORMAT,
  fields: Object.keys(FIELD_SEVERITIES),
  read: readNpmAudit,
});

/**
 * Lê o número de vulnerabilidades do campo pedido.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readNpmAudit(text, request) {
  const document = parseJson(text, FORMAT);
  rejectAuditFailure(document);
  const counts = readPath(document, VULNERABILITIES, FORMAT);
  const reportsTotal = isPlainObject(counts) && counts.total !== undefined;
  const keys = request.field === 'total' && reportsTotal
    ? ['total']
    : FIELD_SEVERITIES[request.field];
  return keys
    .map((key) => readCount(document, [...VULNERABILITIES, key], FORMAT))
    .reduce((sum, count) => sum + count, 0);
}

/**
 * Rejeita o JSON de erro que o npm escreve quando a auditoria falha (ex: sem lockfile).
 * @param {unknown} document
 * @returns {void}
 */
function rejectAuditFailure(document) {
  if (!isPlainObject(document) || !isPlainObject(document.error)) return;
  const { code, summary } = document.error;
  const details = [code, summary].filter((part) => typeof part === 'string').join(' ');
  throw unparseable(FORMAT, ['npm audit failed', details].filter(Boolean).join(': '));
}
