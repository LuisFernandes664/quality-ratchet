// @ts-check
/**
 * Catálogo de mensagens em inglês e português europeu. Todo o texto que chega a pessoas
 * (sumário, logs, erros) passa por aqui, identificado por código.
 */
import { ConfigError, RatchetError } from './errors.js';

/**
 * @typedef {(params: Record<string, any>, t: Translator) => string} Template
 * @typedef {(code: string, params?: Record<string, unknown>) => string} Translator
 */

/** Línguas suportadas. */
export const LANGUAGES = Object.freeze(['en', 'pt']);

/**
 * Junta partes não vazias com vírgulas.
 * @param {Array<string|false>} parts
 * @returns {string}
 */
function joinParts(parts) {
  return parts.filter(Boolean).join(', ');
}

/**
 * Lista de problemas em Markdown.
 * @param {Array<{code: string, params: Record<string, unknown>}>} issues
 * @param {Translator} t
 * @returns {string}
 */
function issueList(issues, t) {
  return issues.map((item) => `- ${t(item.code, item.params)}`).join('\n');
}

/** @type {Record<string, Template>} */
const EN = {
  title: (p) => (p.name ? `Quality ratchet - ${p.name}` : 'Quality ratchet'),
  verdict_passed: () => 'Ratchet green. No metric regressed.',
  verdict_failed: (p) => `Ratchet red. ${joinParts([
    p.failures > 0 && `${p.failures} failing metric(s)`,
    p.unlocked > 0 && `${p.unlocked} improvement(s) not locked in`,
    p.loosened > 0 && `${p.loosened} unauthorised baseline change(s)`,
  ])}.`,
  note_bypassed: (p) => `Failure forgiven: ${p.reason}.`,
  note_loosen_authorised: (p) => `Baseline loosened with authorisation: ${p.reason}.`,
  note_loosen_unauthorised: (p) => `This pull request loosens the baseline (${p.names}) `
    + 'without authorisation. Give it a title that matches the lower-baseline pattern, '
    + 'or revert the change.',
  note_base_missing: (p) => `There is no baseline at \`${p.path}\` on the base branch, so `
    + 'baseline changes are not governed in this run.',
  note_no_token: () => 'No token available, so the base branch baseline was not read and '
    + 'baseline changes are not governed in this run.',
  note_base_invalid: (p) => `The baseline on the base branch is invalid (${p.reason}), so `
    + 'baseline changes are not governed in this run.',
  reason_label: (p) => `label \`${p.label}\``,
  reason_title: (p) => `pull request title "${p.title}"`,
  col_metric: () => 'Metric',
  col_baseline: () => 'Baseline',
  col_now: () => 'Now',
  col_delta: () => 'Delta',
  col_target: () => 'Target',
  col_change: () => 'Change',
  col_fields: () => 'Fields',
  missing_value: () => 'missing',
  change_loosened: () => 'loosened',
  change_tightened: () => 'tightened',
  change_added: () => 'added',
  change_removed: () => 'removed',
  section_changes: () => 'Baseline changes in this pull request',
  section_warnings: () => 'Warnings',
  unlocked_hint: (p) => `Strict mode: ${p.names} improved but the baseline was not updated. `
    + 'Commit the updated baseline below.',
  new_baseline_title: (p) => `Updated baseline (${p.count} metric(s) tightened)`,
  new_baseline_hint: () => 'Replace the committed baseline with this content to lock in '
    + 'the improvements.',
  footer_frozen: (p) => `Baseline frozen at ${p.date}.`,
  warning_untracked: (p) => `Measured but not tracked by the baseline: ${p.names}.`,

  metric_not_reported: () => 'not present in the metrics file; an incomplete collector '
    + 'counts as a failure',
  value_not_numeric_current: (p) => `the measured value ${p.value} is not a number`,
  below_min: (p) => `${p.value} is below the absolute minimum ${p.limit}`,
  above_max: (p) => `${p.value} is above the absolute maximum ${p.limit}`,
  rule_without_value: (p) => `metric "${p.name}" has a rule but no value in the baseline`,
  report_not_found: (p) => `report not found: ${p.path}`,

  baseline_invalid: (p, t) => `The baseline is invalid:\n${issueList(p.issues, t)}`,
  baseline_not_object: () => 'the baseline must be a JSON object',
  baseline_no_rules: () => 'the baseline has no rules: define rules.monotonic_down '
    + 'and/or rules.monotonic_up',
  baseline_no_metrics: () => 'the baseline has no metrics',
  baseline_mixed_format: () => 'metrics mix the v1 format (numbers) with the v2 format '
    + '(objects)',
  version_unsupported: (p) => `unsupported baseline version ${p.version}`,
  frozen_at_invalid: (p) => `frozen_at must be text, got ${p.value}`,
  rules_not_list: (p) => `rules.${p.key} must be a list of metric names`,
  metric_in_both_directions: (p) => `"${p.name}" is in both monotonic_down and monotonic_up`,
  metric_duplicated: (p) => `"${p.name}" is listed more than once`,
  value_not_numeric: (p) => `the baseline value of "${p.name}" is not a number: ${p.value}`,
  metric_not_object: (p) => `metric "${p.name}" must be an object`,
  direction_invalid: (p) => `the direction of "${p.name}" must be "up" or "down", `
    + `got ${p.value}`,
  tolerance_invalid: (p) => `the tolerance of "${p.name}" must be a number >= 0, got ${p.value}`,
  limit_not_numeric: (p) => `${p.field} of "${p.name}" must be a number, got ${p.value}`,
  limits_inverted: (p) => `"${p.name}" has min ${p.min} above max ${p.max}`,
  source_invalid: (p) => `the source of "${p.name}" needs text fields "format" and "path"`,
  metric_without_rule: (p) => `"${p.name}" has a baseline value but no rule, so it is `
    + 'not checked',
  unknown_field: (p) => `unknown field "${p.field}" in metric "${p.name}" (typo?)`,
  unknown_root_field: (p) => `unknown field "${p.field}" at the root of the baseline`,
  value_violates_limit: (p) => `the baseline value of "${p.name}" (${p.value}) already `
    + `breaks its ${p.field} of ${p.limit}; every run fails until it is fixed`,

  metrics_not_object: (p) => `the metrics file ${p.path} must hold a JSON object of `
    + 'metric names to numbers',
  metrics_file_missing: (p) => `the metrics file ${p.path} does not exist and these `
    + `metrics have no source: ${p.names}`,
  metric_defined_twice: (p) => `metric "${p.name}" comes from both the metrics file and `
    + 'its source; keep only one',

  config_boolean_invalid: (p) => `input "${p.input}" must be true or false, got "${p.value}"`,
  config_language_unsupported: (p) => `unsupported language "${p.language}"; `
    + `use one of: ${p.supported}`,
  config_pattern_invalid: (p) => `invalid regular expression "${p.pattern}": ${p.reason}`,
  config_format_unsupported: (p) => `unsupported format "${p.format}"; `
    + `use one of: ${p.supported}`,
  config_path_exists: (p) => `${p.path} already exists; use --force to overwrite it`,
  config_input_required: (p) => `"${p.input}" is required`,
  cli_command_unknown: (p) => `unknown command "${p.command}"; run with --help`,
  cli_option_invalid: (p) => `invalid options: ${p.reason}`,
  init_metric_absent: (p) => `metric "${p.name}" is not in the metrics file`,
  init_no_metrics: () => 'no metrics selected; use --up and/or --down',
  git_show_failed: (p) => `could not read ${p.path} at ${p.ref}: ${p.reason}`,
  file_unreadable: (p) => `could not read ${p.path}: ${p.reason}`,
  json_invalid: (p) => `${p.path} is not valid JSON: ${p.reason}`,

  extractor_format_unknown: (p) => `unknown report format "${p.format}"; `
    + `known formats: ${p.known}`,
  extractor_field_unknown: (p) => `format "${p.format}" has no field "${p.field}"; `
    + `known fields: ${p.known}`,
  extractor_report_unparseable: (p) => `could not parse the ${p.format} report: ${p.reason}`,
  extractor_report_empty: (p) => `the ${p.format} report has nothing to measure`,
  extractor_option_invalid: (p) => `invalid option "${p.option}" for format "${p.format}": `
    + `${p.reason}`,

  github_api_failed: (p) => `GitHub API ${p.method} ${p.path} returned ${p.status}: ${p.body}`,
  github_repository_missing: () => 'GITHUB_REPOSITORY is not set',

  log_regressed: (p) => `${p.name} regressed: ${p.before} -> ${p.after}`,
  log_failure: (p) => `${p.name}: ${p.detail}`,
  log_unlocked: (p) => `${p.name} improved (${p.before} -> ${p.after}) but the baseline was `
    + 'not updated (strict mode)',
  log_passed: () => 'Ratchet green.',
  log_bypassed: (p) => `Failure forgiven: ${p.reason}.`,
  log_comment_created: (p) => `Summary comment created on pull request #${p.number}.`,
  log_comment_updated: (p) => `Summary comment updated on pull request #${p.number}.`,
  log_comment_failed: (p) => `Could not post the summary comment (${p.reason}). The result `
    + 'is still in the job summary. Pull requests from forks get a read-only token.',
  log_pr_refresh_failed: (p) => `Could not refresh the pull request title and labels `
    + `(${p.reason}); using the event payload.`,
  log_tightened: (p) => `Improvements to lock in: ${p.names}. See the new-baseline output.`,
  log_baseline_written: (p) => `Updated baseline written to ${p.path}.`,
  cli_written: (p) => `Wrote ${p.path}.`,
  cli_nothing_to_update: () => 'Nothing to tighten: the baseline already matches the '
    + 'measurements.',
  cli_migrate_dropped: (p) => `Values without a rule were dropped: ${p.names}.`,
  cli_init_ignored: (p) => `Metrics in the file without a direction were ignored: ${p.names}.`,
  cli_update_missing: (p) => `No measurement for: ${p.names}. Their values were kept.`,
};

