// @ts-check
/**
 * Extractor da saída de `npm audit --json`. Lê `metadata.vulnerabilities`, presente tanto no
 * formato do npm 7+ (`auditReportVersion: 2`, com `total`) como no do npm 6 (sem `total`).
 */

import { isPlainObject } from '../core/guards.js';
import {
  because,
  defineExtractor,
  parseJson,
  readCount,
  readPath,
  unparseable,
} from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

const FORMAT = 'npm-audit';

/** Caminho das contagens por severidade no relatório. */
const VULNERABILITIES = ['metadata', 'vulnerabilities'];

/** Credenciais embutidas num URL (`//utilizador:palavra-passe@`), que o npm não esconde. */
const URL_CREDENTIALS = /(\/\/)[^/\s@]+@/g;

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
 * Rejeita o JSON de erro que o npm escreve quando a auditoria falha. Sem lockfile, a causa
 * vem em `error.summary`; quando o serviço de auditoria falha (rede, proxy, registry sem
 * auditoria), o npm deixa `error.summary` vazio e põe a causa no `message` de topo. O motivo
 * é publicado no comentário do pull request, por isso as credenciais dos URLs são tapadas.
 * @param {unknown} document
 * @returns {void}
 */
function rejectAuditFailure(document) {
  if (!isPlainObject(document) || !isPlainObject(document.error)) return;
  const { code, summary, detail } = document.error;
  const cause = trimmed(summary) || trimmed(document.message) || trimmed(detail);
  const details = [trimmed(code), cause].filter(Boolean).join(' ');
  throw unparseable(FORMAT, because('reason_npm_audit_failed', {
    details: details.replace(URL_CREDENTIALS, '$1***@'),
  }));
}

/**
 * Texto sem espaços nas pontas, ou texto vazio quando o valor não é texto.
 * @param {unknown} value
 * @returns {string}
 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}
