// @ts-check
/**
 * Extractor de relatórios JUnit XML (Maven Surefire, Gradle, pytest, jest-junit, Vitest, ...).
 * `tests` e `skipped` contam os elementos `<testcase>` e `<skipped>`, com ou sem filhos.
 * `failures` e `errors` contam os `<testcase>` com pelo menos um `<failure>` (ou `<error>`):
 * o Vitest escreve um `<failure>` por cada erro do teste (ex: vários `expect.soft`) e o
 * jest-junit um por mensagem (ex: o teste e o `afterEach` falham), mas é um só teste falhado.
 * Um teste com `<failure>` e `<error>` conta nos dois campos.
 */

import {
  because,
  countTags,
  defineExtractor,
  reportEmpty,
  requireContent,
  stripXmlNoise,
  unparseable,
} from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

const FORMAT = 'junit';

/**
 * Elemento contado por cada campo: os próprios elementos em `tests` e `skipped`, os
 * `<testcase>` que o contêm em `failures` e `errors`.
 * @type {Record<string, string>}
 */
const ELEMENTS = {
  tests: 'testcase',
  failures: 'failure',
  errors: 'error',
  skipped: 'skipped',
};

/** Campos que contam os testes falhados e não os elementos. */
const FAILED_CASE_FIELDS = new Set(['failures', 'errors']);

/**
 * Tag de abertura, de fecho ou auto-fechada de `<testcase>`, `<failure>` ou `<error>`.
 * Grupos: barra de fecho, nome, barra de auto-fecho. Os valores dos atributos podem ter `>`.
 * O nome tem de acabar ali, para não confundir `<errors>` ou `<failureDetail>` com eles.
 */
const CASE_TAG = /<(\/?)(testcase|failure|error)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*?(\/?)>/g;

/** Extractor do formato `junit`. */
export const junitExtractor = defineExtractor({
  format: FORMAT,
  fields: Object.keys(ELEMENTS),
  read: readJunit,
});

/**
 * Conta os elementos ou os testes do campo pedido. Exige um `<testsuites>` ou
 * `<testsuite>` e pelo menos um `<testcase>`; um ficheiro vazio não tem nada para medir.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readJunit(text, request) {
  const xml = requireContent(text, FORMAT);
  if (countTags(xml, 'testsuites') + countTags(xml, 'testsuite') === 0) {
    throw unparseable(FORMAT, because('reason_junit_no_suite'));
  }
  if (countTags(xml, 'testcase') === 0) throw reportEmpty(FORMAT);
  const element = ELEMENTS[request.field];
  return FAILED_CASE_FIELDS.has(request.field)
    ? countFailedCases(xml, element)
    : countTags(xml, element);
}

/**
 * Conta os `<testcase>` com pelo menos um filho `child`. Um `<testcase/>` auto-fechado não
 * tem filhos, e um `child` fora de um `<testcase>` não conta. Ignora o texto de comentários
 * e de CDATA.
 * @param {string} xml
 * @param {string} child 'failure' ou 'error'
 * @returns {number}
 */
function countFailedCases(xml, child) {
  let count = 0;
  let open = false;
  let failed = false;
  for (const [, closing, name, selfClosing] of stripXmlNoise(xml).matchAll(CASE_TAG)) {
    if (name === 'testcase' && closing) {
      if (open && failed) count += 1;
      open = false;
    } else if (name === 'testcase') {
      open = selfClosing === '';
      failed = false;
    } else if (name === child && open && !closing) {
      failed = true;
    }
  }
  return count;
}
