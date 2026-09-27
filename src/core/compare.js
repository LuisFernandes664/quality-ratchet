// @ts-check
/**
 * Comparação das medições com o contrato. Sem I/O: tudo o que decide passar ou falhar
 * vive aqui e no resto de src/core, para ficar testável.
 */
import { ownValue } from './guards.js';
import { toNumber } from './measurements.js';

/** @typedef {import('./types.js').Baseline} Baseline */
/** @typedef {import('./types.js').MetricRule} MetricRule */
/** @typedef {import('./types.js').MetricResult} MetricResult */
/** @typedef {import('./types.js').MetricStatus} MetricStatus */
/** @typedef {import('./types.js').Measurement} Measurement */
/** @typedef {import('./types.js').Outcome} Outcome */
/** @typedef {import('./types.js').Issue} Issue */

/** Margem para absorver ruído de vírgula flutuante sem deixar passar regressões reais. */
export const EPSILON = 1e-9;

/** Estados possíveis de uma métrica após comparação. */
export const Status = Object.freeze({
  IMPROVED: /** @type {MetricStatus} */ ('improved'),
  UNCHANGED: /** @type {MetricStatus} */ ('unchanged'),
  TOLERATED: /** @type {MetricStatus} */ ('tolerated'),
  REGRESSED: /** @type {MetricStatus} */ ('regressed'),
  MISSING: /** @type {MetricStatus} */ ('missing'),
  INVALID: /** @type {MetricStatus} */ ('invalid'),
  LIMIT: /** @type {MetricStatus} */ ('limit'),
});

/** Estados que fazem a catraca falhar. */
const FAILING = new Set([Status.REGRESSED, Status.MISSING, Status.INVALID, Status.LIMIT]);

/**
 * Indica se `candidate` é melhor do que `reference` na direcção da métrica.
 * @param {'up'|'down'} direction
 * @param {number} candidate
 * @param {number} reference
 * @returns {boolean}
 */
export function isBetter(direction, candidate, reference) {
  const delta = candidate - reference;
  return direction === 'up' ? delta > EPSILON : delta < -EPSILON;
}

/**
 * Indica se uma variação ultrapassa a tolerância da métrica.
 * @param {number} delta
 * @param {number} tolerance
 * @returns {boolean}
 */
export function exceedsTolerance(delta, tolerance) {
  return Math.abs(delta) > tolerance + EPSILON;
}

/**
 * Compara uma métrica com a sua regra. Uma métrica em falta conta como falha: um coletor
 * que deixa cair uma métrica em silêncio produz um verde mentiroso, que é exactamente o
 * que a catraca existe para impedir.
 * @param {MetricRule} rule
 * @param {Measurement|undefined} measurement
 * @returns {MetricResult}
 */
export function evaluate(rule, measurement) {
  const missing = missingDetail(measurement);
  if (missing) return { ...emptyResult(rule), status: Status.MISSING, detail: missing };
  const raw = measurement?.value;
  const after = toNumber(raw);
  if (after === null) {
    const value = JSON.stringify(raw) ?? String(raw);
    const detail = issue('value_not_numeric_current', { value });
    return { ...emptyResult(rule), status: Status.INVALID, detail };
  }
  if (rule.value === null) {
    const detail = issue('rule_without_value', { name: rule.name });
    return { ...emptyResult(rule), after, status: Status.MISSING, detail };
  }
  return classify(rule, rule.value, after);
}

/**
 * Motivo pelo qual não há valor medido, ou null quando há.
 * @param {Measurement|undefined} measurement
 * @returns {Issue|null}
 */
function missingDetail(measurement) {
  if (measurement?.error) return measurement.error;
  if (measurement === undefined || measurement.value === undefined) {
    return issue('metric_not_reported');
  }
  return null;
}

/**
 * @param {MetricRule} rule
 * @returns {Omit<MetricResult, 'status'>}
 */
function emptyResult(rule) {
  return {
    name: rule.name,
    direction: rule.direction,
    before: rule.value,
    after: null,
    delta: null,
    tolerance: rule.tolerance,
    ...(rule.target === undefined ? {} : { target: rule.target }),
  };
}

/**
 * Classifica uma medição numérica face ao valor congelado e aos limites absolutos.
 * @param {MetricRule} rule
 * @param {number} before
 * @param {number} after
 * @returns {MetricResult}
 */
function classify(rule, before, after) {
  const delta = Math.abs(after - before) <= EPSILON ? 0 : after - before;
  const result = { ...emptyResult(rule), after, delta };
  const breach = limitBreach(rule, after);
  if (breach) return { ...result, status: Status.LIMIT, detail: breach };
  if (delta === 0) return { ...result, status: Status.UNCHANGED };
  if (isBetter(rule.direction, after, before)) return { ...result, status: Status.IMPROVED };
  const status = exceedsTolerance(delta, rule.tolerance) ? Status.REGRESSED : Status.TOLERATED;
  return { ...result, status };
}

/**
 * Verifica os limites absolutos `min` e `max`.
 * @param {MetricRule} rule
 * @param {number} value
 * @returns {Issue|null}
 */
function limitBreach(rule, value) {
  if (rule.min !== undefined && value < rule.min - EPSILON) {
    return issue('below_min', { name: rule.name, value, limit: rule.min });
  }
  if (rule.max !== undefined && value > rule.max + EPSILON) {
    return issue('above_max', { name: rule.name, value, limit: rule.max });
  }
  return null;
}

/**
 * Compara todas as métricas do contrato.
 * @param {Baseline} contract baseline efectivo contra o qual se compara
 * @param {Record<string, Measurement>} measurements
 * @param {{strict?: boolean}} [options] strict: melhorias por fixar no baseline contam como falha
 * @returns {Outcome}
 */
export function compareAll(contract, measurements, { strict = false } = {}) {
  const results = contract.metrics.map((rule) => evaluate(rule, ownValue(measurements, rule.name)));
  const failures = results.filter((result) => FAILING.has(result.status));
  const improvements = results.filter((result) => result.status === Status.IMPROVED);
  const unlocked = strict
    ? improvements.filter((result) => exceedsTolerance(result.delta ?? 0, result.tolerance))
    : [];
  return {
    results,
    failures,
    improvements,
    unlocked,
    passed: failures.length === 0 && unlocked.length === 0,
  };
}

/**
 * @param {string} code
 * @param {Record<string, unknown>} [params]
 * @returns {Issue}
 */
function issue(code, params = {}) {
  return { code, params };
}
