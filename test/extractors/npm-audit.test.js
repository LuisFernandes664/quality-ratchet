// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extract } from '../../src/extractors/index.js';
import { npmAuditExtractor } from '../../src/extractors/npm-audit.js';

const FORMAT = 'npm-audit';
const UNPARSEABLE = { name: 'ExtractorError', code: 'extractor_report_unparseable' };

/** Saída de `npm audit --json` do npm 7 ou superior (`auditReportVersion: 2`). */
const NPM7 = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    minimist: {
      name: 'minimist',
      severity: 'critical',
      isDirect: false,
      via: [{
        source: 1088948,
        name: 'minimist',
        dependency: 'minimist',
        title: 'Prototype Pollution in minimist',
        url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
        severity: 'critical',
        cwe: ['CWE-1321'],
        cvss: { score: 9.8, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
        range: '<0.2.4',
      }],
      effects: ['mkdirp'],
      range: '<0.2.4',
      nodes: ['node_modules/minimist'],
      fixAvailable: true,
    },
  },
  metadata: {
    vulnerabilities: { info: 1, low: 2, moderate: 3, high: 4, critical: 5, total: 15 },
    dependencies: { prod: 120, dev: 340, optional: 12, peer: 0, peerOptional: 0, total: 471 },
  },
});

/** Saída de `npm audit --json` do npm 6: sem `total` nas contagens por severidade. */
const NPM6 = JSON.stringify({
  actions: [{
    action: 'update',
    module: 'lodash',
    depth: 2,
    target: '4.17.21',
    resolves: [{ id: 1673, path: 'webpack>lodash', dev: true, optional: false, bundled: false }],
  }],
  advisories: {
    1673: { id: 1673, title: 'Command Injection', module_name: 'lodash', severity: 'high' },
  },
  muted: [],
  metadata: {
    vulnerabilities: { info: 0, low: 1, moderate: 0, high: 2, critical: 1 },
    dependencies: 180,
    devDependencies: 950,
    optionalDependencies: 12,
    totalDependencies: 1130,
  },
  runId: '3b1f2c9e-7d2a-4f7e-9a51-0c1d2e3f4a5b',
});

/** JSON de erro escrito pelo npm quando não há lockfile. */
const ENOLOCK = JSON.stringify({
  error: {
    code: 'ENOLOCK',
    summary: 'This command requires an existing lockfile.',
    detail: 'Try creating one first with: npm i --package-lock-only',
  },
});

/**
 * @param {string} text
 * @param {string} [field]
 * @returns {number}
 */
function run(text, field) {
  return extract({ format: FORMAT, path: 'npm-audit.json', field }, text);
}

describe('npm-audit', () => {
  test('declara os campos do contrato com total por omissão', () => {
    assert.deepEqual([npmAuditExtractor.fields, npmAuditExtractor.defaultField], [
      ['total', 'critical', 'high', 'moderate', 'low', 'info', 'high+', 'moderate+', 'low+'],
      'total',
    ]);
  });

  test('usa total como campo por omissão', () => {
    assert.equal(run(NPM7), 15);
  });

  test('total lê metadata.vulnerabilities.total (npm 7+)', () => {
    assert.equal(run(NPM7, 'total'), 15);
  });

  test('total sem "total" no relatório soma as severidades (npm 6)', () => {
    assert.equal(run(NPM6, 'total'), 4);
  });

  for (const [field, expected] of [
    ['critical', 5],
    ['high', 4],
    ['moderate', 3],
    ['low', 2],
    ['info', 1],
  ]) {
    test(`${field} lê metadata.vulnerabilities.${field}`, () => {
      assert.equal(run(NPM7, String(field)), expected);
    });
  }

  test('high+ soma high e critical', () => {
    assert.equal(run(NPM7, 'high+'), 9);
  });

  test('moderate+ soma moderate, high e critical', () => {
    assert.equal(run(NPM7, 'moderate+'), 12);
  });

  test('low+ soma low, moderate, high e critical', () => {
    assert.equal(run(NPM7, 'low+'), 14);
  });

  test('as variantes com + também funcionam no formato do npm 6', () => {
    assert.equal(run(NPM6, 'high+'), 3);
  });

  test('relatório sem vulnerabilidades devolve 0', () => {
    const vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
    assert.equal(run(JSON.stringify({ auditReportVersion: 2, metadata: { vulnerabilities } })), 0);
  });

  test('JSON de erro do npm dá extractor_report_unparseable com o código', () => {
    assert.throws(() => run(ENOLOCK), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: 'npm audit failed: ENOLOCK This command requires an existing lockfile.',
      },
    });
  });

  test('relatório sem metadata.vulnerabilities dá extractor_report_unparseable', () => {
    assert.throws(() => run('{"auditReportVersion":2,"vulnerabilities":{}}'), {
      ...UNPARSEABLE,
      params: { format: FORMAT, reason: 'missing "metadata.vulnerabilities"' },
    });
  });

  test('contagem negativa dá extractor_report_unparseable', () => {
    const text = '{"metadata":{"vulnerabilities":{"high":-1,"critical":0}}}';
    assert.throws(() => run(text, 'high+'), UNPARSEABLE);
  });

  test('contagem não finita dá extractor_report_unparseable', () => {
    const text = '{"metadata":{"vulnerabilities":{"high":1e999,"critical":0}}}';
    assert.throws(() => run(text, 'high'), UNPARSEABLE);
  });

  test('JSON inválido dá extractor_report_unparseable', () => {
    assert.throws(() => run('npm ERR! code ENOAUDIT'), UNPARSEABLE);
  });

  test('campo desconhecido dá extractor_field_unknown', () => {
    assert.throws(() => run(NPM7, 'medium'), {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: {
        format: FORMAT,
        field: 'medium',
        known: 'total, critical, high, moderate, low, info, high+, moderate+, low+',
      },
    });
  });
});
