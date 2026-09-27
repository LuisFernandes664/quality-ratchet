// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  COMMAND_OPTIONS,
  flagOption,
  listOption,
  nonEmptyOption,
  peekLanguage,
  readCommandOptions,
  splitCommand,
  stringOption,
} from '../../src/cli/args.js';
import { ConfigError } from '../../src/core/errors.js';

describe('splitCommand', () => {
  test('o primeiro argumento posicional e o comando', () => {
    const { command, args } = splitCommand(['--baseline', 'b.json', 'update', '--allow-lower']);

    assert.deepEqual({ command, args }, {
      command: 'update',
      args: ['--baseline', 'b.json', '--allow-lower'],
    });
  });

  test('sem argumento posicional o comando e check', () => {
    assert.equal(splitCommand(['--strict']).command, 'check');
  });

  test('um valor de opcao nao e confundido com o comando', () => {
    assert.equal(splitCommand(['--name', 'init']).command, 'check');
  });

  test('le a lingua antes de validar o comando', () => {
    assert.equal(splitCommand(['nope', '--language', 'pt']).values.language, 'pt');
  });

  test('opcao que nenhum comando conhece e cli_option_invalid', () => {
    assert.throws(
      () => splitCommand(['--nope']),
      (error) => error instanceof ConfigError && error.code === 'cli_option_invalid',
    );
  });
});

describe('peekLanguage', () => {
  test('le a lingua mesmo com opcoes invalidas', () => {
    assert.equal(peekLanguage(['--nope', '--language', 'pt']), 'pt');
  });

  test('le a lingua na forma --language=<valor>', () => {
    assert.equal(peekLanguage(['--language=pt', '--nope']), 'pt');
  });

  test('o valor de outra opcao nao passa por lingua', () => {
    assert.equal(peekLanguage(['--title', '--language']), undefined);
  });

  test('sem --language devolve undefined', () => {
    assert.equal(peekLanguage([]), undefined);
  });

  test('--language sem valor devolve undefined', () => {
    assert.equal(peekLanguage(['--language']), undefined);
  });

  test('opcao de texto sem valor nao lanca excepcao', () => {
    assert.doesNotThrow(() => peekLanguage(['--baseline']));
  });
});

describe('readCommandOptions', () => {
  test('comando desconhecido e cli_command_unknown', () => {
    assert.throws(
      () => readCommandOptions('deploy', []),
      (error) => error instanceof ConfigError && error.code === 'cli_command_unknown'
        && error.params.command === 'deploy',
    );
  });

  test('opcao de outro comando e cli_option_invalid', () => {
    assert.throws(
      () => readCommandOptions('migrate', ['--metrics', 'm.json']),
      (error) => error instanceof ConfigError && error.code === 'cli_option_invalid',
    );
  });

  test('uma opcao tem o mesmo tipo em todos os comandos', () => {
    /** @type {Map<string, string>} */
    const types = new Map();
    for (const options of Object.values(COMMAND_OPTIONS)) {
      for (const [name, spec] of Object.entries(options)) {
        assert.equal(types.get(name) ?? spec.type, spec.type, name);
        types.set(name, spec.type);
      }
    }
  });
});

describe('leitura de valores', () => {
  test('stringOption mantem um texto vazio explicito', () => {
    assert.equal(stringOption({ name: '' }, 'name', 'x'), '');
  });

  test('stringOption usa o valor por omissao quando a opcao falta', () => {
    assert.equal(stringOption({}, 'name', 'x'), 'x');
  });

  test('nonEmptyOption usa o valor por omissao quando a opcao falta', () => {
    assert.equal(nonEmptyOption({}, 'output', 'x.json'), 'x.json');
  });

  test('nonEmptyOption devolve o valor dado sem o alterar', () => {
    assert.equal(nonEmptyOption({ output: ' a b.json' }, 'output', 'x.json'), ' a b.json');
  });

  test('nonEmptyOption rejeita um valor vazio com config_input_required', () => {
    assert.throws(
      () => nonEmptyOption({ output: '' }, 'output', 'x.json'),
      (error) => error instanceof ConfigError && error.code === 'config_input_required'
        && error.params.input === '--output',
    );
  });

  test('nonEmptyOption rejeita um valor so com espacos', () => {
    assert.throws(
      () => nonEmptyOption({ output: '  ' }, 'output', 'x.json'),
      (error) => error instanceof ConfigError && error.code === 'config_input_required',
    );
  });

  test('flagOption so e verdadeiro para true', () => {
    assert.deepEqual([flagOption({ a: true }, 'a'), flagOption({}, 'a')], [true, false]);
  });

  test('listOption separa por virgulas, junta repeticoes e retira vazios e duplicados', () => {
    assert.deepEqual(listOption({ up: ['a, b', 'c,,a', ' '] }, 'up'), ['a', 'b', 'c']);
  });

  test('listOption sem valor devolve lista vazia', () => {
    assert.deepEqual(listOption({}, 'up'), []);
  });
});
