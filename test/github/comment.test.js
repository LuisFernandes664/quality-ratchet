// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { commentMarker, upsertComment } from '../../src/github/comment.js';

const REPO = 'dono/projecto';
const DEFAULT_MARKER = '<!-- quality-ratchet -->';

/** @typedef {import('../../src/github/client.js').IssueComment} IssueComment */

/**
 * Cliente falso: devolve os comentários indicados e regista criações e actualizações.
 * @param {Array<{id: number, body: string}>} existing
 */
function fakeClient(existing) {
  /** @type {Array<{repo: string, number: number, body: string}>} */
  const created = [];
  /** @type {Array<{repo: string, id: number, body: string}>} */
  const updated = [];
  const client = {
    listIssueComments: async () => existing.map((comment) => ({ user: 'bot', ...comment })),
    /** @type {(repo: string, number: number, body: string) => Promise<{id: number}>} */
    createComment: async (repo, number, body) => (created.push({ repo, number, body }), { id: 1 }),
    /** @type {(repo: string, id: number, body: string) => Promise<{id: number}>} */
    updateComment: async (repo, id, body) => (updated.push({ repo, id, body }), { id }),
  };
  return { client, created, updated };
}

/**
 * Pedido de upsert com o marcador indicado.
 * @param {string} marker
 * @returns {import('../../src/github/comment.js').UpsertRequest}
 */
function request(marker) {
  return { repo: REPO, number: 42, marker, body: 'resumo novo' };
}

describe('commentMarker', () => {
  test('devolve o marcador por omissão quando o nome está vazio', () => {
    assert.equal(commentMarker(''), DEFAULT_MARKER);
  });

  test('devolve o marcador por omissão quando não recebe nome', () => {
    assert.equal(commentMarker(), DEFAULT_MARKER);
  });

  test('inclui o nome no marcador', () => {
    assert.equal(commentMarker('api'), '<!-- quality-ratchet:api -->');
  });

  test('remove os espaços à volta do nome', () => {
    assert.equal(commentMarker('  api '), '<!-- quality-ratchet:api -->');
  });
});

describe('upsertComment', () => {
  test('cria o comentário quando nenhum começa pelo marcador', async () => {
    const fake = fakeClient([{ id: 5, body: 'comentário normal' }]);
    const outcome = await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.equal(outcome, 'created');
    const body = `${DEFAULT_MARKER}\nresumo novo`;
    assert.deepEqual(fake.created, [{ repo: REPO, number: 42, body }]);
  });

  test('actualiza o comentário cujo body começa pelo marcador', async () => {
    const fake = fakeClient([{ id: 5, body: `${DEFAULT_MARKER}\nresumo antigo` }]);
    const outcome = await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.equal(outcome, 'updated');
    assert.deepEqual(fake.updated, [{ repo: REPO, id: 5, body: `${DEFAULT_MARKER}\nresumo novo` }]);
  });

  test('actualiza o mais recente quando vários começam pelo marcador', async () => {
    const fake = fakeClient([
      { id: 10, body: `${DEFAULT_MARKER}\nsegundo` },
      { id: 3, body: `${DEFAULT_MARKER}\nprimeiro` },
      { id: 7, body: 'outro assunto' },
    ]);
    await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.deepEqual(fake.updated.map((call) => call.id), [10]);
  });

  test('actualiza o comentário com espaços ou quebras de linha antes do marcador', async () => {
    const fake = fakeClient([{ id: 5, body: `\r\n  ${DEFAULT_MARKER}\nresumo antigo` }]);
    const outcome = await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.equal(outcome, 'updated');
  });

  test('cria o comentário quando a issue ainda não tem comentários', async () => {
    const fake = fakeClient([]);
    const outcome = await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.equal(outcome, 'created');
  });

  test('ignora comentários que apenas citam o marcador a meio do texto', async () => {
    const quoted = `Porque é que o ${DEFAULT_MARKER} aparece aqui?\n> ${DEFAULT_MARKER}`;
    const fake = fakeClient([{ id: 5, body: quoted }]);
    const outcome = await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.equal(outcome, 'created');
  });

  test('não confunde marcadores com nomes diferentes', async () => {
    const fake = fakeClient([{ id: 5, body: `${commentMarker('api-v2')}\nresumo` }]);
    const outcome = await upsertComment(fake.client, request(commentMarker('api')));
    assert.equal(outcome, 'created');
  });

  test('não confunde o marcador por omissão com um marcador com nome', async () => {
    const fake = fakeClient([{ id: 5, body: `${commentMarker('api')}\nresumo` }]);
    const outcome = await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.equal(outcome, 'created');
  });

  test('usa o marcador por omissão quando o marcador pedido está vazio', async () => {
    const fake = fakeClient([{ id: 5, body: 'comentário normal' }]);
    await upsertComment(fake.client, request(''));
    assert.equal(fake.created[0].body, `${DEFAULT_MARKER}\nresumo novo`);
  });
});
