// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { dotnetVulnerableExtractor } from '../../src/extractors/dotnet-vulnerable.js';
import { extract } from '../../src/extractors/index.js';

const FORMAT = 'dotnet-vulnerable';
const UNPARSEABLE = { name: 'ExtractorError', code: 'extractor_report_unparseable' };

/** Pasta da solução no runner. */
const ROOT = '/home/runner/work/shop/shop';

/** Fonte do NuGet usada por omissão. */
const NUGET_ORG = 'https://api.nuget.org/v3/index.json';

/**
 * Vulnerabilidade de um pacote, tal como o `dotnet list package` a escreve.
 * @param {string} severity
 * @param {string} ghsa identificador do advisory do GitHub
 * @returns {Record<string, string>}
 */
function advisory(severity, ghsa) {
  return { severity, advisoryurl: `https://github.com/advisories/${ghsa}` };
}

/**
 * Pacote directo (de `topLevelPackages`), com a versão pedida igual à resolvida.
 * @param {string} id
 * @param {string} version
 * @param {Record<string, string>[]} vulnerabilities
 * @returns {Record<string, unknown>}
 */
function topLevel(id, version, vulnerabilities) {
  return { id, requestedVersion: version, resolvedVersion: version, vulnerabilities };
}

/**
 * Pacote transitivo (de `transitivePackages`): só tem a versão resolvida.
 * @param {string} id
 * @param {string} version
 * @param {Record<string, string>[]} vulnerabilities
 * @returns {Record<string, unknown>}
 */
function transitive(id, version, vulnerabilities) {
  return { id, resolvedVersion: version, vulnerabilities };
}

/**
 * Projecto da solução. Sem pacotes vulneráveis, o projecto só tem `path`.
 * @param {string} path caminho relativo à pasta da solução
 * @param {Record<string, unknown>[]} [frameworks]
 * @returns {Record<string, unknown>}
 */
function project(path, frameworks) {
  return frameworks ? { path: `${ROOT}/${path}`, frameworks } : { path: `${ROOT}/${path}` };
}

/**
 * Saída de `dotnet list package --vulnerable --include-transitive --format json`, indentada
 * como o `dotnet` a escreve. `problems` só aparece quando há problemas.
 * @param {Record<string, unknown>[]} projects
 * @param {Record<string, unknown>[]} [problems]
 * @param {string[]} [sources]
 * @returns {string}
 */
function report(projects, problems = [], sources = [NUGET_ORG]) {
  return JSON.stringify({
    version: 1,
    parameters: '--vulnerable --include-transitive',
    ...(problems.length > 0 ? { problems } : {}),
    sources,
    projects,
  }, null, 2);
}

const AZURE_IDENTITY = topLevel('Azure.Identity', '1.10.2', [
  advisory('Moderate', 'GHSA-m5vv-6r4h-3vj9'),
]);
const MSAL = transitive('Microsoft.Identity.Client', '4.56.0', [
  advisory('Low', 'GHSA-x674-v45j-fwxw'),
  advisory('Moderate', 'GHSA-m5vv-6r4h-3vj9'),
]);
const NET_HTTP = transitive('System.Net.Http', '4.3.0', [advisory('High', 'GHSA-7jgj-8wvc-jh57')]);
const PRIVATE_URI = transitive('System.Private.Uri', '4.3.0', [
  advisory('High', 'GHSA-5f2m-466j-3848'),
  advisory('Moderate', 'GHSA-x5qj-9vmx-7g6g'),
  advisory('Moderate', 'GHSA-xhfc-gr8f-ffwc'),
]);
const REGEX = transitive('System.Text.RegularExpressions', '4.3.0', [
  advisory('High', 'GHSA-cmhx-cq75-c4mj'),
]);
const DRAWING = transitive('System.Drawing.Common', '4.7.0', [
  advisory('Critical', 'GHSA-rxg9-xrhp-64gj'),
]);
const ENCODINGS = topLevel('System.Text.Encodings.Web', '4.5.0', [
  advisory('Critical', 'GHSA-ghhp-997w-qr28'),
]);

/**
 * Solução com cinco projectos: 25 vulnerabilidades listadas e 10 advisories distintos
 * (2 critical, 3 high, 4 moderate, 1 low). System.Net.Http e System.Private.Uri repetem-se
 * em três projectos e nas duas frameworks do Shop.Worker, o Azure.Identity é directo no
 * Shop.Api e transitivo nos testes, e o GHSA-m5vv-6r4h-3vj9 afecta dois pacotes.
 */
