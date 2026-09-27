// @ts-check
/**
 * Apresentação do relatório: sumário em Markdown para o PR e mensagens de log. O sumário
 * também serve de input a quem lê o resultado do gate e corrige o código.
 */
import { serializeBaseline } from './baseline.js';
import { EPSILON, Status } from './compare.js';
import { codeSpan, oneLine, tableCode } from './markdown.js';

/** @typedef {import('./types.js').Report} Report */
/** @typedef {import('./types.js').MetricResult} MetricResult */
/** @typedef {import('./types.js').BaselineChange} BaselineChange */
/** @typedef {import('./types.js').Issue} Issue */
/** @typedef {import('./messages.js').Translator} Translator */

/** Casas decimais dos números apresentados, quando chegam para os distinguir. */
const DECIMALS = 4;

/** Máximo de casas decimais para distinguir valores muito próximos. */
const MAX_DECIMALS = 12;

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
 * Dica que acompanha, por omissão, o afrouxamento sem autorização: um checkout do último
 * commit do PR, em vez do merge commit, mostra um baseline antigo que parece afrouxado sem
 * o PR o mudar. Quem compara com outra revisão (a CLI com `--base-ref`) passa a sua.
 * @type {Issue}
 */
const CHECKOUT_HINT = Object.freeze({ code: 'note_checkout_hint', params: Object.freeze({}) });

/**
 * @typedef {object} SummaryOptions
 * @property {string} [name] nome desta catraca, quando há várias no mesmo repositório
 * @property {Issue[]} [notes] notas extra do chamador (ex: baseline do ramo base em falta)
 * @property {Issue} [hint] dica que acompanha o afrouxamento sem autorização (por omissão,
 *   a do checkout do merge commit)
 */

/**
 * Sumário completo em Markdown.
 * @param {Report} report
 * @param {Translator} t
 * @param {SummaryOptions} [options]
 * @returns {string}
 */
