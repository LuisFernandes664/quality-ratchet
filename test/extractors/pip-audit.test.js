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
 * Entrada de `vulns` com o id e os aliases indicados.
 * @param {string} id
 * @param {string[]} aliases
 * @param {string} description
 * @returns {Record<string, unknown>}
 */
function vuln(id, aliases, description) {
  return { id, fix_versions: ['2.31.0'], aliases, description };
}

/**
 * requests 2.19.0 auditado pelo pip-audit 2.10.1 com o serviço PyPI: cada vulnerabilidade
 * aparece duas vezes com o mesmo id PYSEC (uma pelo registo PYSEC, outra pelo GHSA), só com
 * a descrição diferente. São 2 vulnerabilidades distintas.
 */
const REQUESTS_PYPI = {
  name: 'requests',
  version: '2.19.0',
  vulns: [
    vuln('PYSEC-2018-28', ['GHSA-x84v-xcm2-53pg', 'CVE-2018-18074'], 'The Requests package...'),
    vuln('PYSEC-2018-28', ['GHSA-x84v-xcm2-53pg', 'CVE-2018-18074'], 'Requests through 2.19.1'),
    vuln('PYSEC-2023-74', ['GHSA-j8r2-6x86-q33q', 'CVE-2023-32681'], '### Impact'),
    vuln('PYSEC-2023-74', ['GHSA-j8r2-6x86-q33q', 'CVE-2023-32681'], 'Requests is a HTTP'),
  ],
};

/**
 * @param {Record<string, unknown>[]} dependencies
 * @returns {string}
 */
function report(dependencies) {
  return JSON.stringify({ dependencies, fixes: [] });
}

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

  test('projecto sem dependências (lista vazia) devolve 0', () => {
    assert.equal(run('{"dependencies": [], "fixes": []}'), 0);
  });

  test('formato antigo com array vazio devolve 0', () => {
    assert.equal(run('[]'), 0);
  });

  test('entradas repetidas com o mesmo id (pip-audit 2.10, serviço PyPI) contam uma vez', () => {
    assert.equal(run(report([REQUESTS_PYPI])), 2);
  });

  test('entradas com ids diferentes que partilham um alias contam uma vez', () => {
    const vulns = [
      vuln('PYSEC-2023-74', ['GHSA-j8r2-6x86-q33q'], 'a'),
      vuln('GHSA-j8r2-6x86-q33q', ['CVE-2023-32681'], 'b'),
    ];
    assert.equal(run(report([{ name: 'requests', version: '2.25.0', vulns }])), 1);
  });

  test('entradas ligadas por aliases em cadeia contam uma vez', () => {
    const vulns = [vuln('A', ['B'], 'a'), vuln('C', ['D'], 'c'), vuln('D', ['B'], 'd')];
    assert.equal(run(report([{ name: 'x', version: '1', vulns }])), 1);
  });

  test('um id PYSEC acrescentado a um aviso GHSA não aumenta a contagem', () => {
    const ghsaOnly = [vuln('GHSA-9wx4-h78v-vm56', ['CVE-2024-35195'], 'Session verify')];
    const withPysec = [
      vuln('PYSEC-2026-1873', ['CVE-2024-35195', 'GHSA-9wx4-h78v-vm56'], 'When using'),
      vuln('PYSEC-2026-1873', ['CVE-2024-35195', 'GHSA-9wx4-h78v-vm56'], 'Requests is'),
    ];
    const counts = [ghsaOnly, withPysec].map((vulns) => (
      run(report([{ name: 'requests', version: '2.31.0', vulns }]))));
    assert.deepEqual(counts, [1, 1]);
  });

  test('o mesmo id em duas dependências conta duas vezes', () => {
    const shared = [vuln('PYSEC-2018-28', [], 'x')];
    const text = report([
      { name: 'a', version: '1', vulns: shared },
      { name: 'b', version: '1', vulns: shared },
    ]);
    assert.equal(run(text), 2);
  });

  test('entrada sem aliases conta pelo id', () => {
    const vulns = [{ id: 'PYSEC-1', fix_versions: [] }, { id: 'PYSEC-2', fix_versions: [] }];
    assert.equal(run(report([{ name: 'x', version: '1', vulns }])), 2);
  });

  test('objecto sem dependencies dá extractor_report_unparseable', () => {
    assert.throws(() => run('{"fixes":[]}'), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_key_missing', params: { path: 'dependencies' } },
      },
    });
  });

  test('dependencies que não é array dá extractor_report_unparseable', () => {
    assert.throws(() => run('{"dependencies":{}}'), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_not_array', params: { path: 'dependencies' } },
      },
    });
  });

  test('vulns que não é array dá extractor_report_unparseable', () => {
    const text = JSON.stringify({ dependencies: [{ name: 'x', version: '1', vulns: 2 }] });
    assert.throws(() => run(text), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_not_array', params: { path: 'dependencies[0].vulns' } },
      },
    });
  });

  test('dependência que não é objecto dá extractor_report_unparseable', () => {
    assert.throws(() => run('["flask==0.5"]'), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_not_object', params: { path: 'dependencies[0]' } },
      },
    });
  });

  test('entrada de vulns que não é objecto dá extractor_report_unparseable', () => {
    assert.throws(() => run(report([{ name: 'x', version: '1', vulns: ['PYSEC-1'] }])), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_not_object', params: { path: 'dependencies[0].vulns[0]' } },
      },
    });
  });

  test('entrada de vulns sem id de texto dá extractor_report_unparseable', () => {
    assert.throws(() => run(report([{ name: 'x', version: '1', vulns: [{ id: 7 }] }])), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_not_string', params: { path: 'dependencies[0].vulns[0].id' } },
      },
    });
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
