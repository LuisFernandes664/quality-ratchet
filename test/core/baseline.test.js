import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  migrateToV2,
  parseBaseline,
  serializeBaseline,
  withValues,
} from '../../src/core/baseline.js';
import { BaselineError } from '../../src/core/errors.js';
import { V1_RAW } from '../helpers.js';

/**
 * Códigos dos problemas de um BaselineError lançado por `fn`.
 * @param {() => unknown} fn
 * @returns {string[]}
 */
function issueCodes(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BaselineError);
    return /** @type {Array<{code: string}>} */ (error.params.issues).map((i) => i.code);
  }
  assert.fail('era esperado um BaselineError');
}

describe('parseBaseline v1', () => {
  test('normaliza as regras pela ordem down e depois up', () => {
    const baseline = parseBaseline(V1_RAW);

    assert.deepEqual(
      baseline.metrics.map((rule) => [rule.name, rule.direction, rule.value]),
      [
        ['lint_violations_total', 'down', 483],
        ['duplication_pct', 'down', 2.2],
        ['coverage_line_pct', 'up', 7],
        ['mutation_score_covered_pct', 'up', 81.6],
      ],
    );
  });

  test('marca o formato original como v1', () => {
    assert.equal(parseBaseline(V1_RAW).version, 1);
  });

  test('guarda a data de congelamento', () => {
    assert.equal(parseBaseline(V1_RAW).frozenAt, '2026-05-04');
  });

  test('tolerancia por omissao e zero', () => {
    assert.ok(parseBaseline(V1_RAW).metrics.every((rule) => rule.tolerance === 0));
  });

  test('baseline sem regras rebenta em vez de passar silenciosamente', () => {
    assert.deepEqual(issueCodes(() => parseBaseline({ metrics: {} })), ['baseline_no_rules']);
  });

  test('regra sem valor no baseline e erro', () => {
    const raw = { metrics: {}, rules: { monotonic_up: ['coverage'] } };

    assert.deepEqual(issueCodes(() => parseBaseline(raw)), ['rule_without_value']);
  });

  test('metrica nas duas direccoes e erro', () => {
    const raw = { metrics: { a: 1 }, rules: { monotonic_up: ['a'], monotonic_down: ['a'] } };

    assert.deepEqual(issueCodes(() => parseBaseline(raw)), ['metric_in_both_directions']);
  });

  test('metrica repetida na mesma lista e erro', () => {
    const raw = { metrics: { a: 1 }, rules: { monotonic_up: ['a', 'a'] } };

    assert.deepEqual(issueCodes(() => parseBaseline(raw)), ['metric_duplicated']);
  });

  test('valor nao numerico no baseline e erro', () => {
    const raw = { metrics: { a: '7' }, rules: { monotonic_up: ['a'] } };

    assert.deepEqual(issueCodes(() => parseBaseline(raw)), ['value_not_numeric']);
  });

  test('regras que nao sao lista de nomes sao erro', () => {
    const raw = { metrics: { a: 1 }, rules: { monotonic_up: 'a' } };

    assert.ok(issueCodes(() => parseBaseline(raw)).includes('rules_not_list'));
  });

  test('valor sem regra gera aviso em vez de ser ignorado em silencio', () => {
    const raw = { metrics: { a: 1, b: 2 }, rules: { monotonic_up: ['a'] } };

    const baseline = parseBaseline(raw);

    assert.deepEqual(baseline.warnings, [{ code: 'metric_without_rule', params: { name: 'b' } }]);
  });

  test('valor sem regra fica guardado para ser reescrito', () => {
    const raw = { metrics: { a: 1, b: 2 }, rules: { monotonic_up: ['a'] } };

    assert.deepEqual(parseBaseline(raw).untracked, { b: 2 });
  });

  test('reporta todos os problemas de uma vez', () => {
    const raw = { metrics: { a: 'x' }, rules: { monotonic_up: ['a', 'b'] } };

    assert.deepEqual(issueCodes(() => parseBaseline(raw)), [
      'value_not_numeric',
      'rule_without_value',
    ]);
  });
});

