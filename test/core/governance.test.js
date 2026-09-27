// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError } from '../../src/core/errors.js';
import {
  authoriseLowering,
  diffBaselines,
  loosenedChanges,
  movedSources,
  resolveContract,
  shouldBypass,
  sourceKey,
} from '../../src/core/governance.js';
import { v2 } from '../helpers.js';

const BASE = v2({
  coverage: { value: 70, direction: 'up', tolerance: 0.5, min: 60 },
  lint: { value: 100, direction: 'down', max: 200 },
});

/** Source do relatório de cobertura no ramo base. */
const LCOV = { format: 'lcov', path: 'coverage/lcov.info', field: 'lines' };

/** Source do relatório SARIF no ramo base. */
const SARIF = { format: 'sarif', path: 'lint.sarif', levels: ['error', 'warning'] };

/** Source que o PR poria no lugar do relatório real. */
const FAKE = { format: 'json', path: 'f.json', pointer: '/v' };

/** Baseline do ramo base com sources. */
const SOURCED = v2({
  coverage: { value: 70, direction: 'up', source: LCOV },
  lint: { value: 100, direction: 'down', source: SARIF },
  dup: { value: 3, direction: 'down' },
});

/**
 * Baseline do PR a partir do baseline com sources, com alterações numa métrica.
 * @param {string} name
 * @param {Record<string, unknown>} fields campos a mudar (undefined retira o campo)
 */
function sourcedWith(name, fields) {
  const metrics = Object.fromEntries(SOURCED.metrics.map(({ name: n, ...rule }) => (
    [n, /** @type {Record<string, unknown>} */ (rule)])));
  return v2({ ...metrics, [name]: { ...metrics[name], ...fields } });
}

/**
 * Baseline do PR a partir do baseline base, com alterações numa métrica.
 * @param {string} name
 * @param {Record<string, unknown>} fields
 */
function headWith(name, fields) {
  const metrics = Object.fromEntries(BASE.metrics.map(({ name: n, ...rule }) => [n, { ...rule }]));
  return v2({ ...metrics, [name]: { ...metrics[name], ...fields } });
}

/**
 * Alteração de uma métrica pelo nome.
 * @param {ReturnType<typeof diffBaselines>} changes
 * @param {string} name
 */
const changeOf = (changes, name) => changes.find((c) => c.name === name);

