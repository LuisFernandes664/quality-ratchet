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
  movedSources,
  resolveContract,
  shouldBypass,
} from './governance.js';
import { ownValue } from './guards.js';
import { tightenBaseline } from './tighten.js';

/** @typedef {import('./types.js').Baseline} Baseline */
/** @typedef {import('./types.js').Measurement} Measurement */
/** @typedef {import('./types.js').Report} Report */
/** @typedef {import('./types.js').Decision} Decision */
/** @typedef {import('./types.js').Outcome} Outcome */

/**
 * Medição de uma métrica cuja source o PR mudou, quando a source do ramo base não foi
 * medida (o chamador não passou `baseMeasurements`).
 * @type {Measurement}
 */
const UNMEASURED = Object.freeze({
  origin: 'source',
  error: Object.freeze({ code: 'source_changed_unmeasured', params: Object.freeze({}) }),
});

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
 * @property {Record<string, Measurement>} measurements medições com as sources do PR
 * @property {Record<string, Measurement>} [baseMeasurements] medições com as sources do
 *   ramo base, para as métricas cuja source o PR mudou ou retirou (ver collectMeasurements)
 * @property {string[]} [untracked] métricas medidas que o baseline não segue
 * @property {{title?: string, labels?: string[]}} [context] dados do PR, se houver
 * @property {RatchetOptions} [options]
 */

/**
 * Corre a catraca. A comparação e o baseline apertado usam o mesmo contrato efectivo:
 * quando o afrouxamento não foi autorizado, o baseline sugerido parte da versão mais
 * exigente (a que o PR tem de ter para passar), e não do baseline do PR.
 * @param {RatchetInput} input
 * @returns {Report}
 */
export function runRatchet(input) {
  const { head, context = {}, options = {} } = input;
  const governance = governBaseline(input.base, head, context.title, options);
  const measurements = contractMeasurements(input, governance.contract);
  const outcome = compareAll(governance.contract, measurements, { strict: options.strict });
  const passed = outcome.passed && !governance.blocked;
  const bypass = decideBypass(passed, context.labels, options.bypassLabel);
  const { frozenAt } = options;
  const tightening = tightenBaseline(governance.contract, measurements, { frozenAt });
  return assembleReport(input, governance, { outcome, bypass, passed, tightening });
}

/**
 * Junta o resultado de cada passo no relatório final.
 * @param {RatchetInput} input
 * @param {Governance} governance
 * @param {{outcome: Outcome, bypass: Decision, passed: boolean,
 *   tightening: {baseline: Baseline, tightened: string[]}}} steps
 * @returns {Report}
 */
function assembleReport(input, governance, { outcome, bypass, passed, tightening }) {
  const contracted = new Set(governance.contract.metrics.map((rule) => rule.name));
  return {
    ...governance.report,
    outcome,
    bypass,
    passed,
    ok: passed || bypass.granted,
    newBaseline: tightening.baseline,
    tightened: tightening.tightened,
    untracked: (input.untracked ?? []).filter((name) => !contracted.has(name)),
    warnings: input.head.warnings,
    frozenAt: input.head.frozenAt,
  };
}

/**
 * Medições que correspondem ao contrato. Quando o contrato mantém a source do ramo base
 * numa métrica cuja source o PR mudou ou retirou, o valor tem de vir dessa source e não da
 * do PR; sem essa medição, a métrica fica em falta com o motivo, em vez de mostrar um
 * valor lido de outro relatório.
 * @param {RatchetInput} input
 * @param {Baseline} contract
 * @returns {Record<string, Measurement>}
 */
function contractMeasurements(input, contract) {
  if (contract === input.head || !input.base) return input.measurements;
  const fromBase = input.baseMeasurements ?? {};
  const replaced = movedSources(input.base, input.head)
    .map((rule) => [rule.name, ownValue(fromBase, rule.name) ?? UNMEASURED]);
  return { ...input.measurements, ...Object.fromEntries(replaced) };
}

/**
 * @typedef {object} Governance
 * @property {Baseline} contract contrato efectivo
 * @property {boolean} blocked o PR afrouxa o baseline sem autorização
 * @property {Pick<Report, 'changes'|'loosened'|'authorisation'|'loosenable'|'governed'>} report
 */

/**
 * Compara o baseline do PR com o do ramo base e decide o contrato efectivo.
 * @param {Baseline|null} base
 * @param {Baseline} head
 * @param {string|undefined} title
 * @param {RatchetOptions} options
 * @returns {Governance}
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
    report: { changes, loosened, authorisation, loosenable: pattern !== '', governed: !!base },
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
