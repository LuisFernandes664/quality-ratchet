// @ts-check
/**
 * Extractor de relatórios Cobertura XML (coverage.py, Istanbul, Cobertura, Coverlet, ...).
 * Calcula a percentagem a partir das contagens exactas do elemento raiz `<coverage>`
 * (`lines-covered`/`lines-valid`, `branches-covered`/`branches-valid`). As taxas
 * `line-rate`/`branch-rate` vêm arredondadas pelas ferramentas (o coverage.py escreve "1"
 * com 20002 de 20003 linhas cobertas) e só se usam quando faltam as contagens.
 */

import {
  because,
  defineExtractor,
  parseStrictNumber,
  percentage,
  reportEmpty,
  requireContent,
  rootAttributes,
  unparseable,
} from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

/**
 * Atributos do elemento raiz de um campo.
 * @typedef {object} FieldAttributes
 * @property {string} rate taxa entre 0 e 1, arredondada pela ferramenta
 * @property {string} valid número de elementos medidos
 * @property {string} covered número de elementos cobertos
 */

const FORMAT = 'cobertura';

/** Elemento raiz esperado. */
const ROOT = 'coverage';

/**
 * Atributos do elemento raiz para cada campo.
 * @type {Record<string, FieldAttributes>}
 */
const ATTRIBUTES = {
  lines: { rate: 'line-rate', valid: 'lines-valid', covered: 'lines-covered' },
  branches: { rate: 'branch-rate', valid: 'branches-valid', covered: 'branches-covered' },
};

/** Extractor do formato `cobertura`. */
export const coberturaExtractor = defineExtractor({
  format: FORMAT,
  fields: ['lines', 'branches'],
  read: readCobertura,
});

/**
 * Devolve a percentagem do campo pedido: covered/valid quando o elemento raiz tem as duas
 * contagens, senão a taxa. Quando o elemento raiz declara zero elementos válidos (ex:
 * `branches-valid="0"`), o relatório conta como vazio.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readCobertura(text, request) {
  const attributes = rootAttributes(requireContent(text, FORMAT), ROOT, FORMAT);
  const names = ATTRIBUTES[request.field];
  const valid = attributes.get(names.valid);
  if (valid !== undefined && parseStrictNumber(valid) === 0) throw reportEmpty(FORMAT);
  const covered = attributes.get(names.covered);
  if (valid === undefined || covered === undefined) {
    return ratePercent(readRate(attributes, names.rate));
  }
  const hit = readCountAttribute(covered, names.covered);
  return percentage(hit, readCountAttribute(valid, names.valid), FORMAT);
}

/**
 * Converte o valor de um atributo de contagem num inteiro não negativo.
 * @param {string} raw valor do atributo
 * @param {string} name nome do atributo, para a mensagem
 * @returns {number}
 */
function readCountAttribute(raw, name) {
  const count = parseStrictNumber(raw);
  if (count !== null && Number.isSafeInteger(count) && count >= 0) return count;
  throw unparseable(FORMAT, because('reason_attribute_not_count', { name, value: raw }));
}

/**
 * Lê uma taxa (0 a 1) do elemento raiz e devolve o texto do atributo, já validado.
 * @param {Map<string, string>} attributes
 * @param {string} name
 * @returns {string}
 */
function readRate(attributes, name) {
  const raw = attributes.get(name);
  if (raw === undefined) {
    throw unparseable(FORMAT, because('reason_attribute_missing', { name, element: ROOT }));
  }
  const rate = parseStrictNumber(raw);
  if (rate === null) {
    throw unparseable(FORMAT, because('reason_attribute_not_number', { name, value: raw }));
  }
  if (rate < 0 || rate > 1) {
    const params = { name, value: raw, min: 0, max: 1 };
    throw unparseable(FORMAT, because('reason_attribute_out_of_range', params));
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
