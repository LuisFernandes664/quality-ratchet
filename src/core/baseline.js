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

/** Campos reconhecidos em `source`. */
const SOURCE_FIELDS = new Set(['format', 'path', 'field', 'pointer', 'levels']);

/** Campos reconhecidos na raiz de um ficheiro v2. O v1 acrescenta `rules`. */
const ROOT_FIELDS_V2 = new Set(['$schema', 'version', 'frozen_at', 'metrics']);

/** Campos reconhecidos na raiz de um ficheiro v1. */
const ROOT_FIELDS_V1 = new Set([...ROOT_FIELDS_V2, 'rules']);

/** Caracteres de controlo, proibidos nos nomes das métricas (partiriam o sumário). */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

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
  checkRoot(raw, log, version);
  if (log.errors.length > 0) throw invalid(log.errors);
  return {
    version,
    frozenAt: typeof raw.frozen_at === 'string' ? raw.frozen_at : undefined,
    schema: typeof raw.$schema === 'string' ? raw.$schema : undefined,
    ...readLayout(raw, version),
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
 * Decide o formato do ficheiro a partir de `version` e da forma das métricas. Sem
 * `version`, métricas todas objecto são v2 mesmo que tenha ficado uma chave `rules`
 * esquecida (que dá aviso); `rules` só desempata quando a forma é ambígua.
 * @param {Record<string, unknown>} raw
 * @param {IssueLog} log
 * @returns {1|2}
 */
function detectVersion(raw, log) {
  if (raw.version === 1 || raw.version === 2) return raw.version;
  if (raw.version !== undefined) log.error('version_unsupported', { version: raw.version });
  const values = isPlainObject(raw.metrics) ? Object.values(raw.metrics) : [];
  if (values.length > 0 && values.every(isPlainObject)) return 2;
  if (raw.rules === undefined && values.some(isPlainObject)) log.error('baseline_mixed_format');
  return 1;
}

/**
 * Valida os campos da raiz comuns aos dois formatos.
 * @param {Record<string, unknown>} raw
 * @param {IssueLog} log
 * @param {1|2} version
 * @returns {void}
 */
function checkRoot(raw, log, version) {
  if (raw.frozen_at !== undefined && typeof raw.frozen_at !== 'string') {
    log.error('frozen_at_invalid', { value: String(raw.frozen_at) });
  }
  if (raw.$schema !== undefined && typeof raw.$schema !== 'string') {
    log.error('schema_invalid', { value: JSON.stringify(raw.$schema) });
  }
  for (const field of Object.keys(unknownFields(raw, rootFields(version)))) {
    log.warn('unknown_root_field', { field });
  }
}

/**
 * @param {1|2} version
 * @returns {Set<string>}
 */
function rootFields(version) {
  return version === 1 ? ROOT_FIELDS_V1 : ROOT_FIELDS_V2;
}

/**
 * Campos que o formato não conhece, pela ordem do ficheiro.
 * @param {Record<string, unknown>} entry
 * @param {Set<string>} known
 * @returns {Record<string, unknown>}
 */
function unknownFields(entry, known) {
  return Object.fromEntries(Object.entries(entry).filter(([field]) => !known.has(field)));
}

/**
 * O que é preciso para reescrever o ficheiro sem perder nada: campos desconhecidos da
 * raiz e, no v1, se `version` estava declarado e a ordem original dos valores.
 * @param {Record<string, unknown>} raw
 * @param {1|2} version
 * @returns {Pick<Baseline, 'extra'|'versionDeclared'|'valueOrder'>}
 */
function readLayout(raw, version) {
  const extra = unknownFields(raw, rootFields(version));
  const layout = Object.keys(extra).length > 0 ? { extra } : {};
  if (version === 2) return layout;
  const valueOrder = isPlainObject(raw.metrics) ? Object.keys(raw.metrics) : [];
  return { ...layout, versionDeclared: raw.version === 1, valueOrder };
}

/**
 * Valida um nome de métrica: tem de ter texto visível e nenhum carácter de controlo.
 * @param {string} name
 * @param {IssueLog} log
 * @returns {void}
 */
function checkName(name, log) {
  if (isNonEmptyString(name) && !CONTROL_CHARACTER.test(name)) return;
  log.error('metric_name_invalid', { name: JSON.stringify(name) });
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
  checkV1Names(values, down, up, log);
  return [
    ...down.map((name) => v1Rule(name, 'down', values, log)),
    ...up.filter((name) => !down.includes(name)).map((name) => v1Rule(name, 'up', values, log)),
  ];
}

/**
 * Nomes das regras v1: válidos, numa só direcção, e valores sem regra assinalados.
 * @param {Record<string, unknown>} values
 * @param {string[]} down
 * @param {string[]} up
 * @param {IssueLog} log
 * @returns {void}
 */
function checkV1Names(values, down, up, log) {
  for (const name of new Set([...down, ...up])) checkName(name, log);
  for (const name of down.filter((n) => up.includes(n))) {
    log.error('metric_in_both_directions', { name });
  }
  for (const name of Object.keys(values).filter((n) => !down.includes(n) && !up.includes(n))) {
    log.warn('metric_without_rule', { name });
  }
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
 * Valores v1 que não têm regra: ficam de fora da comparação, com aviso, mas são guardados
 * tal como estão (números ou não) para o ficheiro ser reescrito sem os perder.
 * @param {Record<string, unknown>} raw
 * @param {MetricRule[]} metrics
 * @returns {Record<string, unknown>}
 */
function readUntracked(raw, metrics) {
  const values = isPlainObject(raw.metrics) ? raw.metrics : {};
  const tracked = new Set(metrics.map((rule) => rule.name));
  return Object.fromEntries(Object.entries(values).filter(([name]) => !tracked.has(name)));
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
  for (const [name] of entries) checkName(name, log);
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
  /** @type {MetricRule} */
  const rule = {
    name,
    ...readUnknownFields(name, entry, log),
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
 * Campos desconhecidos de uma métrica: dão aviso (podem ser gralhas) e são guardados, para
 * o aviso se repetir até alguém os corrigir em vez de desaparecerem ao reescrever.
 * @param {string} name
 * @param {Record<string, unknown>} entry
 * @param {IssueLog} log
 * @returns {{extra?: Record<string, unknown>}}
 */
function readUnknownFields(name, entry, log) {
  const extra = unknownFields(entry, METRIC_FIELDS);
  const fields = Object.keys(extra);
  for (const field of fields) log.warn('unknown_field', { name, field });
  return fields.length > 0 ? { extra } : {};
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
  return {
    ...readDescription(name, entry.description, log),
    ...readSourceEntry(name, entry.source, log),
  };
}

/**
 * A descrição é texto; outro tipo é erro, como no schema, em vez de desaparecer.
 * @param {string} name
 * @param {unknown} value
 * @param {IssueLog} log
 * @returns {{description?: string}}
 */
function readDescription(name, value, log) {
  if (value === undefined) return {};
  if (typeof value === 'string') return { description: value };
  log.error('description_invalid', { name, value: JSON.stringify(value) });
  return {};
}

/**
 * Lê `source`. Chaves desconhecidas dentro dela dão aviso: uma gralha como `feild` faria o
 * extractor medir o campo por omissão sem ninguém dar por isso.
 * @param {string} name
 * @param {unknown} raw
 * @param {IssueLog} log
 * @returns {{source?: MetricSource}}
 */
function readSourceEntry(name, raw, log) {
  if (raw === undefined) return {};
  const source = readSource(raw);
  if (!source) {
    log.error('source_invalid', { name });
    return {};
  }
  for (const key of Object.keys(source)) {
    if (!SOURCE_FIELDS.has(key)) log.warn('unknown_field', { name, field: `source.${key}` });
  }
  return { source };
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
  if (baseline.version === 2 || baseline.versionDeclared) out.version = baseline.version;
  if (baseline.frozenAt !== undefined) out.frozen_at = baseline.frozenAt;
  const body = baseline.version === 1 ? serializeV1(baseline) : {
    metrics: Object.fromEntries(baseline.metrics.map((rule) => [rule.name, serializeRule(rule)])),
  };
  return { ...out, ...baseline.extra, ...body };
}

/**
 * Formato v1: os valores pela ordem original do ficheiro (as métricas novas no fim) e as
 * listas de regras que têm nomes.
 * @param {Baseline} baseline
 * @returns {Record<string, unknown>}
 */
function serializeV1(baseline) {
  const values = new Map(Object.entries(baseline.untracked));
  for (const rule of baseline.metrics) values.set(rule.name, rule.value);
  const order = [...new Set([...(baseline.valueOrder ?? []), ...values.keys()])]
    .filter((name) => values.has(name));
  return {
    metrics: Object.fromEntries(order.map((name) => [name, values.get(name)])),
    rules: v1Rules(baseline.metrics),
  };
}

/**
 * Listas de regras v1, sem as que ficariam vazias.
 * @param {MetricRule[]} metrics
 * @returns {Record<string, string[]>}
 */
function v1Rules(metrics) {
  const namesFor = (/** @type {'up'|'down'} */ direction) => metrics
    .filter((rule) => rule.direction === direction)
    .map((rule) => rule.name);
  const lists = Object.entries({ monotonic_down: namesFor('down'), monotonic_up: namesFor('up') });
  return Object.fromEntries(lists.filter(([, names]) => names.length > 0));
}

/**
 * Serializa uma métrica v2, omitindo os campos opcionais vazios. Os campos desconhecidos
 * vão no fim, tal como estavam.
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
  return { ...out, ...rule.extra };
}

/**
 * Converte um baseline para o formato v2. Os valores v1 sem regra (números ou não) não
 * têm direcção e por isso não podem ser migrados: são devolvidos à parte para o chamador
 * os reportar.
 * @param {Baseline} baseline
 * @returns {{baseline: Baseline, dropped: string[]}}
 */
export function migrateToV2(baseline) {
  return {
    baseline: { ...baseline, version: 2, untracked: {}, metrics: inFileOrder(baseline) },
    dropped: Object.keys(baseline.untracked),
  };
}

/**
 * Métricas pela ordem em que os valores aparecem no ficheiro v1, para a migração não
 * baralhar o diff (a leitura v1 agrupa-as por direcção).
 * @param {Baseline} baseline
 * @returns {MetricRule[]}
 */
function inFileOrder(baseline) {
  const order = baseline.valueOrder ?? [];
  const rank = (/** @type {string} */ name) => {
    const index = order.indexOf(name);
    return index === -1 ? order.length : index;
  };
  return [...baseline.metrics].sort((a, b) => rank(a.name) - rank(b.name));
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
