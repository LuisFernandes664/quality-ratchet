// @ts-check
/**
 * Utilitários dos testes da CLI: pasta temporária real, git falso e execução da CLI com
 * a saída acumulada.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../../src/cli/main.js';
import { createNodeFileSystem } from '../../src/cli/node-fs.js';

/** Data fixa dos testes. */
export const NOW = new Date('2026-09-27T10:00:00Z');

/** Data de hoje nos testes, tal como fica em frozen_at. */
export const TODAY = '2026-09-27';

/** Versão injectada nos testes. */
export const VERSION = '9.9.9';

/**
 * @typedef {object} FakeGit
 * @property {(ref: string, filePath: string, cwd: string) => Promise<string|null>} show
 * @property {Array<{ref: string, filePath: string, cwd: string}>} calls
 */

/**
 * Git falso: devolve o conteúdo registado para `<ref>:<caminho>`, ou null.
 * @param {Record<string, unknown>} [files] conteúdo por `<ref>:<caminho>`; objectos são
 *   convertidos em JSON
 * @returns {FakeGit}
 */
export function fakeGit(files = {}) {
  /** @type {FakeGit['calls']} */
  const calls = [];
  return {
    calls,
    show: async (ref, filePath, cwd) => {
      calls.push({ ref, filePath, cwd });
      const key = `${ref}:${filePath}`;
      if (!Object.hasOwn(files, key)) return null;
      const content = files[key];
      return typeof content === 'string' ? content : JSON.stringify(content);
    },
  };
}

/**
 * Cria uma pasta temporária para um teste.
 * @returns {Promise<string>}
 */
export function makeTempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'quality-ratchet-cli-'));
}

/**
 * Apaga uma pasta temporária.
 * @param {string} dir
 * @returns {Promise<void>}
 */
export function removeDir(dir) {
  return rm(dir, { recursive: true, force: true });
}

/**
 * Escreve ficheiros na pasta; objectos são gravados como JSON.
 * @param {string} dir
 * @param {Record<string, unknown>} files caminho relativo -> conteúdo
 * @returns {Promise<void>}
 */
export async function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    await writeFile(target, text, 'utf8');
  }
}

/**
 * Lê um ficheiro de texto da pasta.
 * @param {string} dir
 * @param {string} name
 * @returns {Promise<string>}
 */
export function readText(dir, name) {
  return readFile(path.join(dir, name), 'utf8');
}

/**
 * Lê e interpreta um ficheiro JSON da pasta.
 * @param {string} dir
 * @param {string} name
 * @returns {Promise<any>}
 */
export async function readJson(dir, name) {
  return JSON.parse(await readText(dir, name));
}

/**
 * @typedef {object} CliRun
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Corre a CLI na pasta indicada, com sistema de ficheiros real e, por omissão, git falso.
 * @param {string} cwd
 * @param {string[]} argv
 * @param {{git?: import('../../src/cli/git.js').Git,
 *   fs?: import('../../src/cli/context.js').CliFileSystem}} [options]
 * @returns {Promise<CliRun>}
 */
export async function runIn(cwd, argv, options = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const code = await runCli({
    argv,
    cwd,
    env: {},
    fs: options.fs ?? createNodeFileSystem(),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now: () => NOW,
    git: options.git ?? fakeGit(),
    version: VERSION,
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

/**
 * Baseline v2 simples para os testes.
 * @param {Record<string, Record<string, unknown>>} metrics
 * @returns {Record<string, unknown>}
 */
export function baselineV2(metrics) {
  return { version: 2, frozen_at: '2026-05-04', metrics };
}

/** Baseline v1 com uma métrica de cada direcção e um valor sem regra. */
export const BASELINE_V1 = Object.freeze({
  frozen_at: '2026-05-04',
  metrics: { coverage: 70, lint: 10, legacy: 3 },
  rules: { monotonic_down: ['lint'], monotonic_up: ['coverage'] },
});