describe('diffBaselines', () => {
  test('baselines iguais nao tem alteracoes', () => {
    assert.ok(diffBaselines(BASE, BASE).every((c) => c.kind === 'unchanged'));
  });

  test('descer o valor de uma metrica up afrouxa', () => {
    const change = changeOf(diffBaselines(BASE, headWith('coverage', { value: 65 })), 'coverage');

    assert.deepEqual([change?.kind, change?.loosenedFields], ['loosened', ['value']]);
  });

  test('subir o valor de uma metrica up aperta', () => {
    const change = changeOf(diffBaselines(BASE, headWith('coverage', { value: 75 })), 'coverage');

    assert.equal(change?.kind, 'tightened');
  });

  test('subir o valor de uma metrica down afrouxa', () => {
    const change = changeOf(diffBaselines(BASE, headWith('lint', { value: 120 })), 'lint');

    assert.equal(change?.kind, 'loosened');
  });

  test('aumentar a tolerancia afrouxa', () => {
    const head = headWith('coverage', { tolerance: 1 });

    const change = changeOf(diffBaselines(BASE, head), 'coverage');

    assert.deepEqual(change?.loosenedFields, ['tolerance']);
  });

  test('retirar o minimo afrouxa', () => {
    const head = headWith('coverage', { min: undefined });

    assert.deepEqual(changeOf(diffBaselines(BASE, head), 'coverage')?.loosenedFields, ['min']);
  });

  test('subir o maximo afrouxa', () => {
    const head = headWith('lint', { max: 300 });

    assert.deepEqual(changeOf(diffBaselines(BASE, head), 'lint')?.loosenedFields, ['max']);
  });

  test('acrescentar um maximo aperta', () => {
    const head = headWith('coverage', { max: 100 });

    assert.deepEqual(changeOf(diffBaselines(BASE, head), 'coverage')?.tightenedFields, ['max']);
  });

  test('mudar a direccao afrouxa', () => {
    const head = headWith('coverage', { direction: 'down' });

    assert.deepEqual(changeOf(diffBaselines(BASE, head), 'coverage')?.loosenedFields, [
      'direction',
    ]);
  });

  test('apertar um campo e afrouxar outro conta como afrouxar', () => {
    const head = headWith('coverage', { value: 80, tolerance: 2 });

    assert.equal(changeOf(diffBaselines(BASE, head), 'coverage')?.kind, 'loosened');
  });

  test('metrica nova no PR e adicionada', () => {
    const head = headWith('dup', { value: 3, direction: 'down' });

    assert.equal(changeOf(diffBaselines(BASE, head), 'dup')?.kind, 'added');
  });

  test('metrica retirada pelo PR e removida e conta como afrouxar', () => {
    const head = v2({ coverage: { value: 70, direction: 'up', tolerance: 0.5, min: 60 } });

    assert.deepEqual(loosenedChanges(diffBaselines(BASE, head)).map((c) => c.kind), ['removed']);
  });

  test('mudar a direccao e a source lista os dois campos', () => {
    const head = sourcedWith('coverage', { direction: 'down', source: { ...LCOV, path: 'x' } });

    assert.deepEqual(changeOf(diffBaselines(SOURCED, head), 'coverage')?.loosenedFields, [
      'direction',
      'source',
    ]);
  });
});

describe('diffBaselines com sources', () => {
  test('trocar o path da source afrouxa a metrica', () => {
    const head = sourcedWith('coverage', { source: FAKE });

    const change = changeOf(diffBaselines(SOURCED, head), 'coverage');

    assert.deepEqual([change?.kind, change?.loosenedFields], ['loosened', ['source']]);
  });

  test('retirar a source afrouxa a metrica', () => {
    const head = sourcedWith('coverage', { source: undefined });

    assert.deepEqual(changeOf(diffBaselines(SOURCED, head), 'coverage')?.loosenedFields, [
      'source',
    ]);
  });

  test('acrescentar source a uma metrica sem source afrouxa a metrica', () => {
    const head = sourcedWith('dup', { source: { format: 'jscpd', path: 'jscpd.json' } });

    assert.deepEqual(changeOf(diffBaselines(SOURCED, head), 'dup')?.loosenedFields, ['source']);
  });

  test('reduzir os levels SARIF afrouxa a metrica', () => {
    const head = sourcedWith('lint', { source: { ...SARIF, levels: ['none'] } });

    assert.deepEqual(changeOf(diffBaselines(SOURCED, head), 'lint')?.loosenedFields, ['source']);
  });

  test('trocar o field lines por functions afrouxa a metrica', () => {
    const head = sourcedWith('coverage', { source: { ...LCOV, field: 'functions' } });

    assert.equal(changeOf(diffBaselines(SOURCED, head), 'coverage')?.kind, 'loosened');
  });

  test('os mesmos levels noutra ordem nao sao alteracao', () => {
    const head = sourcedWith('lint', { source: { ...SARIF, levels: ['warning', 'error'] } });

    assert.equal(changeOf(diffBaselines(SOURCED, head), 'lint')?.kind, 'unchanged');
  });

  test('o mesmo caminho escrito com ./ nao e alteracao', () => {
    const head = sourcedWith('coverage', { source: { ...LCOV, path: './coverage/lcov.info' } });

    assert.equal(changeOf(diffBaselines(SOURCED, head), 'coverage')?.kind, 'unchanged');
  });

  test('uma chave desconhecida na source nao muda a source', () => {
    const head = sourcedWith('coverage', { source: { ...LCOV, note: 'x' } });

    assert.equal(changeOf(diffBaselines(SOURCED, head), 'coverage')?.kind, 'unchanged');
  });
});

