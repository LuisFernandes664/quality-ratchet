// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readPullRequestFromEvent } from '../../src/action/context.js';

const PULL_REQUEST = {
  number: 42,
  title: 'refactor: simplificar',
  labels: [{ id: 1, name: 'hotfix-bypass-ratchet' }],
  base: { ref: 'main', sha: 'base123', repo: { full_name: 'dono/projecto' } },
  head: { ref: 'ramo', sha: 'head456', repo: { full_name: 'fork/projecto' } },
};

const EXPECTED = {
  number: 42,
  title: 'refactor: simplificar',
  labels: ['hotfix-bypass-ratchet'],
  baseSha: 'base123',
  mergeBase: '',
  headSha: 'head456',
  baseRepo: 'dono/projecto',
  headRepo: 'fork/projecto',
};

describe('readPullRequestFromEvent', () => {
  test('lê o pull request de um evento pull_request', () => {
    const event = { action: 'synchronize', number: 42, pull_request: PULL_REQUEST };
    assert.deepEqual(readPullRequestFromEvent(event), EXPECTED);
  });

  test('lê o pull request de um evento pull_request_target', () => {
    const event = { action: 'opened', pull_request: PULL_REQUEST, repository: { id: 1 } };
    assert.deepEqual(readPullRequestFromEvent(event), EXPECTED);
  });

  test('lê a merge_base do payload do Gitea e do Forgejo', () => {
    const event = { action: 'opened', pull_request: { ...PULL_REQUEST, merge_base: 'mb789' } };
    assert.equal(readPullRequestFromEvent(event)?.mergeBase, 'mb789');
  });

  test('devolve null quando o payload não tem pull_request (ex: push)', () => {
    const event = { ref: 'refs/heads/main', head_commit: { id: 'abc' } };
    assert.equal(readPullRequestFromEvent(event), null);
  });

  test('devolve null quando o payload não é um objecto', () => {
    assert.equal(readPullRequestFromEvent(null), null);
  });

  test('aceita o número do pull request em forma de string', () => {
    const event = { pull_request: { ...PULL_REQUEST, number: '42' } };
    assert.equal(readPullRequestFromEvent(event)?.number, 42);
  });

  test('devolve labels vazias quando o payload não as traz', () => {
    const event = { pull_request: { ...PULL_REQUEST, labels: undefined } };
    assert.deepEqual(readPullRequestFromEvent(event)?.labels, []);
  });

  test('devolve headRepo vazio quando o fork de origem foi apagado', () => {
    const event = { pull_request: { ...PULL_REQUEST, head: { sha: 'head456', repo: null } } };
    assert.equal(readPullRequestFromEvent(event)?.headRepo, '');
  });

  test('devolve null quando pull_request é um array', () => {
    assert.equal(readPullRequestFromEvent({ pull_request: [PULL_REQUEST] }), null);
  });

  test('devolve null quando o número do pull request é zero', () => {
    const event = { pull_request: { ...PULL_REQUEST, number: 0 } };
    assert.equal(readPullRequestFromEvent(event), null);
  });

  test('devolve null quando o pull request não tem número válido', () => {
    const event = { pull_request: { ...PULL_REQUEST, number: undefined } };
    assert.equal(readPullRequestFromEvent(event), null);
  });
});
