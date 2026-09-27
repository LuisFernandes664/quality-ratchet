// @ts-check
/**
 * Governação do baseline. O contrato que conta é o do ramo base: um PR que mexe no
 * ficheiro do baseline só o pode apertar. Afrouxar exige autorização explícita, e o
 * perdão de hotfix é uma saída à parte, sempre visível no sumário.
 */
import { ConfigError } from './errors.js';
import { EPSILON, isBetter } from './compare.js';

/** @typedef {import('./types.js').Baseline} Baseline */
/** @typedef {import('./types.js').MetricRule} MetricRule */
/** @typedef {import('./types.js').BaselineChange} BaselineChange */
/** @typedef {import('./types.js').ChangeKind} ChangeKind */
/** @typedef {import('./types.js').Decision} Decision */
/** @typedef {'loosened'|'tightened'|null} FieldVerdict */

/** Decisão negativa, partilhada para não criar objectos repetidos. */
const DENIED = Object.freeze({ granted: false, reason: null });

/**
 * Comparadores por campo: dizem se o PR afrouxou ou apertou cada campo da regra.
 * @type {Array<[string, (before: MetricRule, after: MetricRule) => FieldVerdict]>}
 */
const FIELD_CHECKS = [
  ['value', compareValue],
  ['tolerance', compareTolerance],
  ['min', compareMin],
  ['max', compareMax],
];

/**
 * Diferenças entre o baseline do ramo base e o do PR, métrica a métrica.
 * @param {Baseline} base
 * @param {Baseline} head
 * @returns {BaselineChange[]}
 */
export function diffBaselines(base, head) {
  const before = new Map(base.metrics.map((rule) => [rule.name, rule]));
  const after = new Map(head.metrics.map((rule) => [rule.name, rule]));
  const names = [...new Set([...after.keys(), ...before.keys()])];
  return names.map((name) => describeChange(name, before.get(name), after.get(name)));
}

/**
 * @param {string} name
 * @param {MetricRule|undefined} before
 * @param {MetricRule|undefined} after
 * @returns {BaselineChange}
 */
function describeChange(name, before, after) {
  if (!before) return change(name, 'added', [], [], null, after ?? null);
  if (!after) return change(name, 'removed', ['metric'], [], before, null);
  if (before.direction !== after.direction) {
    return change(name, 'loosened', ['direction'], [], before, after);
  }
  const verdicts = FIELD_CHECKS.map(([field, check]) => [field, check(before, after)]);
  const loosened = verdicts.filter(([, v]) => v === 'loosened').map(([field]) => String(field));
  const tightened = verdicts.filter(([, v]) => v === 'tightened').map(([field]) => String(field));
  const kind = loosened.length > 0 ? 'loosened' : tightened.length > 0 ? 'tightened' : 'unchanged';
  return change(name, kind, loosened, tightened, before, after);
}

/**
 * @param {string} name
 * @param {ChangeKind} kind
 * @param {string[]} loosenedFields
 * @param {string[]} tightenedFields
 * @param {MetricRule|null} before
 * @param {MetricRule|null} after
 * @returns {BaselineChange}
 */
function change(name, kind, loosenedFields, tightenedFields, before, after) {
  return { name, kind, loosenedFields, tightenedFields, before, after };
}

/**
 * @param {MetricRule} before
 * @param {MetricRule} after
 * @returns {FieldVerdict}
 */
function compareValue(before, after) {
  if (before.value === null || after.value === null) return null;
  if (isBetter(before.direction, after.value, before.value)) return 'tightened';
  if (isBetter(before.direction, before.value, after.value)) return 'loosened';
  return null;
}

/**
 * @param {MetricRule} before
 * @param {MetricRule} after
 * @returns {FieldVerdict}
 */
function compareTolerance(before, after) {
  if (after.tolerance > before.tolerance + EPSILON) return 'loosened';
  if (after.tolerance < before.tolerance - EPSILON) return 'tightened';
  return null;
}

/**
 * Limite inferior: descer ou retirar afrouxa, subir ou acrescentar aperta.
 * @param {MetricRule} before
 * @param {MetricRule} after
 * @returns {FieldVerdict}
 */
function compareMin(before, after) {
  return compareBound(before.min, after.min, 'up');
}

/**
 * Limite superior: subir ou retirar afrouxa, descer ou acrescentar aperta.
 * @param {MetricRule} before
 * @param {MetricRule} after
 * @returns {FieldVerdict}
 */