/** @type {Record<string, Template>} */
const PT = {
  title: (p) => (p.name ? `Quality ratchet - ${p.name}` : 'Quality ratchet'),
  verdict_passed: () => 'Catraca verde. Nenhuma métrica regrediu.',
  verdict_failed: (p) => `Catraca vermelha. ${joinParts([
    p.failures > 0 && `${p.failures} métrica(s) em falha`,
    p.unlocked > 0 && `${p.unlocked} melhoria(s) por fixar`,
    p.loosened > 0 && `${p.loosened} alteração(ões) ao baseline sem autorização`,
  ])}.`,
  note_bypassed: (p) => `Falha perdoada: ${p.reason}.`,
  note_loosen_authorised: (p) => `Baseline afrouxado com autorização: ${p.reason}.`,
  note_loosen_unauthorised: (p) => `Este pull request afrouxa o baseline (${p.names}) `
    + 'sem autorização. Dá-lhe um título que corresponda ao padrão de descida de baseline, '
    + 'ou reverte a alteração.',
  note_base_missing: (p) => `Não existe baseline em \`${p.path}\` no ramo base, por isso `
    + 'as alterações ao baseline não são governadas nesta execução.',
  note_no_token: () => 'Sem token, o baseline do ramo base não foi lido e as alterações ao '
    + 'baseline não são governadas nesta execução.',
  note_base_invalid: (p) => `O baseline do ramo base é inválido (${p.reason}), por isso as `
    + 'alterações ao baseline não são governadas nesta execução.',
  reason_label: (p) => `label \`${p.label}\``,
  reason_title: (p) => `título do pull request "${p.title}"`,
  col_metric: () => 'Métrica',
  col_baseline: () => 'Baseline',
  col_now: () => 'Agora',
  col_delta: () => 'Delta',
  col_target: () => 'Objectivo',
  col_change: () => 'Alteração',
  col_fields: () => 'Campos',
  missing_value: () => 'em falta',
  change_loosened: () => 'afrouxada',
  change_tightened: () => 'apertada',
  change_added: () => 'nova',
  change_removed: () => 'removida',
  section_changes: () => 'Alterações ao baseline neste pull request',
  section_warnings: () => 'Avisos',
  unlocked_hint: (p) => `Modo estrito: ${p.names} melhorou mas o baseline não foi `
    + 'actualizado. Faz commit do baseline actualizado abaixo.',
  new_baseline_title: (p) => `Baseline actualizado (${p.count} métrica(s) apertada(s))`,
  new_baseline_hint: () => 'Substitui o baseline versionado por este conteúdo para fixar '
    + 'as melhorias.',
  footer_frozen: (p) => `Baseline congelado em ${p.date}.`,
  warning_untracked: (p) => `Medidas mas não seguidas pelo baseline: ${p.names}.`,

  metric_not_reported: () => 'não veio no ficheiro de métricas; um colector incompleto '
    + 'conta como falha',
  value_not_numeric_current: (p) => `o valor medido ${p.value} não é um número`,
  below_min: (p) => `${p.value} está abaixo do mínimo absoluto ${p.limit}`,
  above_max: (p) => `${p.value} está acima do máximo absoluto ${p.limit}`,
  rule_without_value: (p) => `a métrica "${p.name}" tem regra mas não tem valor no baseline`,
  report_not_found: (p) => `relatório não encontrado: ${p.path}`,

  baseline_invalid: (p, t) => `O baseline é inválido:\n${issueList(p.issues, t)}`,
  baseline_not_object: () => 'o baseline tem de ser um objecto JSON',
  baseline_no_rules: () => 'o baseline não tem regras: define rules.monotonic_down '
    + 'e/ou rules.monotonic_up',
  baseline_no_metrics: () => 'o baseline não tem métricas',
  baseline_mixed_format: () => 'as métricas misturam o formato v1 (números) com o formato '
    + 'v2 (objectos)',
  version_unsupported: (p) => `versão de baseline não suportada: ${p.version}`,
  frozen_at_invalid: (p) => `frozen_at tem de ser texto, veio ${p.value}`,
  rules_not_list: (p) => `rules.${p.key} tem de ser uma lista de nomes de métricas`,
  metric_in_both_directions: (p) => `"${p.name}" está em monotonic_down e em monotonic_up`,
  metric_duplicated: (p) => `"${p.name}" aparece mais de uma vez`,
  value_not_numeric: (p) => `o valor de "${p.name}" no baseline não é um número: ${p.value}`,
  metric_not_object: (p) => `a métrica "${p.name}" tem de ser um objecto`,
  direction_invalid: (p) => `a direcção de "${p.name}" tem de ser "up" ou "down", `
    + `veio ${p.value}`,
  tolerance_invalid: (p) => `a tolerância de "${p.name}" tem de ser um número >= 0, `
    + `veio ${p.value}`,
  limit_not_numeric: (p) => `${p.field} de "${p.name}" tem de ser um número, veio ${p.value}`,
  limits_inverted: (p) => `"${p.name}" tem min ${p.min} acima de max ${p.max}`,
  source_invalid: (p) => `a source de "${p.name}" precisa dos campos de texto "format" `
    + 'e "path"',
  metric_without_rule: (p) => `"${p.name}" tem valor no baseline mas nenhuma regra, por isso `
    + 'não é verificada',
  unknown_field: (p) => `campo desconhecido "${p.field}" na métrica "${p.name}" (gralha?)`,
  unknown_root_field: (p) => `campo desconhecido "${p.field}" na raiz do baseline`,
  value_violates_limit: (p) => `o valor de "${p.name}" no baseline (${p.value}) já viola o `
    + `${p.field} de ${p.limit}; todas as execuções falham até ser corrigido`,

  metrics_not_object: (p) => `o ficheiro de métricas ${p.path} tem de conter um objecto JSON `
    + 'de nomes de métricas para números',
  metrics_file_missing: (p) => `o ficheiro de métricas ${p.path} não existe e estas métricas `
    + `não têm source: ${p.names}`,
  metric_defined_twice: (p) => `a métrica "${p.name}" vem do ficheiro de métricas e da sua `
    + 'source; mantém apenas uma',

  config_boolean_invalid: (p) => `o input "${p.input}" tem de ser true ou false, `
    + `veio "${p.value}"`,
  config_language_unsupported: (p) => `língua não suportada "${p.language}"; `
    + `usa uma de: ${p.supported}`,
  config_pattern_invalid: (p) => `expressão regular inválida "${p.pattern}": ${p.reason}`,
  config_format_unsupported: (p) => `formato não suportado "${p.format}"; `
    + `usa um de: ${p.supported}`,
  config_path_exists: (p) => `${p.path} já existe; usa --force para o substituir`,
  config_input_required: (p) => `"${p.input}" é obrigatório`,
  cli_command_unknown: (p) => `comando desconhecido "${p.command}"; corre com --help`,
  cli_option_invalid: (p) => `opções inválidas: ${p.reason}`,
  init_metric_absent: (p) => `a métrica "${p.name}" não está no ficheiro de métricas`,
  init_no_metrics: () => 'nenhuma métrica seleccionada; usa --up e/ou --down',
  git_show_failed: (p) => `não foi possível ler ${p.path} em ${p.ref}: ${p.reason}`,
  file_unreadable: (p) => `não foi possível ler ${p.path}: ${p.reason}`,
  json_invalid: (p) => `${p.path} não é JSON válido: ${p.reason}`,

  extractor_format_unknown: (p) => `formato de relatório desconhecido "${p.format}"; `
    + `formatos conhecidos: ${p.known}`,
  extractor_field_unknown: (p) => `o formato "${p.format}" não tem o campo "${p.field}"; `
    + `campos conhecidos: ${p.known}`,
  extractor_report_unparseable: (p) => `não foi possível interpretar o relatório ${p.format}: `
    + `${p.reason}`,
  extractor_report_empty: (p) => `o relatório ${p.format} não tem nada para medir`,
  extractor_option_invalid: (p) => `opção "${p.option}" inválida para o formato `
    + `"${p.format}": ${p.reason}`,

  github_api_failed: (p) => `a API do GitHub ${p.method} ${p.path} devolveu ${p.status}: `
    + `${p.body}`,
  github_repository_missing: () => 'GITHUB_REPOSITORY não está definido',

  log_regressed: (p) => `${p.name} regrediu: ${p.before} -> ${p.after}`,
  log_failure: (p) => `${p.name}: ${p.detail}`,
  log_unlocked: (p) => `${p.name} melhorou (${p.before} -> ${p.after}) mas o baseline não `
    + 'foi actualizado (modo estrito)',
  log_passed: () => 'Catraca verde.',
  log_bypassed: (p) => `Falha perdoada: ${p.reason}.`,
  log_comment_created: (p) => `Comentário de sumário criado no pull request #${p.number}.`,
  log_comment_updated: (p) => `Comentário de sumário actualizado no pull request #${p.number}.`,
  log_comment_failed: (p) => `Não foi possível publicar o comentário de sumário (${p.reason}). `
    + 'O resultado continua no sumário do job. Pull requests de forks recebem um token só '
    + 'de leitura.',
  log_pr_refresh_failed: (p) => 'Não foi possível actualizar o título e as labels do pull '
    + `request (${p.reason}); a usar o payload do evento.`,
  log_tightened: (p) => `Melhorias por fixar: ${p.names}. Ver o output new-baseline.`,
  log_baseline_written: (p) => `Baseline actualizado escrito em ${p.path}.`,
  cli_written: (p) => `Escrito ${p.path}.`,
  cli_nothing_to_update: () => 'Nada a apertar: o baseline já corresponde às medições.',
  cli_migrate_dropped: (p) => `Valores sem regra foram descartados: ${p.names}.`,
  cli_init_ignored: (p) => `Métricas do ficheiro sem direcção foram ignoradas: ${p.names}.`,
  cli_update_missing: (p) => `Sem medição para: ${p.names}. Os valores anteriores mantêm-se.`,
};

