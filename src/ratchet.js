/**
 * Lógica pura da catraca. Sem I/O, sem rede, sem process.env.
 * Tudo o que toca no GitHub vive em index.js, para isto ficar testável.
 */

/** Margem para absorver ruído de vírgula flutuante sem deixar passar regressões reais. */
const EPSILON = 1e-9;

/** Estados possíveis de uma métrica após comparação. */
export const Status = {
  REGRESSED: 'regressed',
  IMPROVED: 'improved',
  UNCHANGED: 'unchanged',
  MISSING: 'missing',
};

/**
 * Compara uma métrica contra o baseline.
 *
 * @param {string} name nome da métrica
 * @param {number|undefined} before valor no baseline
 * @param {number|undefined} after valor medido agora
 * @param {'up'|'down'} direction 'up' = só pode subir, 'down' = só pode descer
 */
function evaluate(name, before, after, direction) {
  const invalid = (v) => typeof v !== 'number' || Number.isNaN(v);

  if (invalid(after) || invalid(before)) {
    return { name, before, after, direction, status: Status.MISSING };
  }

  const delta = after - before;

  if (Math.abs(delta) <= EPSILON) {
    return { name, before, after, delta: 0, direction, status: Status.UNCHANGED };
  }

  const regressed = direction === 'down' ? delta > 0 : delta < 0;

  return {
    name,
    before,
    after,
    delta,
    direction,
    status: regressed ? Status.REGRESSED : Status.IMPROVED,
  };
}

/**
 * Corre a catraca. Uma métrica em falta conta como falha: um coletor que deixa
 * cair silenciosamente uma métrica produz verde mentiroso, que é exatamente o
 * que a catraca existe para impedir.
 *
 * @param {object} baseline conteúdo de quality-baseline.json
 * @param {object} current mapa { nomeDaMetrica: número } medido nesta execução
 */
export function compare(baseline, current) {
  const rules = baseline?.rules ?? {};
  const metrics = baseline?.metrics ?? {};
  const down = rules.monotonic_down ?? [];
  const up = rules.monotonic_up ?? [];

  if (down.length === 0 && up.length === 0) {
    throw new Error(
      'Baseline sem regras: define rules.monotonic_down e/ou rules.monotonic_up.',
    );
  }

  const results = [
    ...down.map((name) => evaluate(name, metrics[name], current?.[name], 'down')),
    ...up.map((name) => evaluate(name, metrics[name], current?.[name], 'up')),
  ];

  const regressions = results.filter((r) => r.status === Status.REGRESSED);
  const missing = results.filter((r) => r.status === Status.MISSING);

  return {
    results,
    regressions,
    missing,
    improvements: results.filter((r) => r.status === Status.IMPROVED),
    passed: regressions.length === 0 && missing.length === 0,
  };
}

/**
 * Decide se uma falha da catraca deve ser perdoada.
 *
 * Duas saídas legítimas, ambas deliberadas e visíveis no PR: baixar o baseline
 * num PR que o declara no título, ou o bypass de hotfix por label.
 */
export function shouldBypass({ title = '', labels = [], bypassLabel, lowerBaselinePattern }) {
  const label = labels.find((l) => l === bypassLabel);
  if (bypassLabel && label) {
    return { bypassed: true, reason: `label \`${label}\`` };
  }

  if (lowerBaselinePattern && new RegExp(lowerBaselinePattern, 'i').test(title)) {
    return { bypassed: true, reason: 'título do PR declara descida de baseline' };
  }

  return { bypassed: false, reason: null };
}

function formatDelta(row) {
  if (row.status === Status.MISSING) return 'em falta';
  if (row.delta === 0) return '0';
  const sign = row.delta > 0 ? '+' : '';
  return `${sign}${Number(row.delta.toFixed(4))}`;
}

const ICON = {
  [Status.REGRESSED]: 'x',
  [Status.IMPROVED]: 'ok',
  [Status.UNCHANGED]: '=',
  [Status.MISSING]: '?',
};

/**
 * Sumário em Markdown para colar no PR. Também serve de input a agentes que
 * leem o resultado do gate e corrigem o código.
 */
export function renderSummary(outcome, { bypass, frozenAt } = {}) {
  const veredicto = outcome.passed
    ? 'Catraca verde. Nenhuma métrica regrediu.'
    : `Catraca vermelha. ${outcome.regressions.length} regressão(ões), ${outcome.missing.length} métrica(s) em falta.`;

  const lines = ['## Quality ratchet', '', veredicto, ''];

  if (bypass?.bypassed) {
    lines.push(`> Falha perdoada: ${bypass.reason}.`, '');
  }

  lines.push('| | Métrica | Baseline | Agora | Delta |', '|---|---|---|---|---|');
  for (const row of outcome.results) {
    const before = typeof row.before === 'number' ? row.before : 'em falta';
    const after = typeof row.after === 'number' ? row.after : 'em falta';
    lines.push(
      `| ${ICON[row.status]} | \`${row.name}\` | ${before} | ${after} | ${formatDelta(row)} |`,
    );
  }

  if (frozenAt) {
    lines.push('', `<sub>Baseline congelado em ${frozenAt}.</sub>`);
  }

  return lines.join('\n');
}
