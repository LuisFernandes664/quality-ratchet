import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createTranslator } from '../../src/core/messages.js';
import { runRatchet } from '../../src/core/ratchet.js';
import { formatNumber, renderSummary, reportLogEntries } from '../../src/core/summary.js';
import { CLEAN, measured, v1, v2 } from '../helpers.js';

const en = createTranslator('en');
const pt = createTranslator('pt');
const OPTIONS = { bypassLabel: 'hotfix', lowerBaselinePattern: '^chore: lower baseline' };

/**
 * Relatório sem governação a partir de medições.
 * @param {Record<string, unknown>} current
 * @param {object} [extra]
 */
function reportFor(current, extra = {}) {
  return runRatchet({ head: v1(), base: null, measurements: measured(current), ...extra });
}

describe('renderSummary', () => {
  test('mostra veredicto, todas as metricas e a data do baseline', () => {
    const markdown = renderSummary(reportFor({ ...CLEAN, lint_violations_total: 500 }), pt);

    assert.match(markdown, /Catraca vermelha/);
    assert.match(markdown, /lint_violations_total.*483.*500.*\+17/);
    assert.match(markdown, /2026-05-04/);
    for (const name of Object.keys(CLEAN)) assert.ok(markdown.includes(name));
  });

  test('em ingles o veredicto verde e em ingles', () => {
    assert.match(renderSummary(reportFor(CLEAN), en), /Ratchet green/);
  });

  test('o titulo inclui o nome da catraca', () => {
    assert.match(renderSummary(reportFor(CLEAN), en, { name: 'backend' }), /## .*backend/);
  });

  test('assinala quando a falha foi perdoada', () => {
    const report = reportFor(
      { ...CLEAN, duplication_pct: 9 },
      { context: { labels: ['hotfix'] }, options: OPTIONS },
    );

    assert.match(renderSummary(report, pt), /> Falha perdoada: label `hotfix`/);
  });

  test('explica a metrica em falta', () => {
    const { duplication_pct: _, ...rest } = CLEAN;

    assert.match(renderSummary(reportFor(rest), en), /`duplication_pct`: not present/);
  });

  test('mostra a tolerancia quando a regressao foi tolerada', () => {
    const report = runRatchet({
      head: v2({ c: { value: 7, direction: 'up', tolerance: 0.5 } }),
      base: null,
      measurements: measured({ c: 6.8 }),
    });

    assert.match(renderSummary(report, en), /-0\.2 \(±0\.5\)/);
  });

  test('acrescenta a coluna de objectivo so quando ha objectivos', () => {
    const report = runRatchet({
      head: v2({ c: { value: 7, direction: 'up', target: 80 } }),
      base: null,
      measurements: measured({ c: 7 }),
    });

    assert.match(renderSummary(report, en), /\| Target \|/);
  });

  test('sem objectivos nao ha coluna de objectivo', () => {
    assert.doesNotMatch(renderSummary(reportFor(CLEAN), en), /Target/);
  });

  test('inclui o baseline actualizado quando ha melhorias', () => {
    const markdown = renderSummary(reportFor({ ...CLEAN, coverage_line_pct: 9 }), en);

    assert.match(markdown, /<details><summary>Updated baseline \(1 metric\(s\) tightened\)/);
    assert.match(markdown, /"coverage_line_pct": 9/);
  });

  test('lista as alteracoes ao baseline e o afrouxamento nao autorizado', () => {
    const report = runRatchet({
      head: v1({ coverage_line_pct: 5 }),
      base: v1(),
      measurements: measured({ ...CLEAN, coverage_line_pct: 5 }),
      options: OPTIONS,
    });

    const markdown = renderSummary(report, en);

    assert.match(markdown, /\| `coverage_line_pct` \| loosened \| value \|/);
    assert.match(markdown, /loosens the baseline \(`coverage_line_pct`\) without authorisation/);
  });

  test('mostra notas extra do chamador', () => {
    const notes = [{ code: 'note_base_missing', params: { path: 'q.json' } }];

    assert.match(renderSummary(reportFor(CLEAN), en, { notes }), /> There is no baseline at/);
  });

  test('mostra avisos e metricas nao seguidas', () => {
    const markdown = renderSummary(reportFor(CLEAN, { untracked: ['extra'] }), en);

    assert.match(markdown, /### Warnings\n\n- Measured but not tracked by the baseline: `extra`/);
  });
});

describe('formatNumber', () => {
  test('arredonda a quatro casas e retira zeros', () => {
    assert.deepEqual([formatNumber(81.60000000001), formatNumber(7)], ['81.6', '7']);
  });
});

describe('reportLogEntries', () => {
  test('um erro por metrica em falha e um fecho vermelho', () => {
    const entries = reportLogEntries(reportFor({ ...CLEAN, duplication_pct: 3 }), en);

    assert.deepEqual(entries.map((e) => e.level), ['error', 'error']);
    assert.equal(entries[0].text, 'duplication_pct regressed: 2.2 -> 3');
  });

  test('execucao verde fecha com aviso informativo', () => {
    assert.deepEqual(reportLogEntries(reportFor(CLEAN), en), [
      { level: 'notice', text: 'Ratchet green.' },
    ]);
  });

  test('execucao perdoada fecha com warning', () => {
    const report = reportFor(
      { ...CLEAN, duplication_pct: 3 },
      { context: { labels: ['hotfix'] }, options: OPTIONS },
    );

    assert.equal(reportLogEntries(report, en).at(-1)?.level, 'warning');
  });

  test('melhorias por fixar geram aviso informativo', () => {
    const entries = reportLogEntries(reportFor({ ...CLEAN, coverage_line_pct: 9 }), en);

    assert.match(entries[0].text, /Improvements to lock in: coverage_line_pct/);
  });
});
