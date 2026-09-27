// @ts-check
/**
 * Leitura, validação e escrita do baseline. Aceita dois formatos:
 * - v1: `metrics` com números e `rules.monotonic_down` / `rules.monotonic_up`;
 * - v2: `metrics` com um objecto por métrica (valor, direcção, tolerância, limites, source).
 * Internamente os dois são normalizados para o mesmo modelo.
 */
import { BaselineError } from './errors.js';
import { isFiniteNumber, isNonEmptyString, isPlainObject } from './guards.js';

/** @typedef {import('./types.js').Baseline} Baseline */
/** @typedef {import('./types.js').MetricRule} MetricRule */
/** @typedef {import('./types.js').MetricSource} MetricSource */
/** @typedef {import('./types.js').Issue} Issue */

/** Campos reconhecidos numa métrica v2. */
const METRIC_FIELDS = new Set([
  'value', 'direction', 'tolerance', 'min', 'max', 'target', 'source', 'description',
]);

/** Campos reconhecidos na raiz do ficheiro. */
const ROOT_FIELDS = new Set(['$schema', 'version', 'frozen_at', 'metrics', 'rules']);

/** Campos opcionais de uma métrica v2 que têm de ser números. */
const NUMERIC_FIELDS = /** @type {const} */ (['min', 'max', 'target']);

/**
 * Acumulador de problemas encontrados durante a validação.
 */
class IssueLog {
  constructor() {
    /** @type {Issue[]} */
    this.errors = [];
    /** @type {Issue[]} */
    this.warnings = [];
  }

  /**
   * Regista um erro.
   * @param {string} code
   * @param {Record<string, unknown>} [params]
   * @returns {void}
   */
  error(code, params = {}) {
    this.errors.push({ code, params });
  }

  /**
   * Regista um aviso.
   * @param {string} code
   * @param {Record<string, unknown>} [params]
   * @returns {void}
   */
  warn(code, params = {}) {
    this.warnings.push({ code, params });
  }
}

/**
 * Valida e normaliza o conteúdo de um ficheiro de baseline.
 * @param {unknown} raw JSON lido do ficheiro
 * @param {{allowEmptyValues?: boolean}} [options] aceitar `value: null` (fluxos de init/update)
 * @returns {Baseline}
 * @throws {BaselineError} com todos os problemas encontrados em `params.issues`
 */
export function parseBaseline(raw, { allowEmptyValues = false } = {}) {
  if (!isPlainObject(raw)) throw invalid([{ code: 'baseline_not_object', params: {} }]);
  const log = new IssueLog();
  const version = detectVersion(raw, log);
  const metrics = version === 1 ? readV1(raw, log) : readV2(raw, log, allowEmptyValues);
  checkRoot(raw, log);
  if (log.errors.length > 0) throw invalid(log.errors);
  return {
    version,
    frozenAt: typeof raw.frozen_at === 'string' ? raw.frozen_at : undefined,
    schema: typeof raw.$schema === 'string' ? raw.$schema : undefined,
    metrics,
    untracked: version === 1 ? readUntracked(raw, metrics) : {},
    warnings: log.warnings,
  };
}

/**
 * @param {Issue[]} issues
 * @returns {BaselineError}
 */
function invalid(issues) {
  return new BaselineError('baseline_invalid', { issues });
}

/**
 * Decide o formato do ficheiro a partir de `version`, `rules` e da forma das métricas.
 * @param {Record<string, unknown>} raw
 * @param {IssueLog} log
 * @returns {1|2}
 */
function detectVersion(raw, log) {
  if (raw.version === 1 || raw.version === 2) return raw.version;
  if (raw.version !== undefined) log.error('version_unsupported', { version: raw.version });
  if (raw.rules !== undefined || !isPlainObject(raw.metrics)) return 1;
  const values = Object.values(raw.metrics);
  if (values.every(isPlainObject)) return values.length > 0 ? 2 : 1;
  if (values.some(isPlainObject)) log.error('baseline_mixed_format');
  return 1;
}

/**
 * Valida os campos da raiz comuns aos dois formatos.
 * @param {Record<string, unknown>} raw
 * @param {IssueLog} log
 * @returns {void}
 */
function checkRoot(raw, log) {
  if (raw.frozen_at !== undefined && typeof raw.frozen_at !== 'string') {
    log.error('frozen_at_invalid', { value: String(raw.frozen_at) });
  }
  for (const field of Object.keys(raw)) {
    if (!ROOT_FIELDS.has(field)) log.warn('unknown_root_field', { field });
  }
}

/**
 * Lê o formato v1.
 * @param {Record<string, unknown>} raw
 * @param {IssueLog} log
 * @returns {MetricRule[]}
 */
