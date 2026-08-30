import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, renderSummary, shouldBypass, Status } from '../src/ratchet.js';

const baseline = {
  frozen_at: '2026-05-04',
  metrics: {
    lint_violations_total: 483,
    duplication_pct: 2.2,
    coverage_line_pct: 7.0,
    mutation_score_covered_pct: 81.6,
  },
  rules: {
    monotonic_down: ['lint_violations_total', 'duplication_pct'],
    monotonic_up: ['coverage_line_pct', 'mutation_score_covered_pct'],
  },
};

const clean = {
  lint_violations_total: 483,
  duplication_pct: 2.2,
  coverage_line_pct: 7.0,
  mutation_score_covered_pct: 81.6,
};

const find = (outcome, name) => outcome.results.find((r) => r.name === name);

test('passa quando nenhuma metrica se mexe', () => {
  const outcome = compare(baseline, clean);

  assert.equal(outcome.passed, true);
  assert.equal(outcome.regressions.length, 0);
  assert.equal(find(outcome, 'duplication_pct').status, Status.UNCHANGED);
});

test('falha quando uma metrica monotonic_down sobe', () => {
  const outcome = compare(baseline, { ...clean, lint_violations_total: 484 });

  assert.equal(outcome.passed, false);
  assert.equal(outcome.regressions.length, 1);
  assert.equal(outcome.regressions[0].name, 'lint_violations_total');
  assert.equal(outcome.regressions[0].delta, 1);
});

test('falha quando uma metrica monotonic_up desce, nem que seja 0.1 pp', () => {
  const outcome = compare(baseline, { ...clean, coverage_line_pct: 6.9 });

  assert.equal(outcome.passed, false);
  assert.equal(outcome.regressions[0].name, 'coverage_line_pct');
});

test('aceita melhorias nas duas direcoes', () => {
  const outcome = compare(baseline, {
    ...clean,
    lint_violations_total: 400,
    coverage_line_pct: 12.5,
  });

  assert.equal(outcome.passed, true);
  assert.equal(outcome.improvements.length, 2);
});

test('metrica em falta conta como falha, para nao haver verde mentiroso', () => {
  const { duplication_pct, ...semDuplicacao } = clean;
  const outcome = compare(baseline, semDuplicacao);

  assert.equal(outcome.passed, false);
  assert.equal(outcome.missing.length, 1);
  assert.equal(outcome.missing[0].name, 'duplication_pct');
});

test('ruido de virgula flutuante nao conta como regressao', () => {
  const outcome = compare(baseline, { ...clean, coverage_line_pct: 7.0 - 1e-12 });

  assert.equal(outcome.passed, true);
  assert.equal(find(outcome, 'coverage_line_pct').status, Status.UNCHANGED);
});

test('baseline sem regras rebenta em vez de passar silenciosamente', () => {
  assert.throws(() => compare({ metrics: {} }, clean), /Baseline sem regras/);
});

test('label de hotfix perdoa a falha', () => {
  const result = shouldBypass({
    title: 'fix: pagamento em producao',
    labels: ['bug', 'hotfix-bypass-ratchet'],
    bypassLabel: 'hotfix-bypass-ratchet',
  });

  assert.equal(result.bypassed, true);
  assert.match(result.reason, /hotfix-bypass-ratchet/);
});

test('titulo que declara descida de baseline perdoa a falha', () => {
  const result = shouldBypass({
    title: 'chore: lower baseline coverage apos migracao de tooling',
    labels: [],
    lowerBaselinePattern: '^(chore: lower baseline|refactor:)',
  });

  assert.equal(result.bypassed, true);
});

test('PR normal nao e perdoado', () => {
  const result = shouldBypass({
    title: 'feat: catalogo de pecas',
    labels: ['enhancement'],
    bypassLabel: 'hotfix-bypass-ratchet',
    lowerBaselinePattern: '^(chore: lower baseline|refactor:)',
  });

  assert.equal(result.bypassed, false);
  assert.equal(result.reason, null);
});

test('sumario mostra veredicto, todas as metricas e a data do baseline', () => {
  const outcome = compare(baseline, { ...clean, lint_violations_total: 500 });
  const markdown = renderSummary(outcome, { frozenAt: baseline.frozen_at });

  assert.match(markdown, /Catraca vermelha/);
  assert.match(markdown, /lint_violations_total.*483.*500.*\+17/);
  assert.match(markdown, /2026-05-04/);
  for (const name of Object.keys(clean)) assert.ok(markdown.includes(name));
});

test('sumario assinala quando a falha foi perdoada', () => {
  const outcome = compare(baseline, { ...clean, duplication_pct: 9 });
  const markdown = renderSummary(outcome, {
    bypass: { bypassed: true, reason: 'label `hotfix-bypass-ratchet`' },
  });

  assert.match(markdown, /Falha perdoada/);
});
