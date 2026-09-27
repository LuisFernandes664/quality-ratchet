import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError } from '../../src/core/errors.js';
import {
  authoriseLowering,
  diffBaselines,
  loosenedChanges,
  resolveContract,
  shouldBypass,
} from '../../src/core/governance.js';
import { v2 } from '../helpers.js';

const BASE = v2({
  coverage: { value: 70, direction: 'up', tolerance: 0.5, min: 60 },
  lint: { value: 100, direction: 'down', max: 200 },
});

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
