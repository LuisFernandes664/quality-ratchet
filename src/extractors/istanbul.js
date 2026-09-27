// @ts-check
/**
 * Extractor do `coverage-summary.json` do Istanbul (reporter `json-summary` do nyc, c8, Jest,
 * Vitest). Calcula `total.<campo>.covered` / `total.<campo>.total` em percentagem. O `pct`
 * vem truncado a duas casas decimais pelo istanbul-lib-coverage (19998/20001 e 19997/20001
 * dão ambos 99.98) e só se usa quando faltam as contagens.
 */

import { isPlainObject } from '../core/guards.js';
import {
  defineExtractor,
  isCount,
  parseJson,
  percentage,
  readNumber,
  readPath,
  reportEmpty,
} from './shared.js';

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
 * há nada medido, e `pct: 100` com `total: 0`: ambos contam como relatório vazio. Com
 * `covered` e `total` inteiros, o resultado é exacto; senão, lê o `pct`.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readIstanbul(text, request) {
  const document = parseJson(text, FORMAT);
  const path = ['total', request.field];
  const counters = readPath(document, path, FORMAT);
  if (isPlainObject(counters) && (counters.pct === 'Unknown' || counters.total === 0)) {
    throw reportEmpty(FORMAT);
  }
  if (isPlainObject(counters) && isCount(counters.covered) && isCount(counters.total)) {
    return percentage(counters.covered, counters.total, FORMAT);
  }
  return readNumber(document, [...path, 'pct'], FORMAT);
}
