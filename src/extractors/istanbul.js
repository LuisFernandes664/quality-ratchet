// @ts-check
/**
 * Extractor do `coverage-summary.json` do Istanbul (reporter `json-summary` do nyc, c8, Jest,
 * Vitest). Lê `total.<campo>.pct`.
 */

import { isPlainObject } from '../core/guards.js';
import { defineExtractor, parseJson, readNumber, readPath, reportEmpty } from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

const FORMAT = 'istanbul';

/** Extractor do formato `istanbul`. */
export const istanbulExtractor = defineExtractor({
  format: FORMAT,
  fields: ['lines', 'statements', 'functions', 'branches'],
  read: readIstanbul,
});

/**
 * Lê a percentagem total do campo pedido. O Istanbul escreve `pct: "Unknown"` quando não
 * há nada medido, e `pct: 100` com `total: 0`: ambos contam como relatório vazio.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readIstanbul(text, request) {
  const document = parseJson(text, FORMAT);
  const counters = readPath(document, ['total', request.field], FORMAT);
  if (isPlainObject(counters) && (counters.pct === 'Unknown' || counters.total === 0)) {
    throw reportEmpty(FORMAT);
  }
  return readNumber(document, ['total', request.field, 'pct'], FORMAT);
}
