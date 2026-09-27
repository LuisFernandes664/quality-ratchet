// @ts-check
/**
 * Extractor de relatórios Cobertura XML (coverage.py, Istanbul, Cobertura, Coverlet, ...).
 * Lê os atributos `line-rate` e `branch-rate` do elemento raiz `<coverage>` e converte-os
 * para percentagem.
 */

import {
  defineExtractor,
  parseStrictNumber,
  reportEmpty,
  requireContent,
  stripXmlNoise,
  unparseable,
} from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

const FORMAT = 'cobertura';

/**
 * Atributos (taxa, total de elementos válidos) do elemento raiz para cada campo.
 * @type {Record<string, [string, string]>}
 */
const ATTRIBUTES = {
  lines: ['line-rate', 'lines-valid'],
  branches: ['branch-rate', 'branches-valid'],
};

/** Primeira tag de abertura bem formada: nome e lista de atributos. */
const START_TAG = /<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/;

/** Atributo XML com valor entre aspas ou plicas. */
const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Extractor do formato `cobertura`. */
export const coberturaExtractor = defineExtractor({
  format: FORMAT,
  fields: ['lines', 'branches'],
  read: readCobertura,
});

/**
 * Lê a taxa do campo pedido e devolve-a em percentagem. Quando o elemento raiz declara
 * zero elementos válidos (ex: `branches-valid="0"`), o relatório conta como vazio.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readCobertura(text, request) {
  const attributes = rootAttributes(requireContent(text, FORMAT));
  const [rateName, validName] = ATTRIBUTES[request.field];
  const valid = attributes.get(validName);
  if (valid !== undefined && parseStrictNumber(valid) === 0) throw reportEmpty(FORMAT);
  return ratePercent(readRate(attributes, rateName));
}

/**
 * Localiza o elemento raiz, depois da declaração XML, do DOCTYPE e de comentários.
 * @param {string} text
 * @returns {Map<string, string>} atributos do elemento raiz
 */
function rootAttributes(text) {
  const match = START_TAG.exec(stripXmlNoise(text));
  if (!match) throw unparseable(FORMAT, 'no XML element found');
  const [, name, attributes] = match;
  if (name !== 'coverage') {
    throw unparseable(FORMAT, `root element is <${name}>, expected <coverage>`);
  }
  return parseAttributes(attributes);
}

/**
 * Converte a lista de atributos de uma tag num mapa nome -> valor.
 * @param {string} source
 * @returns {Map<string, string>}
 */
function parseAttributes(source) {
  /** @type {Map<string, string>} */
  const attributes = new Map();
  for (const [, name, doubleQuoted, singleQuoted] of source.matchAll(ATTRIBUTE)) {
    attributes.set(name, doubleQuoted ?? singleQuoted);
  }
  return attributes;
}

/**
 * Lê uma taxa (0 a 1) do elemento raiz e devolve o texto do atributo, já validado.
 * @param {Map<string, string>} attributes
 * @param {string} name
 * @returns {string}
 */
function readRate(attributes, name) {
  const raw = attributes.get(name);
  if (raw === undefined) throw unparseable(FORMAT, `missing attribute "${name}" on <coverage>`);
  const rate = parseStrictNumber(raw);
  if (rate === null) throw unparseable(FORMAT, `attribute "${name}" is not a number: "${raw}"`);
  if (rate < 0 || rate > 1) {
    throw unparseable(FORMAT, `attribute "${name}" is not between 0 and 1: "${raw}"`);
  }
  return raw;
}

/**
 * Converte uma taxa escrita em decimal (ex: "0.57") em percentagem, deslocando o expoente
 * no próprio texto ("0.57e2"). Assim o resultado é o número mais próximo do valor exacto,
 * sem o erro de vírgula flutuante de `0.57 * 100` (56.99999999999999).
 * @param {string} rate taxa numérica estrita, validada por readRate
 * @returns {number}
 */
function ratePercent(rate) {
  const [mantissa, exponent = '0'] = rate.toLowerCase().split('e');
  return Number(`${mantissa}e${Number(exponent) + 2}`);
}
