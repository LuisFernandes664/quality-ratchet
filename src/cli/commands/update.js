// @ts-check
/**
 * Comando `update`: fixa no ficheiro do baseline as melhorias medidas. Por omissão só
 * aperta; `--allow-lower` recongela todos os valores, incluindo regressões, e só deve ser
 * usado quando a descida do baseline foi decidida.
 */
import { serializeBaseline } from '../../core/baseline.js';
import { ownValue } from '../../core/guards.js';
import { toNumber } from '../../core/measurements.js';
import { formatNumber } from '../../core/summary.js';
import { rebaseline, tightenBaseline } from '../../core/tighten.js';
import { collectMeasurements, loadBaseline } from '../../run.js';
import { flagOption, stringOption } from '../args.js';
import { baselineDir, logIssues, warnUntracked, writeJson } from '../context.js';
import { DEFAULTS, EXIT } from '../defaults.js';

/** @typedef {import('../../core/types.js').Baseline} Baseline */
/** @typedef {import('../../core/types.js').Measurement} Measurement */
/** @typedef {import('../context.js').CommandContext} CommandContext */
/** @typedef {import('../args.js').OptionValues} OptionValues */

/**
 * Actualiza o baseline com as medições e escreve-o, se algo mudou.
 * @param {CommandContext} ctx
 * @param {OptionValues} values
 * @returns {Promise<number>}
 */
export async function runUpdate(ctx, values) {
  const baselinePath = stringOption(values, 'baseline', DEFAULTS.baseline);
  const output = stringOption(values, 'output', baselinePath);
  const head = await loadBaseline(ctx.fs, baselinePath, { allowEmptyValues: true });
  logIssues(ctx, 'warning', head.warnings);
  const { measurements, untracked } = await collectMeasurements(ctx.fs, head, {
    metricsPath: stringOption(values, 'metrics', DEFAULTS.metrics),
    baselineDir: baselineDir(ctx, baselinePath),
  });
  warnUnmeasured(ctx, head, measurements, untracked);
  const result = applyUpdate(head, measurements, flagOption(values, 'allow-lower'), ctx.today);
  await saveUpdate(ctx, head, result, output);
  return EXIT.ok;
}

/**
 * Escreve o baseline actualizado e descreve as alterações; sem alterações, não escreve.
 * @param {CommandContext} ctx
 * @param {Baseline} head baseline antes da actualização
 * @param {{baseline: Baseline, changed: string[]}} result
 * @param {string} output
 * @returns {Promise<void>}
 */
async function saveUpdate(ctx, head, result, output) {
  if (result.changed.length === 0) {
    ctx.stdout(ctx.t('cli_nothing_to_update'));
    return;
  }
  await writeJson(ctx, output, serializeBaseline(result.baseline));
  const lines = describeChanges(ctx, head, result);
  ctx.stdout([...lines, ctx.t('cli_written', { path: output })].join('\n'));
}

/**
 * Aperta o baseline ou, com autorização, recongela-o.
 * @param {Baseline} head
 * @param {Record<string, Measurement>} measurements
 * @param {boolean} allowLower
 * @param {string} frozenAt
 * @returns {{baseline: Baseline, changed: string[]}}
 */
function applyUpdate(head, measurements, allowLower, frozenAt) {
  if (allowLower) {
    const { baseline, changed } = rebaseline(head, measurements, { frozenAt });
    return { baseline, changed };
  }
  const { baseline, tightened } = tightenBaseline(head, measurements, { frozenAt });
  return { baseline, changed: tightened };
}

/**
 * Avisa das métricas sem medição (com o motivo, quando o há) e das medidas que o baseline
 * não segue. As métricas sem medição mantêm o valor anterior.
 * @param {CommandContext} ctx
 * @param {Baseline} head
 * @param {Record<string, Measurement>} measurements
 * @param {string[]} untracked
 * @returns {void}
 */
function warnUnmeasured(ctx, head, measurements, untracked) {
  warnMeasurementErrors(ctx, measurements);
  const missing = head.metrics
    .filter((rule) => measuredValue(measurements, rule.name) === null)
    .map((rule) => rule.name);
  if (missing.length > 0) {
    ctx.log('warning', ctx.t('cli_update_missing', { names: missing.join(', ') }));
  }
  warnUntracked(ctx, untracked);
}

/**
 * Um aviso por métrica cuja source não foi possível medir, com o motivo.
 * @param {CommandContext} ctx
 * @param {Record<string, Measurement>} measurements
 * @returns {void}
 */
function warnMeasurementErrors(ctx, measurements) {
  for (const [name, measurement] of Object.entries(measurements)) {
    if (!measurement.error) continue;
    const detail = ctx.t(measurement.error.code, measurement.error.params);
    ctx.log('warning', ctx.t('log_failure', { name, detail }));
  }
}

/**
 * Valor numérico medido para uma métrica, ou null quando não há.
 * @param {Record<string, Measurement>} measurements
 * @param {string} name
 * @returns {number|null}
 */
function measuredValue(measurements, name) {
  const measurement = ownValue(measurements, name);
  if (!measurement || measurement.error) return null;
  return toNumber(measurement.value);
}

/**
 * Uma linha por métrica alterada, com o valor anterior e o novo.
 * @param {CommandContext} ctx
 * @param {Baseline} head
 * @param {{baseline: Baseline, changed: string[]}} result
 * @returns {string[]}
 */
function describeChanges(ctx, head, result) {
  const valueOf = (/** @type {Baseline} */ baseline, /** @type {string} */ name) => {
    const value = baseline.metrics.find((rule) => rule.name === name)?.value ?? null;
    return value === null ? ctx.t('missing_value') : formatNumber(value);
  };
  return result.changed.map((name) => (
    `- ${name}: ${valueOf(head, name)} -> ${valueOf(result.baseline, name)}`));
}
