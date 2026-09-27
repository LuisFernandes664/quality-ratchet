// @ts-check
/**
 * Governação do baseline. O contrato que conta é o do ramo base: um PR que mexe no
 * ficheiro do baseline só o pode apertar. Afrouxar exige autorização explícita, e o
 * perdão de hotfix é uma saída à parte, sempre visível no sumário.
 */
import path from 'node:path';

import { ConfigError } from './errors.js';
import { EPSILON, isBetter } from './compare.js';

/** @typedef {import('./types.js').Baseline} Baseline */
/** @typedef {import('./types.js').MetricRule} MetricRule */
/** @typedef {import('./types.js').MetricSource} MetricSource */
/** @typedef {import('./types.js').BaselineChange} BaselineChange */
/** @typedef {import('./types.js').ChangeKind} ChangeKind */
/** @typedef {import('./types.js').Decision} Decision */
/** @typedef {'loosened'|'tightened'|'changed'|null} FieldVerdict */
/** @typedef {{loosened: string[], tightened: string[], changed: string[]}} FieldsByVerdict */

/** Decisão negativa, partilhada para não criar objectos repetidos. */
const DENIED = Object.freeze({ granted: false, reason: null });

/**
 * Comparadores por campo: dizem se o PR afrouxou, apertou ou só alterou cada campo da
 * regra. A `source` decide o que é medido, por isso qualquer mudança nela afrouxa: sem
 * isso, apontar a métrica para outro relatório esconderia uma regressão. `target` e
 * `description` são informativos e só ficam registados.
 * @type {Array<[string, (before: MetricRule, after: MetricRule) => FieldVerdict]>}
 */
const FIELD_CHECKS = [
  ['direction', (before, after) => (before.direction === after.direction ? null : 'loosened')],
  ['value', compareValue],
  ['tolerance', compareTolerance],
  ['min', compareMin],
  ['max', compareMax],
  ['source', (before, after) => (sourceKey(before) === sourceKey(after) ? null : 'loosened')],
  ['target', (before, after) => informative(before.target, after.target)],
  ['description', (before, after) => informative(before.description, after.description)],
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
  if (!before) return change(name, 'added', groupFields([]), null, after ?? null);
  if (!after) return change(name, 'removed', groupFields([['metric', 'loosened']]), before, null);
  const fields = groupFields(FIELD_CHECKS.map(([field, check]) => (
    /** @type {[string, FieldVerdict]} */ ([field, check(before, after)]))));
  return change(name, kindOf(fields), fields, before, after);
}

/**
 * Agrupa os campos pelo veredicto de cada um.
 * @param {Array<[string, FieldVerdict]>} verdicts
 * @returns {FieldsByVerdict}
 */
function groupFields(verdicts) {
  const having = (/** @type {FieldVerdict} */ verdict) => verdicts
    .filter(([, candidate]) => candidate === verdict)
    .map(([field]) => field);
  return {
    loosened: having('loosened'),
    tightened: having('tightened'),
    changed: having('changed'),
  };
}

/**
 * Tipo da alteração: afrouxar pesa mais do que apertar, e apertar mais do que só alterar.
 * @param {FieldsByVerdict} fields
 * @returns {ChangeKind}
 */
function kindOf(fields) {
  if (fields.loosened.length > 0) return 'loosened';
  if (fields.tightened.length > 0) return 'tightened';
  return fields.changed.length > 0 ? 'changed' : 'unchanged';
}

/**
 * @param {string} name
 * @param {ChangeKind} kind
 * @param {FieldsByVerdict} fields
 * @param {MetricRule|null} before
 * @param {MetricRule|null} after
 * @returns {BaselineChange}
 */
function change(name, kind, fields, before, after) {
  return {
    name,
    kind,
    loosenedFields: fields.loosened,
    tightenedFields: fields.tightened,
    changedFields: fields.changed,
    before,
    after,
  };
}

/**
 * Identidade da source de uma regra, para saber se o PR mudou o que é medido. A ordem e
 * as repetições de `levels` não contam, nem as formas equivalentes do caminho (`./a` é
 * `a`). Tudo o resto conta, incluindo acrescentar ou retirar a source, ou escrever o
 * `field` por omissão que antes estava implícito: na dúvida, pede-se autorização. As
 * chaves desconhecidas ficam de fora, porque os extractors não as lêem.
 * @param {MetricRule|undefined} rule
 * @returns {string} '' quando a regra não existe ou não tem source
 */
export function sourceKey(rule) {
  const source = rule?.source;
  if (source === undefined) return '';
  const levels = source.levels === undefined ? null : [...new Set(source.levels)].sort();
  const file = path.posix.normalize(source.path);
  const { format, field = null, pointer = null } = source;
  return JSON.stringify([format, file, field, pointer, levels]);
}

/**
 * Regras do ramo base cuja source o PR mudou, acrescentou ou retirou, incluindo as
 * métricas retiradas que tinham source. Enquanto a mudança não for autorizada, estas
 * métricas medem-se com a source do ramo base.
 * @param {Baseline} base
 * @param {Baseline} head
 * @returns {MetricRule[]}
 */
export function movedSources(base, head) {
  const heads = new Map(head.metrics.map((rule) => [rule.name, rule]));
  return base.metrics.filter((rule) => sourceKey(rule) !== sourceKey(heads.get(rule.name)));
}

/**
 * Campo informativo: qualquer diferença fica registada, sem afrouxar nem apertar.
 * @param {unknown} before
 * @param {unknown} after
 * @returns {FieldVerdict}
 */
function informative(before, after) {
  return before === after ? null : 'changed';
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
 * duas e com a source do ramo base, e as métricas retiradas pelo PR continuam a ser
 * verificadas.
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
 * Combina duas versões da mesma regra, ficando com o mais exigente de cada campo. A
 * source é a do ramo base (ou nenhuma, se lá não havia), porque mudá-la é afrouxar; só
 * fica a do PR quando é a mesma escrita de outra forma.
 * @param {MetricRule|undefined} base
 * @param {MetricRule} head
 * @returns {MetricRule}
 */
function stricterRule(base, head) {
  if (!base) return head;
  if (base.direction !== head.direction) return base;
  const source = sourceKey(base) === sourceKey(head) ? head.source : base.source;
  return withSource({
    ...head,
    value: stricterValue(head.direction, base.value, head.value),
    tolerance: Math.min(base.tolerance, head.tolerance),
    ...optional('min', pickBound(base.min, head.min, Math.max)),
    ...optional('max', pickBound(base.max, head.max, Math.min)),
  }, source);
}

/**
 * Cópia da regra com a source indicada, ou sem source quando ela é undefined.
 * @param {MetricRule} rule
 * @param {MetricSource|undefined} source
 * @returns {MetricRule}
 */
function withSource(rule, source) {
  const copy = { ...rule };
  delete copy.source;
  return source === undefined ? copy : { ...copy, source };
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
