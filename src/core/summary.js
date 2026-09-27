// @ts-check
/**
 * Apresentação do relatório: sumário em Markdown para o PR e mensagens de log. O sumário
 * também serve de input a quem lê o resultado do gate e corrige o código.
 */
import { serializeBaseline } from './baseline.js';
import { Status } from './compare.js';

/** @typedef {import('./types.js').Report} Report */
/** @typedef {import('./types.js').MetricResult} MetricResult */
/** @typedef {import('./types.js').BaselineChange} BaselineChange */
/** @typedef {import('./types.js').Issue} Issue */
/** @typedef {import('./messages.js').Translator} Translator */

/** Ícone de cada estado na tabela. */
const ICON = Object.freeze({
  [Status.IMPROVED]: '✅',
  [Status.UNCHANGED]: '➖',
  [Status.TOLERATED]: '🟡',
  [Status.REGRESSED]: '❌',
  [Status.MISSING]: '❓',
  [Status.INVALID]: '⚠️',
  [Status.LIMIT]: '⛔',
});

/**
 * @typedef {object} SummaryOptions
 * @property {string} [name] nome desta catraca, quando há várias no mesmo repositório
 * @property {Issue[]} [notes] notas extra do chamador (ex: baseline do ramo base em falta)
 */

/**
 * Sumário completo em Markdown.
 * @param {Report} report
 * @param {Translator} t
 * @param {SummaryOptions} [options]
 * @returns {string}
 */
export function renderSummary(report, t, { name = '', notes = [] } = {}) {
  const sections = [
    `## ${t('title', { name })}`,
    verdict(report, t),
    ...renderNotes(report, notes, t),
    renderTable(report.outcome.results, t),
    renderDetails(report, t),
    renderChanges(report.changes, t),
    renderWarnings(report, t),
    renderNewBaseline(report, t),
    report.frozenAt ? `<sub>${t('footer_frozen', { date: report.frozenAt })}</sub>` : '',
  ];
  return sections.filter(Boolean).join('\n\n');
}

/**
 * @param {Report} report
 * @param {Translator} t
 * @returns {string}
 */
function verdict(report, t) {
  if (report.passed) return `**${t('verdict_passed')}**`;
  return `**${t('verdict_failed', verdictParams(report))}**`;
}

/**
 * Notas visíveis sobre perdões, autorizações e governação.
 * @param {Report} report
 * @param {Issue[]} extra
 * @param {Translator} t
 * @returns {string[]}
 */
function renderNotes(report, extra, t) {
  /** @type {Issue[]} */
  const notes = [...extra];
  const reasonOf = (/** @type {Issue|null} */ reason) => (
    reason ? t(reason.code, reason.params) : '');
  if (report.loosened.length > 0 && report.authorisation.granted) {
    const reason = reasonOf(report.authorisation.reason);
    notes.push(note('note_loosen_authorised', { reason }));
  } else if (report.loosened.length > 0) {
    notes.push(note('note_loosen_unauthorised', { names: codeList(report.loosened) }));
  }
  if (!report.passed && report.bypass.granted) {
    notes.push(note('note_bypassed', { reason: reasonOf(report.bypass.reason) }));
  }
  return notes.map((item) => `> ${t(item.code, item.params)}`);
}

/**
 * @param {string} code
 * @param {Record<string, unknown>} params
 * @returns {Issue}
 */
function note(code, params) {
  return { code, params };
}

/**
 * Tabela com todas as métricas comparadas.
 * @param {MetricResult[]} results
 * @param {Translator} t
 * @returns {string}
 */
function renderTable(results, t) {
  const withTarget = results.some((row) => row.target !== undefined);
  const columns = ['col_metric', 'col_baseline', 'col_now', 'col_delta'];
  if (withTarget) columns.push('col_target');
  const header = `| | ${columns.map((column) => t(column)).join(' | ')} |`;
  const divider = `|---|${columns.map(() => '---').join('|')}|`;
  const rows = results.map((row) => renderRow(row, withTarget, t));
  return [header, divider, ...rows].join('\n');
}

/**
 * @param {MetricResult} row
 * @param {boolean} withTarget
 * @param {Translator} t
 * @returns {string}
 */
function renderRow(row, withTarget, t) {
  const missing = t('missing_value');
  const cells = [
    ICON[row.status],
    `\`${row.name}\``,
    row.before === null ? missing : formatNumber(row.before),
    row.after === null ? missing : formatNumber(row.after),
    formatDelta(row),
  ];
  if (withTarget) cells.push(row.target === undefined ? '' : formatNumber(row.target));
  return `| ${cells.join(' | ')} |`;
}

/**
 * Delta com sinal, e a tolerância quando a regressão foi tolerada.
 * @param {MetricResult} row
 * @returns {string}
 */
function formatDelta(row) {
  if (row.delta === null) return '';
  if (row.delta === 0) return '0';
  const sign = row.delta > 0 ? '+' : '';
  const delta = `${sign}${formatNumber(row.delta)}`;
  if (row.status !== Status.TOLERATED) return delta;
  return `${delta} (±${formatNumber(row.tolerance)})`;
}

/**
 * Número com no máximo quatro casas decimais, sem zeros à direita.
 * @param {number} value
 * @returns {string}
 */
export function formatNumber(value) {
  return String(Number(value.toFixed(4)));
}

