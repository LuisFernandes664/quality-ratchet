// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { ConfigError } from '../../src/core/errors.js';
import {
  BASELINE_V1,
  TODAY,
  baselineV2,
  fakeGit,
  makeTempDir,
  readJson,
  readText,
  removeDir,
  runIn,
  writeFiles,
} from './helpers.js';

/** @typedef {import('./helpers.js').CliRun} CliRun */

/** Baseline v2 com uma métrica de cada direcção. */
const BASELINE = baselineV2({
  coverage: { value: 70, direction: 'up' },
  lint: { value: 10, direction: 'down' },
});

/** Baseline que afrouxa a cobertura face a BASELINE. */
const LOWERED = baselineV2({
  coverage: { value: 60, direction: 'up' },
  lint: { value: 10, direction: 'down' },
});

/** Regra de cobertura a 80, sem source. */
const COVERAGE_80 = Object.freeze({ value: 80, direction: 'up' });

describe('check', () => {
  /** @type {string} */
  let dir;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  /**
   * Grava o baseline e as métricas com os nomes por omissão.
   * @param {unknown} baseline
   * @param {Record<string, unknown>} metrics
   * @returns {Promise<void>}
   */
  function setup(baseline, metrics) {
    return writeFiles(dir, { 'quality-baseline.json': baseline, 'metrics-current.json': metrics });
  }

  describe('verde', () => {
    /** @type {CliRun} */
    let result;

    beforeEach(async () => {
      await setup(BASELINE, { coverage: 70, lint: 10 });
      result = await runIn(dir, ['check']);
    });

    test('sai com 0', () => {
      assert.equal(result.code, 0);
    });

    test('imprime o sumario em markdown', () => {
      assert.match(result.stdout, /^## Quality ratchet\n\n\*\*Ratchet green/);
    });

    test('regista a notice no stderr', () => {
      assert.match(result.stderr, /^notice: Ratchet green\.$/m);
    });
  });

  describe('regressao', () => {
    /** @type {CliRun} */
    let result;

    beforeEach(async () => {
      await setup(BASELINE, { coverage: 65, lint: 10 });
      result = await runIn(dir, ['check']);
    });

    test('sai com 1', () => {
      assert.equal(result.code, 1);
    });

    test('regista o erro no stderr', () => {
      assert.match(result.stderr, /^error: coverage regressed: 70 -> 65$/m);
    });
  });

  test('metrica em falta no ficheiro de metricas falha', async () => {
    await setup(BASELINE, { coverage: 70 });

    assert.equal((await runIn(dir, ['check'])).code, 1);
  });

  test('aceita o baseline v1', async () => {
    await setup(BASELINE_V1, { coverage: 70, lint: 11 });

    const result = await runIn(dir, ['check']);

    assert.match(result.stderr, /^error: lint regressed: 10 -> 11$/m);
  });

  test('--baseline e --metrics sao relativos a pasta de trabalho', async () => {
    await writeFiles(dir, { 'cfg/base.json': BASELINE, 'out/m.json': { coverage: 71, lint: 9 } });
    const argv = ['check', '--baseline', 'cfg/base.json', '--metrics', 'out/m.json'];

    const result = await runIn(dir, argv);

    assert.equal(result.code, 0);
  });

  test('sources sao lidas relativamente a pasta do baseline', async () => {
    const baseline = baselineV2({
      coverage: { value: 70, direction: 'up', source: { format: 'lcov', path: 'cov/lcov.info' } },
    });
    await writeFiles(dir, {
      'pkg/quality-baseline.json': baseline,
      'pkg/cov/lcov.info': 'SF:a.js\nLF:10\nLH:8\nend_of_record\n',
    });

    const result = await runIn(dir, ['check', '--baseline', 'pkg/quality-baseline.json']);

    assert.match(result.stdout, /`coverage` \| 70 \| 80 \| \+10/);
  });

  describe('--format json com regressao e melhoria', () => {
    /** @type {CliRun} */
    let result;
    /** @type {any} */
    let report;

    beforeEach(async () => {
      await setup(BASELINE, { coverage: 75, lint: 12 });
      result = await runIn(dir, ['check', '--format', 'json']);
      report = JSON.parse(result.stdout);
    });

    test('sai com 1', () => {
      assert.equal(result.code, 1);
    });

    test('tem as chaves do relatorio pela ordem', () => {
      assert.deepEqual(
        Object.keys(report),
        ['passed', 'ok', 'bypassed', 'results', 'failures', 'loosened', 'tightened', 'newBaseline'],
      );
    });

    test('lista as falhas', () => {
      assert.deepEqual(report.failures.map((/** @type {any} */ row) => row.name), ['lint']);
    });

    test('lista as metricas apertadas', () => {
      assert.deepEqual(report.tightened, ['coverage']);
    });

    test('inclui o baseline apertado', () => {
      assert.equal(report.newBaseline.metrics.coverage.value, 75);
    });
  });

  test('--format json lista os nomes das metricas afrouxadas', async () => {
    await setup(LOWERED, { coverage: 70, lint: 10 });
    const git = fakeGit({ 'main:quality-baseline.json': BASELINE });

    const result = await runIn(dir, ['check', '--base-ref', 'main', '--format', 'json'], { git });

    assert.deepEqual(JSON.parse(result.stdout).loosened, ['coverage']);
  });

  test('--format json deixa os avisos do baseline no stderr', async () => {
    const typo = baselineV2({ coverage: { value: 70, direction: 'up', tolerence: 1 } });
    await setup(typo, { coverage: 70 });

    const result = await runIn(dir, ['check', '--format', 'json']);

    assert.match(result.stderr,
      /^warning: unknown field "tolerence" in metric "coverage" \(typo\?\)$/m);
  });

  test('metricas medidas que o baseline nao segue geram aviso no stderr', async () => {
    await setup(BASELINE, { coverage: 70, lint: 10, extra: 1 });

    const result = await runIn(dir, ['check', '--format', 'json']);

    assert.match(result.stderr, /^warning: Measured but not tracked by the baseline: extra\.$/m);
  });

  describe('valor medido fora do alcance dos numeros', () => {
    /** @type {CliRun} */
    let result;

    beforeEach(async () => {
      await writeFiles(dir, {
        'quality-baseline.json': baselineV2({ coverage: { value: 70, direction: 'up' } }),
        'metrics-current.json': '{"coverage": "1e400"}',
      });
      result = await runIn(dir, ['check', '--write-baseline', 'new.json']);
    });

    test('sai com 1', () => {
      assert.equal(result.code, 1);
    });

    test('nao escreve o ficheiro de --write-baseline', async () => {
      await assert.rejects(readText(dir, 'new.json'), { code: 'ENOENT' });
    });
  });

  test('--language pt traduz o motivo de um relatorio que nao se interpreta', async () => {
    const source = { format: 'sarif', path: 'r.sarif' };
    await writeFiles(dir, {
      'quality-baseline.json': baselineV2({ alerts: { value: 0, direction: 'down', source } }),
      'r.sarif': '{"version": "2.1.0", "runs": {}}',
    });

    const result = await runIn(dir, ['check', '--language', 'pt']);

    assert.match(result.stderr, /^error: alerts: .*"runs" não é uma lista$/m);
  });

  describe('--format invalido', () => {
    /** @type {CliRun} */
    let result;

    beforeEach(async () => {
      await setup(BASELINE, { coverage: 70, lint: 10 });
      result = await runIn(dir, ['check', '--format', 'xml']);
    });

    test('sai com 2', () => {
      assert.equal(result.code, 2);
    });

    test('explica o erro', () => {
      assert.equal(result.stderr, 'error: unsupported format "xml"; use one of: markdown, json');
    });
  });

  describe('baseline inexistente', () => {
    /** @type {CliRun} */
    let result;

    beforeEach(async () => {
      result = await runIn(dir, ['check']);
    });

    test('sai com 2', () => {
      assert.equal(result.code, 2);
    });

    test('explica o erro', () => {
      assert.match(result.stderr, /^error: could not read quality-baseline\.json/);
    });
  });

  describe('--language pt', () => {
    /** @type {CliRun} */
    let result;

    beforeEach(async () => {
      await setup(BASELINE, { coverage: 65, lint: 10 });
      result = await runIn(dir, ['check', '--language', 'pt']);
    });

    test('traduz o sumario', () => {
      assert.match(result.stdout, /Catraca vermelha/);
    });

    test('traduz os logs', () => {
      assert.match(result.stderr, /^error: coverage regrediu: 70 -> 65$/m);
    });
  });

  test('--name aparece no titulo do sumario', async () => {
    await setup(BASELINE, { coverage: 70, lint: 10 });

    const result = await runIn(dir, ['check', '--name', 'api']);

    assert.match(result.stdout, /^## Quality ratchet - api/);
  });

  describe('--strict com melhorias por fixar', () => {
    /** @type {CliRun} */
    let result;

    beforeEach(async () => {
      await setup(BASELINE, { coverage: 75, lint: 10 });
      result = await runIn(dir, ['check', '--strict']);
    });

    test('sai com 1', () => {
      assert.equal(result.code, 1);
    });

    test('diz que a melhoria esta por fixar', () => {
      assert.match(result.stderr, /coverage improved \(70 -> 75\)/);
    });
  });

  test('sem --strict as melhorias por fixar passam', async () => {
    await setup(BASELINE, { coverage: 75, lint: 10 });

    assert.equal((await runIn(dir, ['check'])).code, 0);
  });

  describe('--write-baseline com melhorias', () => {
    /** @type {CliRun} */
    let result;

    beforeEach(async () => {
      await setup(BASELINE, { coverage: 75, lint: 10 });
      result = await runIn(dir, ['check', '--write-baseline', 'out/new.json']);
    });

    test('grava o valor apertado', async () => {
      assert.equal((await readJson(dir, 'out/new.json')).metrics.coverage.value, 75);
    });

    test('grava a data de hoje em frozen_at', async () => {
      assert.equal((await readJson(dir, 'out/new.json')).frozen_at, TODAY);
    });

    test('anuncia o ficheiro escrito', () => {
      assert.match(result.stderr, /^notice: Updated baseline written to out\/new\.json\.$/m);
    });

    test('termina o ficheiro com fim de linha', async () => {
      assert.ok((await readText(dir, 'out/new.json')).endsWith('}\n'));
    });
  });

  test('--write-baseline nao escreve nada quando nada melhorou', async () => {
    await setup(BASELINE, { coverage: 70, lint: 10 });

    await runIn(dir, ['check', '--write-baseline', 'new.json']);

    await assert.rejects(readText(dir, 'new.json'), { code: 'ENOENT' });
  });

  describe('--labels com a label de hotfix', () => {
    /** @type {CliRun} */
    let result;

    beforeEach(async () => {
      await setup(BASELINE, { coverage: 65, lint: 10 });
      result = await runIn(dir, ['check', '--labels', 'bug, hotfix-bypass-ratchet']);
    });

    test('perdoa a falha', () => {
      assert.equal(result.code, 0);
    });

    test('regista a falha perdoada no stderr', () => {
      assert.match(result.stderr, /^warning: Failure forgiven: label `hotfix-bypass-ratchet`\.$/m);
    });
  });

  test('--labels pode repetir-se', async () => {
    await setup(BASELINE, { coverage: 65, lint: 10 });
    const argv = ['check', '--labels', 'bug', '--labels', 'hotfix-bypass-ratchet'];

    const result = await runIn(dir, argv);

    assert.equal(result.code, 0);
  });

  test('--bypass-label faz a label por omissao deixar de perdoar', async () => {
    await setup(BASELINE, { coverage: 65, lint: 10 });
    const argv = ['check', '--bypass-label', 'urgent', '--labels', 'hotfix-bypass-ratchet'];

    assert.equal((await runIn(dir, argv)).code, 1);
  });

  test('--bypass-label faz a nova label perdoar', async () => {
    await setup(BASELINE, { coverage: 65, lint: 10 });
    const argv = ['check', '--bypass-label', 'urgent', '--labels', 'urgent'];

    assert.equal((await runIn(dir, argv)).code, 0);
  });

  describe('caminhos vazios', () => {
    beforeEach(async () => {
      await setup(BASELINE, { coverage: 75, lint: 10 });
    });

    for (const option of ['--baseline', '--metrics', '--write-baseline']) {
      test(`${option} vazio sai com 2`, async () => {
        assert.equal((await runIn(dir, ['check', `${option}=`])).code, 2);
      });

      test(`${option} vazio diz que o valor e obrigatorio`, async () => {
        const result = await runIn(dir, ['check', `${option}=`]);

        assert.equal(result.stderr, `error: "${option}" is required`);
      });

      test(`${option} vazio nao imprime o sumario`, async () => {
        assert.equal((await runIn(dir, ['check', `${option}=`])).stdout, '');
      });
    }

    test('--write-baseline so com espacos sai com 2', async () => {
      assert.equal((await runIn(dir, ['check', '--write-baseline', '  '])).code, 2);
    });

    test('--write-baseline so com espacos nao cria um ficheiro com esse nome', async () => {
      await runIn(dir, ['check', '--write-baseline', '  ']);

      await assert.rejects(readText(dir, '  '), { code: 'ENOENT' });
    });

    test('--language pt traduz o erro do caminho vazio', async () => {
      const result = await runIn(dir, ['check', '--metrics=', '--language', 'pt']);

      assert.equal(result.stderr, 'error: "--metrics" é obrigatório');
    });
  });

  describe('governacao com --base-ref', () => {
    test('pede ao git o baseline na revisao indicada, a partir da pasta de trabalho', async () => {
      await setup(BASELINE, { coverage: 70, lint: 10 });
      const git = fakeGit({ 'origin/main:quality-baseline.json': BASELINE });

      await runIn(dir, ['check', '--base-ref', 'origin/main'], { git });

      assert.deepEqual(git.calls, [
        { ref: 'origin/main', filePath: 'quality-baseline.json', cwd: dir },
      ]);
    });

    test('sem --base-ref nao consulta o git', async () => {
      await setup(BASELINE, { coverage: 70, lint: 10 });
      const git = fakeGit();

      await runIn(dir, ['check'], { git });

      assert.deepEqual(git.calls, []);
    });

    describe('baixar o baseline sem titulo autorizado', () => {
      /** @type {CliRun} */
      let result;

      beforeEach(async () => {
        await setup(LOWERED, { coverage: 65, lint: 10 });
        const git = fakeGit({ 'main:quality-baseline.json': BASELINE });
        result = await runIn(dir, ['check', '--base-ref', 'main', '--title', 'feat: x'], { git });
      });

      test('falha', () => {
        assert.equal(result.code, 1);
      });

      test('diz que o baseline foi afrouxado', () => {
        assert.match(result.stderr, /loosens the baseline \(`coverage`\)/);
      });

      test('o erro sugere confirmar que --base-ref e a merge base', () => {
        assert.match(result.stderr, /check that `--base-ref` is the merge base/);
      });

      test('o sumario sugere confirmar que --base-ref e a merge base', () => {
        assert.match(result.stdout, /> If this .* check that `--base-ref` is the merge base/);
      });

      test('a dica nao fala do checkout do actions/checkout', () => {
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /actions\/checkout/);
      });
    });

    describe('baixar o baseline com titulo autorizado', () => {
      /** @type {CliRun} */
      let result;

      beforeEach(async () => {
        await setup(LOWERED, { coverage: 65, lint: 10 });
        const git = fakeGit({ 'main:quality-baseline.json': BASELINE });
        const title = 'chore(ci): lower baseline after removing dead tests';
        result = await runIn(dir, ['check', '--base-ref', 'main', '--title', title], { git });
      });

      test('passa', () => {
        assert.equal(result.code, 0);
      });

      test('regista a autorizacao no sumario', () => {
        assert.match(result.stdout, /Baseline loosened with authorisation/);
      });
    });

    test('o titulo refactor: ja nao autoriza baixar o baseline', async () => {
      await setup(LOWERED, { coverage: 65, lint: 10 });
      const git = fakeGit({ 'main:quality-baseline.json': BASELINE });
      const argv = ['check', '--base-ref', 'main', '--title', 'refactor: lower baseline'];

      assert.equal((await runIn(dir, argv, { git })).code, 1);
    });

    test('--lower-baseline-pattern troca o padrao que autoriza', async () => {
      await setup(LOWERED, { coverage: 65, lint: 10 });
      const git = fakeGit({ 'main:quality-baseline.json': BASELINE });
      const argv = ['check', '--base-ref', 'main', '--lower-baseline-pattern', '^\\[lower\\]',
        '--title', '[lower] coverage'];

      assert.equal((await runIn(dir, argv, { git })).code, 0);
    });

    describe('padrao invalido', () => {
      /** @type {CliRun} */
      let result;

      beforeEach(async () => {
        await setup(BASELINE, { coverage: 70, lint: 10 });
        result = await runIn(dir, ['check', '--lower-baseline-pattern', '(']);
      });

      test('sai com 2', () => {
        assert.equal(result.code, 2);
      });

      test('explica o erro', () => {
        assert.match(result.stderr, /^error: invalid regular expression "\("/);
      });
    });

    test('o contrato da revisao base prevalece sobre o baseline afrouxado', async () => {
      await setup(LOWERED, { coverage: 65, lint: 10 });
      const git = fakeGit({ 'main:quality-baseline.json': BASELINE });

      const result = await runIn(dir, ['check', '--base-ref', 'main'], { git });

      assert.match(result.stderr, /^error: coverage regressed: 70 -> 65$/m);
    });

    describe('source trocada pelo ramo', () => {
      /** @type {CliRun} */
      let result;

      beforeEach(async () => {
        const lcov = { format: 'lcov', path: 'coverage/lcov.info' };
        const fake = { format: 'json', path: 'fake.json', pointer: '/v' };
        await writeFiles(dir, {
          'quality-baseline.json': baselineV2({ coverage: { ...COVERAGE_80, source: fake } }),
          'fake.json': '{"v": 99}',
          'coverage/lcov.info': 'SF:a.js\nLF:10\nLH:5\nend_of_record\n',
        });
        const base = baselineV2({ coverage: { ...COVERAGE_80, source: lcov } });
        const git = fakeGit({ 'main:quality-baseline.json': base });
        result = await runIn(dir, ['check', '--base-ref', 'main'], { git });
      });

      test('falha', () => {
        assert.equal(result.code, 1);
      });

      test('diz que o baseline foi afrouxado', () => {
        assert.match(result.stderr, /loosens the baseline \(`coverage`\)/);
      });

      test('mede a metrica com a source da revisao base', () => {
        assert.match(result.stderr, /^error: coverage regressed: 80 -> 50$/m);
      });
    });

    describe('baixar o baseline sem autorizacao e medir entre os dois valores', () => {
      /** @type {CliRun} */
      let result;

      beforeEach(async () => {
        await setup(LOWERED, { coverage: 65, lint: 10 });
        const git = fakeGit({ 'main:quality-baseline.json': BASELINE });
        const argv = ['check', '--base-ref', 'main', '--write-baseline', 'new.json'];
        result = await runIn(dir, argv, { git });
      });

      test('nao anuncia melhorias por fixar', () => {
        assert.doesNotMatch(result.stderr, /Improvements to lock in/);
      });

      test('nao escreve o ficheiro de --write-baseline', async () => {
        await assert.rejects(readText(dir, 'new.json'), { code: 'ENOENT' });
      });
    });

    describe('sem baseline nessa revisao', () => {
      /** @type {CliRun} */
      let result;

      beforeEach(async () => {
        await setup(LOWERED, { coverage: 65, lint: 10 });
        result = await runIn(dir, ['check', '--base-ref', 'main'], { git: fakeGit() });
      });

      test('segue sem governacao', () => {
        assert.equal(result.code, 0);
      });

      test('avisa no stderr', () => {
        assert.match(result.stderr, /^warning: There is no baseline at `quality-baseline\.json`/m);
      });

      test('deixa nota no sumario', () => {
        assert.match(result.stdout, /^> There is no baseline at/m);
      });
    });

    describe('baseline invalido na revisao base', () => {
      /** @type {CliRun} */
      let result;

      beforeEach(async () => {
        await setup(LOWERED, { coverage: 65, lint: 10 });
        const git = fakeGit({ 'main:quality-baseline.json': '{ nope' });
        result = await runIn(dir, ['check', '--base-ref', 'main'], { git });
      });

      test('segue sem governacao', () => {
        assert.equal(result.code, 0);
      });

      test('avisa no stderr', () => {
        assert.match(result.stderr, new RegExp('^warning: The baseline on the base branch is '
          + 'invalid \\(main:quality-baseline\\.json is not valid JSON', 'm'));
      });

      test('deixa nota no sumario', () => {
        assert.match(result.stdout, /^> The baseline on the base branch is invalid/m);
      });
    });

    test('baseline da revisao base com varios erros fica numa so linha', async () => {
      await setup(BASELINE, { coverage: 70, lint: 10 });
      const git = fakeGit({ 'main:quality-baseline.json': { version: 2, metrics: {} } });

      const result = await runIn(dir, ['check', '--base-ref', 'main'], { git });

      assert.match(result.stderr, new RegExp('^warning: The baseline on the base branch is '
        + 'invalid \\(The baseline is invalid: - the baseline has no metrics\\), ', 'm'));
    });

    describe('--base-ref vazio', () => {
      /** @type {CliRun} */
      let result;
      /** @type {import('./helpers.js').FakeGit} */
      let git;

      beforeEach(async () => {
        await setup(LOWERED, { coverage: 65, lint: 10 });
        git = fakeGit();
        result = await runIn(dir, ['check', '--base-ref='], { git });
      });

      test('sai com 2', () => {
        assert.equal(result.code, 2);
      });

      test('diz que --base-ref e obrigatorio', () => {
        assert.equal(result.stderr, 'error: "--base-ref" is required');
      });

      test('nao consulta o git', () => {
        assert.deepEqual(git.calls, []);
      });
    });

    describe('falha do git', () => {
      /** @type {CliRun} */
      let result;

      beforeEach(async () => {
        await setup(BASELINE, { coverage: 70, lint: 10 });
        const git = {
          calls: [],
          show: async () => {
            throw new ConfigError('git_show_failed', { ref: 'x', path: 'q', reason: 'bad ref' });
          },
        };
        result = await runIn(dir, ['check', '--base-ref', 'x'], { git });
      });

      test('sai com 2, sem desligar a governacao', () => {
        assert.equal(result.code, 2);
      });

      test('mostra so o erro, sem nota de baseline em falta nem veredicto', () => {
        assert.equal(result.stderr, 'error: could not read q at x: bad ref');
      });
    });
  });
});
