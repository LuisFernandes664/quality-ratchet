// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createTranslator } from '../../src/core/messages.js';
import { runRatchet } from '../../src/core/ratchet.js';
import {
  formatNumber,
  formatNumbers,
  renderSummary,
  reportLogEntries,
} from '../../src/core/summary.js';
import { CLEAN, measured, v1, v2 } from '../helpers.js';

/** @typedef {import('../../src/core/types.js').Baseline} Baseline */

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

/**
 * Relatório de uma métrica v2 sem governação.
 * @param {Record<string, unknown>} rule
 * @param {unknown} current valor medido
 */
function singleReport(rule, current) {
  return runRatchet({ head: v2({ m: rule }), base: null, measurements: measured({ m: current }) });
}

/**
 * Baseline com uma métrica renomeada, sem passar pela validação dos nomes: o sumário não
 * pode depender dela para se proteger.
 * @param {Baseline} baseline
 * @param {string} from
 * @param {string} to
 * @returns {Baseline}
 */
function renamed(baseline, from, to) {
  const metrics = baseline.metrics.map((rule) => (
    rule.name === from ? { ...rule, name: to } : rule));
  return { ...baseline, metrics };
}

/**
 * Sumário de um relatório com uma métrica de nome arbitrário e a cobertura a regredir.
 * @param {string} name
 */
function summaryWithName(name) {
  const head = renamed(v2({
    x: { value: 1, direction: 'up' },
    coverage: { value: 80, direction: 'up' },
  }), 'x', name);
  const measurements = measured({ [name]: 1, coverage: 40 });
  return renderSummary(runRatchet({ head, base: null, measurements }), en);
}

/**
 * Linha da tabela de uma métrica.
 * @param {string} markdown
 * @param {string} fragment texto que identifica a linha
 */
function rowOf(markdown, fragment) {
  return markdown.split('\n').find((line) => line.startsWith('|') && line.includes(fragment)) ?? '';
}

/**
 * Número de células de uma linha de tabela (os `|` escapados não separam células).
 * @param {string} line
 */
const cellCount = (line) => line.split(/(?<!\\)\|/).length;

/** Relatório vermelho em português com o lint a regredir. */
const redSummary = () => renderSummary(reportFor({ ...CLEAN, lint_violations_total: 500 }), pt);

/** Relatório com o baseline da cobertura baixado no PR sem autorização. */
const loosenedReport = (options = OPTIONS) => runRatchet({
  head: v1({ coverage_line_pct: 5 }),
  base: v1(),
  measurements: measured({ ...CLEAN, coverage_line_pct: 5 }),
  options,
});

