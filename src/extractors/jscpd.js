// @ts-check
/**
 * Extractor do `jscpd-report.json` (reporter `json` do jscpd). Lê `statistics.total`.
 */

import { isPlainObject } from '../core/guards.js';
import {
  defineExtractor,
  parseJson,
  readCount,
  readNumber,
  readPath,
  reportEmpty,
} from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

const FORMAT = 'jscpd';

/** Caminho de `statistics.total` no relatório. */
const TOTAL = ['statistics', 'total'];

/**
 * Chave de `statistics.total` de cada campo.
 * @type {Record<string, string>}
 */
const KEYS = {
  percentage: 'percentage',
  clones: 'clones',
  duplicated_lines: 'duplicatedLines',
};

/** Extractor do formato `jscpd`. */
export const jscpdExtractor = defineExtractor({
  format: FORMAT,
  fields: ['percentage', 'clones', 'duplicated_lines'],
  read: readJscpd,
});

/**
 * Lê a percentagem de linhas duplicadas ou uma das contagens. Sem ficheiros ou sem linhas
 * analisadas, o relatório conta como vazio.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readJscpd(text, request) {
  const document = parseJson(text, FORMAT);
  const total = readPath(document, TOTAL, FORMAT);
  if (isPlainObject(total) && (total.sources === 0 || total.lines === 0)) {
    throw reportEmpty(FORMAT);
  }
  const path = [...TOTAL, KEYS[request.field]];
  return request.field === 'percentage'
    ? readNumber(document, path, FORMAT)
    : readCount(document, path, FORMAT);
}
