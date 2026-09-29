// @ts-check
/**
 * Catálogo de mensagens em inglês e português europeu. Todo o texto que chega a pessoas
 * (sumário, logs, erros) passa por aqui, identificado por código.
 */
import { ConfigError, RatchetError } from './errors.js';
import { codeSpan, oneLine } from './markdown.js';

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

/**
 * Texto de um motivo, que pode ser um problema do catálogo ou texto já pronto (por exemplo a
 * mensagem do motor de JSON). O resultado fica numa só linha, porque vem de relatórios.
 * @param {unknown} reason
 * @param {Translator} t
 * @returns {string}
 */
function reasonText(reason, t) {
  if (typeof reason === 'string') return oneLine(reason);
  if (reason && typeof reason === 'object' && 'code' in reason) {
    const issue = /** @type {{code: string, params?: Record<string, unknown>}} */ (reason);
    return oneLine(t(issue.code, issue.params ?? {}));
  }
  return oneLine(String(reason ?? ''));
}

/**
 * Acrescenta `: detalhe` quando há detalhe.
 * @param {unknown} details
 * @returns {string}
 */
function withDetails(details) {
  return details ? `: ${oneLine(String(details))}` : '';
}

/** @type {Record<string, Template>} */
const EN = {
  title: (p) => (p.name ? `Quality ratchet - ${p.name}` : 'Quality ratchet'),
  verdict_passed: () => 'Ratchet green. No metric regressed beyond its tolerance.',
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
  note_loosen_disabled: (p) => `This pull request loosens the baseline (${p.names}), but `
    + 'loosening is turned off: the lower-baseline pattern is empty. Revert the change.',
  note_checkout_hint: () => 'If this pull request does not edit the baseline, check that the '
    + 'workflow checks out the merge commit (the default of actions/checkout on pull_request) '
    + 'and not the head commit, or update the branch.',
  note_base_ref_hint: () => 'If this pull request does not edit the baseline, check that '
    + '`--base-ref` is the merge base with the target branch (`git merge-base`) and not the '
    + 'tip of that branch, or update the branch.',
  note_base_missing: (p) => `There is no baseline at \`${p.path}\` on the base branch, so `
    + 'baseline changes are not governed in this run.',
  note_no_token: () => 'No token available, so the base branch baseline was not read and '
    + 'baseline changes are not governed in this run.',
  note_base_invalid: (p) => `The baseline on the base branch is invalid (${p.reason}), so `
    + 'baseline changes are not governed in this run.',
  reason_label: (p) => `label ${codeSpan(String(p.label))}`,
  reason_title: (p) => `pull request title ${codeSpan(String(p.title))}`,
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
  change_changed: () => 'changed',
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
  source_changed_unmeasured: () => 'this pull request changed or removed the source, and the '
    + 'base branch source was not measured',

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
  metric_name_invalid: (p) => `invalid metric name ${p.name}: a name needs visible text and `
    + 'no line breaks or other control characters',
  description_invalid: (p) => `the description of "${p.name}" must be text, got ${p.value}`,
  schema_invalid: (p) => `$schema must be text, got ${p.value}`,
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
    + `breaks its ${p.field} of ${p.limit}; runs fail while the measured value stays outside it`,

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
  config_marker_invalid: (p) => `comment-marker ${p.value} must be a name or a one-line `
    + 'HTML comment such as <!-- quality-gate -->',
  cli_command_unknown: (p) => `unknown command "${p.command}"; run with --help`,
  cli_option_invalid: (p) => `invalid options: ${p.reason}`,
  init_metric_absent: (p) => `metric "${p.name}" is not in the metrics file`,
  init_no_metrics: () => 'no metrics selected; use --up and/or --down',
  init_metric_conflict: (p) => `metric "${p.name}" cannot be in both --up and --down`,
  git_show_failed: (p, t) => `could not read ${p.path} at ${p.ref}: ${reasonText(p.reason, t)}`,
  file_unreadable: (p) => `could not read ${p.path}: ${p.reason}`,
  json_invalid: (p) => `${p.path} is not valid JSON: ${p.reason}`,

  extractor_format_unknown: (p) => `unknown report format "${p.format}"; `
    + `known formats: ${p.known}`,
  extractor_field_unknown: (p) => `format "${p.format}" has no field "${p.field}"; `
    + `known fields: ${p.known}`,
  extractor_report_unparseable: (p, t) => `could not parse the ${p.format} report: `
    + `${reasonText(p.reason, t)}`,
  extractor_report_empty: (p) => `the ${p.format} report has nothing to measure`,
  extractor_option_invalid: (p, t) => `invalid option "${p.option}" for format "${p.format}": `
    + `${reasonText(p.reason, t)}`,

  reason_value_not_finite: (p) => `the extracted value is not a finite number: ${p.value}`,
  reason_key_missing: (p) => `missing "${p.path}"`,
  reason_not_number: (p) => `"${p.path}" is not a finite number`,
  reason_not_count: (p) => `"${p.path}" is not a non-negative integer`,
  reason_not_array: (p) => `"${p.path}" is not an array`,
  reason_not_object: (p) => `"${p.path}" is not an object`,
  reason_not_array_of_objects: (p) => `"${p.path}" is not an array of objects`,
  reason_not_string: (p) => `"${p.path}" is not text`,
  reason_not_text: () => 'the report content is not text',
  reason_hit_exceeds_total: (p) => `hit count ${p.hit} exceeds total ${p.total}`,
  reason_pointer_missing: () => 'missing',
  reason_pointer_not_string: () => 'must be a string',
  reason_pointer_not_absolute: (p) => `"${p.pointer}" must be empty or start with "/"`,
  reason_pointer_bad_escape: (p) => `"${p.pointer}" has "~" not followed by "0" or "1"`,
  reason_pointer_not_found: (p) => `pointer "${p.pointer}" does not exist`,
  reason_pointer_not_numeric: (p) => `value at "${p.pointer}" is not numeric (found ${p.kind})`,
  reason_xml_no_element: () => 'no XML element found',
  reason_xml_root: (p) => `root element is <${p.found}>, expected <${p.expected}>`,
  reason_attribute_missing: (p) => `missing attribute "${p.name}" on <${p.element}>`,
  reason_attribute_not_number: (p) => `attribute "${p.name}" is not a number: "${p.value}"`,
  reason_attribute_not_count: (p) => `attribute "${p.name}" is not a non-negative integer: `
    + `"${p.value}"`,
  reason_attribute_out_of_range: (p) => `attribute "${p.name}" is not between ${p.min} and `
    + `${p.max}: "${p.value}"`,
  reason_junit_no_suite: () => 'no <testsuites> or <testsuite> element found',
  reason_lcov_no_record: () => 'no "SF:" record found',
  reason_lcov_invalid_value: (p) => `invalid "${p.key}" value: "${p.value}"`,
  reason_levels_invalid: (p) => `must be a non-empty array of ${p.known}`,
  reason_level_unknown: (p) => `unknown level "${p.level}"`,
  reason_rules_invalid: () => 'must be a non-empty array of rule ids, such as ["CA1502"]',
  reason_sarif_version: (p) => `SARIF version "${p.version}" is not supported, only 2.1.0 `
    + '(for dotnet build, use -p:ErrorLog=<file>.sarif%2Cversion=2.1)',
  reason_sarif_version_missing: () => 'the SARIF log has no "version"; only 2.1.0 is supported',
  reason_sarif_execution_failed: (p) => `"${p.run}" reports an unsuccessful tool execution`
    + withDetails(p.details),
  reason_eslint_not_array: () => 'expected an array of file results',
  reason_npm_audit_failed: (p) => `npm audit failed${withDetails(p.details)}`,
  reason_mutant_status_unknown: (p) => `unknown mutant status "${p.status}" in "${p.path}"`,
  reason_not_a_revision: () => 'not a revision: it is empty or starts with "-"',

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
  log_tightened: (p) => `Improvements to lock in: ${p.names}. The updated baseline is in the `
    + 'summary.',
  log_event_unreadable: (p) => `Could not read the event payload (${p.reason}); continuing `
    + 'without pull request context, so there is no governance or comment in this run.',
  log_pagination_truncated: (p) => `Stopped reading ${p.path} after ${p.pages} pages (safety `
    + 'limit); later pages were ignored.',
  log_api_retry: (p) => `GitHub API ${p.method} ${p.path} returned ${p.status} `
    + `(attempt ${p.attempt}); retrying in ${p.seconds} s.`,
  log_proxy_unsupported: () => 'A proxy variable (HTTPS_PROXY/HTTP_PROXY) is set, but this '
    + 'Node.js does not route fetch through it, so API requests go direct. If they fail, add '
    + 'NODE_USE_ENV_PROXY: "1" to the step env.',
  proxy_invalid: (p) => `the proxy configuration in HTTPS_PROXY/HTTP_PROXY is invalid: `
    + `${p.reason}`,
  log_comment_failed_generic: (p) => `Could not post the summary comment (${p.reason}). The `
    + 'result is still in the job summary.',
  comment_too_long: (p) => `the comment has ${p.length} characters, above the API limit of `
    + `${p.max}`,
  note_comment_abbreviated: () => 'This comment was shortened to fit the size limit for pull '
    + 'request comments. The full report is in the job summary.',
  error_node_unsupported: (p) => `quality-ratchet needs Node.js 20 or later; this step runs on `
    + `${p.version}. On Gitea and Forgejo runners the action runs with the node of the job `
    + 'image: use an image with Node.js 20 or later.',
  log_baseline_written: (p) => `Updated baseline written to ${p.path}.`,
  cli_written: (p) => `Wrote ${p.path}.`,
  cli_nothing_to_update: () => 'Nothing to tighten: no metric improved beyond its tolerance.',
  cli_nothing_to_rebaseline: () => 'Nothing to change: the baseline already matches the '
    + 'measurements.',
  cli_update_not_lowered: (p) => `Values not lowered: ${p.names}. The check will fail until `
    + 'they recover; use --allow-lower only if lowering the baseline was decided.',
  cli_migrate_dropped: (p) => `Values without a rule were dropped: ${p.names}.`,
  cli_init_ignored: (p) => `Metrics in the file without a direction were ignored: ${p.names}.`,
  cli_update_missing: (p) => `No measurement for: ${p.names}. Their values were kept.`,
};

