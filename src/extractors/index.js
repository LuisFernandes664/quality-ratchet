// @ts-check
/**
 * Registo dos extractors de relatórios. Cada extractor é puro: recebe o texto do relatório
 * (lido em src/run.js) e devolve um número finito, com percentagens entre 0 e 100.
 */

import { ExtractorError } from '../core/errors.js';
import { coberturaExtractor } from './cobertura.js';
import { dotnetVulnerableExtractor } from './dotnet-vulnerable.js';
import { eslintExtractor } from './eslint.js';
import { istanbulExtractor } from './istanbul.js';
import { jscpdExtractor } from './jscpd.js';
import { jsonExtractor } from './json.js';
import { junitExtractor } from './junit.js';
import { lcovExtractor } from './lcov.js';
import { npmAuditExtractor } from './npm-audit.js';
import { pipAuditExtractor } from './pip-audit.js';
import { sarifExtractor } from './sarif.js';
import { ensureFinite } from './shared.js';
import { strykerExtractor } from './stryker.js';
import { stylelintExtractor } from './stylelint.js';
import { trxExtractor } from './trx.js';

/** @typedef {import('../core/types.js').MetricSource} MetricSource */
/** @typedef {import('./shared.js').Extractor} Extractor */

/**
 * Extractors disponíveis, indexados pelo formato.
 * @type {Record<string, Extractor>}
 */
export const EXTRACTORS = Object.freeze(Object.fromEntries([
  lcovExtractor,
  istanbulExtractor,
  coberturaExtractor,
  strykerExtractor,
  sarifExtractor,
  eslintExtractor,
  stylelintExtractor,
  jscpdExtractor,
  npmAuditExtractor,
  pipAuditExtractor,
  dotnetVulnerableExtractor,
  junitExtractor,
  trxExtractor,
  jsonExtractor,
].map((extractor) => [extractor.format, extractor])));

/**
 * Extrai o valor de uma métrica do texto de um relatório. Sem `source.field`, usa o campo
 * por omissão do formato.
 * @param {MetricSource} source origem da métrica: formato, campo e opções
 * @param {string} text conteúdo do relatório
 * @returns {number} valor finito, sem arredondamento
 * @throws {ExtractorError} extractor_format_unknown, extractor_field_unknown,
 *   extractor_option_invalid, extractor_report_unparseable ou extractor_report_empty
 */
export function extract(source, text) {
  const extractor = findExtractor(source.format);
  return ensureFinite(extractor.extract(text, source), extractor.format);
}

/**
 * Lista os formatos suportados, pela ordem de registo.
 * @returns {string[]}
 */
export function listFormats() {
  return Object.keys(EXTRACTORS);
}

/**
 * Procura o extractor de um formato, ignorando a cadeia de protótipos.
 * @param {unknown} format
 * @returns {Extractor}
 */
function findExtractor(format) {
  if (typeof format === 'string' && Object.hasOwn(EXTRACTORS, format)) {
    return EXTRACTORS[format];
  }
  throw new ExtractorError('extractor_format_unknown', {
    format,
    known: listFormats().join(', '),
  });
}