export function renderSummary(report, t, { name = '', notes = [], hint = CHECKOUT_HINT } = {}) {
  const sections = [
    `## ${oneLine(t('title', { name }))}`,
    verdict(report, t),
    ...renderNotes(report, notes, hint, t),
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
 * Notas visíveis sobre perdões, autorizações e governação. Cada nota fica numa só linha,
 * para um título ou um nome com quebras de linha não sair da citação.
 * @param {Report} report
 * @param {Issue[]} extra
 * @param {Issue} hint dica que acompanha o afrouxamento sem autorização
 * @param {Translator} t
 * @returns {string[]}
 */
function renderNotes(report, extra, hint, t) {
  /** @type {Issue[]} */
  const notes = [...extra];
  const reasonOf = (/** @type {Issue|null} */ reason) => (
    reason ? t(reason.code, reason.params) : '');
  if (report.loosened.length > 0 && report.authorisation.granted) {
    const reason = reasonOf(report.authorisation.reason);
    notes.push(note('note_loosen_authorised', { reason }));
  } else if (report.loosened.length > 0) {
    notes.push(unauthorisedNote(report), hint);
  }
  if (!report.passed && report.bypass.granted) {
    notes.push(note('note_bypassed', { reason: reasonOf(report.bypass.reason) }));
  }
  return notes.map((item) => `> ${oneLine(t(item.code, item.params))}`);
}

/**
 * Nota de afrouxamento sem autorização. Com o padrão de título vazio não há título que
 * autorize, por isso a nota não o sugere.
 * @param {Report} report
 * @returns {Issue}
 */
function unauthorisedNote(report) {
  const code = report.loosenable ? 'note_loosen_unauthorised' : 'note_loosen_disabled';
  return note(code, { names: codeList(report.loosened) });
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
  const [before, after] = formatPair(row.before, row.after, t('missing_value'));
  const cells = [ICON[row.status], tableCode(row.name), before, after, formatDelta(row)];
  if (withTarget) cells.push(row.target === undefined ? '' : formatNumber(row.target));
  return `| ${cells.join(' | ')} |`;
}

/**
 * Delta com sinal, e a tolerância quando a regressão foi tolerada. Um delta ou uma
 * tolerância que não são zero nunca aparecem como zero.
 * @param {MetricResult} row
 * @returns {string}
 */
function formatDelta(row) {
  if (row.delta === null) return '';
  if (row.delta === 0) return '0';
  const sign = row.delta > 0 ? '+' : '';
  const delta = `${sign}${formatNonZero(row.delta)}`;
  if (row.status !== Status.TOLERATED) return delta;
  return `${delta} (±${formatNonZero(row.tolerance)})`;
}

/**
 * Número com no máximo quatro casas decimais, sem zeros à direita.
 * @param {number} value
 * @returns {string}
 */
export function formatNumber(value) {
  return toDecimals(value, DECIMALS);
}

/**
 * Formata números que aparecem lado a lado (baseline e valor medido) com as mesmas casas
 * decimais: quatro, ou as que forem precisas para que valores que a comparação distingue
 * não pareçam iguais (ex: 0.81234 e 0.81231, que a quatro casas seriam ambos 0.8123).
 * @param {number[]} values
 * @returns {string[]}
 */
export function formatNumbers(values) {
  let decimals = DECIMALS;
  while (decimals < MAX_DECIMALS && collide(values, decimals)) decimals += 1;
  return values.map((value) => toDecimals(value, decimals));
}

/**
 * Indica se dois valores diferentes ficam iguais quando arredondados.
 * @param {number[]} values
 * @param {number} decimals
 * @returns {boolean}
 */
function collide(values, decimals) {
  return values.some((a, i) => values.some((b, j) => j > i
    && Math.abs(a - b) > EPSILON
    && toDecimals(a, decimals) === toDecimals(b, decimals)));
}

/**
 * @param {number} value
 * @param {number} decimals
 * @returns {string}
 */
function toDecimals(value, decimals) {
  return String(Number(value.toFixed(decimals)));
}

/**
 * Valor que não é zero: quando quatro casas o arredondariam para zero, mostra três
 * algarismos significativos.
 * @param {number} value
 * @returns {string}
 */
function formatNonZero(value) {
  const text = formatNumber(value);
  return text === '0' && value !== 0 ? String(Number(value.toPrecision(3))) : text;
}

/**
 * Baseline e valor medido formatados em conjunto; os que faltam ficam com `missing`.
 * @param {number|null} before
 * @param {number|null} after
 * @param {string} missing
 * @returns {[string, string]}
 */
function formatPair(before, after, missing) {
  if (before !== null && after !== null) {
    const [shownBefore, shownAfter] = formatNumbers([before, after]);
    return [shownBefore, shownAfter];
  }
  const show = (/** @type {number|null} */ value) => (
    value === null ? missing : formatNumber(value));
  return [show(before), show(after)];
}

/**
 * Explicação de cada métrica em falha e das melhorias por fixar.
 * @param {Report} report
 * @param {Translator} t
 * @returns {string}
 */
function renderDetails(report, t) {
  const lines = report.outcome.results.flatMap((row) => (row.detail
    ? [`- ${codeSpan(row.name)}: ${oneLine(t(row.detail.code, row.detail.params))}`]
    : []));
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
    const fields = [...item.loosenedFields, ...item.tightenedFields, ...item.changedFields];
    return `| ${tableCode(item.name)} | ${t(`change_${item.kind}`)} | ${fields.join(', ')} |`;
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
  const lines = report.warnings.map((item) => `- ${oneLine(t(item.code, item.params))}`);
  if (report.untracked.length > 0) {
    const names = report.untracked.map((name) => codeSpan(name)).join(', ');
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
  return items.map((item) => codeSpan(item.name)).join(', ');
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
 * @param {Issue} [hint] dica que acompanha o afrouxamento sem autorização (por omissão, a
 *   do checkout do merge commit)
 * @returns {LogEntry[]}
 */
export function reportLogEntries(report, t, hint = CHECKOUT_HINT) {
  return [
    ...report.outcome.failures.map((row) => errorEntry(failureText(row, t))),
    ...report.outcome.unlocked.map((row) => errorEntry(t('log_unlocked', numbers(row)))),
    ...loosenedEntries(report, t, hint),
    ...tightenedEntries(report, t),
    closingEntry(report, t),
  ];
}

/**
 * @param {string} text
 * @returns {LogEntry}
 */
function errorEntry(text) {
  return { level: 'error', text };
}

/**
 * Erro de afrouxamento sem autorização, quando o há, seguido da dica.
 * @param {Report} report
 * @param {Translator} t
 * @param {Issue} hint
 * @returns {LogEntry[]}
 */
function loosenedEntries(report, t, hint) {
  if (report.loosened.length === 0 || report.authorisation.granted) return [];
  const { code, params } = unauthorisedNote(report);
  return [errorEntry(`${t(code, params)} ${t(hint.code, hint.params)}`)];
}

/**
 * Aviso informativo das melhorias por fixar, quando as há.
 * @param {Report} report
 * @param {Translator} t
 * @returns {LogEntry[]}
 */
function tightenedEntries(report, t) {
  if (report.tightened.length === 0) return [];
  return [{ level: 'notice', text: t('log_tightened', { names: report.tightened.join(', ') }) }];
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
  const [before, after] = formatPair(row.before, row.after, '?');
  return { name: row.name, before, after };
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