function readV1(raw, log) {
  const values = isPlainObject(raw.metrics) ? raw.metrics : {};
  const rules = isPlainObject(raw.rules) ? raw.rules : {};
  const down = readRuleList(rules, 'monotonic_down', log);
  const up = readRuleList(rules, 'monotonic_up', log);
  if (down.length === 0 && up.length === 0) log.error('baseline_no_rules');
  for (const name of down.filter((n) => up.includes(n))) {
    log.error('metric_in_both_directions', { name });
  }
  for (const name of Object.keys(values).filter((n) => !down.includes(n) && !up.includes(n))) {
    log.warn('metric_without_rule', { name });
  }
  return [
    ...down.map((name) => v1Rule(name, 'down', values, log)),
    ...up.filter((name) => !down.includes(name)).map((name) => v1Rule(name, 'up', values, log)),
  ];
}

/**
 * Lê uma lista de nomes em `rules`, sem repetidos.
 * @param {Record<string, unknown>} rules
 * @param {string} key
 * @param {IssueLog} log
 * @returns {string[]}
 */
function readRuleList(rules, key, log) {
  const list = rules[key];
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.every(isNonEmptyString)) {
    log.error('rules_not_list', { key });
    return [];
  }
  const repeated = list.filter((name, index) => list.indexOf(name) !== index);
  for (const name of new Set(repeated)) log.error('metric_duplicated', { name });
  return [...new Set(list)];
}

/**
 * Constrói a regra de uma métrica v1.
 * @param {string} name
 * @param {'up'|'down'} direction
 * @param {Record<string, unknown>} values
 * @param {IssueLog} log
 * @returns {MetricRule}
 */
function v1Rule(name, direction, values, log) {
  const value = Object.hasOwn(values, name) ? values[name] : undefined;
  return { name, value: readValue(name, value, false, log), direction, tolerance: 0 };
}

/**
 * Valores v1 que não têm regra: ficam de fora da comparação, com aviso.
 * @param {Record<string, unknown>} raw
 * @param {MetricRule[]} metrics
 * @returns {Record<string, number>}
 */
