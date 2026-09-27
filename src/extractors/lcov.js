// @ts-check
/**
 * Extractor de relatórios LCOV (`lcov.info`). Cada ficheiro fonte conta com os totais de
 * resumo do seu registo (LH/LF, BRH/BRF, FNH/FNF), somados sobre todos os ficheiros.
 *
 * O mesmo ficheiro pode ter vários registos: um por nome de teste (`TN:`) quando o tracefile
 * vem de `lcov --capture --test-name` combinado com `lcov -a`, ou repetidos quando se
 * concatenam relatórios (shards, projectos de um monorepo). Somar os resumos contaria o
 * ficheiro várias vezes. Os registos com o mesmo `SF:` e os mesmos elementos medidos (as
 * mesmas linhas DA, ramos BRDA ou funções FNDA/FNA) juntam-se pela união: um elemento está
 * coberto se algum registo o cobre, como no `lcov --summary` e no genhtml. Registos com o
 * mesmo `SF:` mas elementos diferentes (ex: `src/index.js` de dois pacotes com caminhos
 * relativos) são ficheiros diferentes e somam-se. Sem linhas de detalhe, os registos com o
 * mesmo total juntam-se pelo maior número de atingidos, o limite inferior da união.
 */

import {
  because,
  defineExtractor,
  percentage,
  requireContent,
  unparseable,
} from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

/**
 * Registo de um ficheiro fonte: o bloco entre `SF:` e `end_of_record`.
 * @typedef {object} LcovRecord
 * @property {string} source caminho do `SF:`
 * @property {Map<string, number>} summary contadores de resumo (LF, LH, BRF, ...)
 * @property {Record<string, Map<string, boolean>>} detail por campo: elemento -> atingido
 * @property {Map<string, string>} functionLines índice de `FNL:` -> linhas da função
 */

/**
 * Totais de um campo: elementos atingidos e encontrados.
 * @typedef {{hit: number, found: number}} Totals
 */

const FORMAT = 'lcov';

/**
 * Chaves de resumo (atingidos, encontrados) de cada campo.
 * @type {Record<string, [string, string]>}
 */
const COUNTERS = {
  lines: ['LH', 'LF'],
  branches: ['BRH', 'BRF'],
  functions: ['FNH', 'FNF'],
};

/** Chaves das linhas de resumo de um registo, ex: `LF:12`. */
const SUMMARY_KEYS = new Set(Object.values(COUNTERS).flat());

/** Valor de contagem aceite numa linha de resumo. */
const COUNT = /^\d+$/;

/** `DA:<linha>,<execuções>[,<checksum>]`. */
const LINE_DETAIL = /^(\d+),(-?\d+)(?:,.*)?$/;

/**
 * `BRDA:<linha>,<bloco>,<ramo>,<vezes>`: o ramo é tudo até à última vírgula (no lcov 2 pode
 * ser uma expressão com vírgulas) e o bloco pode ter o prefixo "e" (excepção); `<vezes>` é
 * "-" quando o bloco nunca correu.
 */
const BRANCH_DETAIL = /^(\d+,[^,]+,.+),(-|-?\d+)$/;

/** `FNDA:<execuções>,<nome>`: o nome pode ter vírgulas (ex: função C++ com parâmetros). */
const FUNCTION_DETAIL = /^(-?\d+),(.+)$/;

/** `FNL:<índice>,<linha inicial>[,<linha final>]` do lcov 2.2 e seguintes. */
const FUNCTION_LINES_DETAIL = /^(\d+),(.+)$/;

/** `FNA:<índice>,<execuções>,<nome>`: um nome (alias) da função `FNL` com esse índice. */
const FUNCTION_ALIAS_DETAIL = /^(\d+),(-?\d+),(.+)$/;

/**
 * Leitura de cada linha de detalhe, pelo prefixo.
 * @type {Map<string, (record: LcovRecord, value: string) => void>}
 */
const DETAIL_READERS = new Map([
  ['DA', readLineDetail],
  ['BRDA', readBranchDetail],
  ['FNDA', readFunctionDetail],
  ['FNL', readFunctionLines],
  ['FNA', readFunctionAlias],
]);

