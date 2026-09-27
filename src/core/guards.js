// @ts-check
/**
 * Verificações de tipo usadas na validação de ficheiros JSON.
 */

/**
 * Indica se o valor é um objecto simples (nem null, nem array).
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Indica se o valor é um número finito.
 * @param {unknown} value
 * @returns {value is number}
 */
export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Indica se o valor é uma string com conteúdo.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Lê uma propriedade própria, ignorando a cadeia de protótipos.
 * @template T
 * @param {Record<string, T>} record
 * @param {string} key
 * @returns {T|undefined}
 */
export function ownValue(record, key) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