describe('diffBaselines com campos informativos', () => {
  test('mudar so a descricao fica registado como alteracao informativa', () => {
    const change = changeOf(diffBaselines(BASE, headWith('lint', { description: 'd' })), 'lint');

    assert.deepEqual([change?.kind, change?.changedFields], ['changed', ['description']]);
  });

  test('mudar so o objectivo fica registado como alteracao informativa', () => {
    const change = changeOf(diffBaselines(BASE, headWith('lint', { target: 50 })), 'lint');

    assert.deepEqual([change?.kind, change?.changedFields], ['changed', ['target']]);
  });

  test('alteracao informativa nao afrouxa', () => {
    const head = headWith('lint', { description: 'd', target: 50 });

    assert.deepEqual(loosenedChanges(diffBaselines(BASE, head)), []);
  });

  test('apertar e mudar a descricao lista os dois campos', () => {
    const change = changeOf(diffBaselines(BASE, headWith('lint', { value: 90, description: 'd' })),
      'lint');

    assert.deepEqual([change?.kind, change?.tightenedFields, change?.changedFields], [
      'tightened',
      ['value'],
      ['description'],
    ]);
  });
});

describe('resolveContract', () => {
  test('sem baseline base vale o do PR', () => {
    const head = headWith('coverage', { value: 10 });

    assert.equal(resolveContract(null, head, false), head);
  });

  test('com autorizacao vale o do PR', () => {
    const head = headWith('coverage', { value: 10 });

    assert.equal(resolveContract(BASE, head, true), head);
  });

  test('sem autorizacao fica o valor mais exigente', () => {
    const contract = resolveContract(BASE, headWith('coverage', { value: 10 }), false);

    assert.equal(contract.metrics[0].value, 70);
  });

  test('sem autorizacao o aperto do PR e respeitado', () => {
    const contract = resolveContract(BASE, headWith('coverage', { value: 75 }), false);

    assert.equal(contract.metrics[0].value, 75);
  });

  test('sem autorizacao fica a menor tolerancia e os limites mais exigentes', () => {
    const head = headWith('coverage', { tolerance: 2, min: 50, max: 99 });

    const [coverage] = resolveContract(BASE, head, false).metrics;

    assert.deepEqual([coverage.tolerance, coverage.min, coverage.max], [0.5, 60, 99]);
  });

  test('sem autorizacao a metrica retirada continua a ser verificada', () => {
    const head = v2({ coverage: { value: 70, direction: 'up' } });

    assert.deepEqual(resolveContract(BASE, head, false).metrics.map((r) => r.name), [
      'coverage',
      'lint',
    ]);
  });

  test('sem autorizacao a mudanca de direccao e ignorada', () => {
    const contract = resolveContract(BASE, headWith('coverage', { direction: 'down' }), false);

    assert.equal(contract.metrics[0].direction, 'up');
  });

  test('sem autorizacao o contrato mantem a source do ramo base', () => {
    const head = sourcedWith('coverage', { source: FAKE });

    assert.deepEqual(resolveContract(SOURCED, head, false).metrics[0].source, LCOV);
  });

  test('sem autorizacao a source acrescentada pelo PR sai do contrato', () => {
    const head = sourcedWith('dup', { source: { format: 'jscpd', path: 'jscpd.json' } });

    const dup = resolveContract(SOURCED, head, false).metrics.find((r) => r.name === 'dup');

    assert.equal(dup?.source, undefined);
  });

  test('sem autorizacao a source retirada pelo PR volta ao contrato', () => {
    const head = sourcedWith('coverage', { source: undefined });

    assert.deepEqual(resolveContract(SOURCED, head, false).metrics[0].source, LCOV);
  });

  test('a source do PR escrita de outra forma mantem-se no contrato', () => {
    const equivalent = { ...LCOV, path: './coverage/lcov.info' };

    const head = sourcedWith('coverage', { source: equivalent });

    assert.deepEqual(resolveContract(SOURCED, head, false).metrics[0].source, equivalent);
  });

  test('com autorizacao o contrato usa a source do PR', () => {
    const contract = resolveContract(SOURCED, sourcedWith('coverage', { source: FAKE }), true);

    assert.deepEqual(contract.metrics[0].source, FAKE);
  });
});