/** @type {Record<string, Record<string, Template>>} */
const CATALOGS = { en: EN, pt: PT };

/**
 * Normaliza o código de língua ('pt-PT' -> 'pt', 'EN' -> 'en').
 * @param {string} language
 * @returns {string}
 * @throws {ConfigError} quando a língua não é suportada
 */
export function normaliseLanguage(language) {
  const code = String(language).trim().toLowerCase().split(/[-_]/)[0];
  if (LANGUAGES.includes(code)) return code;
  throw new ConfigError('config_language_unsupported', {
    language,
    supported: LANGUAGES.join(', '),
  });
}

/**
 * Cria a função de tradução para uma língua. Um código sem entrada no catálogo devolve o
 * próprio código com os parâmetros, para nunca esconder informação.
 * @param {string} language
 * @returns {Translator}
 */
export function createTranslator(language) {
  const catalog = CATALOGS[normaliseLanguage(language)];
  /** @type {Translator} */
  const t = (code, params = {}) => {
    const template = Object.hasOwn(catalog, code) ? catalog[code] : undefined;
    return template ? template(params, t) : `${code} ${JSON.stringify(params)}`;
  };
  return t;
}

/**
 * Texto legível de um erro: os erros do projecto passam pelo catálogo, os restantes
 * mantêm a mensagem original.
 * @param {unknown} error
 * @param {Translator} t
 * @returns {string}
 */
export function describeError(error, t) {
  if (error instanceof RatchetError) return t(error.code, error.params);
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Códigos presentes em cada catálogo, para os testes garantirem que estão alinhados.
 * @returns {Record<string, string[]>}
 */
export function catalogKeys() {
  return { en: Object.keys(EN).sort(), pt: Object.keys(PT).sort() };
}
