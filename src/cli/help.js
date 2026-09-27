// @ts-check
/**
 * Texto de ajuda da CLI, em inglês e português europeu. Cada língua descreve os comandos e
 * as opções como dados; a formatação em colunas é comum.
 */
import { DEFAULTS } from './defaults.js';

/**
 * @typedef {object} HelpSection
 * @property {string} title
 * @property {Array<[string, string]>} rows pares [opção ou comando, descrição]
 */

/**
 * @typedef {object} HelpText
 * @property {string} usage
 * @property {string} intro
 * @property {HelpSection[]} sections
 * @property {string} exit
 */

/** Largura da coluna das opções. */
const COLUMN = 34;

/** @type {HelpText} */
const EN = {
  usage: 'Usage: quality-ratchet [command] [options]',
  intro: 'Fails when a quality metric regresses against a versioned baseline.',
  sections: [
    {
      title: 'Commands',
      rows: [
        ['check', 'Compare the measurements with the baseline (default command)'],
        ['update', 'Lock the measured improvements into the baseline file'],
        ['init', 'Create a v2 baseline from a flat metrics file'],
        ['migrate', 'Convert a v1 baseline to the v2 format'],
      ],
    },
    {
      title: 'check options',
      rows: [
        ['--baseline <path>', `Baseline file (default: ${DEFAULTS.baseline})`],
        ['--metrics <path>', `Flat metrics file (default: ${DEFAULTS.metrics})`],
        ['--base-ref <ref>', 'Git ref whose baseline is the contract (enables governance)'],
        ['--title <text>', 'Pull request title, matched against the lower-baseline pattern'],
        ['--labels <a,b>', 'Pull request labels, comma separated'],
        ['--bypass-label <label>',
          `Label that forgives a failure (default: ${DEFAULTS.bypassLabel})`],
        ['--lower-baseline-pattern <regex>',
          'Title pattern that authorises loosening the baseline'],
        ['', `(default: ${DEFAULTS.lowerBaselinePattern})`],
        ['--strict', 'Fail when improvements are not locked into the baseline'],
        ['--name <name>', 'Name of this ratchet, shown in the summary title'],
        ['--format <markdown|json>', `Output format (default: ${DEFAULTS.format})`],
        ['--write-baseline <path>', 'Write the tightened baseline to this file'],
      ],
    },
    {
      title: 'update options',
      rows: [
        ['--baseline <path>', `Baseline file (default: ${DEFAULTS.baseline})`],
        ['--metrics <path>', `Flat metrics file (default: ${DEFAULTS.metrics})`],
        ['--allow-lower', 'Re-freeze every value, regressions included'],
        ['--output <path>', 'File to write (default: the baseline file)'],
      ],
    },
    {
      title: 'init options',
      rows: [
        ['--metrics <path>', 'Flat metrics file to read (required)'],
        ['--up <a,b>', 'Metrics that may only go up'],
        ['--down <c,d>', 'Metrics that may only go down'],
        ['--output <path>', `File to write (default: ${DEFAULTS.baseline})`],
        ['--force', 'Overwrite an existing file'],
      ],
    },
    {
      title: 'migrate options',
      rows: [
        ['--baseline <path>', `Baseline to convert (default: ${DEFAULTS.baseline})`],
        ['--output <path>', 'File to write (default: the baseline file)'],
      ],
    },
    {
      title: 'Common options',
      rows: [
        ['--language <en|pt>', `Language of the messages (default: ${DEFAULTS.language})`],
        ['-h, --help', 'Show this help'],
        ['-v, --version', 'Show the version'],
      ],
    },
  ],
  exit: 'Exit codes: 0 passed, 1 the ratchet failed, 2 usage or configuration error.',
};

