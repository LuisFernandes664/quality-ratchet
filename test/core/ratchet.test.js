import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { runRatchet } from '../../src/core/ratchet.js';
import { CLEAN, measured, v1, v2 } from '../helpers.js';

const OPTIONS = {
  bypassLabel: 'hotfix-bypass-ratchet',
  lowerBaselinePattern: '^chore(\\([^)]*\\))?: lower baseline',
};

describe('runRatchet sem governacao', () => {
  test('passa quando nada regride', () => {
    const report = runRatchet({ head: v1(), base: null, measurements: measured(CLEAN) });

    assert.deepEqual([report.passed, report.ok, report.governed], [true, true, false]);
  });

  test('falha quando uma metrica regride', () => {
    const current = measured({ ...CLEAN, duplication_pct: 3 });

    const report = runRatchet({ head: v1(), base: null, measurements: current });

    assert.deepEqual([report.passed, report.ok], [false, false]);
  });

  test('label de hotfix perdoa a falha de forma visivel', () => {
    const report = runRatchet({
      head: v1(),
      base: null,
      measurements: measured({ ...CLEAN, duplication_pct: 3 }),
      context: { labels: ['hotfix-bypass-ratchet'] },
      options: OPTIONS,
    });

    assert.deepEqual([report.passed, report.ok, report.bypass.granted], [false, true, true]);
  });

  test('titulo refactor ja nao perdoa regressoes', () => {
    const report = runRatchet({
      head: v1(),
      base: null,
      measurements: measured({ ...CLEAN, duplication_pct: 3 }),
      context: { title: 'refactor: tudo' },
      options: { ...OPTIONS, lowerBaselinePattern: '^(chore: lower baseline|refactor:)' },
    });

    assert.equal(report.ok, false);
  });

  test('titulo de descida sem alteracao ao baseline nao perdoa regressoes', () => {
    const report = runRatchet({
      head: v1(),
      base: v1(),
      measurements: measured({ ...CLEAN, duplication_pct: 3 }),
      context: { title: 'chore: lower baseline' },
      options: OPTIONS,
    });

    assert.equal(report.ok, false);
  });

  test('o perdao nao aparece em execucoes verdes', () => {
    const report = runRatchet({
      head: v1(),
      base: null,
      measurements: measured(CLEAN),
      context: { labels: ['hotfix-bypass-ratchet'] },
      options: OPTIONS,
    });

    assert.equal(report.bypass.granted, false);
  });

  test('propoe o baseline apertado com as melhorias', () => {
    const current = measured({ ...CLEAN, coverage_line_pct: 9 });

    const report = runRatchet({ head: v1(), base: null, measurements: current });

    assert.deepEqual(report.tightened, ['coverage_line_pct']);
  });

  test('passa a lista de metricas nao seguidas', () => {
    const report = runRatchet({
      head: v1(), base: null, measurements: measured(CLEAN), untracked: ['extra'],
    });

    assert.deepEqual(report.untracked, ['extra']);
  });
});

describe('runRatchet com governacao', () => {
  test('baixar o baseline no proprio PR sem autorizacao falha', () => {
    const report = runRatchet({
      head: v1({ coverage_line_pct: 5 }),
      base: v1(),
      measurements: measured({ ...CLEAN, coverage_line_pct: 5 }),
      context: { title: 'feat: nova pagina' },
      options: OPTIONS,
    });

    assert.deepEqual(
      [report.passed, report.loosened.map((c) => c.name)],
      [false, ['coverage_line_pct']],
    );
  });

  test('sem autorizacao a medicao e comparada com o baseline do ramo base', () => {
    const report = runRatchet({
      head: v1({ coverage_line_pct: 5 }),
      base: v1(),
      measurements: measured({ ...CLEAN, coverage_line_pct: 5 }),
      options: OPTIONS,
    });

    assert.deepEqual(report.outcome.failures.map((r) => [r.name, r.before]), [
      ['coverage_line_pct', 7],
    ]);
  });

  test('baixar o baseline com titulo autorizado passa', () => {
    const report = runRatchet({
      head: v1({ coverage_line_pct: 5 }),
      base: v1(),
      measurements: measured({ ...CLEAN, coverage_line_pct: 5 }),
      context: { title: 'chore: lower baseline depois da migracao' },
      options: OPTIONS,
    });

    assert.deepEqual([report.passed, report.authorisation.granted], [true, true]);
  });

  test('apertar o baseline no PR nao precisa de autorizacao', () => {
    const report = runRatchet({
      head: v1({ coverage_line_pct: 9 }),
      base: v1(),
      measurements: measured({ ...CLEAN, coverage_line_pct: 9 }),
      options: OPTIONS,
    });

    assert.deepEqual([report.passed, report.changes.map((c) => c.kind)], [true, ['tightened']]);
  });

  test('apertar o baseline acima do medido falha', () => {
    const report = runRatchet({
      head: v1({ coverage_line_pct: 9 }),
      base: v1(),
      measurements: measured({ ...CLEAN, coverage_line_pct: 8 }),
      options: OPTIONS,
    });

    assert.equal(report.passed, false);
  });

  test('retirar uma metrica sem autorizacao falha e ela continua verificada', () => {
    const base = v2({ a: { value: 1, direction: 'up' }, b: { value: 1, direction: 'up' } });
    const head = v2({ a: { value: 1, direction: 'up' } });

    const report = runRatchet({ head, base, measurements: measured({ a: 1 }), options: OPTIONS });

    assert.deepEqual(report.outcome.failures.map((r) => r.name), ['b']);
  });

  test('perdao de hotfix tambem cobre afrouxamento nao autorizado', () => {
    const report = runRatchet({
      head: v1({ coverage_line_pct: 5 }),
      base: v1(),
      measurements: measured({ ...CLEAN, coverage_line_pct: 5 }),
      context: { labels: ['hotfix-bypass-ratchet'] },
      options: OPTIONS,
    });

    assert.deepEqual([report.passed, report.ok], [false, true]);
  });

  test('modo estrito passa quando o PR fixa a melhoria no baseline', () => {
    const report = runRatchet({
      head: v1({ coverage_line_pct: 9 }),
      base: v1(),
      measurements: measured({ ...CLEAN, coverage_line_pct: 9 }),
      options: { ...OPTIONS, strict: true },
    });

    assert.equal(report.passed, true);
  });

  test('modo estrito falha quando o PR nao fixa a melhoria', () => {
    const report = runRatchet({
      head: v1(),
      base: v1(),
      measurements: measured({ ...CLEAN, coverage_line_pct: 9 }),
      options: { ...OPTIONS, strict: true },
    });

    assert.deepEqual(report.outcome.unlocked.map((r) => r.name), ['coverage_line_pct']);
  });
});
