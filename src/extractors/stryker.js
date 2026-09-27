// @ts-check
/**
 * Extractor de relatórios de testes de mutação no formato mutation-testing-report-schema
 * (`mutation.json` do Stryker e de outras ferramentas compatíveis).
 */

import { isPlainObject } from '../core/guards.js';
import {
  defineExtractor,
  parseJson,
  percentage,
  readPath,
  reportEmpty,
  unparseable,
} from './shared.js';

/** @typedef {import('../core/errors.js').ExtractorError} ExtractorError */
/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

const FORMAT = 'stryker';

/** Estados de mutante definidos pelo esquema. */
const STATUSES = [
  'Killed',
  'Survived',
  'NoCoverage',
  'Timeout',
  'CompileError',
  'RuntimeError',
  'Ignored',
  'Pending',
];

/**
 * Estado contado por cada campo de contagem.
 * @type {Record<string, string>}
 */
const COUNTED_STATUS = {
  killed: 'Killed',
  survived: 'Survived',
  no_coverage: 'NoCoverage',
  timeout: 'Timeout',
};

/** Extractor do formato `stryker`. */
export const strykerExtractor = defineExtractor({
  format: FORMAT,
  fields: ['score', 'score_covered', 'killed', 'survived', 'no_coverage', 'timeout'],
  read: readStryker,
});

/**
 * Calcula a pontuação ou a contagem pedida. CompileError, RuntimeError, Ignored e Pending
 * não entram em nenhuma pontuação.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readStryker(text, request) {
  const counts = countStatuses(parseJson(text, FORMAT));
  const detected = counts.Killed + counts.Timeout;
  if (request.field === 'score') {
    return percentage(detected, detected + counts.Survived + counts.NoCoverage, FORMAT);
  }
  if (request.field === 'score_covered') {
    return percentage(detected, detected + counts.Survived, FORMAT);
  }
  return counts[COUNTED_STATUS[request.field]];
}

/**
 * Conta os mutantes de todos os ficheiros por estado.
 * @param {unknown} document
 * @returns {Record<string, number>}
 * @throws {ExtractorError} extractor_report_empty quando não há mutantes
 */
function countStatuses(document) {
  const files = readPath(document, ['files'], FORMAT);
  if (!isPlainObject(files)) throw unparseable(FORMAT, '"files" is not an object');
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  let total = 0;
  for (const [path, file] of Object.entries(files)) {
    for (const status of mutantStatuses(file, path)) {
      counts[status] += 1;
      total += 1;
    }
  }
  if (total === 0) throw reportEmpty(FORMAT);
  return counts;
}

/**
 * Devolve o estado de cada mutante de um ficheiro.
 * @param {unknown} file
 * @param {string} path
 * @returns {string[]}
 */
function mutantStatuses(file, path) {
  const mutants = isPlainObject(file) ? file.mutants : undefined;
  if (!Array.isArray(mutants)) {
    throw unparseable(FORMAT, `"files.${path}.mutants" is not an array`);
  }
  return mutants.map((mutant) => statusOf(mutant, path));
}

/**
 * Valida e devolve o estado de um mutante.
 * @param {unknown} mutant
 * @param {string} path ficheiro do mutante, para a mensagem
 * @returns {string}
 */
function statusOf(mutant, path) {
  const status = isPlainObject(mutant) ? mutant.status : undefined;
  if (typeof status === 'string' && STATUSES.includes(status)) return status;
  throw unparseable(FORMAT, `unknown mutant status "${String(status)}" in "${path}"`);
}
