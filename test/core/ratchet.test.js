// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { runRatchet } from '../../src/core/ratchet.js';
import { CLEAN, measured, v1, v2 } from '../helpers.js';

const OPTIONS = {
  bypassLabel: 'hotfix-bypass-ratchet',
  lowerBaselinePattern: '^chore(\\([^)]*\\))?: lower baseline',
};

/** Source real da cobertura, no ramo base. */
const LCOV = { format: 'lcov', path: 'coverage/lcov.info' };

/** Source que o PR poria no lugar do relatório real. */
const FAKE = { format: 'json', path: 'fake.json', pointer: '/v' };

/** Baseline do ramo base, com a cobertura lida do lcov. */
const BASE_LCOV = v2({ coverage: { value: 80, direction: 'up', source: LCOV } });

/** Baseline do PR, com a cobertura apontada para um ficheiro do próprio PR. */
const HEAD_FAKE = v2({ coverage: { value: 80, direction: 'up', source: FAKE } });

/** Título que autoriza afrouxar o baseline. */
const AUTHORISED = { title: 'chore: lower baseline para mudar o relatorio' };

/**
 * Medição da cobertura vinda de uma source.
 * @param {number} value
 * @returns {Record<string, import('../../src/core/types.js').Measurement>}
 */
const coverageOf = (value) => ({ coverage: { value, origin: 'source' } });

/**
 * Relatório de um PR que troca a source da cobertura: o relatório real (lcov) mede 50 e
 * o ficheiro do PR diz 99.
 * @param {{title?: string}} [context]
 */
function swapReport(context = { title: 'feat: x' }) {
  return runRatchet({
    head: HEAD_FAKE,
    base: BASE_LCOV,
    measurements: coverageOf(99),
    baseMeasurements: coverageOf(50),
    context,
    options: OPTIONS,
  });
}

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

describe('runRatchet com a source trocada pelo PR', () => {
  test('source trocada sem titulo autorizado falha', () => {
    const report = swapReport();

    assert.deepEqual([report.passed, report.loosened.map((c) => c.name)], [false, ['coverage']]);
  });

  test('source trocada com titulo autorizado passa', () => {
    assert.equal(swapReport(AUTHORISED).passed, true);
  });

  test('sem autorizacao a metrica e medida com a source do ramo base', () => {
    assert.equal(swapReport().outcome.results[0].after, 50);
  });

  test('com autorizacao conta a medicao da source do PR', () => {
    assert.equal(swapReport(AUTHORISED).outcome.results[0].after, 99);
  });

  test('sem medicao da source do ramo base a metrica fica em falta com o motivo', () => {
    const report = runRatchet({
      head: HEAD_FAKE, base: BASE_LCOV, measurements: coverageOf(99), options: OPTIONS,
    });

    assert.equal(report.outcome.results[0].detail?.code, 'source_changed_unmeasured');
  });

  test('sem autorizacao o baseline sugerido nao fixa o valor lido da source do PR', () => {
    assert.deepEqual(swapReport().tightened, []);
  });

  test('metrica retirada com source e medida pela source do ramo base', () => {
    const base = v2({
      coverage: { value: 80, direction: 'up', source: LCOV },
      lint: { value: 3, direction: 'down' },
    });
    const head = v2({ lint: { value: 3, direction: 'down' } });

    const report = runRatchet({
      head, base, measurements: measured({ lint: 3 }), baseMeasurements: coverageOf(90),
    });

    assert.deepEqual(report.outcome.results.map((r) => [r.name, r.status]), [
      ['lint', 'unchanged'],
      ['coverage', 'improved'],
    ]);
  });
});

