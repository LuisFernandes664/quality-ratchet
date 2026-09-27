// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extract } from '../../src/extractors/index.js';
import { pipAuditExtractor } from '../../src/extractors/pip-audit.js';

const FORMAT = 'pip-audit';
const UNPARSEABLE = { name: 'ExtractorError', code: 'extractor_report_unparseable' };

const FLASK = {
  name: 'flask',
  version: '0.5',
  vulns: [
    {
      id: 'PYSEC-2019-179',
      fix_versions: ['1.0'],
      aliases: ['CVE-2019-1010083'],
      description: 'The Pallets Project Flask before 1.0 is affected by unexpected memory usage.',
    },
    {
      id: 'PYSEC-2018-66',
      fix_versions: ['0.12.3'],
      aliases: ['CVE-2018-1000656'],
      description: 'The Pallets Project flask version before 0.12.3 contains a CWE-20 issue.',
    },
  ],
};

const REQUESTS = {
  name: 'requests',
  version: '2.25.0',
  vulns: [{
    id: 'GHSA-j8r2-6x86-q33q',
    fix_versions: ['2.31.0'],
    aliases: ['CVE-2023-32681'],
    description: 'Unintended leak of Proxy-Authorization header in requests.',
  }],
};

const JINJA = { name: 'jinja2', version: '3.1.4', vulns: [] };

/** Dependência local que o pip-audit não consegue auditar. */
const SKIPPED = {
  name: 'app-internal',
  skip_reason: 'Dependency not found on PyPI and could not be audited: app-internal (0.1.0)',
};

/** Saída de `pip-audit -f json` actual: objecto com `dependencies` e `fixes`. */
const REPORT = JSON.stringify({ dependencies: [FLASK, JINJA, REQUESTS, SKIPPED], fixes: [] });

/** Saída de `pip-audit -f json` antiga: array de dependências no topo. */
const LEGACY = JSON.stringify([
  { name: 'flask', version: '0.5', vulns: [{ id: 'PYSEC-2019-179', fix_versions: ['1.0'] }] },
  { name: 'jinja2', version: '3.1.4', vulns: [] },
]);

/**
 * @param {string} text
 * @param {string} [field]
 * @returns {number}
 */
function run(text, field) {
  return extract({ format: FORMAT, path: 'pip-audit.json', field }, text);
}

describe('pip-audit', () => {
  test('declara apenas o campo count', () => {
    assert.deepEqual([pipAuditExtractor.fields, pipAuditExtractor.defaultField], [
      ['count'],
      'count',
    ]);
  });

  test('usa count como campo por omissão', () => {
    assert.equal(run(REPORT), 3);
  });

  test('count soma os vulns de todas as dependências', () => {
    assert.equal(run(REPORT, 'count'), 3);
  });

  test('aceita o formato antigo com o array de dependências no topo', () => {
    assert.equal(run(LEGACY), 1);
  });

  test('dependências ignoradas, sem vulns, contam zero', () => {
    assert.equal(run(JSON.stringify({ dependencies: [SKIPPED, REQUESTS], fixes: [] })), 1);
  });

  test('dependências sem vulnerabilidades devolvem 0', () => {
    assert.equal(run(JSON.stringify({ dependencies: [JINJA], fixes: [] })), 0);
  });

  test('lista de dependências vazia dá extractor_report_empty', () => {
    assert.throws(() => run('{"dependencies":[],"fixes":[]}'), {
      name: 'ExtractorError',
      code: 'extractor_report_empty',
      params: { format: FORMAT },
    });
  });

  test('objecto sem dependencies dá extractor_report_unparseable', () => {
    assert.throws(() => run('{"fixes":[]}'), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: 'missing "dependencies"' },
    });
  });

  test('vulns que não é array dá extractor_report_unparseable', () => {
    const text = JSON.stringify({ dependencies: [{ name: 'x', version: '1', vulns: 2 }] });
    assert.throws(() => run(text), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: '"dependencies[0].vulns" is not an array' },
    });
  });

  test('dependência que não é objecto dá extractor_report_unparseable', () => {
    assert.throws(() => run('["flask==0.5"]'), UNPARSEABLE);
  });

  test('JSON inválido dá extractor_report_unparseable', () => {
    assert.throws(() => run('No known vulnerabilities found'), UNPARSEABLE);
  });

  test('campo desconhecido dá extractor_field_unknown', () => {
    assert.throws(() => run(REPORT, 'fixes'), {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: { format: FORMAT, field: 'fixes', known: 'count' },
    });
  });
});
