// @ts-check
/**
 * Extractor da saída de `stylelint --formatter json`: um array com um objecto por ficheiro,
 * cada um com a lista `warnings` dos problemas encontrados, de `severity` "error" ou
 * "warning". Um erro de sintaxe do CSS também é uma entrada de `warnings`, da regra
 * `CssSyntaxError` e de `severity` "error". Não conta `deprecations` nem `parseErrors`. Um
 * array vazio (nenhum ficheiro analisado, ex: com `--allow-empty-input`) conta 0.
 *
 * Rejeita o relatório quando há `invalidOptionWarnings`: uma regra com opções inválidas não
 * corre, e a contagem desceria sem ninguém dar por isso.
 */

import { isPlainObject } from '../core/guards.js';
import { because, defineExtractor, parseJson, unparseable } from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

const FORMAT = 'stylelint';

/** Severidades do stylelint. */
const SEVERITIES = ['error', 'warning'];

/**
 * Severidades contadas por cada campo.
 * @type {Record<string, string[]>}
 */
const FIELD_SEVERITIES = {
  total: SEVERITIES,
  errors: ['error'],
  warnings: ['warning'],
};

/** Extractor do formato `stylelint`. */
export const stylelintExtractor = defineExtractor({
  format: FORMAT,
  fields: Object.keys(FIELD_SEVERITIES),
  read: readStylelint,
});

/**
 * Conta as entradas de `warnings` de todos os ficheiros com a severidade do campo pedido.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readStylelint(text, request) {
  const files = parseJson(text, FORMAT);
  if (!Array.isArray(files)) throw unparseable(FORMAT, because('reason_stylelint_not_array'));
  rejectInvalidOptions(files);
  const counted = FIELD_SEVERITIES[request.field];
  return files
    .flatMap((file, index) => fileSeverities(file, `[${index}]`))
    .filter((severity) => counted.includes(severity))
    .length;
}

/**
 * Rejeita o relatório quando alguma regra tem opções inválidas. O stylelint repete o aviso
 * em cada ficheiro, por isso os textos aparecem uma vez cada.
 * @param {unknown[]} files
 * @returns {void}
 */
function rejectInvalidOptions(files) {
  const texts = files.flatMap((file) => {
    const warnings = isPlainObject(file) ? file.invalidOptionWarnings : undefined;
    return Array.isArray(warnings) ? warnings.map(warningText) : [];
  });
  if (texts.length === 0) return;
  const details = [...new Set(texts)].filter(Boolean).join('; ');
  throw unparseable(FORMAT, because('reason_stylelint_invalid_options', { details }));
}

/**
 * Texto de um aviso de opções inválidas, ou texto vazio.
 * @param {unknown} warning
 * @returns {string}
 */
function warningText(warning) {
  const text = isPlainObject(warning) ? warning.text : undefined;
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * Severidade de cada entrada de `warnings` de um ficheiro.
 * @param {unknown} file
 * @param {string} path posição do ficheiro no relatório, para a mensagem
 * @returns {string[]}
 */
function fileSeverities(file, path) {
  const warnings = isPlainObject(file) ? file.warnings : undefined;
  if (!Array.isArray(warnings)) {
    throw unparseable(FORMAT, because('reason_not_array', { path: `${path}.warnings` }));
  }
  return warnings.map((warning, index) => severityOf(warning, `${path}.warnings[${index}]`));
}

/**
 * Valida e devolve a severidade de uma entrada de `warnings`.
 * @param {unknown} warning
 * @param {string} path posição da entrada no relatório, para a mensagem
 * @returns {string}
 */
function severityOf(warning, path) {
  const severity = isPlainObject(warning) ? warning.severity : undefined;
  if (typeof severity === 'string' && SEVERITIES.includes(severity)) return severity;
  throw unparseable(FORMAT, because('reason_severity_unknown', {
    severity: String(severity),
    path,
    known: SEVERITIES.join(', '),
  }));
}
