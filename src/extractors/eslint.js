// @ts-check
/**
 * Extractor da saída de `eslint -f json`: um array com um objecto por ficheiro, cada um com
 * `errorCount` e `warningCount`.
 */

import {
  because,
  defineExtractor,
  parseJson,
  readCount,
  reportEmpty,
  unparseable,
} from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

const FORMAT = 'eslint';

/** Extractor do formato `eslint`. */
export const eslintExtractor = defineExtractor({
  format: FORMAT,
  fields: ['total', 'errors', 'warnings'],
  read: readEslint,
});

/**
 * Soma os erros e/ou avisos de todos os ficheiros analisados.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readEslint(text, request) {
  const files = parseJson(text, FORMAT);
  if (!Array.isArray(files)) throw unparseable(FORMAT, because('reason_eslint_not_array'));
  if (files.length === 0) throw reportEmpty(FORMAT);
  let errors = 0;
  let warnings = 0;
  for (const file of files) {
    errors += readCount(file, ['errorCount'], FORMAT);
    warnings += readCount(file, ['warningCount'], FORMAT);
  }
  if (request.field === 'errors') return errors;
  return request.field === 'warnings' ? warnings : errors + warnings;
}
