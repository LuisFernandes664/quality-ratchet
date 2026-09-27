// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { helpText } from '../../src/cli/help.js';

/**
 * Descrição de `--base-ref` na ajuda: a linha da opção e as de continuação que se lhe
 * seguem, numa só linha.
 * @param {string} text ajuda completa
 * @returns {string}
 */
function baseRefDescription(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('  --base-ref '));
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => !line.startsWith('    '));
  return [lines[start], ...rest.slice(0, end)].map((line) => line.trim()).join(' ');
}

describe('helpText', () => {
  test('em ingles, --base-ref recomenda a merge base em vez da ponta do destino', () => {
    const description = baseRefDescription(helpText('en'));

    assert.match(description, /merge base, not the tip of the target branch/);
  });

  test('em ingles, --base-ref mostra o comando da merge base', () => {
    const description = baseRefDescription(helpText('en'));

    assert.ok(description.includes('--base-ref "$(git merge-base origin/main HEAD)"'));
  });

  test('em portugues, --base-ref recomenda a merge base em vez da ponta do destino', () => {
    const description = baseRefDescription(helpText('pt'));

    assert.match(description, /merge base, e não a ponta do ramo de destino/);
  });

  test('em portugues, --base-ref mostra o comando da merge base', () => {
    const description = baseRefDescription(helpText('pt'));

    assert.ok(description.includes('--base-ref "$(git merge-base origin/main HEAD)"'));
  });
});
