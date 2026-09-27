// @ts-check
/**
 * Comando `migrate`: converte um baseline v1 (números e listas de regras) para o formato
 * v2 (um objecto por métrica), que aceita tolerância, limites e sources.
 */
import { migrateToV2, serializeBaseline } from '../../core/baseline.js';
import { loadBaseline } from '../../run.js';
import { stringOption } from '../args.js';
import { logIssues, writeJson } from '../context.js';
import { DEFAULTS, EXIT, SCHEMA_URL } from '../defaults.js';

/** @typedef {import('../context.js').CommandContext} CommandContext */
/** @typedef {import('../args.js').OptionValues} OptionValues */

/**
 * Converte o baseline e escreve-o. Os valores v1 sem regra não têm direcção e não podem
 * ser migrados: são descartados, com aviso.
 * @param {CommandContext} ctx
 * @param {OptionValues} values
 * @returns {Promise<number>}
 */
export async function runMigrate(ctx, values) {
  const baselinePath = stringOption(values, 'baseline', DEFAULTS.baseline);
  const output = stringOption(values, 'output', baselinePath);
  const head = await loadBaseline(ctx.fs, baselinePath, { allowEmptyValues: true });
  const others = head.warnings.filter((issue) => issue.code !== 'metric_without_rule');
  logIssues(ctx, 'warning', others);
  const { baseline, dropped } = migrateToV2(head);
  if (dropped.length > 0) {
    ctx.log('warning', ctx.t('cli_migrate_dropped', { names: dropped.join(', ') }));
  }
  const schema = baseline.schema ?? SCHEMA_URL;
  await writeJson(ctx, output, serializeBaseline({ ...baseline, schema }));
  ctx.stdout(ctx.t('cli_written', { path: output }));
  return EXIT.ok;
}
