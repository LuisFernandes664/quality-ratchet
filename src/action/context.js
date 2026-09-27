// @ts-check
/**
 * Contexto do pull request lido do payload do evento que disparou o workflow, sem gastar
 * chamadas à API.
 */

import { mapPullRequest } from '../github/client.js';

/** @typedef {import('../github/client.js').PullRequestInfo} PullRequestInfo */

/**
 * Extrai o pull request do payload de eventos `pull_request` e `pull_request_target` (ou de
 * outros com o mesmo campo). Devolve null quando o evento não traz um pull request válido.
 * @param {unknown} event payload já interpretado (conteúdo de GITHUB_EVENT_PATH)
 * @returns {PullRequestInfo|null}
 */
export function readPullRequestFromEvent(event) {
  const pullRequest = isRecord(event) ? event.pull_request : undefined;
  if (!isRecord(pullRequest)) return null;
  const info = mapPullRequest(pullRequest);
  return Number.isInteger(info.number) && info.number > 0 ? info : null;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
