/**
 * Entrypoint da action. Só aqui há I/O, rede e process.env.
 * A decisão de passar ou falhar vive toda em ratchet.js.
 */
import { readFile, appendFile } from 'node:fs/promises';
import { compare, renderSummary, shouldBypass } from './ratchet.js';

const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const MARKER = '<!-- quality-ratchet -->';

const input = (name, fallback = '') => process.env[`INPUT_${name.toUpperCase()}`] || fallback;
const isTrue = (value) => String(value).toLowerCase() === 'true';

const log = {
  error: (msg) => console.log(`::error::${msg}`),
  notice: (msg) => console.log(`::notice::${msg}`),
};

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    throw new Error(`Não consegui ler o JSON em "${path}": ${cause.message}`);
  }
}

async function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = `ghadelim_${Math.random().toString(36).slice(2)}`;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

async function writeJobSummary(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

/** Contexto do PR a partir do payload do evento, sem gastar chamadas à API. */
async function readPullRequestContext() {
  if (!process.env.GITHUB_EVENT_PATH) return null;

  const event = await readJson(process.env.GITHUB_EVENT_PATH).catch(() => null);
  const pr = event?.pull_request;
  if (!pr) return null;

  return {
    number: pr.number,
    title: pr.title ?? '',
    labels: (pr.labels ?? []).map((l) => l.name),
  };
}

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'quality-ratchet',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw new Error(
      `GitHub API ${method} ${path} devolveu ${response.status}: ${await response.text()}`,
    );
  }

  return response.status === 204 ? null : response.json();
}

/**
 * Um comentário por PR, atualizado em cada corrida. Um comentário novo por push
 * enterra a conversa e treina toda a gente a ignorar o gate.
 */
async function upsertComment({ token, repo, issueNumber, body }) {
  const existing = await api(`/repos/${repo}/issues/${issueNumber}/comments?per_page=100`, { token });
  const mine = existing.find((c) => typeof c.body === 'string' && c.body.includes(MARKER));
  const payload = { body: `${MARKER}\n${body}` };

  if (mine) {
    await api(`/repos/${repo}/issues/comments/${mine.id}`, { token, method: 'PATCH', body: payload });
    return 'atualizado';
  }

  await api(`/repos/${repo}/issues/${issueNumber}/comments`, { token, method: 'POST', body: payload });
  return 'criado';
}

async function main() {
  const baselinePath = input('baseline', 'quality-baseline.json');
  const metricsPath = input('metrics', 'metrics-current.json');
  const token = input('token');
  const wantsComment = isTrue(input('comment', 'true'));

  const baseline = await readJson(baselinePath);
  const current = await readJson(metricsPath);

  const outcome = compare(baseline, current);
  const pr = await readPullRequestContext();

  const bypass = outcome.passed
    ? { bypassed: false, reason: null }
    : shouldBypass({
        title: pr?.title,
        labels: pr?.labels ?? [],
        bypassLabel: input('bypass-label', 'hotfix-bypass-ratchet'),
        lowerBaselinePattern: input('lower-baseline-pattern', '^(chore: lower baseline|refactor:)'),
      });

  const summary = renderSummary(outcome, { bypass, frozenAt: baseline.frozen_at });

  await writeJobSummary(summary);
  await setOutput('passed', String(outcome.passed));
  await setOutput('summary', summary);
  await setOutput('regressions', JSON.stringify(outcome.regressions));

  if (wantsComment && pr && token) {
    const action = await upsertComment({
      token,
      repo: process.env.GITHUB_REPOSITORY,
      issueNumber: pr.number,
      body: summary,
    });
    log.notice(`Comentário ${action} no PR #${pr.number}.`);
  }

  if (outcome.passed) {
    log.notice('Catraca verde.');
    return;
  }

  for (const r of outcome.regressions) {
    log.error(`${r.name} regrediu: ${r.before} -> ${r.after}`);
  }
  for (const r of outcome.missing) {
    log.error(`${r.name} não veio no ficheiro de métricas. Coletor incompleto conta como falha.`);
  }

  if (bypass.bypassed) {
    log.notice(`Falha perdoada: ${bypass.reason}.`);
    return;
  }

  process.exitCode = 1;
}

main().catch((error) => {
  log.error(error.message);
  process.exitCode = 1;
});
