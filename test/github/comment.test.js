// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ConfigError, GitHubApiError } from '../../src/core/errors.js';
import {
  MAX_COMMENT_LENGTH, commentMarker, customMarker, upsertComment,
} from '../../src/github/comment.js';

const REPO = 'dono/projecto';
const DEFAULT_MARKER = '<!-- quality-ratchet -->';
const AUTHOR = 'bot';

/** @typedef {import('../../src/github/client.js').IssueComment} IssueComment */
/** @typedef {import('../../src/github/comment.js').UpsertRequest} UpsertRequest */

/**
 * Cliente falso: devolve os comentários indicados (autor 'bot' quando omitido) e regista
 * criações e actualizações.
 * @param {Array<Omit<IssueComment, 'user'> & {user?: string}>} existing
 */
function fakeClient(existing) {
  /** @type {Array<{repo: string, number: number, body: string}>} */
  const created = [];
  /** @type {Array<{repo: string, id: number, body: string}>} */
  const updated = [];
  const client = {
    listIssueComments: async () => existing.map((comment) => ({ user: AUTHOR, ...comment })),
    /** @type {(repo: string, number: number, body: string) => Promise<{id: number}>} */
    createComment: async (repo, number, body) => (created.push({ repo, number, body }), { id: 1 }),
    /** @type {(repo: string, id: number, body: string) => Promise<{id: number}>} */
    updateComment: async (repo, id, body) => (updated.push({ repo, id, body }), { id }),
  };
  return { client, created, updated };
}

/**
 * Pedido de upsert com o marcador e o autor indicados.
 * @param {string} marker
 * @param {Partial<UpsertRequest>} [extra]
 * @returns {UpsertRequest}
 */
function request(marker, extra = {}) {
  return { repo: REPO, number: 42, marker, author: AUTHOR, body: 'resumo novo', ...extra };
}

/**
 * Executa a promessa e devolve o GitHubApiError que ela rejeita.
 * @param {Promise<unknown>} promise
 * @returns {Promise<GitHubApiError>}
 */