/** @type {Record<string, Template>} */
const PT = {
  title: (p) => (p.name ? `Quality ratchet - ${p.name}` : 'Quality ratchet'),
  verdict_passed: () => 'Catraca verde. Nenhuma métrica regrediu além da tolerância.',
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
  note_loosen_disabled: (p) => `Este pull request afrouxa o baseline (${p.names}), mas `
    + 'afrouxar está desligado: o padrão de descida de baseline está vazio. Reverte a '
    + 'alteração.',
  note_checkout_hint: () => 'Se este pull request não altera o baseline, confirma que o '
    + 'workflow faz checkout do merge commit (o comportamento por omissão do actions/checkout '
    + 'em pull_request) e não do último commit do pull request, ou actualiza o ramo.',
  note_base_ref_hint: () => 'Se este pull request não altera o baseline, confirma que o '
    + '`--base-ref` é a merge base com o ramo de destino (`git merge-base`) e não a ponta '
    + 'desse ramo, ou actualiza o ramo.',
  note_base_missing: (p) => `Não existe baseline em \`${p.path}\` no ramo base, por isso `
    + 'as alterações ao baseline não são governadas nesta execução.',
  note_no_token: () => 'Sem token, o baseline do ramo base não foi lido e as alterações ao '
    + 'baseline não são governadas nesta execução.',
  note_base_invalid: (p) => `O baseline do ramo base é inválido (${p.reason}), por isso as `
    + 'alterações ao baseline não são governadas nesta execução.',
  reason_label: (p) => `label ${codeSpan(String(p.label))}`,
  reason_title: (p) => `título do pull request ${codeSpan(String(p.title))}`,
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
  change_changed: () => 'alterada',
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
  source_changed_unmeasured: () => 'este pull request mudou ou retirou a source, e a source '
    + 'do ramo base não foi medida',

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
  metric_name_invalid: (p) => `nome de métrica inválido ${p.name}: um nome precisa de texto `
    + 'visível e de nenhuma quebra de linha ou outro carácter de controlo',
  description_invalid: (p) => `a descrição de "${p.name}" tem de ser texto, veio ${p.value}`,
  schema_invalid: (p) => `$schema tem de ser texto, veio ${p.value}`,
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
    + `${p.field} de ${p.limit}; as execuções falham enquanto o valor medido estiver fora dele`,

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
  config_marker_invalid: (p) => `comment-marker ${p.value} tem de ser um nome ou um `
    + 'comentário HTML de uma linha, como <!-- quality-gate -->',
  cli_command_unknown: (p) => `comando desconhecido "${p.command}"; corre com --help`,
  cli_option_invalid: (p) => `opções inválidas: ${p.reason}`,
  init_metric_absent: (p) => `a métrica "${p.name}" não está no ficheiro de métricas`,
  init_no_metrics: () => 'nenhuma métrica seleccionada; usa --up e/ou --down',
  init_metric_conflict: (p) => `a métrica "${p.name}" não pode estar em --up e em --down`,
  git_show_failed: (p, t) => `não foi possível ler ${p.path} em ${p.ref}: `
    + `${reasonText(p.reason, t)}`,
  file_unreadable: (p) => `não foi possível ler ${p.path}: ${p.reason}`,
  json_invalid: (p) => `${p.path} não é JSON válido: ${p.reason}`,

  extractor_format_unknown: (p) => `formato de relatório desconhecido "${p.format}"; `
    + `formatos conhecidos: ${p.known}`,
  extractor_field_unknown: (p) => `o formato "${p.format}" não tem o campo "${p.field}"; `
    + `campos conhecidos: ${p.known}`,
  extractor_report_unparseable: (p, t) => `não foi possível interpretar o relatório `
    + `${p.format}: ${reasonText(p.reason, t)}`,
  extractor_report_empty: (p) => `o relatório ${p.format} não tem nada para medir`,
  extractor_option_invalid: (p, t) => `opção "${p.option}" inválida para o formato `
    + `"${p.format}": ${reasonText(p.reason, t)}`,

  reason_value_not_finite: (p) => `o valor extraído não é um número finito: ${p.value}`,
  reason_key_missing: (p) => `falta "${p.path}"`,
  reason_not_number: (p) => `"${p.path}" não é um número finito`,
  reason_not_count: (p) => `"${p.path}" não é um inteiro não negativo`,
  reason_not_array: (p) => `"${p.path}" não é uma lista`,
  reason_not_object: (p) => `"${p.path}" não é um objecto`,
  reason_not_array_of_objects: (p) => `"${p.path}" não é uma lista de objectos`,
  reason_not_string: (p) => `"${p.path}" não é texto`,
  reason_not_text: () => 'o conteúdo do relatório não é texto',
  reason_hit_exceeds_total: (p) => `a contagem de atingidos ${p.hit} excede o total ${p.total}`,
  reason_pointer_missing: () => 'em falta',
  reason_pointer_not_string: () => 'tem de ser texto',
  reason_pointer_not_absolute: (p) => `"${p.pointer}" tem de ser vazio ou começar por "/"`,
  reason_pointer_bad_escape: (p) => `"${p.pointer}" tem "~" sem "0" nem "1" a seguir`,
  reason_pointer_not_found: (p) => `o ponteiro "${p.pointer}" não existe`,
  reason_pointer_not_numeric: (p) => `o valor em "${p.pointer}" não é numérico `
    + `(encontrado: ${p.kind})`,
  reason_xml_no_element: () => 'não foi encontrado nenhum elemento XML',
  reason_xml_root: (p) => `o elemento raiz é <${p.found}>, esperava-se <${p.expected}>`,
  reason_attribute_missing: (p) => `falta o atributo "${p.name}" em <${p.element}>`,
  reason_attribute_not_number: (p) => `o atributo "${p.name}" não é um número: "${p.value}"`,
  reason_attribute_not_count: (p) => `o atributo "${p.name}" não é um inteiro não negativo: `
    + `"${p.value}"`,
  reason_attribute_out_of_range: (p) => `o atributo "${p.name}" não está entre ${p.min} e `
    + `${p.max}: "${p.value}"`,
  reason_junit_no_suite: () => 'não foi encontrado nenhum elemento <testsuites> nem <testsuite>',
  reason_lcov_no_record: () => 'não foi encontrado nenhum registo "SF:"',
  reason_lcov_invalid_value: (p) => `valor de "${p.key}" inválido: "${p.value}"`,
  reason_levels_invalid: (p) => `tem de ser uma lista não vazia de ${p.known}`,
  reason_level_unknown: (p) => `nível desconhecido "${p.level}"`,
  reason_rules_invalid: () => 'tem de ser uma lista não vazia de identificadores de regras, '
    + 'como ["CA1502"]',
  reason_sarif_version: (p) => `a versão SARIF "${p.version}" não é suportada, só a 2.1.0 `
    + '(no dotnet build, usa -p:ErrorLog=<ficheiro>.sarif%2Cversion=2.1)',
  reason_sarif_version_missing: () => 'o registo SARIF não tem "version"; só a 2.1.0 é '
    + 'suportada',
  reason_sarif_execution_failed: (p) => `"${p.run}" indica que a execução da ferramenta falhou`
    + withDetails(p.details),
  reason_eslint_not_array: () => 'esperava-se uma lista de resultados por ficheiro',
  reason_npm_audit_failed: (p) => `o npm audit falhou${withDetails(p.details)}`,
  reason_mutant_status_unknown: (p) => `estado de mutante desconhecido "${p.status}" em `
    + `"${p.path}"`,
  reason_not_a_revision: () => 'não é uma revisão: está vazia ou começa por "-"',

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
  log_tightened: (p) => `Melhorias por fixar: ${p.names}. O baseline actualizado está no `
    + 'sumário.',
  log_event_unreadable: (p) => `Não foi possível ler o payload do evento (${p.reason}); a `
    + 'execução segue sem contexto de pull request, por isso sem governação nem comentário.',
  log_pagination_truncated: (p) => `A leitura de ${p.path} parou ao fim de ${p.pages} páginas `
    + '(limite de segurança); as páginas seguintes foram ignoradas.',
  log_api_retry: (p) => `A API do GitHub ${p.method} ${p.path} devolveu ${p.status} `
    + `(tentativa ${p.attempt}); nova tentativa dentro de ${p.seconds} s.`,
  log_proxy_unsupported: () => 'Está definida uma variável de proxy (HTTPS_PROXY/HTTP_PROXY), '
    + 'mas este Node.js não a aplica ao fetch, por isso os pedidos à API vão directos. Se '
    + 'falharem, acrescenta NODE_USE_ENV_PROXY: "1" ao env do step.',
  proxy_invalid: (p) => `a configuração de proxy em HTTPS_PROXY/HTTP_PROXY é inválida: `
    + `${p.reason}`,
  log_comment_failed_generic: (p) => 'Não foi possível publicar o comentário de sumário '
    + `(${p.reason}). O resultado continua no sumário do job.`,
  comment_too_long: (p) => `o comentário tem ${p.length} caracteres, acima do limite de `
    + `${p.max} da API`,
  note_comment_abbreviated: () => 'Este comentário foi abreviado para caber no limite de '
    + 'tamanho dos comentários. O relatório completo está no sumário do job.',
  error_node_unsupported: (p) => `o quality-ratchet precisa do Node.js 20 ou posterior; este `
    + `passo corre no ${p.version}. Nos runners do Gitea e do Forgejo a action corre com o node `
    + 'da imagem do job: usa uma imagem com Node.js 20 ou posterior.',
  log_baseline_written: (p) => `Baseline actualizado escrito em ${p.path}.`,
  cli_written: (p) => `Escrito ${p.path}.`,
  cli_nothing_to_update: () => 'Nada a apertar: nenhuma métrica melhorou além da tolerância.',
  cli_nothing_to_rebaseline: () => 'Nada a alterar: o baseline já corresponde às medições.',
  cli_update_not_lowered: (p) => `Valores não baixados: ${p.names}. O check vai falhar até `
    + 'recuperarem; usa --allow-lower só se foi decidido baixar o baseline.',
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