describe('movedSources', () => {
  /**
   * @param {import('../../src/core/types.js').Baseline} head
   */
  const movedNames = (head) => movedSources(SOURCED, head).map((rule) => rule.name);

  test('lista a metrica cuja source o PR trocou', () => {
    assert.deepEqual(movedNames(sourcedWith('coverage', { source: FAKE })), ['coverage']);
  });

  test('lista a metrica retirada que tinha source', () => {
    const head = v2({ dup: { value: 3, direction: 'down' } });

    assert.deepEqual(movedNames(head), ['coverage', 'lint']);
  });

  test('ignora a metrica retirada que nao tinha source', () => {
    const head = v2({
      coverage: { value: 70, direction: 'up', source: LCOV },
      lint: { value: 100, direction: 'down', source: SARIF },
    });

    assert.deepEqual(movedNames(head), []);
  });
});

describe('sourceKey', () => {
  test('regra sem source da chave vazia', () => {
    assert.equal(sourceKey(BASE.metrics[0]), '');
  });

  test('regra inexistente da chave vazia', () => {
    assert.equal(sourceKey(undefined), '');
  });

  test('levels repetidos contam uma vez', () => {
    const levels = ['error', 'warning', 'error'];

    const repeated = sourcedWith('lint', { source: { ...SARIF, levels } });

    assert.equal(sourceKey(repeated.metrics[1]), sourceKey(SOURCED.metrics[1]));
  });
});

describe('authoriseLowering', () => {
  const pattern = '^chore(\\([^)]*\\))?: lower baseline';

  test('titulo que declara a descida autoriza', () => {
    const decision = authoriseLowering({ title: 'chore: lower baseline apos migracao', pattern });

    assert.equal(decision.granted, true);
  });

  test('o motivo cita o titulo', () => {
    const title = 'chore(api): lower baseline';

    assert.deepEqual(authoriseLowering({ title, pattern }).reason, {
      code: 'reason_title',
      params: { title },
    });
  });

  test('refactor ja nao autoriza nada por omissao', () => {
    assert.equal(authoriseLowering({ title: 'refactor: limpar', pattern }).granted, false);
  });

  test('padrao vazio nunca autoriza', () => {
    assert.equal(authoriseLowering({ title: 'qualquer', pattern: '' }).granted, false);
  });

  test('padrao invalido rebenta com erro de configuracao', () => {
    assert.throws(
      () => authoriseLowering({ title: 'x', pattern: '(' }),
      (error) => error instanceof ConfigError && error.code === 'config_pattern_invalid',
    );
  });
});

describe('shouldBypass', () => {
  test('label de hotfix perdoa a falha', () => {
    const decision = shouldBypass({
      labels: ['bug', 'hotfix-bypass-ratchet'],
      bypassLabel: 'hotfix-bypass-ratchet',
    });

    assert.deepEqual(decision.reason, {
      code: 'reason_label',
      params: { label: 'hotfix-bypass-ratchet' },
    });
  });

  test('a label compara sem distinguir maiusculas', () => {
    const decision = shouldBypass({ labels: ['Hotfix-Bypass'], bypassLabel: 'hotfix-bypass' });

    assert.equal(decision.granted, true);
  });

  test('PR normal nao e perdoado', () => {
    const decision = shouldBypass({ labels: ['enhancement'], bypassLabel: 'hotfix' });

    assert.deepEqual(decision, { granted: false, reason: null });
  });

  test('label configurada vazia nunca perdoa', () => {
    assert.equal(shouldBypass({ labels: [''], bypassLabel: '' }).granted, false);
  });
});
