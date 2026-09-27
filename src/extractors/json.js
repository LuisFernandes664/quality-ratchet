// @ts-check
/**
 * Extractor genérico de JSON: lê o valor apontado por `source.pointer` (JSON Pointer,
 * RFC 6901). Aceita um número, uma string numérica estrita ou um array (conta os elementos).
 */

import {
  because,
  defineExtractor,
  parseJson,
  parsePointer,
  parseStrictNumber,
  resolvePointer,
  unparseable,
} from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

const FORMAT = 'json';

/** Extractor do formato `json`. */
export const jsonExtractor = defineExtractor({
  format: FORMAT,
  fields: ['value'],
  read: readJson,
});

/**
 * Lê o valor apontado. O ponteiro é validado antes de interpretar o relatório.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readJson(text, request) {
  const { pointer } = request.source;
  const tokens = parsePointer(pointer, FORMAT);
  const target = resolvePointer(parseJson(text, FORMAT), tokens);
  if (!target.found) {
    throw unparseable(FORMAT, because('reason_pointer_not_found', { pointer: String(pointer) }));
  }
  return toMetricValue(target.value, String(pointer));
}

/**
 * Converte o valor apontado em número.
 * @param {unknown} value
 * @param {string} pointer para a mensagem de erro
 * @returns {number}
 */
function toMetricValue(value, pointer) {
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.length;
  const number = typeof value === 'string' ? parseStrictNumber(value) : null;
  if (number !== null) return number;
  const kind = value === null ? 'null' : typeof value;
  throw unparseable(FORMAT, because('reason_pointer_not_numeric', { pointer, kind }));
}
