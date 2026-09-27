// @ts-check
/**
 * Normalização dos valores medidos nesta execução.
 */
import { MetricsError } from './errors.js';
import { isPlainObject } from './guards.js';

/** @typedef {import('./types.js').Measurement} Measurement */

/** Número decimal estrito, com sinal e expoente opcionais. */
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Converte um valor medido em número. Aceita números finitos e strings numéricas estritas,
 * como "7.0", que são frequentes quando o coletor é um script de shell.
 * @param {unknown} value
 * @returns {number|null} null quando o valor não é numérico
 */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return NUMERIC.test(text) ? Number(text) : null;
}

/**
 * Valida o conteúdo do ficheiro de métricas e converte-o em medições.
 * @param {unknown} raw JSON lido do ficheiro
 * @param {string} path caminho do ficheiro, para as mensagens
 * @returns {Record<string, Measurement>}
 */
export function parseMetricsFile(raw, path) {
  if (!isPlainObject(raw)) throw new MetricsError('metrics_not_object', { path });
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [name, { value, origin: 'file' }]),
  );
}
