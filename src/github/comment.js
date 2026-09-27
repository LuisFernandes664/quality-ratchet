// @ts-check
/**
 * Comentário único por pull request, identificado por um marcador HTML invisível. Cada
 * execução actualiza o mesmo comentário em vez de criar um novo a cada push.
 */

/** @typedef {import('./client.js').GitHubClient} GitHubClient */
/** @typedef {import('./client.js').IssueComment} IssueComment */
/**
 * Parte do cliente de que o upsert precisa.
 * @typedef {Pick<GitHubClient, 'listIssueComments'|'createComment'|'updateComment'>}
 *   CommentClient
 */

/**
 * @typedef {object} UpsertRequest
 * @property {string} repo 'dono/repo'
 * @property {number} number número do pull request ou da issue
 * @property {string} marker marcador devolvido por commentMarker (vazio usa o de omissão)
 * @property {string} body markdown a publicar, sem o marcador
 */

const MARKER_NAME = 'quality-ratchet';

/**
 * Devolve o marcador HTML do comentário. Nomes diferentes permitem vários comentários
 * independentes no mesmo pull request (ex: um por pacote de um monorepo).
 * @param {string} [name] nome opcional do comentário
 * @returns {string}
 */
export function commentMarker(name = '') {
  const suffix = name.trim();
  return suffix === '' ? `<!-- ${MARKER_NAME} -->` : `<!-- ${MARKER_NAME}:${suffix} -->`;
}

/**
 * Cria ou actualiza o comentário cujo body começa pelo marcador; havendo vários, actualiza
 * o mais recente. O body publicado é o marcador, uma quebra de linha e o texto.
 * @param {CommentClient} client
 * @param {UpsertRequest} request
 * @returns {Promise<'created'|'updated'>}
 */
export async function upsertComment(client, { repo, number, marker, body }) {
  const tag = marker === '' ? commentMarker() : marker;
  const text = `${tag}\n${body}`;
  const existing = findLatestMarked(await client.listIssueComments(repo, number), tag);
  if (existing === null) {
    await client.createComment(repo, number, text);
    return 'created';
  }
  await client.updateComment(repo, existing.id, text);
  return 'updated';
}

/**
 * Procura o comentário mais recente (maior id) cujo body começa pelo marcador. Comentários
 * que apenas citam o marcador a meio do texto não contam.
 * @param {IssueComment[]} comments
 * @param {string} marker
 * @returns {IssueComment|null}
 */
function findLatestMarked(comments, marker) {
  /** @type {IssueComment|null} */
  let latest = null;
  for (const comment of comments) {
    if (!comment.body.trimStart().startsWith(marker)) continue;
    if (latest === null || comment.id > latest.id) latest = comment;
  }
  return latest;
}