describe('parseBaseline v2', () => {
  const raw = {
    version: 2,
    metrics: {
      coverage: { value: 7, direction: 'up', tolerance: 0.2, min: 5, target: 80 },
      vulns: { value: 0, direction: 'down', max: 0, description: 'altas e criticas' },
    },
  };

  test('le todos os campos de uma metrica', () => {
    const [coverage] = parseBaseline(raw).metrics;

    assert.deepEqual(coverage, {
      name: 'coverage', value: 7, direction: 'up', tolerance: 0.2, min: 5, target: 80,
    });
  });

  test('le a descricao como texto informativo', () => {
    assert.equal(parseBaseline(raw).metrics[1].description, 'altas e criticas');
  });

  test('detecta o formato v2 pela forma das metricas sem campo version', () => {
    const { version, ...withoutVersion } = raw;

    assert.equal(parseBaseline(withoutVersion).version, 2);
  });

  test('le a source da metrica', () => {
    const source = { format: 'lcov', path: 'coverage/lcov.info', field: 'lines' };
    const baseline = parseBaseline({ metrics: { c: { value: 1, direction: 'up', source } } });

    assert.deepEqual(baseline.metrics[0].source, source);
  });

  test('direccao invalida e erro', () => {
    const bad = { metrics: { a: { value: 1, direction: 'sideways' } } };

    assert.deepEqual(issueCodes(() => parseBaseline(bad)), ['direction_invalid']);
  });

  test('tolerancia negativa e erro', () => {
    const bad = { metrics: { a: { value: 1, direction: 'up', tolerance: -1 } } };

    assert.deepEqual(issueCodes(() => parseBaseline(bad)), ['tolerance_invalid']);
  });

  test('limite nao numerico e erro', () => {
    const bad = { metrics: { a: { value: 1, direction: 'up', min: '5' } } };

    assert.deepEqual(issueCodes(() => parseBaseline(bad)), ['limit_not_numeric']);
  });

  test('min acima de max e erro', () => {
    const bad = { metrics: { a: { value: 1, direction: 'up', min: 5, max: 2 } } };

    assert.ok(issueCodes(() => parseBaseline(bad)).includes('limits_inverted'));
  });

  test('source sem path e erro', () => {
    const bad = { metrics: { a: { value: 1, direction: 'up', source: { format: 'lcov' } } } };

    assert.deepEqual(issueCodes(() => parseBaseline(bad)), ['source_invalid']);
  });

  test('metrica que nao e objecto e erro', () => {
    const bad = { version: 2, metrics: { a: 3 } };

    assert.deepEqual(issueCodes(() => parseBaseline(bad)), ['metric_not_object']);
  });

  test('mistura de formatos e erro', () => {
    const bad = { metrics: { a: 3, b: { value: 1, direction: 'up' } } };

    assert.ok(issueCodes(() => parseBaseline(bad)).includes('baseline_mixed_format'));
  });

  test('versao desconhecida e erro', () => {
    const bad = { version: 3, metrics: { a: { value: 1, direction: 'up' } } };

    assert.ok(issueCodes(() => parseBaseline(bad)).includes('version_unsupported'));
  });

  test('valor nulo e erro fora dos fluxos de init e update', () => {
    const bad = { metrics: { a: { value: null, direction: 'up' } } };

    assert.deepEqual(issueCodes(() => parseBaseline(bad)), ['value_not_numeric']);
  });

  test('valor nulo e aceite quando allowEmptyValues', () => {
    const empty = { metrics: { a: { value: null, direction: 'up' } } };

    assert.equal(parseBaseline(empty, { allowEmptyValues: true }).metrics[0].value, null);
  });

  test('campo desconhecido gera aviso', () => {
    const typo = { metrics: { a: { value: 1, direction: 'up', tolerence: 1 } } };

    assert.deepEqual(parseBaseline(typo).warnings, [
      { code: 'unknown_field', params: { name: 'a', field: 'tolerence' } },
    ]);
  });

  test('valor que ja viola o proprio limite gera aviso', () => {
    const over = { metrics: { a: { value: 3, direction: 'down', max: 0 } } };

    assert.equal(parseBaseline(over).warnings[0].code, 'value_violates_limit');
  });

  test('baseline que nao e objecto e erro', () => {
    assert.deepEqual(issueCodes(() => parseBaseline([])), ['baseline_not_object']);
  });

  test('frozen_at que nao e texto e erro', () => {
    const bad = { frozen_at: 20260504, metrics: { a: { value: 1, direction: 'up' } } };

    assert.deepEqual(issueCodes(() => parseBaseline(bad)), ['frozen_at_invalid']);
  });

  test('nome de metrica __proto__ nao contamina o prototipo', () => {
    const tricky = JSON.parse('{"metrics": {"__proto__": {"value": 1, "direction": "up"}}}');

    assert.equal(parseBaseline(tricky).metrics[0].name, '__proto__');
  });
});

describe('serializeBaseline', () => {
  test('v1 volta ao formato v1 com os valores sem regra', () => {
    const raw = { ...V1_RAW, metrics: { ...V1_RAW.metrics, extra: 3 } };

    assert.deepEqual(serializeBaseline(parseBaseline(raw)), raw);
  });

  test('v2 omite tolerancia zero e campos vazios', () => {
    const raw = { version: 2, frozen_at: 'x', metrics: { a: { value: 1, direction: 'up' } } };

    assert.deepEqual(serializeBaseline(parseBaseline(raw)), raw);
  });

  test('v2 preserva $schema, limites, objectivo, source e descricao', () => {
    const raw = {
      $schema: './schema.json',
      version: 2,
      metrics: {
        a: {
          value: 1, direction: 'up', tolerance: 0.5, min: 0, max: 2, target: 2,
          source: { format: 'json', path: 'm.json', pointer: '/a' }, description: 'd',
        },
      },
    };

    assert.deepEqual(serializeBaseline(parseBaseline(raw)), raw);
  });
});

describe('migrateToV2', () => {
  test('converte regras v1 em metricas v2', () => {
    const { baseline } = migrateToV2(parseBaseline(V1_RAW));

    assert.deepEqual(serializeBaseline(baseline).metrics, {
      lint_violations_total: { value: 483, direction: 'down' },
      duplication_pct: { value: 2.2, direction: 'down' },
      coverage_line_pct: { value: 7, direction: 'up' },
      mutation_score_covered_pct: { value: 81.6, direction: 'up' },
    });
  });

  test('devolve os valores sem regra que nao podem ser migrados', () => {
    const raw = { ...V1_RAW, metrics: { ...V1_RAW.metrics, extra: 3 } };

    assert.deepEqual(migrateToV2(parseBaseline(raw)).dropped, ['extra']);
  });
});

describe('withValues', () => {
  test('substitui so os valores indicados', () => {
    const updated = withValues(parseBaseline(V1_RAW), new Map([['duplication_pct', 1.5]]));

    assert.deepEqual(updated.metrics.map((rule) => rule.value), [483, 1.5, 7, 81.6]);
  });

  test('actualiza a data quando indicada', () => {
    const updated = withValues(parseBaseline(V1_RAW), new Map(), '2026-09-27');

    assert.equal(updated.frozenAt, '2026-09-27');
  });
});
