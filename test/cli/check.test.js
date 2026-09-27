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

  test('verde sai com 0 e imprime o sumario em markdown', async () => {
    await setup(BASELINE, { coverage: 70, lint: 10 });

    const result = await runIn(dir, ['check']);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /^## Quality ratchet\n\n\*\*Ratchet green/);
    assert.match(result.stderr, /^notice: Ratchet green\.$/m);
  });

  test('regressao sai com 1 e regista o erro no stderr', async () => {
    await setup(BASELINE, { coverage: 65, lint: 10 });

    const result = await runIn(dir, ['check']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /^error: coverage regressed: 70 -> 65$/m);
  });

  test('metrica em falta no ficheiro de metricas falha', async () => {
    await setup(BASELINE, { coverage: 70 });

    assert.equal((await runIn(dir, ['check'])).code, 1);
  });

  test('aceita o baseline v1', async () => {
    await setup(BASELINE_V1, { coverage: 70, lint: 11 });

    const result = await runIn(dir, ['check']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /lint regressed: 10 -> 11/);
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

    assert.equal(result.code, 0);
    assert.match(result.stdout, /`coverage` \| 70 \| 80 \| \+10/);
  });

  test('--format json imprime o relatorio em JSON', async () => {
    await setup(BASELINE, { coverage: 75, lint: 12 });

    const result = await runIn(dir, ['check', '--format', 'json']);
    const report = JSON.parse(result.stdout);

    assert.equal(result.code, 1);
    assert.deepEqual(
      Object.keys(report),
      ['passed', 'ok', 'bypassed', 'results', 'failures', 'loosened', 'tightened', 'newBaseline'],
    );
    assert.deepEqual(report.failures.map((/** @type {any} */ row) => row.name), ['lint']);
    assert.deepEqual(report.tightened, ['coverage']);
    assert.equal(report.newBaseline.metrics.coverage.value, 75);
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

  test('--format invalido sai com 2', async () => {
    await setup(BASELINE, { coverage: 70, lint: 10 });

    const result = await runIn(dir, ['check', '--format', 'xml']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /^error: unsupported format "xml"; use one of: markdown, json$/);
  });

  test('baseline inexistente sai com 2', async () => {
    const result = await runIn(dir, ['check']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /^error: could not read quality-baseline\.json/);
  });

  test('--language pt traduz o sumario e os logs', async () => {
    await setup(BASELINE, { coverage: 65, lint: 10 });

    const result = await runIn(dir, ['check', '--language', 'pt']);

    assert.match(result.stdout, /Catraca vermelha/);
    assert.match(result.stderr, /^error: coverage regrediu: 70 -> 65$/m);
  });

  test('--name aparece no titulo do sumario', async () => {
    await setup(BASELINE, { coverage: 70, lint: 10 });

    const result = await runIn(dir, ['check', '--name', 'api']);

    assert.match(result.stdout, /^## Quality ratchet - api/);
  });

  test('--strict falha com melhorias por fixar', async () => {
    await setup(BASELINE, { coverage: 75, lint: 10 });

    const result = await runIn(dir, ['check', '--strict']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /coverage improved \(70 -> 75\)/);
  });

  test('sem --strict as melhorias por fixar passam', async () => {
    await setup(BASELINE, { coverage: 75, lint: 10 });

    assert.equal((await runIn(dir, ['check'])).code, 0);
  });

  test('--write-baseline escreve o baseline apertado quando ha melhorias', async () => {
    await setup(BASELINE, { coverage: 75, lint: 10 });

    const result = await runIn(dir, ['check', '--write-baseline', 'out/new.json']);
    const written = await readJson(dir, 'out/new.json');

    assert.equal(written.metrics.coverage.value, 75);
    assert.equal(written.frozen_at, TODAY);
    assert.match(result.stderr, /^notice: Updated baseline written to out\/new\.json\.$/m);
  });

  test('--write-baseline termina o ficheiro com fim de linha', async () => {
    await setup(BASELINE, { coverage: 75, lint: 10 });

    await runIn(dir, ['check', '--write-baseline', 'new.json']);

    assert.ok((await readText(dir, 'new.json')).endsWith('}\n'));
  });

  test('--write-baseline nao escreve nada quando nada melhorou', async () => {
    await setup(BASELINE, { coverage: 70, lint: 10 });

    await runIn(dir, ['check', '--write-baseline', 'new.json']);

    await assert.rejects(readText(dir, 'new.json'), { code: 'ENOENT' });
  });

  test('--labels com a label de hotfix perdoa a falha', async () => {
    await setup(BASELINE, { coverage: 65, lint: 10 });

    const result = await runIn(dir, ['check', '--labels', 'bug, hotfix-bypass-ratchet']);

    assert.equal(result.code, 0);
    assert.match(result.stderr, /^warning: Failure forgiven: label `hotfix-bypass-ratchet`\.$/m);
  });

  test('--labels pode repetir-se', async () => {
    await setup(BASELINE, { coverage: 65, lint: 10 });
    const argv = ['check', '--labels', 'bug', '--labels', 'hotfix-bypass-ratchet'];

    const result = await runIn(dir, argv);

    assert.equal(result.code, 0);
  });

  test('--bypass-label troca a label de hotfix', async () => {
    await setup(BASELINE, { coverage: 65, lint: 10 });

    const standard = await runIn(dir, ['check', '--bypass-label', 'urgent', '--labels',
      'hotfix-bypass-ratchet']);
    const custom = await runIn(dir, ['check', '--bypass-label', 'urgent', '--labels', 'urgent']);

    assert.deepEqual([standard.code, custom.code], [1, 0]);
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

    test('baixar o baseline sem titulo autorizado falha', async () => {
      await setup(LOWERED, { coverage: 65, lint: 10 });
      const git = fakeGit({ 'main:quality-baseline.json': BASELINE });
      const argv = ['check', '--base-ref', 'main', '--title', 'feat: x'];

      const result = await runIn(dir, argv, { git });

      assert.equal(result.code, 1);
      assert.match(result.stderr, /loosens the baseline \(`coverage`\)/);
    });

    test('baixar o baseline com titulo autorizado passa', async () => {
      await setup(LOWERED, { coverage: 65, lint: 10 });
      const git = fakeGit({ 'main:quality-baseline.json': BASELINE });
      const title = 'chore(ci): lower baseline after removing dead tests';

      const result = await runIn(dir, ['check', '--base-ref', 'main', '--title', title], { git });

      assert.equal(result.code, 0);
      assert.match(result.stdout, /Baseline loosened with authorisation/);
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

    test('padrao invalido sai com 2', async () => {
      await setup(BASELINE, { coverage: 70, lint: 10 });

      const result = await runIn(dir, ['check', '--lower-baseline-pattern', '(']);

      assert.equal(result.code, 2);
      assert.match(result.stderr, /^error: invalid regular expression "\("/);
    });

    test('o contrato da revisao base prevalece sobre o baseline afrouxado', async () => {
      await setup(LOWERED, { coverage: 65, lint: 10 });
      const git = fakeGit({ 'main:quality-baseline.json': BASELINE });

      const result = await runIn(dir, ['check', '--base-ref', 'main'], { git });

      assert.match(result.stderr, /^error: coverage regressed: 70 -> 65$/m);
    });

    test('sem baseline nessa revisao avisa e segue sem governacao', async () => {
      await setup(LOWERED, { coverage: 65, lint: 10 });

      const result = await runIn(dir, ['check', '--base-ref', 'main'], { git: fakeGit() });

      assert.equal(result.code, 0);
      assert.match(result.stderr, /^warning: There is no baseline at `quality-baseline\.json`/m);
      assert.match(result.stdout, /^> There is no baseline at/m);
    });

    test('baseline invalido na revisao base avisa e segue sem governacao', async () => {
      await setup(LOWERED, { coverage: 65, lint: 10 });
      const git = fakeGit({ 'main:quality-baseline.json': '{ nope' });

      const result = await runIn(dir, ['check', '--base-ref', 'main'], { git });

      assert.equal(result.code, 0);
      assert.match(result.stderr, new RegExp('^warning: The baseline on the base branch is '
        + 'invalid \\(main:quality-baseline\\.json is not valid JSON', 'm'));
      assert.match(result.stdout, /^> The baseline on the base branch is invalid/m);
    });

    test('baseline da revisao base com varios erros fica numa so linha', async () => {
      await setup(BASELINE, { coverage: 70, lint: 10 });
      const git = fakeGit({ 'main:quality-baseline.json': { version: 2, metrics: {} } });

      const result = await runIn(dir, ['check', '--base-ref', 'main'], { git });

      assert.match(result.stderr, new RegExp('^warning: The baseline on the base branch is '
        + 'invalid \\(The baseline is invalid: - the baseline has no metrics\\), ', 'm'));
    });

    test('--base-ref vazio sai com 2 sem consultar o git', async () => {
      await setup(LOWERED, { coverage: 65, lint: 10 });
      const git = fakeGit();

      const result = await runIn(dir, ['check', '--base-ref='], { git });

      assert.deepEqual(
        { code: result.code, stderr: result.stderr, calls: git.calls },
        { code: 2, stderr: 'error: "--base-ref" is required', calls: [] },
      );
    });

    test('falha do git sai com 2', async () => {
      await setup(BASELINE, { coverage: 70, lint: 10 });
      const git = {
        calls: [],
        show: async () => {
          throw new ConfigError('git_show_failed', { ref: 'x', path: 'q', reason: 'bad ref' });
        },
      };

      const result = await runIn(dir, ['check', '--base-ref', 'x'], { git });

      assert.equal(result.code, 2);
      assert.equal(result.stderr, 'error: could not read q at x: bad ref');
    });
  });
});
