// @ts-check
/**
 * Extractor de relatórios JUnit XML (Maven Surefire, Gradle, pytest, jest-junit, ...). Conta
 * os elementos `<testcase>`, `<failure>`, `<error>` e `<skipped>`, com ou sem filhos.
 */

import {
  countTags,
  defineExtractor,
  reportEmpty,
  requireContent,
  unparseable,
} from './shared.js';

/** @typedef {import('./shared.js').ReadRequest} ReadRequest */

const FORMAT = 'junit';

/**
 * Elemento contado por cada campo.
 * @type {Record<string, string>}
 */
const ELEMENTS = {
  tests: 'testcase',
  failures: 'failure',
  errors: 'error',
  skipped: 'skipped',
};

/** Extractor do formato `junit`. */
export const junitExtractor = defineExtractor({
  format: FORMAT,
  fields: Object.keys(ELEMENTS),
  read: readJunit,
});

/**
 * Conta os elementos do campo pedido. Exige um `<testsuites>` ou `<testsuite>` e pelo
 * menos um `<testcase>`; um ficheiro vazio não tem nada para medir.
 * @param {string} text
 * @param {ReadRequest} request
 * @returns {number}
 */
function readJunit(text, request) {
  const xml = requireContent(text, FORMAT);
  if (countTags(xml, 'testsuites') + countTags(xml, 'testsuite') === 0) {
    throw unparseable(FORMAT, 'no <testsuites> or <testsuite> element found');
  }
  if (countTags(xml, 'testcase') === 0) throw reportEmpty(FORMAT);
  return countTags(xml, ELEMENTS[request.field]);
}