const REPORT = report([
  project('src/Shop.Api/Shop.Api.csproj', [{
    framework: 'net8.0',
    topLevelPackages: [AZURE_IDENTITY],
    transitivePackages: [MSAL, NET_HTTP, PRIVATE_URI],
  }]),
  project('src/Shop.Contracts/Shop.Contracts.csproj', [{
    framework: 'netstandard2.0',
    topLevelPackages: [ENCODINGS],
  }]),
  project('src/Shop.Domain/Shop.Domain.csproj'),
  project('src/Shop.Worker/Shop.Worker.csproj', [
    { framework: 'net6.0', transitivePackages: [DRAWING, NET_HTTP, PRIVATE_URI] },
    { framework: 'net8.0', transitivePackages: [NET_HTTP, PRIVATE_URI] },
  ]),
  project('tests/Shop.Api.Tests/Shop.Api.Tests.csproj', [{
    framework: 'net8.0',
    transitivePackages: [
      transitive('Azure.Identity', '1.10.2', [advisory('Moderate', 'GHSA-m5vv-6r4h-3vj9')]),
      MSAL,
      NET_HTTP,
      PRIVATE_URI,
      REGEX,
    ],
  }]),
]);

/**
 * Problema que o `dotnet` indica para um projecto sem restore.
 * @param {string} path caminho do projecto, relativo à pasta da solução
 * @returns {Record<string, string>}
 */
function noAssetsFile(path) {
  return {
    project: `${ROOT}/${path}`,
    level: 'error',
    text: `No assets file was found for \`${ROOT}/${path}\`. Please run restore before `
      + 'running this command.',
  };
}

/**
 * Projecto net8.0 só com os pacotes transitivos indicados.
 * @param {string} path
 * @param {Record<string, unknown>[]} packages
 * @returns {Record<string, unknown>}
 */
function net8(path, packages) {
  return project(path, [{ framework: 'net8.0', transitivePackages: packages }]);
}

/**
 * @param {string} text
 * @param {string} [field]
 * @returns {number}
 */
function run(text, field) {
  return extract({ format: FORMAT, path: 'reports/dotnet-vulnerable.json', field }, text);
}

