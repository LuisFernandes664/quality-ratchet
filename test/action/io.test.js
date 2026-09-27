// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ConfigError } from '../../src/core/errors.js';
import {
  createActionIO,
  readBooleanInput,
  readInput,
  readOptionalInput,
} from '../../src/action/io.js';

/**
 * Dependências falsas: regista escritas em ficheiro e linhas no stdout; randomId devolve os
 * identificadores indicados, por ordem.
 * @param {Record<string, string|undefined>} env
 * @param {string[]} [ids]
 */
function fakeDeps(env, ids = ['abc']) {
  /** @type {Array<{path: string, text: string}>} */
  const files = [];
  /** @type {string[]} */
  const lines = [];
  let next = 0;
  const deps = {
    env,
    appendFile: async (/** @type {string} */ path, /** @type {string} */ text) => {
      files.push({ path, text });
    },
    write: (/** @type {string} */ line) => lines.push(line),
    randomId: () => ids[Math.min(next++, ids.length - 1)],
  };
  return { io: createActionIO(deps), files, lines };
}

describe('readOptionalInput', () => {
  test('devolve o fallback quando a variável não existe', () => {
    assert.equal(readOptionalInput({}, 'bypass-label', 'hotfix'), 'hotfix');
  });

  test('valor vazio explícito devolve vazio e desliga a funcionalidade', () => {
    assert.equal(readOptionalInput({ 'INPUT_BYPASS-LABEL': '' }, 'bypass-label', 'hotfix'), '');
  });

  test('remove os espaços à volta do valor', () => {
    assert.equal(readOptionalInput({ 'INPUT_BYPASS-LABEL': ' x ' }, 'bypass-label', 'h'), 'x');
  });
});

describe('readInput', () => {
  test('lê a variável INPUT_ com o nome em maiúsculas', () => {
    assert.equal(readInput({ INPUT_BASELINE: 'q.json' }, 'baseline'), 'q.json');
  });

  test('mantém os hífenes do nome (INPUT_BYPASS-LABEL)', () => {
    assert.equal(readInput({ 'INPUT_BYPASS-LABEL': 'hotfix' }, 'bypass-label'), 'hotfix');
  });

  test('converte os espaços do nome em _', () => {
    const env = { INPUT_LOWER_BASELINE_PATTERN: '^chore' };
    assert.equal(readInput(env, 'lower baseline pattern'), '^chore');
  });

  test('remove os espaços à volta do valor', () => {
    assert.equal(readInput({ INPUT_TOKEN: '  abc \n' }, 'token'), 'abc');
  });

  test('devolve o fallback quando a variável está ausente', () => {
    assert.equal(readInput({}, 'baseline', 'quality-baseline.json'), 'quality-baseline.json');
  });

  test('devolve o fallback quando o valor só tem espaços', () => {
    assert.equal(readInput({ INPUT_BASELINE: '   ' }, 'baseline', 'x.json'), 'x.json');
  });
});

describe('readBooleanInput', () => {
  test('aceita true', () => {
    assert.equal(readBooleanInput({ INPUT_COMMENT: 'true' }, 'comment', false), true);
  });

  test('aceita false', () => {
    assert.equal(readBooleanInput({ INPUT_COMMENT: 'false' }, 'comment', true), false);
  });

  test('não distingue maiúsculas (TRUE)', () => {
    assert.equal(readBooleanInput({ INPUT_COMMENT: 'TRUE' }, 'comment', false), true);
  });

  test('devolve o fallback quando o input está vazio', () => {
    assert.equal(readBooleanInput({ INPUT_COMMENT: '' }, 'comment', true), true);
  });

  test('devolve o fallback quando o input está ausente', () => {
    assert.equal(readBooleanInput({}, 'comment', false), false);
  });

  test('remove os espaços à volta do valor', () => {
    assert.equal(readBooleanInput({ INPUT_COMMENT: ' false\n' }, 'comment', true), false);
  });

  test('lança ConfigError config_boolean_invalid para outros valores', () => {
    assert.throws(
      () => readBooleanInput({ INPUT_STRICT: 'sim' }, 'strict', false),
      (/** @type {unknown} */ error) => error instanceof ConfigError
        && error.code === 'config_boolean_invalid'
        && error.params.input === 'strict'
        && error.params.value === 'sim',
    );
  });
});

describe('createActionIO: setOutput', () => {
  test('escreve o output em GITHUB_OUTPUT com delimitador heredoc', async () => {
    const { io, files } = fakeDeps({ GITHUB_OUTPUT: '/tmp/out' });
    await io.setOutput('passed', 'true');
    assert.deepEqual(files, [
      { path: '/tmp/out', text: 'passed<<ghadelimiter_abc\ntrue\nghadelimiter_abc\n' },
    ]);
  });

  test('gera outro delimitador quando o valor contém o primeiro', async () => {
    const { io, files } = fakeDeps({ GITHUB_OUTPUT: '/tmp/out' }, ['abc', 'def']);
    const value = 'linha\nghadelimiter_abc\nfim';
    await io.setOutput('summary', value);
    const delimiter = 'ghadelimiter_abc_def';
    assert.equal(files[0].text, `summary<<${delimiter}\n${value}\n${delimiter}\n`);
  });

  test('escreve um valor vazio entre os delimitadores', async () => {
    const { io, files } = fakeDeps({ GITHUB_OUTPUT: '/tmp/out' });
    await io.setOutput('regressions', '');
    assert.equal(files[0].text, 'regressions<<ghadelimiter_abc\n\nghadelimiter_abc\n');
  });

  test('não escreve nada nem falha sem GITHUB_OUTPUT', async () => {
    const { io, files } = fakeDeps({});
    await io.setOutput('passed', 'true');
    assert.deepEqual(files, []);
  });
});

describe('createActionIO: appendSummary', () => {
  test('acrescenta o markdown a GITHUB_STEP_SUMMARY', async () => {
    const { io, files } = fakeDeps({ GITHUB_STEP_SUMMARY: '/tmp/summary' });
    await io.appendSummary('## Resumo');
    assert.deepEqual(files, [{ path: '/tmp/summary', text: '## Resumo\n' }]);
  });

  test('não escreve nada nem falha sem GITHUB_STEP_SUMMARY', async () => {
    const { io, files } = fakeDeps({});
    await io.appendSummary('## Resumo');
    assert.deepEqual(files, []);
  });
});

describe('createActionIO: logs', () => {
  test('escreve os workflow commands debug, notice, warning e error', () => {
    const { io, lines } = fakeDeps({});
    io.debug('a');
    io.notice('b');
    io.warning('c');
    io.error('d');
    assert.deepEqual(lines, ['::debug::a', '::notice::b', '::warning::c', '::error::d']);
  });

  test('não deixa uma mensagem com quebra de linha criar outro workflow command', () => {
    const { io, lines } = fakeDeps({});
    io.warning('aviso\n::add-mask::segredo');
    assert.deepEqual(lines, ['::warning::aviso%0A::add-mask::segredo']);
  });

  test('escapa %, \\r e \\n na mensagem', () => {
    const { io, lines } = fakeDeps({});
    io.error('100% falhou\r\nlinha 2');
    assert.deepEqual(lines, ['::error::100%25 falhou%0D%0Alinha 2']);
  });
});
