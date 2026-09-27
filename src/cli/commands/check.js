// @ts-check
/**
 * Comando `check`: corre a catraca sobre o baseline e as métricas, com governação opcional
 * contra o baseline de outra revisão git (ex: o ramo de destino de um merge request).
 */
import { parseBaseline, serializeBaseline } from '../../core/baseline.js';
import { BaselineError, ConfigError } from '../../core/errors.js';
import { describeError } from '../../core/messages.js';
import { runRatchet } from '../../core/ratchet.js';
import { renderSummary, reportLogEntries } from '../../core/summary.js';
import { collectMeasurements, loadBaseline, parseJsonText } from '../../run.js';
import { flagOption, listOption, nonEmptyOption, stringOption } from '../args.js';
import { baselineDir, logIssues, warnUntracked, writeJson } from '../context.js';
import { DEFAULTS, EXIT, OUTPUT_FORMATS } from '../defaults.js';

/** @typedef {import('../../core/types.js').Baseline} Baseline */
/** @typedef {import('../../core/types.js').Issue} Issue */
/** @typedef {import('../../core/types.js').Report} Report */
/** @typedef {import('../../core/messages.js').Translator} Translator */
/** @typedef {import('../context.js').CommandContext} CommandContext */
/** @typedef {import('../args.js').OptionValues} OptionValues */
/** @typedef {{base: Baseline|null, notes: Issue[]}} BaseContract */

/**
 * @typedef {object} CheckOptions
 * @property {string} baseline caminho do baseline
 * @property {string} metrics caminho do ficheiro de métricas plano
 * @property {string} [baseRef] revisão git cujo baseline é o contrato
 * @property {string} [title] título do pull request
 * @property {string[]} labels labels do pull request
 * @property {string} bypassLabel
 * @property {string} lowerBaselinePattern
 * @property {boolean} strict
 * @property {string} name
 * @property {string} format 'markdown' ou 'json'
 * @property {string} [writeBaseline] onde escrever o baseline apertado
 */

/**
 * Corre a catraca e imprime o sumário (stdout) e as mensagens de log (stderr).
 * @param {CommandContext} ctx
 * @param {OptionValues} values
 * @returns {Promise<number>} 0 verde ou perdoado, 1 a catraca falhou
 */
export async function runCheck(ctx, values) {
  const options = readCheckOptions(values);
  const head = await loadBaseline(ctx.fs, options.baseline);
  const { base, notes } = await loadBaseBaseline(ctx, options);
  const collected = await collectMeasurements(ctx.fs, head, {
    metricsPath: options.metrics,
    baselineDir: baselineDir(ctx, options.baseline),
  });
  const report = runRatchet({ head, base, ...collected, ...ratchetSettings(options, ctx.today) });
  ctx.stdout(renderReport(report, options, notes, ctx.t));
  logReport(ctx, report);
  await writeTightened(ctx, report, options.writeBaseline);
  return report.ok ? EXIT.ok : EXIT.failed;
}

/**
 * Mensagens de log no stderr: avisos do baseline, métricas medidas que ele não segue e o
 * resultado. Os avisos vão sempre para o log, porque com `--format json` (ou com o sumário
 * redireccionado para um ficheiro) uma gralha como `tolerence` ficaria invisível.
 * @param {CommandContext} ctx
 * @param {Report} report
 * @returns {void}
 */
function logReport(ctx, report) {
  logIssues(ctx, 'warning', report.warnings);
  warnUntracked(ctx, report.untracked);
  for (const entry of reportLogEntries(report, ctx.t)) ctx.log(entry.level, entry.text);
}

/**
 * Lê as opções do comando, com os valores por omissão partilhados com a action. Os caminhos
 * e a revisão não aceitam valores vazios: um `--base-ref` vazio (ex: variável de CI por
 * definir fora de um merge request) seguiria sem governação e esconderia que o pedido não
 * foi cumprido.
 * @param {OptionValues} values
 * @returns {CheckOptions}
 * @throws {ConfigError} config_input_required ou config_format_unsupported
 */
function readCheckOptions(values) {
  return {
    baseline: nonEmptyOption(values, 'baseline', DEFAULTS.baseline),
    metrics: nonEmptyOption(values, 'metrics', DEFAULTS.metrics),
    baseRef: nonEmptyOption(values, 'base-ref', undefined),
    title: stringOption(values, 'title', undefined),
    labels: listOption(values, 'labels'),
    bypassLabel: stringOption(values, 'bypass-label', DEFAULTS.bypassLabel),
    lowerBaselinePattern: stringOption(values, 'lower-baseline-pattern',
      DEFAULTS.lowerBaselinePattern),
    strict: flagOption(values, 'strict'),
    name: stringOption(values, 'name', ''),
    format: readFormat(values),
    writeBaseline: nonEmptyOption(values, 'write-baseline', undefined),
  };
}

