// @ts-check
/**
 * Leitura de ficheiros partilhada pela action e pela CLI: baseline, ficheiro de métricas e
 * relatórios das ferramentas. O sistema de ficheiros é injectado para ficar testável.
 */
import path from 'node:path';

import { parseBaseline, sourcesOf } from './core/baseline.js';
import { BaselineError, ExtractorError, MetricsError } from './core/errors.js';
import { movedSources } from './core/governance.js';
import { ownValue } from './core/guards.js';
import { parseMetricsFile } from './core/measurements.js';
import { extract } from './extractors/index.js';

/** @typedef {import('./core/types.js').Baseline} Baseline */
/** @typedef {import('./core/types.js').MetricRule} MetricRule */
/** @typedef {import('./core/types.js').Measurement} Measurement */
/** @typedef {import('./core/types.js').Issue} Issue */
/** @typedef {typeof BaselineError | typeof MetricsError} FileErrorClass */

/** Métrica do ficheiro de métricas que não veio nele. */
const NO_VALUE = Object.freeze(/** @type {Measurement} */ ({ origin: 'file' }));

/**
 * Acesso ao sistema de ficheiros.
 * @typedef {object} FileSystem
 * @property {(filePath: string) => Promise<string>} readText
 * @property {(filePath: string) => Promise<boolean>} exists
 */

/**
 * Converte texto em JSON, ignorando um BOM UTF-8 inicial.
 * @param {string} text
 * @param {string} filePath caminho, para as mensagens
 * @param {FileErrorClass} ErrorClass classe de erro a lançar
 * @returns {unknown}
 */
export function parseJsonText(text, filePath, ErrorClass) {
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (cause) {
    throw new ErrorClass('json_invalid', { path: filePath, reason: reasonOf(cause) });
  }
}

/**
 * Lê e interpreta um ficheiro JSON.
 * @param {FileSystem} fs
 * @param {string} filePath
 * @param {FileErrorClass} ErrorClass classe de erro a lançar
 * @returns {Promise<unknown>}
 */
export async function readJsonFile(fs, filePath, ErrorClass) {
  let text;
  try {
    text = await fs.readText(filePath);
  } catch (cause) {
    throw new ErrorClass('file_unreadable', { path: filePath, reason: reasonOf(cause) });
  }
  return parseJsonText(text, filePath, ErrorClass);
}

/**
 * Lê e valida o baseline.
 * @param {FileSystem} fs
 * @param {string} filePath
 * @param {{allowEmptyValues?: boolean}} [options]
 * @returns {Promise<Baseline>}
 */
export async function loadBaseline(fs, filePath, options = {}) {
  return parseBaseline(await readJsonFile(fs, filePath, BaselineError), options);
}

/**
 * @typedef {object} CollectOptions
 * @property {string} [metricsPath] ficheiro de métricas plano; opcional se todas têm source
 * @property {string} baselineDir pasta do baseline, base dos caminhos das sources
 * @property {Baseline|null} [base] baseline do ramo base, quando há governação
 */

/**
 * @typedef {object} Collected
 * @property {Record<string, Measurement>} measurements medições com as sources do baseline
 * @property {Record<string, Measurement>} baseMeasurements medições com as sources do ramo
 *   base, só para as métricas cuja source o PR mudou ou retirou (vazio sem `base`)
 * @property {string[]} untracked métricas do ficheiro que o baseline não segue
 */

/**
 * Reúne as medições desta execução: ficheiro de métricas e relatórios das sources. Com o
 * baseline do ramo base, mede também as métricas cuja source o PR mudou ou retirou com a
 * source do ramo base, porque é essa que conta enquanto a mudança não for autorizada.
 * @param {FileSystem} fs
 * @param {Baseline} baseline
 * @param {CollectOptions} options
 * @returns {Promise<Collected>}
 * @throws {MetricsError} ficheiro de métricas em falta ou métrica com duas origens
 */
export async function collectMeasurements(fs, baseline, options) {
  const fromFile = await readMetricsFile(fs, baseline, options.metricsPath);
  const sourced = baseline.metrics.filter((rule) => rule.source !== undefined);
  const fromSources = await measureRules(fs, sourced, options.baselineDir);
  for (const [name] of fromSources) {
    if (Object.hasOwn(fromFile, name)) throw new MetricsError('metric_defined_twice', { name });
  }
  const tracked = new Set(baseline.metrics.map((rule) => rule.name));
  return {
    measurements: Object.fromEntries([...Object.entries(fromFile), ...fromSources]),
    baseMeasurements: await measureBase(fs, baseline, fromFile, options),
    untracked: Object.keys(fromFile).filter((name) => !tracked.has(name)),
  };
}

/**
 * Mede cada regra a partir da sua source.
 * @param {FileSystem} fs
 * @param {MetricRule[]} rules regras com source
 * @param {string} baselineDir
 * @returns {Promise<Array<[string, Measurement]>>}
 */
