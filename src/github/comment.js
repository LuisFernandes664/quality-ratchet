// @ts-check
/**
 * Comentário único por pull request, identificado por um marcador HTML invisível. Cada
 * execução actualiza o mesmo comentário em vez de criar um novo a cada push. Só contam os
 * comentários da identidade que publica: qualquer pessoa pode escrever um comentário a
 * começar pelo marcador, e esse comentário nunca pode receber (nem esconder) o relatório.
 */

import { GitHubApiError } from '../core/errors.js';

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
 * @property {string|null} author login de quem publica (sem distinguir maiúsculas); null
 *   quando a identidade do token não se conhece, e então só contam contas de bot
 * @property {string} body markdown a publicar, sem o marcador
 */

const MARKER_NAME = 'quality-ratchet';

/** Sufixo dos logins das contas de bot (GitHub Apps, github-actions). */
const BOT_SUFFIX = '[bot]';

/** Tamanho máximo do body de um comentário aceite pela API do GitHub. */
export const MAX_COMMENT_LENGTH = 65536;

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
 * Cria ou actualiza o comentário do autor cujo body começa pelo marcador. Execuções
 * simultâneas podem ter criado mais do que um: todos são actualizados, por ordem de id,
 * para nenhum ficar com um resultado antigo. Comentários de outros autores são ignorados.
 * O body publicado é o marcador, uma quebra de linha e o texto.
 * @param {CommentClient} client
 * @param {UpsertRequest} request
 * @returns {Promise<'created'|'updated'>}
 * @throws {GitHubApiError} comment_too_long, antes de qualquer pedido, quando o body
 *   publicado passa de MAX_COMMENT_LENGTH
 */
export async function upsertComment(client, { repo, number, marker, author, body }) {
  const tag = marker === '' ? commentMarker() : marker;
  const text = commentText(tag, body);
  const own = findMarked(await client.listIssueComments(repo, number), tag, author);
  if (own.length === 0) {
    await client.createComment(repo, number, text);
    return 'created';
  }
  for (const comment of own) await client.updateComment(repo, comment.id, text);
  return 'updated';
}

/**
 * Body publicado. Um texto acima do limite da API é recusado já, com o mesmo estado que
 * a API devolveria (422), em vez de deixar o comentário anterior por actualizar.
 * @param {string} marker
 * @param {string} body
 * @returns {string}
 * @throws {GitHubApiError} comment_too_long
 */
function commentText(marker, body) {
  const text = `${marker}\n${body}`;
  if (text.length <= MAX_COMMENT_LENGTH) return text;
  throw new GitHubApiError('comment_too_long', {
    length: text.length,
    max: MAX_COMMENT_LENGTH,
  }, 422);
}

/**
 * Comentários do autor cujo body começa pelo marcador, por ordem crescente de id.
 * Comentários que apenas citam o marcador a meio do texto não contam.
 * @param {IssueComment[]} comments
 * @param {string} marker
 * @param {string|null} author
 * @returns {IssueComment[]}
 */
function findMarked(comments, marker, author) {
  return comments
    .filter((comment) => comment.body.trimStart().startsWith(marker))
    .filter((comment) => isAuthor(comment.user, author))
    .sort((a, b) => a.id - b.id);
}

/**
 * Indica se o login é o do autor. Os logins não distinguem maiúsculas. Sem autor
 * conhecido aceitam-se só contas de bot: um utilizador não consegue criar um login com
 * `[bot]`, que é reservado às GitHub Apps.
 * @param {string} login
 * @param {string|null} author
 * @returns {boolean}
 */
function isAuthor(login, author) {
  const normalized = login.toLowerCase();
  return author === null ? normalized.endsWith(BOT_SUFFIX) : normalized === author.toLowerCase();
}
