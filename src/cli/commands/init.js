// @ts-check
/**
 * Comando `init`: cria um baseline v2 a partir de um ficheiro de métricas plano, com a
 * direcção de cada métrica dada em `--up` e `--down`.
 */
import { parseBaseline, serializeBaseline } from '../../core/baseline.js';
import { ConfigError, MetricsError } from '../../core/errors.js';
import { parseMetricsFile, toNumber } from '../../core/measurements.js';
import { readJsonFile } from '../../run.js';
import { flagOption, listOption, stringOption } from '../args.js';
import { writeJson } from '../context.js';
import { DEFAULTS, EXIT, SCHEMA_URL } from '../defaults.js';

/** @typedef {import('../../core/types.js').Baseline} Baseline */
/** @typedef {import('../../core/types.js').Direction} Direction */
/** @typedef {import('../../core/types.js').Measurement} Measurement */
/** @typedef {import('../context.js').CommandContext} CommandContext */
/** @typedef {import('../args.js').OptionValues} OptionValues */
/** @typedef {{name: string, direction: Direction}} Selection */

/**
 * Gera o baseline e escreve-o.
 * @param {CommandContext} ctx
 * @param {OptionValues} values
 * @returns {Promise<number>}
 */
export async function runInit(ctx, values) {
  const metricsPath = stringOption(values, 'metrics', undefined);
  if (!metricsPath) throw new ConfigError('config_input_required', { input: '--metrics' });
  const output = stringOption(values, 'output', DEFAULTS.baseline);
  const selection = readSelection(values);
  await ensureWritable(ctx, output, flagOption(values, 'force'));
  const raw = await readJsonFile(ctx.fs, metricsPath, MetricsError);
  const measured = parseMetricsFile(raw, metricsPath);
  const baseline = buildBaseline(selection, measured, ctx.today);
  warnIgnored(ctx, measured, selection);
  await writeJson(ctx, output, serializeBaseline(baseline));
  ctx.stdout(ctx.t('cli_written', { path: output }));
  return EXIT.ok;
}

/**
 * Métricas escolhidas e a sua direcção: primeiro as de `--up`, depois as de `--down`,
 * cada grupo pela ordem em que foi indicado.
 * @param {OptionValues} values
 * @returns {Selection[]}
 * @throws {ConfigError} init_no_metrics, ou init_metric_conflict quando uma métrica está
 *   nas duas direcções
 */
function readSelection(values) {
  const up = listOption(values, 'up');
  const down = listOption(values, 'down');
  const conflict = up.find((name) => down.includes(name));
  if (conflict !== undefined) throw new ConfigError('init_metric_conflict', { name: conflict });
  /** @type {Selection[]} */
  const selection = [
    ...up.map((name) => ({ name, direction: /** @type {Direction} */ ('up') })),
    ...down.map((name) => ({ name, direction: /** @type {Direction} */ ('down') })),
  ];
  if (selection.length === 0) throw new ConfigError('init_no_metrics');
  return selection;
}

/**
 * Recusa substituir um ficheiro existente sem `--force`.
 * @param {CommandContext} ctx
 * @param {string} output
 * @param {boolean} force
 * @returns {Promise<void>}
 * @throws {ConfigError} config_path_exists
 */
async function ensureWritable(ctx, output, force) {
  if (!force && await ctx.fs.exists(output)) {
    throw new ConfigError('config_path_exists', { path: output });
  }
}

/**
 * Constrói e valida o baseline v2 com os valores medidos.
 * @param {Selection[]} selection
 * @param {Record<string, Measurement>} measured
 * @param {string} today
 * @returns {Baseline}
 * @throws {ConfigError} init_metric_absent
 * @throws {import('../../core/errors.js').BaselineError} valor que não é numérico
 */
function buildBaseline(selection, measured, today) {
  const absent = selection.find(({ name }) => !Object.hasOwn(measured, name));
  if (absent) throw new ConfigError('init_metric_absent', { name: absent.name });
  const metrics = Object.fromEntries(selection.map(({ name, direction }) => {
    const value = measured[name].value;
    return [name, { value: toNumber(value) ?? value, direction }];
  }));
  return parseBaseline({ $schema: SCHEMA_URL, version: 2, frozen_at: today, metrics });
}

/**
 * Avisa das métricas do ficheiro que ficaram de fora por não terem direcção.
 * @param {CommandContext} ctx
 * @param {Record<string, Measurement>} measured
 * @param {Selection[]} selection
 * @returns {void}
 */
function warnIgnored(ctx, measured, selection) {
  const chosen = new Set(selection.map(({ name }) => name));
  const ignored = Object.keys(measured).filter((name) => !chosen.has(name));
  if (ignored.length === 0) return;
  ctx.log('warning', ctx.t('cli_init_ignored', { names: ignored.join(', ') }));
}