/** Extractor do formato `lcov`. */
export const lcovExtractor = defineExtractor({
  format: FORMAT,
  fields: ['lines', 'branches', 'functions'],
  read: readLcov,
});

/**
 * Calcula a percentagem de cobertura do campo pedido.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readLcov(text, request) {
  /** @type {Totals} */
  const totals = { hit: 0, found: 0 };
  for (const group of groupBySource(parseRecords(splitLines(text)), request.field)) {
    const file = fileTotals(group, request.field);
    totals.hit += file.hit;
    totals.found += file.found;
  }
  return percentage(totals.hit, totals.found, FORMAT);
}

/**
 * Divide o relatório em linhas sem espaços nas pontas e valida que tem registos.
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  const lines = requireContent(text, FORMAT).split(/\r?\n/).map((line) => line.trim());
  if (!lines.some((line) => line.startsWith('SF:'))) {
    throw unparseable(FORMAT, because('reason_lcov_no_record'));
  }
  return lines;
}

/**
 * Separa o relatório em registos. Um registo começa em `SF:` e acaba em `end_of_record`
 * (ou no `SF:` seguinte, se o fim faltar); as linhas fora de registos (ex: `TN:`) não contam.
 * @param {string[]} lines
 * @returns {LcovRecord[]}
 */
function parseRecords(lines) {
  /** @type {LcovRecord[]} */
  const records = [];
  /** @type {LcovRecord|null} */
  let current = null;
  for (const line of lines) {
    if (line.startsWith('SF:')) {
      current = newRecord(line.slice('SF:'.length));
      records.push(current);
    } else if (line === 'end_of_record') {
      current = null;
    } else if (current !== null) {
      readRecordLine(current, line);
    }
  }
  return records;
}

/**
 * Cria um registo vazio para um ficheiro fonte.
 * @param {string} source
 * @returns {LcovRecord}
 */
function newRecord(source) {
  return {
    source,
    summary: new Map(),
    detail: { lines: new Map(), branches: new Map(), functions: new Map() },
    functionLines: new Map(),
  };
}

/**
 * Lê uma linha de um registo: resumo, detalhe ou outra (ignorada, ex: `FN:`, `VER:`).
 * @param {LcovRecord} record
 * @param {string} line
 * @returns {void}
 */
function readRecordLine(record, line) {
  const separator = line.indexOf(':');
  if (separator < 0) return;
  const key = line.slice(0, separator);
  const value = line.slice(separator + 1);
  if (SUMMARY_KEYS.has(key)) {
    record.summary.set(key, (record.summary.get(key) ?? 0) + parseCount(key, value));
  } else {
    DETAIL_READERS.get(key)?.(record, value);
  }
}

/**
 * Converte o valor de uma linha de resumo numa contagem.
 * @param {string} key
 * @param {string} value
 * @returns {number}
 */
function parseCount(key, value) {
  if (COUNT.test(value)) return Number(value);
  throw invalidValue(key, value);
}

/**
 * Regista uma linha `DA:`.
 * @param {LcovRecord} record
 * @param {string} value
 * @returns {void}
 */
function readLineDetail(record, value) {
  const [line, count] = matchDetail('DA', value, LINE_DETAIL);
  markHit(record.detail.lines, line, Number(count) > 0);
}

/**
 * Regista uma linha `BRDA:`.
 * @param {LcovRecord} record
 * @param {string} value
 * @returns {void}
 */
function readBranchDetail(record, value) {
  const [branch, taken] = matchDetail('BRDA', value, BRANCH_DETAIL);
  markHit(record.detail.branches, branch, taken !== '-' && Number(taken) > 0);
}

/**
 * Regista uma linha `FNDA:`, identificando a função pelo nome.
 * @param {LcovRecord} record
 * @param {string} value
 * @returns {void}
 */
function readFunctionDetail(record, value) {
  const [count, name] = matchDetail('FNDA', value, FUNCTION_DETAIL);
  markHit(record.detail.functions, name, Number(count) > 0);
}

