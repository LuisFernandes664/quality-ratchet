// @ts-check
/**
 * Extractor de relatórios LCOV (`lcov.info`). Soma os totais de resumo de todos os registos
 * (LH/LF, BRH/BRF, FNH/FNF) e ignora as linhas de detalhe (DA, BRDA, FNDA).
 */

import { defineExtractor, percentage, requireContent, unparseable } from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

const FORMAT = 'lcov';

/**
 * Chaves de resumo (atingidos, encontrados) de cada campo.
 * @type {Record<string, [string, string]>}
 */
const COUNTERS = {
  lines: ['LH', 'LF'],
  branches: ['BRH', 'BRF'],
  functions: ['FNH', 'FNF'],
};

/** Linha de resumo de um registo, ex: `LF:12`. */
const SUMMARY_LINE = /^(LF|LH|BRF|BRH|FNF|FNH):(.*)$/;

/** Valor de contagem aceite numa linha de resumo. */
const COUNT = /^\d+$/;

/** Extractor do formato `lcov`. */
export const lcovExtractor = defineExtractor({
  format: FORMAT,
  fields: ['lines', 'branches', 'functions'],
  read: readLcov,
});

/**
 * Calcula a percentagem de cobertura do campo pedido.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readLcov(text, request) {
  const totals = sumCounters(splitLines(text));
  const [hitKey, foundKey] = COUNTERS[request.field];
  return percentage(totals.get(hitKey) ?? 0, totals.get(foundKey) ?? 0, FORMAT);
}

/**
 * Divide o relatório em linhas sem espaços nas pontas e valida que tem registos.
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  const lines = requireContent(text, FORMAT).split(/\r?\n/).map((line) => line.trim());
  if (!lines.some((line) => line.startsWith('SF:'))) {
    throw unparseable(FORMAT, 'no "SF:" record found');
  }
  return lines;
}

/**
 * Soma, por chave, os valores das linhas de resumo de todos os registos.
 * @param {string[]} lines
 * @returns {Map<string, number>}
 */
function sumCounters(lines) {
  /** @type {Map<string, number>} */
  const totals = new Map();
  for (const line of lines) {
    const match = SUMMARY_LINE.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    totals.set(key, (totals.get(key) ?? 0) + parseCount(key, value));
  }
  return totals;
}

/**
 * Converte o valor de uma linha de resumo numa contagem.
 * @param {string} key
 * @param {string} value
 * @returns {number}
 */
function parseCount(key, value) {
  if (COUNT.test(value)) return Number(value);
  throw unparseable(FORMAT, `invalid "${key}" value: "${value}"`);
}
