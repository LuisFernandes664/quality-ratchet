// @ts-check
/**
 * Escape de texto para o sumário em Markdown. Nomes de métricas, campos e títulos vêm de
 * ficheiros e de pull requests: sem escape, uma crase ou um `|` partem a tabela, e uma
 * quebra de linha seguida de `<!--` esconde o resto do relatório.
 */

/** Caracteres de controlo, incluindo as quebras de linha. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** Sequências de crases. */
const BACKTICK_RUNS = /`+/g;

/**
 * Texto numa só linha: cada carácter de controlo (quebras de linha incluídas) passa a
 * espaço, para o texto não abrir blocos novos no Markdown.
 * @param {string} text
 * @returns {string}
 */
export function oneLine(text) {
  return text.replace(CONTROL_CHARACTERS, ' ');
}

/**
 * Code span que mostra o texto tal como é. A cerca tem mais uma crase do que a maior
 * sequência de crases do texto. Quando o texto começa ou acaba em crase ou espaço, leva um
 * espaço de cada lado, que o Markdown retira ao apresentar.
 * @param {string} text
 * @returns {string}
 */
export function codeSpan(text) {
  const clean = oneLine(text);
  const runs = clean.match(BACKTICK_RUNS) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  const pad = /^[ `]|[ `]$/.test(clean) ? ' ' : '';
  return `${fence}${pad}${clean}${pad}${fence}`;
}

/**
 * Code span para uma célula de tabela: um `|` separaria colunas mesmo dentro do code span,
 * por isso é escapado (o GitHub mostra-o sem a barra).
 * @param {string} text
 * @returns {string}
 */
export function tableCode(text) {
  return codeSpan(text).replaceAll('|', '\\|');
}