/** @type {HelpText} */
const PT = {
  usage: 'Utilização: quality-ratchet [comando] [opções]',
  intro: 'Falha quando uma métrica de qualidade regride face a um baseline versionado.',
  sections: [
    {
      title: 'Comandos',
      rows: [
        ['check', 'Compara as medições com o baseline (comando por omissão)'],
        ['update', 'Fixa no ficheiro do baseline as melhorias medidas'],
        ['init', 'Cria um baseline v2 a partir de um ficheiro de métricas plano'],
        ['migrate', 'Converte um baseline v1 para o formato v2'],
      ],
    },
    {
      title: 'Opções de check',
      rows: [
        ['--baseline <caminho>', `Ficheiro do baseline (omissão: ${DEFAULTS.baseline})`],
        ['--metrics <caminho>', `Ficheiro de métricas plano (omissão: ${DEFAULTS.metrics})`],
        ['--base-ref <ref>', 'Revisão git cujo baseline é o contrato (activa a governação)'],
        ['--title <texto>', 'Título do pull request, comparado com o padrão de descida'],
        ['--labels <a,b>', 'Labels do pull request, separadas por vírgulas'],
        ['--bypass-label <label>',
          `Label que perdoa uma falha (omissão: ${DEFAULTS.bypassLabel})`],
        ['--lower-baseline-pattern <regex>',
          'Padrão do título que autoriza afrouxar o baseline'],
        ['', `(omissão: ${DEFAULTS.lowerBaselinePattern})`],
        ['--strict', 'Falha quando há melhorias por fixar no baseline'],
        ['--name <nome>', 'Nome desta catraca, mostrado no título do sumário'],
        ['--format <markdown|json>', `Formato da saída (omissão: ${DEFAULTS.format})`],
        ['--write-baseline <caminho>', 'Escreve o baseline apertado neste ficheiro'],
      ],
    },
    {
      title: 'Opções de update',
      rows: [
        ['--baseline <caminho>', `Ficheiro do baseline (omissão: ${DEFAULTS.baseline})`],
        ['--metrics <caminho>', `Ficheiro de métricas plano (omissão: ${DEFAULTS.metrics})`],
        ['--allow-lower', 'Recongela todos os valores, incluindo regressões'],
        ['--output <caminho>', 'Ficheiro a escrever (omissão: o próprio baseline)'],
      ],
    },
    {
      title: 'Opções de init',
      rows: [
        ['--metrics <caminho>', 'Ficheiro de métricas plano a ler (obrigatório)'],
        ['--up <a,b>', 'Métricas que só podem subir'],
        ['--down <c,d>', 'Métricas que só podem descer'],
        ['--output <caminho>', `Ficheiro a escrever (omissão: ${DEFAULTS.baseline})`],
        ['--force', 'Substitui um ficheiro existente'],
      ],
    },
    {
      title: 'Opções de migrate',
      rows: [
        ['--baseline <caminho>', `Baseline a converter (omissão: ${DEFAULTS.baseline})`],
        ['--output <caminho>', 'Ficheiro a escrever (omissão: o próprio baseline)'],
      ],
    },
    {
      title: 'Opções comuns',
      rows: [
        ['--language <en|pt>', `Língua das mensagens (omissão: ${DEFAULTS.language})`],
        ['-h, --help', 'Mostra esta ajuda'],
        ['-v, --version', 'Mostra a versão'],
      ],
    },
  ],
  exit: 'Códigos de saída: 0 verde, 1 a catraca falhou, 2 erro de utilização ou de '
    + 'configuração.',
};

/**
 * Textos de ajuda por língua.
 * @type {Readonly<Record<string, HelpText>>}
 */
export const HELP = Object.freeze({ en: EN, pt: PT });

/**
 * Texto de ajuda completo numa língua (inglês quando a língua não tem ajuda).
 * @param {string} language código normalizado ('en', 'pt')
 * @returns {string}
 */
export function helpText(language) {
  const help = Object.hasOwn(HELP, language) ? HELP[language] : HELP.en;
  const sections = help.sections.flatMap(renderSection);
  return [help.usage, '', help.intro, '', ...sections, help.exit].join('\n');
}

/**
 * Secção em duas colunas, seguida de uma linha em branco.
 * @param {HelpSection} section
 * @returns {string[]}
 */
function renderSection(section) {
  const rows = section.rows.map(([name, text]) => `  ${name.padEnd(COLUMN)}${text}`.trimEnd());
  return [`${section.title}:`, ...rows, ''];
}
