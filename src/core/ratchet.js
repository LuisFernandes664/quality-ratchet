// @ts-check
/**
 * Núcleo puro da catraca: recebe baselines, medições e contexto do PR e devolve o
 * relatório completo. Sem I/O, sem rede, sem process.env.
 */
import { compareAll } from './compare.js';
import {
  authoriseLowering,
  diffBaselines,
  loosenedChanges,
  resolveContract,
  shouldBypass,
} from './governance.js';
import { tightenBaseline } from './tighten.js';

/** @typedef {import('./types.js').Baseline} Baseline */
/** @typedef {import('./types.js').Measurement} Measurement */
/** @typedef {import('./types.js').Report} Report */
/** @typedef {import('./types.js').Decision} Decision */

/**
 * @typedef {object} RatchetOptions
 * @property {boolean} [strict] melhorias por fixar no baseline contam como falha
 * @property {string} [bypassLabel] label que perdoa uma falha (hotfix)
 * @property {string} [lowerBaselinePattern] padrão do título que autoriza afrouxar
 * @property {string} [frozenAt] data a gravar no baseline apertado
 */

/**
 * @typedef {object} RatchetInput
 * @property {Baseline} head baseline do checkout, o que vai ficar no ramo
 * @property {Baseline|null} base baseline do ramo base; null desliga a governação
 * @property {Record<string, Measurement>} measurements
 * @property {string[]} [untracked] métricas medidas que o baseline não segue
 * @property {{title?: string, labels?: string[]}} [context] dados do PR, se houver
 * @property {RatchetOptions} [options]
 */

/**
 * Corre a catraca.
 * @param {RatchetInput} input
 * @returns {Report}
 */
export function runRatchet(input) {
  const { head, measurements, context = {}, options = {} } = input;
  const governance = governBaseline(input.base, head, context.title, options);
  const outcome = compareAll(governance.contract, measurements, { strict: options.strict });
  const passed = outcome.passed && !governance.blocked;
  const bypass = decideBypass(passed, context.labels, options.bypassLabel);
  const tightening = tightenBaseline(head, measurements, { frozenAt: options.frozenAt });
  return {
    ...governance.report,
    outcome,
    bypass,
    passed,
    ok: passed || bypass.granted,
    newBaseline: tightening.baseline,
    tightened: tightening.tightened,
    untracked: input.untracked ?? [],
    warnings: head.warnings,
    frozenAt: head.frozenAt,
  };
}

/**
 * Compara o baseline do PR com o do ramo base e decide o contrato efectivo.
 * @param {Baseline|null} base
 * @param {Baseline} head
 * @param {string|undefined} title
 * @param {RatchetOptions} options
 * @returns {{contract: Baseline, blocked: boolean, report: Pick<Report,
 *   'changes'|'loosened'|'authorisation'|'governed'>}}
 */
function governBaseline(base, head, title, options) {
  const changes = base ? diffBaselines(base, head).filter((c) => c.kind !== 'unchanged') : [];
  const loosened = loosenedChanges(changes);
  const pattern = options.lowerBaselinePattern ?? '';
  const authorisation = authoriseLowering({ title, pattern });
  const granted = loosened.length > 0 && authorisation.granted;
  return {
    contract: resolveContract(base, head, granted),
    blocked: loosened.length > 0 && !granted,
    report: { changes, loosened, authorisation, governed: base !== null },
  };
}

/**
 * O perdão só é avaliado quando há falha, para não aparecer em execuções verdes.
 * @param {boolean} passed
 * @param {string[]|undefined} labels
 * @param {string|undefined} bypassLabel
 * @returns {Decision}
 */
function decideBypass(passed, labels, bypassLabel) {
  if (passed) return { granted: false, reason: null };
  return shouldBypass({ labels, bypassLabel: bypassLabel ?? '' });
}

export { Status, compareAll, evaluate } from './compare.js';
export { parseBaseline, serializeBaseline, migrateToV2 } from './baseline.js';
export { tightenBaseline, rebaseline } from './tighten.js';