function readUntracked(raw, metrics) {
  const values = isPlainObject(raw.metrics) ? raw.metrics : {};
  const tracked = new Set(metrics.map((rule) => rule.name));
  /** @type {Array<[string, number]>} */
  const entries = [];
  for (const [name, value] of Object.entries(values)) {
    if (!tracked.has(name) && isFiniteNumber(value)) entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

/**
 * Lê o formato v2.
 * @param {Record<string, unknown>} raw
 * @param {IssueLog} log
 * @param {boolean} allowEmptyValues
 * @returns {MetricRule[]}
 */
function readV2(raw, log, allowEmptyValues) {
  const entries = isPlainObject(raw.metrics) ? Object.entries(raw.metrics) : [];
  if (entries.length === 0) log.error('baseline_no_metrics');
  if (raw.rules !== undefined) log.warn('unknown_root_field', { field: 'rules' });
  return entries.map(([name, entry]) => readV2Metric(name, entry, log, allowEmptyValues));
}

/**
 * Lê e valida uma métrica v2.
 * @param {string} name
 * @param {unknown} entry
 * @param {IssueLog} log
 * @param {boolean} allowEmptyValues
 * @returns {MetricRule}
 */
function readV2Metric(name, entry, log, allowEmptyValues) {
  if (!isPlainObject(entry)) {
    log.error('metric_not_object', { name });
    return { name, value: null, direction: 'up', tolerance: 0 };
  }
  warnUnknownFields(name, entry, log);
  /** @type {MetricRule} */
  const rule = {
    name,
    value: readValue(name, entry.value, allowEmptyValues, log),
    direction: readDirection(name, entry.direction, log),
    tolerance: readTolerance(name, entry.tolerance, log),
    ...readNumericFields(name, entry, log),
    ...readExtras(name, entry, log),
  };
  checkLimits(rule, log);
  return rule;
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} entry
 * @param {IssueLog} log
 * @returns {void}
 */
function warnUnknownFields(name, entry, log) {
  for (const field of Object.keys(entry)) {
    if (!METRIC_FIELDS.has(field)) log.warn('unknown_field', { name, field });
  }
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {boolean} allowEmpty
 * @param {IssueLog} log
 * @returns {number|null}
 */
function readValue(name, value, allowEmpty, log) {
  if (isFiniteNumber(value)) return value;
  if ((value === undefined || value === null) && allowEmpty) return null;
  if (value === undefined) log.error('rule_without_value', { name });
  else log.error('value_not_numeric', { name, value: JSON.stringify(value) });
  return null;
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {IssueLog} log
 * @returns {'up'|'down'}
 */
function readDirection(name, value, log) {
  if (value === 'up' || value === 'down') return value;
  log.error('direction_invalid', { name, value: JSON.stringify(value) });
  return 'up';
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {IssueLog} log
 * @returns {number}
 */
function readTolerance(name, value, log) {
  if (value === undefined) return 0;
  if (isFiniteNumber(value) && value >= 0) return value;
  log.error('tolerance_invalid', { name, value: JSON.stringify(value) });
  return 0;
}

/**
 * Lê `min`, `max` e `target`, todos opcionais e numéricos.
 * @param {string} name
 * @param {Record<string, unknown>} entry
 * @param {IssueLog} log
 * @returns {{min?: number, max?: number, target?: number}}
 */
function readNumericFields(name, entry, log) {
  /** @type {{min?: number, max?: number, target?: number}} */
  const fields = {};
  for (const field of NUMERIC_FIELDS) {
    const value = entry[field];
    if (value === undefined) continue;
    if (isFiniteNumber(value)) fields[field] = value;
    else log.error('limit_not_numeric', { name, field, value: JSON.stringify(value) });
  }
  return fields;
}

/**
 * Lê `source` e `description`.
 * @param {string} name
 * @param {Record<string, unknown>} entry
 * @param {IssueLog} log
 * @returns {{source?: MetricSource, description?: string}}
 */
function readExtras(name, entry, log) {
  /** @type {{source?: MetricSource, description?: string}} */
  const extras = {};
  if (typeof entry.description === 'string') extras.description = entry.description;
  if (entry.source === undefined) return extras;
  const source = readSource(entry.source);
  if (source) extras.source = source;
  else log.error('source_invalid', { name });
  return extras;
}

/**
 * Valida a forma de `source`. A validação do formato e do campo cabe aos extractors.
 * @param {unknown} raw
 * @returns {MetricSource|null}
 */
function readSource(raw) {
  if (!isPlainObject(raw) || !isNonEmptyString(raw.format) || !isNonEmptyString(raw.path)) {
    return null;
  }
  const optionalText = ['field', 'pointer'].every(
    (key) => raw[key] === undefined || typeof raw[key] === 'string',
  );
  const levelsOk = raw.levels === undefined
    || (Array.isArray(raw.levels) && raw.levels.every((level) => typeof level === 'string'));
  if (!optionalText || !levelsOk) return null;
  return /** @type {MetricSource} */ ({ ...raw });
}

/**
 * Coerência entre `min`, `max` e o valor congelado.
 * @param {MetricRule} rule
 * @param {IssueLog} log
 * @returns {void}
 */
function checkLimits(rule, log) {
  const { name, value, min, max } = rule;
  if (min !== undefined && max !== undefined && min > max) {
    log.error('limits_inverted', { name, min, max });
  }
  if (value === null) return;
  if (min !== undefined && value < min) {
    log.warn('value_violates_limit', { name, value, field: 'min', limit: min });
  }
  if (max !== undefined && value > max) {
    log.warn('value_violates_limit', { name, value, field: 'max', limit: max });
  }
}

/**
 * Converte o modelo normalizado de volta para JSON, no formato original do ficheiro.
 * @param {Baseline} baseline
 * @returns {Record<string, unknown>}
 */
export function serializeBaseline(baseline) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (baseline.schema !== undefined) out.$schema = baseline.schema;
  if (baseline.version === 2) out.version = 2;
  if (baseline.frozenAt !== undefined) out.frozen_at = baseline.frozenAt;
  return baseline.version === 1 ? { ...out, ...serializeV1(baseline) } : {
    ...out,
    metrics: Object.fromEntries(baseline.metrics.map((rule) => [rule.name, serializeRule(rule)])),
  };
}

/**
 * @param {Baseline} baseline
 * @returns {Record<string, unknown>}
 */
function serializeV1(baseline) {
  const namesFor = (/** @type {'up'|'down'} */ direction) => baseline.metrics
    .filter((rule) => rule.direction === direction)
    .map((rule) => rule.name);
  const values = baseline.metrics.map((rule) => [rule.name, rule.value]);
  return {
    metrics: { ...Object.fromEntries(values), ...baseline.untracked },
    rules: { monotonic_down: namesFor('down'), monotonic_up: namesFor('up') },
  };
}

/**
 * Serializa uma métrica v2, omitindo os campos opcionais vazios.
 * @param {MetricRule} rule
 * @returns {Record<string, unknown>}
 */
function serializeRule(rule) {
  /** @type {Record<string, unknown>} */
  const out = { value: rule.value, direction: rule.direction };
  if (rule.tolerance > 0) out.tolerance = rule.tolerance;
  for (const field of NUMERIC_FIELDS) {
    if (rule[field] !== undefined) out[field] = rule[field];
  }
  if (rule.source !== undefined) out.source = rule.source;
  if (rule.description !== undefined) out.description = rule.description;
  return out;
}

/**
 * Converte um baseline para o formato v2. Os valores v1 sem regra não têm direcção e
 * por isso não podem ser migrados: são devolvidos à parte para o chamador os reportar.
 * @param {Baseline} baseline
 * @returns {{baseline: Baseline, dropped: string[]}}
 */
export function migrateToV2(baseline) {
  return {
    baseline: { ...baseline, version: 2, untracked: {} },
    dropped: Object.keys(baseline.untracked),
  };
}

/**
 * Devolve uma cópia do baseline com novos valores para algumas métricas.
 * @param {Baseline} baseline
 * @param {Map<string, number>} values novos valores por nome de métrica
 * @param {string} [frozenAt] nova data de congelamento
 * @returns {Baseline}
 */
export function withValues(baseline, values, frozenAt) {
  return {
    ...baseline,
    frozenAt: frozenAt ?? baseline.frozenAt,
    metrics: baseline.metrics.map((rule) => {
      const value = values.get(rule.name);
      return value === undefined ? rule : { ...rule, value };
    }),
  };
}