async function captureError(promise) {
  const error = await promise.then(
    () => assert.fail('era esperado um erro'),
    (/** @type {unknown} */ reason) => reason,
  );
  assert.ok(error instanceof GitHubApiError);
  return error;
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

describe('customMarker', () => {
  test('um comentário HTML completo fica como está', () => {
    assert.equal(customMarker('<!-- quality-gate -->'), '<!-- quality-gate -->');
  });

  test('um nome é envolvido num comentário HTML', () => {
    assert.equal(customMarker(' quality-gate '), '<!-- quality-gate -->');
  });

  test('um valor que fecha o comentário antes do fim é recusado', () => {
    assert.throws(() => customMarker('a --> b'), (error) => (
      error instanceof ConfigError && error.code === 'config_marker_invalid'));
  });

  test('um valor com quebra de linha é recusado', () => {
    assert.throws(() => customMarker('<!-- a\nb -->'), ConfigError);
  });

  test('um comentário HTML sem fecho é recusado', () => {
    assert.throws(() => customMarker('<!-- quality-gate'), ConfigError);
  });
});

describe('upsertComment', () => {
  test('cria o comentário quando nenhum começa pelo marcador', async () => {
    const fake = fakeClient([{ id: 5, body: 'comentário normal' }]);
    const outcome = await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.equal(outcome, 'created');
  });

  test('cria o comentário com o marcador, uma quebra de linha e o texto', async () => {
    const fake = fakeClient([{ id: 5, body: 'comentário normal' }]);
    await upsertComment(fake.client, request(DEFAULT_MARKER));
    const body = `${DEFAULT_MARKER}\nresumo novo`;
    assert.deepEqual(fake.created, [{ repo: REPO, number: 42, body }]);
  });

  test('devolve updated quando o comentário já existe', async () => {
    const fake = fakeClient([{ id: 5, body: `${DEFAULT_MARKER}\nresumo antigo` }]);
    const outcome = await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.equal(outcome, 'updated');
  });

  test('actualiza o comentário cujo body começa pelo marcador', async () => {
    const fake = fakeClient([{ id: 5, body: `${DEFAULT_MARKER}\nresumo antigo` }]);
    await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.deepEqual(fake.updated, [{ repo: REPO, id: 5, body: `${DEFAULT_MARKER}\nresumo novo` }]);
  });

  test('actualiza todos os comentários do autor com o marcador, por ordem de id', async () => {
    const fake = fakeClient([
      { id: 10, body: `${DEFAULT_MARKER}\nsegundo` },
      { id: 3, body: `${DEFAULT_MARKER}\nprimeiro` },
      { id: 7, body: 'outro assunto' },
    ]);
    await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.deepEqual(fake.updated.map((call) => call.id), [3, 10]);
  });

  test('não cria outro comentário quando há vários com o marcador', async () => {
    const fake = fakeClient([
      { id: 10, body: `${DEFAULT_MARKER}\nsegundo` },
      { id: 3, body: `${DEFAULT_MARKER}\nprimeiro` },
    ]);
    await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.deepEqual(fake.created, []);
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

describe('upsertComment: autor', () => {
  /** Comentário do bot e um posterior, de outra pessoa, com o mesmo marcador. */
  const HIJACKED = Object.freeze([
    { id: 100, body: `${DEFAULT_MARKER}\nRatchet red`, user: AUTHOR },
    { id: 200, body: `${DEFAULT_MARKER}\nRatchet green`, user: 'mallory' },
  ]);

  test('nunca actualiza um comentário marcado de outro autor', async () => {
    const fake = fakeClient([...HIJACKED]);
    await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.deepEqual(fake.updated.map((call) => call.id), [100]);
  });

  test('cria um comentário quando só outro autor tem o marcador', async () => {
    const fake = fakeClient([{ id: 200, body: `${DEFAULT_MARKER}\nverde`, user: 'mallory' }]);
    const outcome = await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.equal(outcome, 'created');
  });

  test('não distingue maiúsculas no login do autor', async () => {
    const fake = fakeClient([{ id: 5, body: `${DEFAULT_MARKER}\nantigo`, user: 'Bot' }]);
    const outcome = await upsertComment(fake.client, request(DEFAULT_MARKER));
    assert.equal(outcome, 'updated');
  });

  test('sem autor conhecido actualiza o comentário de uma conta de bot', async () => {
    const user = 'github-actions[bot]';
    const fake = fakeClient([{ id: 5, body: `${DEFAULT_MARKER}\nantigo`, user }]);
    const outcome = await upsertComment(fake.client, request(DEFAULT_MARKER, { author: null }));
    assert.equal(outcome, 'updated');
  });

  test('sem autor conhecido ignora o comentário marcado de um utilizador', async () => {
    const fake = fakeClient([{ id: 5, body: `${DEFAULT_MARKER}\nverde`, user: 'mallory' }]);
    const outcome = await upsertComment(fake.client, request(DEFAULT_MARKER, { author: null }));
    assert.equal(outcome, 'created');
  });
});

describe('upsertComment: tamanho', () => {
  /** Body que, com o marcador e a quebra de linha, passa um carácter do limite. */
  const TOO_LONG = 'x'.repeat(MAX_COMMENT_LENGTH - DEFAULT_MARKER.length);

  test('recusa com comment_too_long um body acima do limite da API', async () => {
    const fake = fakeClient([]);
    const error = await captureError(
      upsertComment(fake.client, request(DEFAULT_MARKER, { body: TOO_LONG })));
    assert.equal(error.code, 'comment_too_long');
  });

  test('não faz pedidos com um body acima do limite da API', async () => {
    const fake = fakeClient([{ id: 5, body: `${DEFAULT_MARKER}\nantigo` }]);
    await upsertComment(fake.client, request(DEFAULT_MARKER, { body: TOO_LONG })).catch(
      (/** @type {unknown} */ error) => assert.ok(error instanceof GitHubApiError));
    assert.deepEqual([fake.created, fake.updated], [[], []]);
  });

  test('aceita um body que fica exactamente no limite da API', async () => {
    const fake = fakeClient([]);
    const body = TOO_LONG.slice(1);
    const outcome = await upsertComment(fake.client, request(DEFAULT_MARKER, { body }));
    assert.equal(outcome, 'created');
  });
});
