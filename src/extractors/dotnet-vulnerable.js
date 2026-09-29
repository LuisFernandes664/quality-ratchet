// @ts-check
/**
 * Extractor da saída de `dotnet list package --vulnerable --include-transitive --format json`.
 * Conta os advisories distintos de cada versão de pacote, directo ou transitivo: a chave é
 * `id@resolvedVersion` com o `advisoryurl`, sem repetições entre projectos e frameworks. O
 * mesmo pacote vulnerável em cinco projectos de uma solução (ou nas duas frameworks de um
 * projecto) conta uma vez; o mesmo advisory em duas versões do pacote conta duas vezes. O
 * NuGet não distingue maiúsculas de minúsculas no id nem na versão: `Newtonsoft.Json` e
 * `newtonsoft.json` são o mesmo pacote.
 *
 * Rejeita o relatório quando `problems` tem erros (ex: um projecto sem restore), porque os
 * pacotes desses projectos ficam por listar e a contagem sairia incompleta, e quando
 * `parameters` mostra que a listagem não foi feita com `--vulnerable` (ex:
 * `--outdated`): esses pacotes não trazem vulnerabilidades e a contagem daria 0.
 */

import { isPlainObject } from '../core/guards.js';
import { because, defineExtractor, parseJson, readPath, unparseable } from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

/**
 * Objecto do relatório com a sua posição, para as mensagens (ex: `projects[0].frameworks[1]`).
 * @typedef {{value: Record<string, unknown>, path: string}} Located
 */

const FORMAT = 'dotnet-vulnerable';

/** Severidades do NuGet, da mais grave para a menos grave. */
const SEVERITIES = ['Critical', 'High', 'Moderate', 'Low'];

/**
 * Severidades contadas por cada campo.
 * @type {Record<string, string[]>}
 */
const FIELD_SEVERITIES = {
  total: SEVERITIES,
  critical: ['Critical'],
  high: ['High'],
  moderate: ['Moderate'],
  low: ['Low'],
  'high+': ['Critical', 'High'],
  'moderate+': ['Critical', 'High', 'Moderate'],
  'low+': SEVERITIES,
};

/** Listas de pacotes de cada framework: os directos e os transitivos. */
const PACKAGE_LISTS = ['topLevelPackages', 'transitivePackages'];

/** Opção `--vulnerable` na linha de parâmetros da listagem. */
const VULNERABLE_OPTION = /(^|\s)--vulnerable(\s|$)/;

/** Sequência de espaços em branco, incluindo quebras de linha. */
const WHITESPACE = /\s+/g;

/** Extractor do formato `dotnet-vulnerable`. */
export const dotnetVulnerableExtractor = defineExtractor({
  format: FORMAT,
  fields: Object.keys(FIELD_SEVERITIES),
  read: readDotnetVulnerable,
});

/**
 * Conta os advisories distintos com a severidade do campo pedido. Sem projectos, ou sem
 * pacotes vulneráveis, conta 0.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readDotnetVulnerable(text, request) {
  const document = parseJson(text, FORMAT);
  rejectOtherListing(document);
  rejectProblems(document);
  const counted = FIELD_SEVERITIES[request.field];
  return [...advisories(document).values()]
    .filter((severity) => counted.includes(severity))
    .length;
}

/**
 * Rejeita uma listagem feita sem `--vulnerable`. Sem `parameters` o relatório é aceite: a
 * verificação só usa o que o próprio `dotnet` declara.
 * @param {unknown} document
 * @returns {void}
 */
function rejectOtherListing(document) {
  const parameters = isPlainObject(document) ? document.parameters : undefined;
  if (typeof parameters !== 'string' || VULNERABLE_OPTION.test(parameters)) return;
  throw unparseable(FORMAT, because('reason_dotnet_not_vulnerable', {
    parameters: oneLineText(parameters),
  }));
}

/**
 * Rejeita o relatório quando `problems` tem entradas de nível "error": o `dotnet` lista os
 * outros projectos, mas não os pacotes do projecto com o erro (ex: sem `project.assets.json`,
 * porque o restore não correu). Os avisos não mudam a lista. O motivo junta os textos dos
 * erros numa só linha.
 * @param {unknown} document
 * @returns {void}
 */