function compareMax(before, after) {
  return compareBound(before.max, after.max, 'down');
}

/**
 * @param {number|undefined} before
 * @param {number|undefined} after
 * @param {'up'|'down'} stricter direcção em que o limite fica mais exigente
 * @returns {FieldVerdict}
 */
function compareBound(before, after, stricter) {
  if (before === undefined && after === undefined) return null;
  if (after === undefined) return 'loosened';
  if (before === undefined) return 'tightened';
  if (isBetter(stricter, after, before)) return 'tightened';
  if (isBetter(stricter, before, after)) return 'loosened';
  return null;
}

/**
 * Alterações que afrouxam o contrato (incluindo métricas retiradas).
 * @param {BaselineChange[]} changes
 * @returns {BaselineChange[]}
 */
export function loosenedChanges(changes) {
  return changes.filter((item) => item.kind === 'loosened' || item.kind === 'removed');
}

/**
 * Contrato efectivo desta execução. Sem baseline do ramo base, ou com autorização para
 * afrouxar, vale o do PR. Caso contrário cada métrica fica com a versão mais exigente das
 * duas, e as métricas retiradas pelo PR continuam a ser verificadas.
 * @param {Baseline|null} base
 * @param {Baseline} head
 * @param {boolean} looseningGranted
 * @returns {Baseline}
 */
export function resolveContract(base, head, looseningGranted) {
  if (base === null || looseningGranted) return head;
  const inHead = new Set(head.metrics.map((rule) => rule.name));
  const baseRules = new Map(base.metrics.map((rule) => [rule.name, rule]));
  const merged = head.metrics.map((rule) => stricterRule(baseRules.get(rule.name), rule));
  const removed = base.metrics.filter((rule) => !inHead.has(rule.name));
  return { ...head, metrics: [...merged, ...removed] };
}

/**
 * Combina duas versões da mesma regra, ficando com o mais exigente de cada campo.
 * @param {MetricRule|undefined} base
 * @param {MetricRule} head
 * @returns {MetricRule}
 */
function stricterRule(base, head) {
  if (!base) return head;
  if (base.direction !== head.direction) return base;
  return {
    ...head,
    value: stricterValue(head.direction, base.value, head.value),
    tolerance: Math.min(base.tolerance, head.tolerance),
    ...optional('min', pickBound(base.min, head.min, Math.max)),
    ...optional('max', pickBound(base.max, head.max, Math.min)),
  };
}

/**
 * @param {'up'|'down'} direction
 * @param {number|null} a
 * @param {number|null} b
 * @returns {number|null}
 */
function stricterValue(direction, a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return isBetter(direction, b, a) ? b : a;
}

/**
 * @param {number|undefined} a
 * @param {number|undefined} b
 * @param {(x: number, y: number) => number} pick
 * @returns {number|undefined}
 */
function pickBound(a, b, pick) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return pick(a, b);
}

/**
 * @param {'min'|'max'} key
 * @param {number|undefined} value
 * @returns {{min?: number, max?: number}}
 */
function optional(key, value) {
  return value === undefined ? {} : { [key]: value };
}

/**
 * Compila o padrão configurado, sem distinguir maiúsculas.
 * @param {string} pattern
 * @returns {RegExp}
 * @throws {ConfigError} quando o padrão não é uma expressão regular válida
 */
export function compilePattern(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigError('config_pattern_invalid', { pattern, reason });
  }
}

/**
 * Decide se o PR está autorizado a afrouxar o baseline: o título tem de o declarar.
 * @param {{title?: string, pattern: string}} input
 * @returns {Decision}
 */
export function authoriseLowering({ title = '', pattern }) {
  if (!pattern) return DENIED;
  if (!compilePattern(pattern).test(title)) return DENIED;
  return { granted: true, reason: { code: 'reason_title', params: { title } } };
}

/**
 * Perdão de hotfix: a label configurada perdoa qualquer falha, de forma visível.
 * As labels do GitHub não distinguem maiúsculas, por isso a comparação também não.
 * @param {{labels?: string[], bypassLabel: string}} input
 * @returns {Decision}
 */
export function shouldBypass({ labels = [], bypassLabel }) {
  if (!bypassLabel) return DENIED;
  const wanted = bypassLabel.toLowerCase();
  const label = labels.find((candidate) => candidate.toLowerCase() === wanted);
  if (label === undefined) return DENIED;
  return { granted: true, reason: { code: 'reason_label', params: { label } } };
}