describe('renderSummary', () => {
  test('em portugues o veredicto vermelho e em portugues', () => {
    assert.match(redSummary(), /Catraca vermelha/);
  });

  test('a linha da metrica mostra baseline, actual e delta', () => {
    assert.match(redSummary(), /lint_violations_total.*483.*500.*\+17/);
  });

  test('lista todas as metricas seguidas', () => {
    const markdown = redSummary();

    assert.deepEqual(Object.keys(CLEAN).filter((name) => !markdown.includes(name)), []);
  });

  test('o rodape mostra a data de congelamento do baseline', () => {
    assert.match(redSummary(), /<sub>.*2026-05-04.*<\/sub>/);
  });

  test('em ingles o veredicto verde e em ingles', () => {
    assert.match(renderSummary(reportFor(CLEAN), en), /Ratchet green/);
  });

  test('o veredicto verde nao nega regressoes toleradas', () => {
    const report = singleReport({ value: 80, direction: 'up', tolerance: 1 }, 79.2);

    assert.match(renderSummary(report, en), /\*\*Ratchet green\. No metric regressed beyond its/);
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
    const report = singleReport({ value: 7, direction: 'up', tolerance: 0.5 }, 6.8);

    assert.match(renderSummary(report, en), /-0\.2 \(±0\.5\)/);
  });

  test('acrescenta a coluna de objectivo so quando ha objectivos', () => {
    const report = singleReport({ value: 7, direction: 'up', target: 80 }, 7);

    assert.match(renderSummary(report, en), /\| Target \|/);
  });

  test('sem objectivos nao ha coluna de objectivo', () => {
    assert.doesNotMatch(renderSummary(reportFor(CLEAN), en), /Target/);
  });

  test('o bloco do baseline actualizado indica quantas metricas foram apertadas', () => {
    const markdown = renderSummary(reportFor({ ...CLEAN, coverage_line_pct: 9 }), en);

    assert.match(markdown, /<details><summary>Updated baseline \(1 metric\(s\) tightened\)/);
  });

  test('o bloco do baseline actualizado contem o valor apertado', () => {
    const markdown = renderSummary(reportFor({ ...CLEAN, coverage_line_pct: 9 }), en);

    assert.match(markdown, /"coverage_line_pct": 9/);
  });

  test('lista as alteracoes ao baseline', () => {
    const markdown = renderSummary(loosenedReport(), en);

    assert.match(markdown, /\| `coverage_line_pct` \| loosened \| value \|/);
  });

  test('assinala o afrouxamento nao autorizado', () => {
    const markdown = renderSummary(loosenedReport(), en);

    assert.match(markdown, /loosens the baseline \(`coverage_line_pct`\) without authorisation/);
  });

  test('com o padrao vazio a nota diz que afrouxar esta desligado', () => {
    const options = { ...OPTIONS, lowerBaselinePattern: '' };

    assert.match(renderSummary(loosenedReport(options), en), /loosening is turned off/);
  });

  test('com o padrao vazio a nota nao sugere mudar o titulo', () => {
    const options = { ...OPTIONS, lowerBaselinePattern: '' };

    assert.doesNotMatch(renderSummary(loosenedReport(options), en), /Give it a title/);
  });

  test('em portugues a nota com o padrao vazio tambem nao sugere o titulo', () => {
    const options = { ...OPTIONS, lowerBaselinePattern: '' };

    assert.match(renderSummary(loosenedReport(options), pt), /afrouxar está desligado/);
  });

  test('a tabela de alteracoes mostra o campo source', () => {
    const lcov = { format: 'lcov', path: 'coverage/lcov.info' };
    const fake = { format: 'json', path: 'fake.json', pointer: '/v' };
    const report = runRatchet({
      head: v2({ coverage: { value: 80, direction: 'up', source: fake } }),
      base: v2({ coverage: { value: 80, direction: 'up', source: lcov } }),
      measurements: measured({}),
      options: OPTIONS,
    });

    assert.match(renderSummary(report, en), /\| `coverage` \| loosened \| source \|/);
  });

  test('a tabela de alteracoes mostra as alteracoes informativas', () => {
    const report = runRatchet({
      head: v2({ c: { value: 1, direction: 'up', description: 'nova' } }),
      base: v2({ c: { value: 1, direction: 'up' } }),
      measurements: measured({ c: 1 }),
      options: OPTIONS,
    });

    assert.match(renderSummary(report, pt), /\| `c` \| alterada \| description \|/);
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

describe('renderSummary com texto vindo do pull request', () => {
  test('nome com | fica escapado na tabela', () => {
    assert.match(rowOf(summaryWithName('a|b'), 'a\\|b'), /`a\\\|b`/);
  });

  test('nome com | nao acrescenta colunas a tabela', () => {
    const markdown = summaryWithName('a|b');

    assert.equal(cellCount(rowOf(markdown, 'a\\|b')), cellCount(rowOf(markdown, '`coverage`')));
  });

  test('nome com crase usa uma cerca maior', () => {
    assert.match(summaryWithName('a`b'), /\| ``a`b`` \|/);
  });

  test('nome com quebra de linha nao abre um comentario HTML', () => {
    const lines = summaryWithName('x`\n\n<!--').split('\n');

    assert.deepEqual(lines.filter((line) => line.startsWith('<!--')), []);
  });

  test('nome com quebra de linha nao cria cabecalhos falsos', () => {
    const lines = summaryWithName('x\n\n## Ratchet green').split('\n');

    assert.deepEqual(lines.filter((line) => line.startsWith('## Ratchet')), []);
  });

  test('a linha da metrica seguinte continua na tabela', () => {
    assert.match(summaryWithName('x`\n\n<!--'), /^\| ❌ \| `coverage` \| 80 \| 40 \| -40 \|$/m);
  });

  test('o detalhe de uma metrica com quebra de linha fica numa so linha', () => {
    const head = renamed(v2({ x: { value: 1, direction: 'up' } }), 'x', 'x\n<!--');
    const report = runRatchet({ head, base: null, measurements: {} });

    assert.match(renderSummary(report, en), /^- `x <!--`: not present/m);
  });

  test('aviso com quebra de linha fica numa so linha', () => {
    const head = v2({ a: { value: 1, direction: 'up', 'x\n\n<!--': 1 } });
    const report = runRatchet({ head, base: null, measurements: measured({ a: 1 }) });

    assert.match(renderSummary(report, en), /^- unknown field "x  <!--" in metric "a"/m);
  });

  test('metrica nao seguida com quebra de linha fica numa so linha', () => {
    const markdown = renderSummary(reportFor(CLEAN, { untracked: ['y\n<!--'] }), en);

    assert.match(markdown, /^- Measured but not tracked by the baseline: `y <!--`\.$/m);
  });

  test('o titulo que autoriza aparece num code span', () => {
    const title = 'chore: lower baseline @org/team <b>x</b>';

    const report = runRatchet({ ...loosenedInput(), context: { title } });

    assert.match(renderSummary(report, en), /`chore: lower baseline @org\/team <b>x<\/b>`/);
  });

  test('o titulo com quebra de linha nao sai da nota', () => {
    const title = 'chore: lower baseline\n\n<!--';

    const report = runRatchet({ ...loosenedInput(), context: { title } });

    const note = /^> Baseline loosened .*`chore: lower baseline {2}<!--`/m;

    assert.match(renderSummary(report, en), note);
  });
});

/**
 * Entrada de runRatchet com a cobertura baixada no PR.
 * @returns {import('../../src/core/ratchet.js').RatchetInput}
 */
function loosenedInput() {
  return {
    head: v1({ coverage_line_pct: 5 }),
    base: v1(),
    measurements: measured({ ...CLEAN, coverage_line_pct: 5 }),
    options: OPTIONS,
  };
}

describe('renderSummary com valores muito proximos', () => {
  const rule = { value: 0.81234, direction: 'up', tolerance: 0.00002 };

  test('uma regressao abaixo das quatro casas mostra os valores distintos', () => {
    const markdown = renderSummary(singleReport(rule, 0.81231), en);

    assert.match(markdown, /\| ❌ \| `m` \| 0\.81234 \| 0\.81231 \| -0\.00003 \|/);
  });

  test('uma regressao tolerada muito pequena mostra o delta e a tolerancia', () => {
    const markdown = renderSummary(singleReport(rule, 0.81233), en);

    assert.match(markdown, /\| -0\.00001 \(±0\.00002\) \|/);
  });

  test('uma melhoria muito pequena nao aparece como +0', () => {
    const markdown = renderSummary(singleReport(rule, 0.81235), en);

    assert.match(markdown, /\| \+0\.00001 \|/);
  });

  test('valores normais continuam com quatro casas', () => {
    const markdown = renderSummary(singleReport({ value: 7, direction: 'up' }, 7.123456), en);

    assert.match(markdown, /\| 7 \| 7\.1235 \| \+0\.1235 \|/);
  });
});

describe('formatNumber', () => {
  test('arredonda a quatro casas e retira zeros', () => {
    assert.deepEqual([formatNumber(81.60000000001), formatNumber(7)], ['81.6', '7']);
  });
});

describe('formatNumbers', () => {
  test('valores distintos a quatro casas ficam com quatro casas', () => {
    assert.deepEqual(formatNumbers([81.60000000001, 7]), ['81.6', '7']);
  });

  test('valores que so diferem depois da quarta casa ganham casas', () => {
    assert.deepEqual(formatNumbers([50.00001, 50]), ['50.00001', '50']);
  });

  test('diferencas dentro da margem de ruido nao ganham casas', () => {
    assert.deepEqual(formatNumbers([7, 7 + 1e-12]), ['7', '7']);
  });

  test('valores com diferencas entre 1e-8 e 1e-4 aparecem sempre distintos', () => {
    const bases = [0, 0.5, 0.81234, 1, 7, 50, 99.99, 12345.678];
    const gaps = [1e-8, 3e-8, 1e-7, 5e-6, 1e-5, 4e-5, 1e-4, -1e-8, -4e-5];

    const equal = bases.flatMap((a) => gaps.map((gap) => formatNumbers([a, a + gap])))
      .filter(([before, after]) => before === after);

    assert.deepEqual(equal, []);
  });
});

describe('reportLogEntries', () => {
  test('um erro por metrica em falha', () => {
    const entries = reportLogEntries(reportFor({ ...CLEAN, duplication_pct: 3 }), en);

    assert.deepEqual(entries.slice(0, -1), [
      { level: 'error', text: 'duplication_pct regressed: 2.2 -> 3' },
    ]);
  });

  test('execucao vermelha fecha com erro', () => {
    const entries = reportLogEntries(reportFor({ ...CLEAN, duplication_pct: 3 }), en);

    assert.equal(entries.at(-1)?.level, 'error');
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

  test('uma regressao abaixo das quatro casas mostra os valores distintos', () => {
    const report = singleReport({ value: 0.81234, direction: 'up' }, 0.81231);

    assert.equal(reportLogEntries(report, en)[0].text, 'm regressed: 0.81234 -> 0.81231');
  });

  test('uma regressao de 50.00001 para 50 nao aparece como 50 -> 50', () => {
    const report = singleReport({ value: 50.00001, direction: 'up' }, 50);

    assert.equal(reportLogEntries(report, en)[0].text, 'm regressed: 50.00001 -> 50');
  });

  test('com o padrao vazio o erro de afrouxamento nao sugere mudar o titulo', () => {
    const report = loosenedReport({ ...OPTIONS, lowerBaselinePattern: '' });

    const texts = reportLogEntries(report, en).map((entry) => entry.text);

    assert.ok(texts.some((text) => text.includes('loosening is turned off')));
  });

  test('ordem: falhas, melhorias por fixar, afrouxamento, apertos e fecho', () => {
    const report = runRatchet({
      head: v1({ coverage_line_pct: 5 }),
      base: v1(),
      measurements: measured({
        ...CLEAN, coverage_line_pct: 5, duplication_pct: 3, lint_violations_total: 400,
      }),
      options: { ...OPTIONS, strict: true },
    });

    assert.deepEqual(reportLogEntries(report, en).map((entry) => entry.text.slice(0, 24)), [
      'duplication_pct regresse',
      'coverage_line_pct regres',
      'lint_violations_total im',
      'This pull request loosen',
      'Improvements to lock in:',
      'Ratchet red. 2 failing m',
    ]);
  });
});