function rejectProblems(document) {
  const problems = isPlainObject(document) && Array.isArray(document.problems)
    ? document.problems
    : [];
  const errors = problems.filter((problem) => isPlainObject(problem)
    && problem.level === 'error');
  if (errors.length === 0) return;
  const details = errors.map((problem) => oneLineText(problem.text)).filter(Boolean).join('; ');
  throw unparseable(FORMAT, because('reason_dotnet_list_errors', { details }));
}

/**
 * Texto numa só linha, sem espaços repetidos nem nas pontas, ou texto vazio quando o valor
 * não é texto.
 * @param {unknown} value
 * @returns {string}
 */
function oneLineText(value) {
  return typeof value === 'string' ? value.replace(WHITESPACE, ' ').trim() : '';
}

/**
 * Advisories distintos de todos os projectos e frameworks, com a severidade de cada um.
 * @param {unknown} document
 * @returns {Map<string, string>} chave `id@versão|advisoryurl` -> severidade
 */
function advisories(document) {
  const frameworks = children(projectList(document), 'frameworks');
  const packages = PACKAGE_LISTS.flatMap((key) => children(frameworks, key));
  return new Map(packages.flatMap(packageAdvisories));
}

/**
 * Projectos do relatório, com a posição de cada um.
 * @param {unknown} document
 * @returns {Located[]}
 */
function projectList(document) {
  const projects = readPath(document, ['projects'], FORMAT);
  if (!Array.isArray(projects) || !projects.every((project) => isPlainObject(project))) {
    throw unparseable(FORMAT, because('reason_not_array_of_objects', { path: 'projects' }));
  }
  return projects.map((value, index) => ({ value, path: `projects[${index}]` }));
}

/**
 * Objectos das listas `key` de cada pai (ex: os `frameworks` de cada projecto), com a
 * posição de cada um. Um pai sem a lista não tem filhos: um projecto sem pacotes vulneráveis
 * só tem `path`.
 * @param {Located[]} parents
 * @param {string} key
 * @returns {Located[]}
 */
function children(parents, key) {
  return parents.flatMap(({ value, path }) => {
    const list = value[key] ?? [];
    if (!Array.isArray(list) || !list.every((item) => isPlainObject(item))) {
      const listPath = `${path}.${key}`;
      throw unparseable(FORMAT, because('reason_not_array_of_objects', { path: listPath }));
    }
    return list.map((child, index) => ({ value: child, path: `${path}.${key}[${index}]` }));
  });
}

/**
 * Advisories de um pacote, como pares chave -> severidade. A chave junta o id e a versão
 * resolvida, em minúsculas, ao `advisoryurl`.
 * @param {Located} entry pacote de `topLevelPackages` ou de `transitivePackages`
 * @returns {Array<[string, string]>}
 */
function packageAdvisories(entry) {
  const identity = `${textOf(entry, 'id')}@${textOf(entry, 'resolvedVersion')}`.toLowerCase();
  return children([entry], 'vulnerabilities').map((vulnerability) => [
    `${identity}|${textOf(vulnerability, 'advisoryurl')}`,
    severityOf(vulnerability),
  ]);
}

/**
 * Texto de uma propriedade de um objecto do relatório.
 * @param {Located} entry
 * @param {string} key
 * @returns {string}
 */
function textOf(entry, key) {
  const text = entry.value[key];
  if (typeof text === 'string') return text;
  throw unparseable(FORMAT, because('reason_not_string', { path: `${entry.path}.${key}` }));
}

/**
 * Valida e devolve a severidade de um advisory. Uma severidade fora das quatro do NuGet
 * (ex: vazia) não tem campo onde contar.
 * @param {Located} vulnerability
 * @returns {string}
 */
function severityOf(vulnerability) {
  const { severity } = vulnerability.value;
  if (typeof severity === 'string' && SEVERITIES.includes(severity)) return severity;
  throw unparseable(FORMAT, because('reason_severity_unknown', {
    severity: String(severity),
    path: vulnerability.path,
    known: SEVERITIES.join(', '),
  }));
}