/**
 * Regista as linhas de uma função `FNL:`, a que os `FNA:` seguintes se referem pelo índice.
 * @param {LcovRecord} record
 * @param {string} value
 * @returns {void}
 */
function readFunctionLines(record, value) {
  const [index, location] = matchDetail('FNL', value, FUNCTION_LINES_DETAIL);
  record.functionLines.set(index, location);
}

/**
 * Regista uma linha `FNA:`. Os aliases de uma função partilham as linhas do `FNL:` e contam
 * como uma só função, como no FNF do lcov.
 * @param {LcovRecord} record
 * @param {string} value
 * @returns {void}
 */
function readFunctionAlias(record, value) {
  const [index, count, name] = matchDetail('FNA', value, FUNCTION_ALIAS_DETAIL);
  const location = record.functionLines.get(index);
  const key = location === undefined ? name : `@${location}`;
  markHit(record.detail.functions, key, Number(count) > 0);
}

/**
 * Valida o valor de uma linha de detalhe e devolve os grupos capturados.
 * @param {string} key prefixo da linha (ex: 'DA')
 * @param {string} value texto depois de "<prefixo>:"
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function matchDetail(key, value, pattern) {
  const match = pattern.exec(value);
  if (match) return match.slice(1);
  throw invalidValue(key, value);
}

/**
 * Marca um elemento como encontrado e, se `hit`, como atingido.
 * @param {Map<string, boolean>} elements
 * @param {string} key
 * @param {boolean} hit
 * @returns {void}
 */
function markHit(elements, key, hit) {
  elements.set(key, elements.get(key) === true || hit);
}

/**
 * Agrupa os registos que descrevem o mesmo ficheiro: o mesmo `SF:` e os mesmos elementos
 * medidos no campo (ou, sem detalhe, o mesmo total no resumo).
 * @param {LcovRecord[]} records
 * @param {string} field
 * @returns {Iterable<LcovRecord[]>}
 */
function groupBySource(records, field) {
  /** @type {Map<string, LcovRecord[]>} */
  const groups = new Map();
  for (const record of records) {
    const key = JSON.stringify([record.source, measuredElements(record, field)]);
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  return groups.values();
}

/**
 * Identifica o que um registo mede num campo: as chaves das linhas de detalhe, ordenadas,
 * ou o total do resumo quando não há detalhe.
 * @param {LcovRecord} record
 * @param {string} field
 * @returns {string[]|number}
 */
function measuredElements(record, field) {
  const detail = record.detail[field];
  if (detail.size > 0) return [...detail.keys()].sort();
  return summaryValue(record, COUNTERS[field][1]);
}

/**
 * Totais de um ficheiro a partir dos seus registos. Um só registo usa o resumo; vários
 * registos com detalhe usam a união; vários sem detalhe usam o maior número de atingidos.
 * @param {LcovRecord[]} group registos do mesmo ficheiro, com os mesmos elementos
 * @param {string} field
 * @returns {Totals}
 */
function fileTotals(group, field) {
  const [hitKey, foundKey] = COUNTERS[field];
  const elements = group[0].detail[field];
  if (group.length === 1 || elements.size === 0) {
    const hit = group.reduce((max, record) => Math.max(max, summaryValue(record, hitKey)), 0);
    return { hit, found: summaryValue(group[0], foundKey) };
  }
  let hit = 0;
  for (const key of elements.keys()) {
    if (group.some((record) => record.detail[field].get(key) === true)) hit += 1;
  }
  return { hit, found: elements.size };
}

/**
 * Valor de um contador de resumo de um registo; 0 quando falta.
 * @param {LcovRecord} record
 * @param {string} key
 * @returns {number}
 */
function summaryValue(record, key) {
  return record.summary.get(key) ?? 0;
}

/**
 * Cria o erro de valor inválido numa linha do relatório.
 * @param {string} key
 * @param {string} value
 * @returns {import('../core/errors.js').ExtractorError}
 */
function invalidValue(key, value) {
  return unparseable(FORMAT, because('reason_lcov_invalid_value', { key, value }));
}
