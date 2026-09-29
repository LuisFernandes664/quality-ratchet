// @ts-check
/**
 * Extractor de relatórios TRX do VSTest (`dotnet test --logger trx`). `tests`, `executed`,
 * `passed` e `failed` lêem os atributos `total`, `executed`, `passed` e `failed` dos
 * `<Counters>` do `<ResultSummary>`. `skipped` conta os `<UnitTestResult>` com
 * `outcome="NotExecuted"`, os testes ignorados em tempo de execução: os `<Counters>` não os
 * contam de forma fiável (o logger TRX do VSTest conta-os em `total` e deixa `notExecuted`
 * a 0).
 *
 * Mede um só ficheiro: numa solução com vários projectos de testes, o `dotnet test` escreve
 * um TRX por projecto. Para os medir juntos, a `source` da métrica pode ser a lista desses
 * ficheiros, cujos valores se somam.
 */

import {
  because,
  defineExtractor,
  isCount,
  parseStrictNumber,
  reportEmpty,
  requireContent,
  rootAttributes,
  stripXmlNoise,
  tagAttributes,
  unparseable,
} from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

const FORMAT = 'trx';

/** Elemento raiz esperado. */
const ROOT = 'TestRun';

/** Elemento com as contagens da execução, dentro de `<ResultSummary>`. */
const COUNTERS = 'Counters';

/**
 * Atributo de `<Counters>` lido por cada campo de contagem.
 * @type {Record<string, string>}
 */
const COUNTER_ATTRIBUTES = {
  tests: 'total',
  executed: 'executed',
  passed: 'passed',
  failed: 'failed',
};

/** `outcome` de um teste que não correu. */
const NOT_EXECUTED = 'NotExecuted';

/** Elemento `<ResultSummary>` inteiro, com o conteúdo. */
const RESULT_SUMMARY = /<ResultSummary(?=[\s>])[\s\S]*?<\/ResultSummary>/;

/** Extractor do formato `trx`. */
export const trxExtractor = defineExtractor({
  format: FORMAT,
  fields: [...Object.keys(COUNTER_ATTRIBUTES), 'skipped'],
  read: readTrx,
});

/**
 * Lê a contagem do campo pedido. Uma execução sem testes (`total="0"`, ex: um `--filter`
 * sem correspondências) não tem nada para medir.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readTrx(text, request) {
  const xml = stripXmlNoise(requireContent(text, FORMAT));
  rootAttributes(xml, ROOT, FORMAT);
  const counters = summaryCounters(xml);
  if (readCounter(counters, 'total') === 0) throw reportEmpty(FORMAT);
  if (request.field === 'skipped') return countNotExecuted(xml);
  return readCounter(counters, COUNTER_ATTRIBUTES[request.field]);
}

/**
 * Atributos dos `<Counters>` do `<ResultSummary>`.
 * @param {string} xml documento sem comentários nem CDATA
 * @returns {Map<string, string>}
 */
function summaryCounters(xml) {
  const summary = RESULT_SUMMARY.exec(xml);
  const [counters] = summary ? tagAttributes(summary[0], COUNTERS) : [];
  if (!counters) throw unparseable(FORMAT, because('reason_trx_no_counters'));
  return counters;
}

/**
 * Lê uma contagem (inteiro não negativo) de `<Counters>`.
 * @param {Map<string, string>} counters
 * @param {string} name nome do atributo
 * @returns {number}
 */
function readCounter(counters, name) {
  const raw = counters.get(name);
  if (raw === undefined) {
    throw unparseable(FORMAT, because('reason_attribute_missing', { name, element: COUNTERS }));
  }
  const count = parseStrictNumber(raw);
  if (isCount(count)) return count;
  throw unparseable(FORMAT, because('reason_attribute_not_count', { name, value: raw }));
}

/**
 * Conta os `<UnitTestResult>` com `outcome="NotExecuted"`.
 * @param {string} xml
 * @returns {number}
 */
function countNotExecuted(xml) {
  return tagAttributes(xml, 'UnitTestResult')
    .filter((attributes) => attributes.get('outcome') === NOT_EXECUTED)
    .length;
}
