// @ts-check
/**
 * Comando `update`: fixa no ficheiro do baseline as melhorias medidas. Por omissão só
 * aperta; `--allow-lower` recongela todos os valores, incluindo regressões, e só deve ser
 * usado quando a descida do baseline foi decidida.
 */
import { serializeBaseline } from '../../core/baseline.js';
import { exceedsTolerance, isBetter } from '../../core/compare.js';
import { ownValue } from '../../core/guards.js';
import { toNumber } from '../../core/measurements.js';
import { formatNumbers } from '../../core/summary.js';
import { rebaseline, tightenBaseline } from '../../core/tighten.js';
import { collectMeasurements, loadBaseline } from '../../run.js';
import { flagOption, nonEmptyOption } from '../args.js';
import { baselineDir, logIssues, warnUntracked, writeJson } from '../context.js';
import { DEFAULTS, EXIT } from '../defaults.js';

/** @typedef {import('../../core/types.js').Baseline} Baseline */
/** @typedef {import('../../core/types.js').Measurement} Measurement */
/** @typedef {import('../../core/messages.js').Translator} Translator */
/** @typedef {import('../context.js').CommandContext} CommandContext */
/** @typedef {import('../args.js').OptionValues} OptionValues */

/**
 * Resultado da actualização.
 * @typedef {object} UpdateResult
 * @property {Baseline} baseline baseline actualizado
 * @property {string[]} changed métricas cujo valor mudou
 * @property {string} unchanged código da mensagem a mostrar quando nada mudou
 */

/**
 * Caminhos usados pelo comando.
 * @typedef {object} UpdatePaths
 * @property {string} baseline baseline a ler
 * @property {string} metrics ficheiro de métricas plano
 * @property {string} output onde escrever o baseline actualizado
 */

/**
 * Actualiza o baseline com as medições e escreve-o, se algo mudou. Sem `--allow-lower` as
 * regressões não descem o baseline e são listadas num aviso, porque o check vai falhar.
 * @param {CommandContext} ctx
 * @param {OptionValues} values
 * @returns {Promise<number>}
 * @throws {import('../../core/errors.js').ConfigError} config_input_required (caminho vazio)
 */
export async function runUpdate(ctx, values) {
  const paths = readPaths(values);
  const allowLower = flagOption(values, 'allow-lower');
  const head = await loadBaseline(ctx.fs, paths.baseline, { allowEmptyValues: true });
  logIssues(ctx, 'warning', head.warnings);
  const { measurements, untracked } = await collectMeasurements(ctx.fs, head, {
    metricsPath: paths.metrics,
    baselineDir: baselineDir(ctx, paths.baseline),
  });
  warnUnmeasured(ctx, head, measurements, untracked);
  if (!allowLower) warnNotLowered(ctx, head, measurements);
  const result = applyUpdate(head, measurements, allowLower, ctx.today);
  await saveUpdate(ctx, head, result, paths.output);
  return EXIT.ok;
}

/**
 * Lê os caminhos antes de qualquer leitura ou escrita, para que um caminho vazio falhe
 * logo. A saída é, por omissão, o próprio baseline.
 * @param {OptionValues} values
 * @returns {UpdatePaths}
 * @throws {import('../../core/errors.js').ConfigError} config_input_required
 */
function readPaths(values) {
  const baseline = nonEmptyOption(values, 'baseline', DEFAULTS.baseline);
  const metrics = nonEmptyOption(values, 'metrics', DEFAULTS.metrics);
  return { baseline, metrics, output: nonEmptyOption(values, 'output', baseline) };
}

/**
 * Escreve o baseline actualizado e descreve as alterações; sem alterações, não escreve.
 * @param {CommandContext} ctx
 * @param {Baseline} head baseline antes da actualização
 * @param {UpdateResult} result
 * @param {string} output
 * @returns {Promise<void>}
 */
async function saveUpdate(ctx, head, result, output) {
  if (result.changed.length === 0) {
    ctx.stdout(ctx.t(result.unchanged));
    return;
  }
  await writeJson(ctx, output, serializeBaseline(result.baseline));
  const lines = describeChanges(ctx, head, result);
  ctx.stdout([...lines, ctx.t('cli_written', { path: output })].join('\n'));
}

/**
 * Aperta o baseline ou, com autorização, recongela-o. Sem alterações, a mensagem diz o que
 * é verdade em cada caso: ao apertar, que nenhuma métrica melhorou além da tolerância (pode
 * haver regressões); ao recongelar, que o baseline já corresponde às medições.
 * @param {Baseline} head
 * @param {Record<string, Measurement>} measurements
 * @param {boolean} allowLower
 * @param {string} frozenAt
 * @returns {UpdateResult}
 */
function applyUpdate(head, measurements, allowLower, frozenAt) {
  if (allowLower) {
    const { baseline, changed } = rebaseline(head, measurements, { frozenAt });
    return { baseline, changed, unchanged: 'cli_nothing_to_rebaseline' };
  }
  const { baseline, tightened } = tightenBaseline(head, measurements, { frozenAt });
  return { baseline, changed: tightened, unchanged: 'cli_nothing_to_update' };
}

/**
 * Avisa das métricas medidas piores do que o baseline além da tolerância. Sem
 * `--allow-lower` o update não as desce, e o check vai falhar até recuperarem: dizer só
 * que não há nada a apertar esconderia isso. As métricas sem medição têm o seu próprio
 * aviso, e as regressões toleradas passam no check.
 * @param {CommandContext} ctx
 * @param {Baseline} head
 * @param {Record<string, Measurement>} measurements
 * @returns {void}
 */
function warnNotLowered(ctx, head, measurements) {
  const names = head.metrics.flatMap((rule) => {
    const after = measuredValue(measurements, rule.name);
    const before = rule.value;
    if (before === null || after === null || !regressed(rule, before, after)) return [];
    const [shownBefore, shownAfter] = formatNumbers([before, after]);
    return [`${rule.name} (${shownBefore} -> ${shownAfter})`];
  });
  if (names.length === 0) return;
  ctx.log('warning', ctx.t('cli_update_not_lowered', { names: names.join(', ') }));
}

/**
 * Indica se o valor medido é pior do que o do baseline além da tolerância.
 * @param {import('../../core/types.js').MetricRule} rule
 * @param {number} before valor do baseline
 * @param {number} after valor medido
 * @returns {boolean}
 */
function regressed(rule, before, after) {
  const worse = isBetter(rule.direction, before, after);
  return worse && exceedsTolerance(after - before, rule.tolerance);
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
  return result.changed.map((name) => {
    const [before, after] = formatPair(ctx.t, valueOf(head, name), valueOf(result.baseline, name));
    return `- ${name}: ${before} -> ${after}`;
  });
}

/**
 * Valor de uma métrica no baseline, ou null quando está vazio.
 * @param {Baseline} baseline
 * @param {string} name
 * @returns {number|null}
 */
function valueOf(baseline, name) {
  return baseline.metrics.find((rule) => rule.name === name)?.value ?? null;
}

/**
 * Valor anterior e novo com as mesmas casas decimais, para que valores diferentes não
 * pareçam iguais (ex: 0.81234 e 0.81231); um valor vazio aparece como tal.
 * @param {Translator} t
 * @param {number|null} before
 * @param {number|null} after
 * @returns {string[]}
 */
function formatPair(t, before, after) {
  const pair = [before, after];
  const texts = formatNumbers(pair.flatMap((value) => (value === null ? [] : [value])));
  return pair.map((value) => (value === null ? t('missing_value') : String(texts.shift())));
}
