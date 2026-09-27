// @ts-check
/**
 * Construtores de dados partilhados pelos testes.
 */
import { parseBaseline } from '../src/core/baseline.js';

/** @typedef {import('../src/core/types.js').Baseline} Baseline */
/** @typedef {import('../src/core/types.js').Measurement} Measurement */

/** Baseline v1 com as quatro métricas do README. */
export const V1_RAW = Object.freeze({
  frozen_at: '2026-05-04',
  metrics: {
    lint_violations_total: 483,
    duplication_pct: 2.2,
    coverage_line_pct: 7.0,
    mutation_score_covered_pct: 81.6,
  },
  rules: {
    monotonic_down: ['lint_violations_total', 'duplication_pct'],
    monotonic_up: ['coverage_line_pct', 'mutation_score_covered_pct'],
  },
});

/** Medições iguais ao baseline v1. */
export const CLEAN = Object.freeze({
  lint_violations_total: 483,
  duplication_pct: 2.2,
  coverage_line_pct: 7.0,
  mutation_score_covered_pct: 81.6,
});

/**
 * Baseline v2 a partir de um mapa de métricas.
 * @param {Record<string, Record<string, unknown>>} metrics
 * @param {Record<string, unknown>} [extra] campos extra na raiz
 * @returns {Baseline}
 */
export function v2(metrics, extra = {}) {
  return parseBaseline({ version: 2, frozen_at: '2026-05-04', ...extra, metrics });
}

/**
 * Baseline v1 normalizado, com valores opcionalmente substituídos.
 * @param {Record<string, number>} [overrides]
 * @returns {Baseline}
 */
export function v1(overrides = {}) {
  return parseBaseline({ ...V1_RAW, metrics: { ...V1_RAW.metrics, ...overrides } });
}

/**
 * Medições a partir de um mapa simples de valores.
 * @param {Record<string, unknown>} values
 * @returns {Record<string, Measurement>}
 */
export function measured(values) {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, { value, origin: 'file' }]),
  );
}