describe('dotnet-vulnerable', () => {
  test('declara os campos do contrato com total por omissão', () => {
    assert.deepEqual([dotnetVulnerableExtractor.fields, dotnetVulnerableExtractor.defaultField], [
      ['total', 'critical', 'high', 'moderate', 'low', 'high+', 'moderate+', 'low+'],
      'total',
    ]);
  });

  test('usa total como campo por omissão', () => {
    assert.equal(run(REPORT), 10);
  });

  test('total conta os advisories distintos de todos os projectos e frameworks', () => {
    assert.equal(run(REPORT, 'total'), 10);
  });

  for (const [field, expected] of [
    ['critical', 2],
    ['high', 3],
    ['moderate', 4],
    ['low', 1],
  ]) {
    test(`${field} conta os advisories distintos dessa severidade`, () => {
      assert.equal(run(REPORT, String(field)), expected);
    });
  }

  test('high+ soma high e critical', () => {
    assert.equal(run(REPORT, 'high+'), 5);
  });

  test('moderate+ soma moderate, high e critical', () => {
    assert.equal(run(REPORT, 'moderate+'), 9);
  });

  test('low+ soma low, moderate, high e critical', () => {
    assert.equal(run(REPORT, 'low+'), 10);
  });

  test('o mesmo pacote vulnerável em cinco projectos conta uma vez', () => {
    const projects = [1, 2, 3, 4, 5].map((n) => net8(`src/Svc${n}/Svc${n}.csproj`, [NET_HTTP]));
    assert.equal(run(report(projects)), 1);
  });

  test('o mesmo pacote nas duas frameworks de um projecto conta uma vez', () => {
    const text = report([project('src/Shop.Worker/Shop.Worker.csproj', [
      { framework: 'net6.0', transitivePackages: [NET_HTTP] },
      { framework: 'net8.0', transitivePackages: [NET_HTTP] },
    ])]);
    assert.equal(run(text), 1);
  });

  test('um pacote directo num projecto e transitivo noutro conta uma vez', () => {
    const text = report([
      project('src/Shop.Api/Shop.Api.csproj', [{
        framework: 'net8.0',
        topLevelPackages: [topLevel('System.Net.Http', '4.3.0', [
          advisory('High', 'GHSA-7jgj-8wvc-jh57'),
        ])],
      }]),
      net8('src/Shop.Worker/Shop.Worker.csproj', [NET_HTTP]),
    ]);
    assert.equal(run(text), 1);
  });

  test('o mesmo advisory em duas versões do pacote conta duas vezes', () => {
    const vulnerabilities = [advisory('High', 'GHSA-5crp-9r3c-p9vr')];
    const text = report([
      net8('src/Shop.Api/Shop.Api.csproj', [transitive('Newtonsoft.Json', '12.0.3',
        vulnerabilities)]),
      net8('src/Shop.Worker/Shop.Worker.csproj', [transitive('Newtonsoft.Json', '11.0.2',
        vulnerabilities)]),
    ]);
    assert.equal(run(text), 2);
  });

  test('o mesmo advisory em dois pacotes conta duas vezes', () => {
    const text = report([net8('src/Shop.Api/Shop.Api.csproj', [
      transitive('Azure.Identity', '1.10.2', [advisory('Moderate', 'GHSA-m5vv-6r4h-3vj9')]),
      transitive('Microsoft.Identity.Client', '4.56.0', [
        advisory('Moderate', 'GHSA-m5vv-6r4h-3vj9'),
      ]),
    ])]);
    assert.equal(run(text), 2);
  });

  test('o id do pacote não distingue maiúsculas de minúsculas', () => {
    const vulnerabilities = [advisory('High', 'GHSA-5crp-9r3c-p9vr')];
    const text = report([
      net8('src/Shop.Api/Shop.Api.csproj', [transitive('Newtonsoft.Json', '12.0.3',
        vulnerabilities)]),
      net8('src/Shop.Worker/Shop.Worker.csproj', [transitive('newtonsoft.json', '12.0.3',
        vulnerabilities)]),
    ]);
    assert.equal(run(text), 1);
  });

  test('projecto sem pacotes vulneráveis devolve 0', () => {
    assert.equal(run(report([project('src/Shop.Domain/Shop.Domain.csproj')])), 0);
  });

  test('lista de projectos vazia devolve 0', () => {
    assert.equal(run(report([])), 0);
  });

  test('erro em problems dá reason_dotnet_list_errors com o texto', () => {
    const text = report([
      project('src/Shop.Api/Shop.Api.csproj'),
      net8('src/Shop.Worker/Shop.Worker.csproj', [NET_HTTP]),
    ], [noAssetsFile('src/Shop.Api/Shop.Api.csproj')]);
    assert.throws(() => run(text), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: {
          code: 'reason_dotnet_list_errors',
          params: {
            details: `No assets file was found for \`${ROOT}/src/Shop.Api/Shop.Api.csproj\`. `
              + 'Please run restore before running this command.',
          },
        },
      },
    });
  });

  test('vários erros em problems ficam numa linha, separados por "; "', () => {
    const paths = ['src/Shop.Api/Shop.Api.csproj', 'src/Shop.Worker/Shop.Worker.csproj'];
    const text = report(paths.map((path) => project(path)), paths.map(noAssetsFile));
    assert.throws(() => run(text), (/** @type {any} */ error) => (
      error.params.reason.params.details === paths
        .map((path) => noAssetsFile(path).text)
        .join('; ')));
  });

  test('as quebras de linha do texto de um erro passam a espaços', () => {
    const problem = {
      level: 'error',
      text: 'Unable to load the service index for source https://nuget.example/v3/index.json.'
        + '\n  Response status code does not indicate success: 401 (Unauthorized).',
    };
    assert.throws(() => run(report([], [problem])), (/** @type {any} */ error) => (
      error.params.reason.params.details === 'Unable to load the service index for source '
        + 'https://nuget.example/v3/index.json. Response status code does not indicate '
        + 'success: 401 (Unauthorized).'));
  });

  test('avisos em problems não impedem a contagem', () => {
    const warning = {
      level: 'warning',
      text: "You are running the 'list package' operation with an 'HTTP' source, "
        + "'http://nuget.example/v3/index.json'. Non-HTTPS access will be removed in a future "
        + "version. Consider migrating to an 'HTTPS' source.",
    };
    const sources = [NUGET_ORG, 'http://nuget.example/v3/index.json'];
    const text = report([net8('src/Shop.Api/Shop.Api.csproj', [NET_HTTP])], [warning], sources);
    assert.equal(run(text), 1);
  });

  test('uma listagem feita sem --vulnerable é rejeitada', () => {
    const text = JSON.stringify({ version: 1, parameters: '--outdated', projects: [] });
    assert.throws(() => run(text), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_dotnet_not_vulnerable', params: { parameters: '--outdated' } },
      },
    });
  });

  test('uma opção que só começa por --vulnerable não conta como --vulnerable', () => {
    const text = JSON.stringify({ version: 1, parameters: '--vulnerable-x', projects: [] });
    assert.throws(() => run(text), UNPARSEABLE);
  });

  test('sem parameters o relatório é aceite', () => {
    assert.equal(run(JSON.stringify({ version: 1, projects: [] })), 0);
  });

  test('relatório sem projects dá reason_key_missing', () => {
    assert.throws(() => run('{"version":1,"parameters":"--vulnerable"}'), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_key_missing', params: { path: 'projects' } },
      },
    });
  });

  test('projects que não é lista de objectos dá reason_not_array_of_objects', () => {
    assert.throws(() => run('{"version":1,"projects":["src/Shop.Api/Shop.Api.csproj"]}'), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: { code: 'reason_not_array_of_objects', params: { path: 'projects' } },
      },
    });
  });

  test('frameworks que não é lista dá reason_not_array_of_objects com a posição', () => {
    const text = report([
      project('src/Shop.Domain/Shop.Domain.csproj'),
      { ...project('src/Shop.Api/Shop.Api.csproj'), frameworks: { 'net8.0': [NET_HTTP] } },
    ]);
    assert.throws(() => run(text), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: {
          code: 'reason_not_array_of_objects',
          params: { path: 'projects[1].frameworks' },
        },
      },
    });
  });

  test('pacote sem resolvedVersion dá reason_not_string com a posição', () => {
    const { resolvedVersion, ...withoutVersion } = NET_HTTP;
    const text = report([net8('src/Shop.Api/Shop.Api.csproj', [PRIVATE_URI, withoutVersion])]);
    assert.throws(() => run(text), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: {
          code: 'reason_not_string',
          params: { path: 'projects[0].frameworks[0].transitivePackages[1].resolvedVersion' },
        },
      },
    });
  });

  test('advisory sem advisoryurl dá reason_not_string com a posição', () => {
    const text = report([net8('src/Shop.Api/Shop.Api.csproj', [
      transitive('System.Net.Http', '4.3.0', [{ severity: 'High' }]),
    ])]);
    assert.throws(() => run(text), (/** @type {any} */ error) => (
      error.params.reason.code === 'reason_not_string'
      && error.params.reason.params.path
        === 'projects[0].frameworks[0].transitivePackages[0].vulnerabilities[0].advisoryurl'));
  });

  test('severidade vazia dá reason_severity_unknown com a posição do advisory', () => {
    const text = report([net8('src/Shop.Api/Shop.Api.csproj', [
      transitive('System.Net.Http', '4.3.0', [advisory('', 'GHSA-7jgj-8wvc-jh57')]),
    ])]);
    assert.throws(() => run(text), {
      ...UNPARSEABLE,
      params: {
        format: FORMAT,
        reason: {
          code: 'reason_severity_unknown',
          params: {
            severity: '',
            path: 'projects[0].frameworks[0].transitivePackages[0].vulnerabilities[0]',
            known: 'Critical, High, Moderate, Low',
          },
        },
      },
    });
  });

  test('saída em texto, sem --format json, dá extractor_report_unparseable', () => {
    const text = '\nThe following sources were used:\n   https://api.nuget.org/v3/index.json\n\n'
      + 'Project `Shop.Api` has the following vulnerable packages\n   [net8.0]: \n';
    assert.throws(() => run(text), UNPARSEABLE);
  });

  test('campo desconhecido dá extractor_field_unknown', () => {
    assert.throws(() => run(REPORT, 'info'), {
      name: 'ExtractorError',
      code: 'extractor_field_unknown',
      params: {
        format: FORMAT,
        field: 'info',
        known: 'total, critical, high, moderate, low, high+, moderate+, low+',
      },
    });
  });
});
