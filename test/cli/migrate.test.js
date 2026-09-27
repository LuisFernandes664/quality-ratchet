// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { SCHEMA_URL } from '../../src/cli/defaults.js';
import {
  BASELINE_V1,
  baselineV2,
  makeTempDir,
  readJson,
  readText,
  removeDir,
  runIn,
  writeFiles,
} from './helpers.js';

describe('migrate', () => {
  /** @type {string} */
  let dir;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  test('converte o baseline v1 para v2 no proprio ficheiro', async () => {
    await writeFiles(dir, { 'quality-baseline.json': BASELINE_V1 });

    const result = await runIn(dir, ['migrate']);
    const written = await readJson(dir, 'quality-baseline.json');

    assert.equal(result.code, 0);
    assert.deepEqual(written, {
      $schema: SCHEMA_URL,
      version: 2,
      frozen_at: '2026-05-04',
      metrics: {
        lint: { value: 10, direction: 'down' },
        coverage: { value: 70, direction: 'up' },
      },
    });
  });

  test('valores sem regra geram aviso de descarte', async () => {
    await writeFiles(dir, { 'quality-baseline.json': BASELINE_V1 });

    const result = await runIn(dir, ['migrate']);

    assert.equal(result.stderr, 'warning: Values without a rule were dropped: legacy.');
  });

  test('--language pt traduz os avisos', async () => {
    await writeFiles(dir, { 'quality-baseline.json': BASELINE_V1 });

    const result = await runIn(dir, ['migrate', '--language', 'pt']);

    assert.equal(result.stderr, 'warning: Valores sem regra foram descartados: legacy.');
  });

  test('confirma o ficheiro escrito no stdout', async () => {
    await writeFiles(dir, { 'quality-baseline.json': BASELINE_V1 });

    const result = await runIn(dir, ['migrate']);

    assert.equal(result.stdout, 'Wrote quality-baseline.json.');
  });

  test('--baseline e --output escolhem os ficheiros e o original fica intacto', async () => {
    await writeFiles(dir, { 'old.json': BASELINE_V1 });
    const before = await readText(dir, 'old.json');

    await runIn(dir, ['migrate', '--baseline', 'old.json', '--output', 'v2/new.json']);

    assert.equal((await readJson(dir, 'v2/new.json')).version, 2);
    assert.equal(await readText(dir, 'old.json'), before);
  });

  test('mantem o $schema que ja existe', async () => {
    const baseline = { ...baselineV2({ a: { value: 1, direction: 'up' } }), $schema: 'x.json' };
    await writeFiles(dir, { 'quality-baseline.json': baseline });

    await runIn(dir, ['migrate']);

    assert.equal((await readJson(dir, 'quality-baseline.json')).$schema, 'x.json');
  });

  test('outros avisos do baseline aparecem no stderr', async () => {
    await writeFiles(dir, { 'quality-baseline.json': { ...BASELINE_V1, notes: 'x' } });

    const result = await runIn(dir, ['migrate']);

    assert.match(result.stderr, /^warning: unknown field "notes" at the root of the baseline$/m);
  });

  test('o baseline migrado passa o check', async () => {
    await writeFiles(dir, {
      'quality-baseline.json': BASELINE_V1,
      'metrics-current.json': { coverage: 70, lint: 10 },
    });
    await runIn(dir, ['migrate']);

    const result = await runIn(dir, ['check']);

    assert.equal(result.code, 0);
  });

  test('baseline invalido sai com 2', async () => {
    await writeFiles(dir, { 'quality-baseline.json': { metrics: { a: 1 } } });

    const result = await runIn(dir, ['migrate']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /^error: The baseline is invalid/);
  });
});