describe('runRatchet baseline sugerido', () => {
  /**
   * PR que baixa a cobertura de 7 para 5 no baseline.
   * @param {number} coverage valor medido
   * @param {{title?: string}} [context]
   */
  const lowered = (coverage, context = {}) => runRatchet({
    head: v1({ coverage_line_pct: 5 }),
    base: v1(),
    measurements: measured({ ...CLEAN, coverage_line_pct: coverage }),
    context,
    options: OPTIONS,
  });

  /**
   * @param {import('../../src/core/types.js').Report} report
   * @param {string} name
   */
  const suggested = (report, name) => report.newBaseline.metrics.find((r) => r.name === name);

  test('afrouxar sem autorizacao com medicao entre os dois valores nao sugere nada', () => {
    assert.deepEqual(lowered(6).tightened, []);
  });

  test('afrouxar sem autorizacao: a sugestao parte do contrato e nao do PR', () => {
    assert.equal(suggested(lowered(6), 'coverage_line_pct')?.value, 7);
  });

  test('afrouxar sem autorizacao: uma melhoria acima do contrato e fixada', () => {
    assert.equal(suggested(lowered(9), 'coverage_line_pct')?.value, 9);
  });

  test('com titulo autorizado a sugestao parte do baseline do PR', () => {
    const report = lowered(6, { title: 'chore: lower baseline' });

    assert.equal(suggested(report, 'coverage_line_pct')?.value, 6);
  });

  test('estrito com tolerancia afrouxada: a sugestao fixa a melhoria que falta', () => {
    const report = runRatchet({
      head: v2({ a: { value: 80, direction: 'up', tolerance: 5 } }),
      base: v2({ a: { value: 80, direction: 'up' } }),
      measurements: measured({ a: 82 }),
      options: { ...OPTIONS, strict: true },
    });

    assert.deepEqual([report.outcome.unlocked.map((r) => r.name), report.tightened], [
      ['a'],
      ['a'],
    ]);
  });

  test('estrito com tolerancia afrouxada: a sugestao repoe a tolerancia do contrato', () => {
    const report = runRatchet({
      head: v2({ a: { value: 80, direction: 'up', tolerance: 5 } }),
      base: v2({ a: { value: 80, direction: 'up' } }),
      measurements: measured({ a: 82 }),
      options: { ...OPTIONS, strict: true },
    });

    assert.equal(suggested(report, 'a')?.tolerance, 0);
  });

  test('metrica retirada sem autorizacao volta no baseline sugerido', () => {
    const base = v2({ a: { value: 1, direction: 'up' }, b: { value: 1, direction: 'up' } });
    const head = v2({ a: { value: 1, direction: 'up' } });

    const report = runRatchet({ head, base, measurements: measured({ a: 1, b: 1 }) });

    assert.deepEqual(report.newBaseline.metrics.map((r) => r.name), ['a', 'b']);
  });
});

describe('runRatchet afrouxamento possivel', () => {
  test('sem padrao de titulo nao e possivel afrouxar', () => {
    const report = runRatchet({ head: v1(), base: v1(), measurements: measured(CLEAN) });

    assert.equal(report.loosenable, false);
  });

  test('com padrao vazio nao e possivel afrouxar', () => {
    const report = runRatchet({
      head: v1(),
      base: v1(),
      measurements: measured(CLEAN),
      options: { ...OPTIONS, lowerBaselinePattern: '' },
    });

    assert.equal(report.loosenable, false);
  });

  test('com padrao de titulo e possivel afrouxar', () => {
    const report = runRatchet({
      head: v1(), base: v1(), measurements: measured(CLEAN), options: OPTIONS,
    });

    assert.equal(report.loosenable, true);
  });
});

describe('runRatchet com valor congelado fora do limite', () => {
  const head = v2({ mut: { value: 50, direction: 'up', min: 60 } });

  test('a medicao que cumpre o limite passa', () => {
    const report = runRatchet({ head, base: null, measurements: measured({ mut: 65 }) });

    assert.equal(report.passed, true);
  });

  test('a medicao fora do limite falha', () => {
    const report = runRatchet({ head, base: null, measurements: measured({ mut: 55 }) });

    assert.equal(report.outcome.results[0].status, 'limit');
  });
});

describe('runRatchet metricas nao seguidas', () => {
  const base = v2({ a: { value: 1, direction: 'up' }, b: { value: 1, direction: 'up' } });
  const head = v2({ a: { value: 1, direction: 'up' } });

  test('metrica retirada que continua no contrato nao aparece como nao seguida', () => {
    const report = runRatchet({
      head, base, measurements: measured({ a: 1, b: 1 }), untracked: ['b'], options: OPTIONS,
    });

    assert.deepEqual(report.untracked, []);
  });

  test('metrica retirada com autorizacao aparece como nao seguida', () => {
    const report = runRatchet({
      head,
      base,
      measurements: measured({ a: 1, b: 1 }),
      untracked: ['b'],
      context: { title: 'chore: lower baseline' },
      options: OPTIONS,
    });

    assert.deepEqual(report.untracked, ['b']);
  });
});