/**
 * Explicação de cada métrica em falha e das melhorias por fixar.
 * @param {Report} report
 * @param {Translator} t
 * @returns {string}
 */
function renderDetails(report, t) {
  const lines = report.outcome.results
    .filter((row) => row.detail)
    .map((row) => `- \`${row.name}\`: ${t(row.detail?.code ?? '', row.detail?.params)}`);
  if (report.outcome.unlocked.length > 0) {
    lines.push(`- ${t('unlocked_hint', { names: codeList(report.outcome.unlocked) })}`);
  }
  return lines.join('\n');
}

/**
 * Alterações ao baseline feitas pelo PR.
 * @param {BaselineChange[]} changes
 * @param {Translator} t
 * @returns {string}
 */
function renderChanges(changes, t) {
  if (changes.length === 0) return '';
  const rows = changes.map((item) => {
    const fields = [...item.loosenedFields, ...item.tightenedFields].join(', ');
    return `| \`${item.name}\` | ${t(`change_${item.kind}`)} | ${fields} |`;
  });
  const header = `| ${t('col_metric')} | ${t('col_change')} | ${t('col_fields')} |`;
  return [`### ${t('section_changes')}`, '', header, '|---|---|---|', ...rows].join('\n');
}

/**
 * Avisos do baseline e métricas medidas que o baseline não segue.
 * @param {Report} report
 * @param {Translator} t
 * @returns {string}
 */
function renderWarnings(report, t) {
  const lines = report.warnings.map((item) => `- ${t(item.code, item.params)}`);
  if (report.untracked.length > 0) {
    const names = report.untracked.map((name) => `\`${name}\``).join(', ');
    lines.push(`- ${t('warning_untracked', { names })}`);
  }
  if (lines.length === 0) return '';
  return [`### ${t('section_warnings')}`, '', ...lines].join('\n');
}

/**
 * Baseline actualizado, pronto a copiar, quando há melhorias por fixar.
 * @param {Report} report
 * @param {Translator} t
 * @returns {string}
 */
function renderNewBaseline(report, t) {
  const count = report.tightened.length;
  if (count === 0) return '';
  const json = JSON.stringify(serializeBaseline(report.newBaseline), null, 2);
  return [
    `<details><summary>${t('new_baseline_title', { count })}</summary>`,
    '',
    t('new_baseline_hint'),
    '',
    '```json',
    json,
    '```',
    '</details>',
  ].join('\n');
}

/**
 * Nomes formatados como código, separados por vírgulas.
 * @param {Array<{name: string}>} items
 * @returns {string}
 */
function codeList(items) {
  return items.map((item) => `\`${item.name}\``).join(', ');
}

/**
 * @typedef {object} LogEntry
 * @property {'error'|'warning'|'notice'} level
 * @property {string} text
 */

/**
 * Mensagens de log para o runner ou para a consola, uma por problema.
 * @param {Report} report
 * @param {Translator} t
 * @returns {LogEntry[]}
 */
export function reportLogEntries(report, t) {
  /** @type {LogEntry[]} */
  const entries = report.outcome.failures.map((row) => ({
    level: 'error',
    text: failureText(row, t),
  }));
  for (const row of report.outcome.unlocked) {
    entries.push({ level: 'error', text: t('log_unlocked', numbers(row)) });
  }
  if (report.loosened.length > 0 && !report.authorisation.granted) {
    const names = codeList(report.loosened);
    entries.push({ level: 'error', text: t('note_loosen_unauthorised', { names }) });
  }
  if (report.tightened.length > 0) {
    const names = report.tightened.join(', ');
    entries.push({ level: 'notice', text: t('log_tightened', { names }) });
  }
  entries.push(closingEntry(report, t));
  return entries;
}

/**
 * @param {MetricResult} row
 * @param {Translator} t
 * @returns {string}
 */
function failureText(row, t) {
  if (row.status === Status.REGRESSED) return t('log_regressed', numbers(row));
  const detail = row.detail ? t(row.detail.code, row.detail.params) : row.status;
  return t('log_failure', { name: row.name, detail });
}

/**
 * @param {MetricResult} row
 * @returns {{name: string, before: string, after: string}}
 */
function numbers(row) {
  const show = (/** @type {number|null} */ value) => (value === null ? '?' : formatNumber(value));
  return { name: row.name, before: show(row.before), after: show(row.after) };
}

/**
 * Mensagem final: verde, perdoado, ou nada a acrescentar aos erros já emitidos.
 * @param {Report} report
 * @param {Translator} t
 * @returns {LogEntry}
 */
function closingEntry(report, t) {
  if (report.passed) return { level: 'notice', text: t('log_passed') };
  if (report.bypass.granted && report.bypass.reason) {
    const reason = t(report.bypass.reason.code, report.bypass.reason.params);
    return { level: 'warning', text: t('log_bypassed', { reason }) };
  }
  return { level: 'error', text: t('verdict_failed', verdictParams(report)) };
}

/**
 * @param {Report} report
 * @returns {{failures: number, unlocked: number, loosened: number}}
 */
function verdictParams(report) {
  return {
    failures: report.outcome.failures.length,
    unlocked: report.outcome.unlocked.length,
    loosened: report.authorisation.granted ? 0 : report.loosened.length,
  };
}