/**
 * Formato de saída pedido, validado.
 * @param {OptionValues} values
 * @returns {string}
 * @throws {ConfigError} config_format_unsupported
 */
function readFormat(values) {
  const format = stringOption(values, 'format', DEFAULTS.format);
  if (OUTPUT_FORMATS.includes(format)) return format;
  throw new ConfigError('config_format_unsupported', {
    format,
    supported: OUTPUT_FORMATS.join(', '),
  });
}

/**
 * Contexto do PR e opções da catraca, no formato de `runRatchet`.
 * @param {CheckOptions} options
 * @param {string} frozenAt data a gravar no baseline apertado
 * @returns {Pick<import('../../core/ratchet.js').RatchetInput, 'context'|'options'>}
 */
function ratchetSettings(options, frozenAt) {
  const { title, labels, strict, bypassLabel, lowerBaselinePattern } = options;
  return {
    context: { title, labels },
    options: { strict, bypassLabel, lowerBaselinePattern, frozenAt },
  };
}

/**
 * Baseline da revisão indicada em `--base-ref`, o contrato que o PR não pode afrouxar.
 * Sem `--base-ref` não há governação. Sem baseline nessa revisão (ex: é o PR que o cria),
 * a governação fica desligada nesta execução, com aviso e nota no sumário. As outras
 * falhas do git (ex: objecto em falta num clone parcial) propagam como erro: a governação
 * não se desliga em silêncio.
 * @param {CommandContext} ctx
 * @param {CheckOptions} options
 * @returns {Promise<BaseContract>}
 */
async function loadBaseBaseline(ctx, options) {
  const ref = options.baseRef;
  if (ref === undefined) return { base: null, notes: [] };
  const text = await ctx.git.show(ref, options.baseline, ctx.cwd);
  if (text === null) return ungoverned(ctx, 'note_base_missing', { path: options.baseline });
  return parseBaseBaseline(ctx, text, `${ref}:${options.baseline}`);
}

/**
 * Interpreta o baseline da revisão base. O PR não consegue alterar esse ficheiro: se
 * estiver inválido, falhar bloquearia todos os PRs, incluindo o que o corrige. Como na
 * action, a governação fica desligada com aviso e nota no sumário.
 * @param {CommandContext} ctx
 * @param {string} text conteúdo do ficheiro na revisão base
 * @param {string} label `<revisão>:<caminho>`, para as mensagens
 * @returns {BaseContract}
 */
function parseBaseBaseline(ctx, text, label) {
  try {
    return { base: parseBaseline(parseJsonText(text, label, BaselineError)), notes: [] };
  } catch (error) {
    if (!(error instanceof BaselineError)) throw error;
    const reason = oneLine(describeError(error, ctx.t));
    return ungoverned(ctx, 'note_base_invalid', { reason });
  }
}

/**
 * Governação desligada nesta execução: aviso no log e a mesma nota no sumário.
 * @param {CommandContext} ctx
 * @param {string} code
 * @param {Record<string, unknown>} params
 * @returns {BaseContract}
 */
function ungoverned(ctx, code, params) {
  ctx.log('warning', ctx.t(code, params));
  return { base: null, notes: [{ code, params }] };
}

/**
 * Junta um texto de várias linhas numa só, para caber numa nota ou linha de log.
 * @param {string} text
 * @returns {string}
 */
function oneLine(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
}

/**
 * Resultado no formato pedido: sumário em Markdown ou relatório JSON.
 * @param {Report} report
 * @param {CheckOptions} options
 * @param {Issue[]} notes
 * @param {Translator} t
 * @returns {string}
 */
function renderReport(report, options, notes, t) {
  if (options.format === 'json') return JSON.stringify(jsonReport(report), null, 2);
  return renderSummary(report, t, { name: options.name, notes });
}

/**
 * Relatório para consumo por outras ferramentas.
 * @param {Report} report
 * @returns {Record<string, unknown>}
 */
function jsonReport(report) {
  return {
    passed: report.passed,
    ok: report.ok,
    bypassed: report.bypass.granted,
    results: report.outcome.results,
    failures: report.outcome.failures,
    loosened: report.loosened.map((change) => change.name),
    tightened: report.tightened,
    newBaseline: serializeBaseline(report.newBaseline),
  };
}

/**
 * Escreve o baseline apertado quando `--write-baseline` foi dado e há melhorias a fixar.
 * @param {CommandContext} ctx
 * @param {Report} report
 * @param {string|undefined} target
 * @returns {Promise<void>}
 */
async function writeTightened(ctx, report, target) {
  if (target === undefined || report.tightened.length === 0) return;
  await writeJson(ctx, target, serializeBaseline(report.newBaseline));
  ctx.log('notice', ctx.t('log_baseline_written', { path: target }));
}