function measureRules(fs, rules, baselineDir) {
  return Promise.all(rules.map(async (rule) => (
    /** @type {[string, Measurement]} */ ([rule.name, await measureSource(fs, rule, baselineDir)])
  )));
}

/**
 * Medições das métricas do ramo base cuja source o PR mudou ou retirou, feitas com a
 * source do ramo base (o baseline do ramo base está no mesmo caminho, por isso os
 * relatórios resolvem-se a partir da mesma pasta). Uma métrica que no ramo base não tinha
 * source vem do ficheiro de métricas, ou fica sem valor. Não há verificação de origem
 * dupla: a source do ramo base prevalece sobre o ficheiro.
 * @param {FileSystem} fs
 * @param {Baseline} head
 * @param {Record<string, Measurement>} fromFile
 * @param {CollectOptions} options
 * @returns {Promise<Record<string, Measurement>>}
 */
async function measureBase(fs, head, fromFile, options) {
  if (!options.base) return {};
  const moved = movedSources(options.base, head);
  const withSource = moved.filter((rule) => rule.source !== undefined);
  const fromSources = await measureRules(fs, withSource, options.baselineDir);
  const fromFileOnly = moved.filter((rule) => rule.source === undefined).map((rule) => (
    /** @type {[string, Measurement]} */ ([rule.name, ownValue(fromFile, rule.name) ?? NO_VALUE])));
  return Object.fromEntries([...fromFileOnly, ...fromSources]);
}

/**
 * Lê o ficheiro de métricas plano. Só pode faltar quando todas as métricas têm source.
 * @param {FileSystem} fs
 * @param {Baseline} baseline
 * @param {string|undefined} metricsPath
 * @returns {Promise<Record<string, Measurement>>}
 */
async function readMetricsFile(fs, baseline, metricsPath) {
  if (metricsPath && await fs.exists(metricsPath)) {
    return parseMetricsFile(await readJsonFile(fs, metricsPath, MetricsError), metricsPath);
  }
  const withoutSource = baseline.metrics.filter((rule) => rule.source === undefined);
  if (withoutSource.length === 0) return {};
  const names = withoutSource.map((rule) => rule.name).join(', ');
  throw new MetricsError('metrics_file_missing', { path: metricsPath ?? '', names });
}

/**
 * Mede uma métrica a partir do relatório da sua source. Problemas com o relatório não
 * interrompem a execução: tornam a métrica "em falta", com o motivo, para que o sumário
 * mostre todos os problemas de uma vez.
 * @param {FileSystem} fs
 * @param {MetricRule} rule
 * @param {string} baselineDir
 * @returns {Promise<Measurement>}
 */
async function measureSource(fs, rule, baselineDir) {
  const parts = await Promise.all(sourcesOf(rule).map((source) => (
    measureReport(fs, source, baselineDir))));
  const failed = parts.find((part) => part.error !== undefined);
  if (failed) return failed;
  const total = parts.reduce((sum, part) => sum + /** @type {number} */ (part.value), 0);
  return { origin: 'source', value: total };
}

/**
 * Mede um relatório. Com várias sources, os valores somam-se e basta um relatório em falta
 * ou ilegível para a métrica ficar em falta: uma soma parcial seria um valor falso.
 * @param {FileSystem} fs
 * @param {import('./core/types.js').MetricSource} source
 * @param {string} baselineDir
 * @returns {Promise<Measurement>}
 */
async function measureReport(fs, source, baselineDir) {
  const report = await readReport(fs, path.resolve(baselineDir, source.path), source.path);
  if (report.error) return { origin: 'source', error: report.error };
  try {
    return { origin: 'source', value: extract(source, report.text) };
  } catch (cause) {
    if (!(cause instanceof ExtractorError)) throw cause;
    return { origin: 'source', error: { code: cause.code, params: cause.params } };
  }
}

/**
 * Lê o texto de um relatório, ou devolve o motivo pelo qual não foi possível.
 * @param {FileSystem} fs
 * @param {string} reportPath caminho resolvido
 * @param {string} shownPath caminho tal como está no baseline, para as mensagens
 * @returns {Promise<{text: string, error?: undefined} | {text?: undefined, error: Issue}>}
 */
async function readReport(fs, reportPath, shownPath) {
  if (!(await fs.exists(reportPath))) {
    return { error: { code: 'report_not_found', params: { path: shownPath } } };
  }
  try {
    return { text: await fs.readText(reportPath) };
  } catch (cause) {
    const params = { path: shownPath, reason: reasonOf(cause) };
    return { error: { code: 'file_unreadable', params } };
  }
}

/**
 * @param {unknown} cause
 * @returns {string}
 */
function reasonOf(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}
