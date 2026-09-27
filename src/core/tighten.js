// @ts-check
/**
 * Aperto do baseline. As melhorias só ficam garantidas quando o baseline as fixa: sem
 * isso, a cobertura sobe de 7 para 12 e o PR seguinte pode voltar a 7.1 sem falhar.
 */
import { withValues } from './baseline.js';
import { exceedsTolerance, isBetter } from './compare.js';
import { ownValue } from './guards.js';
import { toNumber } from './measurements.js';

/** @typedef {import('./types.js').Baseline} Baseline */
/** @typedef {import('./types.js').MetricRule} MetricRule */
/** @typedef {import('./types.js').Measurement} Measurement */

/**
 * Fixa no baseline as melhorias que ultrapassam a tolerância, e preenche valores vazios.
 * Nunca afrouxa: regressões, mesmo toleradas, mantêm o valor anterior.
 * @param {Baseline} baseline
 * @param {Record<string, Measurement>} measurements
 * @param {{frozenAt?: string}} [options] nova data de congelamento, se algo mudar
 * @returns {{baseline: Baseline, tightened: string[]}}
 */
export function tightenBaseline(baseline, measurements, { frozenAt } = {}) {
  /** @type {Map<string, number>} */
  const values = new Map();
  for (const rule of baseline.metrics) {
    const after = measuredValue(measurements, rule.name);
    if (after !== null && shouldTighten(rule, after)) values.set(rule.name, after);
  }
  const tightened = [...values.keys()];
  const date = tightened.length > 0 ? frozenAt : undefined;
  return { baseline: withValues(baseline, values, date), tightened };
}

/**
 * @param {MetricRule} rule
 * @param {number} after
 * @returns {boolean}
 */
function shouldTighten(rule, after) {
  if (rule.value === null) return true;
  const improved = isBetter(rule.direction, after, rule.value);
  return improved && exceedsTolerance(after - rule.value, rule.tolerance);
}

/**
 * Recongela o baseline com os valores medidos, nas duas direcções. Só deve ser usado
 * quando a descida do baseline foi decidida e autorizada.
 * @param {Baseline} baseline
 * @param {Record<string, Measurement>} measurements
 * @param {{frozenAt?: string}} [options]
 * @returns {{baseline: Baseline, changed: string[], missing: string[]}}
 */
export function rebaseline(baseline, measurements, { frozenAt } = {}) {
  /** @type {Map<string, number>} */
  const values = new Map();
  const missing = [];
  for (const rule of baseline.metrics) {
    const after = measuredValue(measurements, rule.name);
    if (after === null) missing.push(rule.name);
    else if (after !== rule.value) values.set(rule.name, after);
  }
  const changed = [...values.keys()];
  const date = changed.length > 0 ? frozenAt : undefined;
  return { baseline: withValues(baseline, values, date), changed, missing };
}

/**
 * @param {Record<string, Measurement>} measurements
 * @param {string} name
 * @returns {number|null}
 */
function measuredValue(measurements, name) {
  const measurement = ownValue(measurements, name);
  if (!measurement || measurement.error) return null;
  return toNumber(measurement.value);
}
