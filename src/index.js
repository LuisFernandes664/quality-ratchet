// @ts-check
/**
 * Ponto de entrada da action: liga as dependências reais (ambiente, rede, proxy,
 * ficheiros, stdout, relógio) e define o código de saída do processo.
 */
import { randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as wait } from 'node:timers/promises';

import { runAction } from './action/main.js';
import { configureProxy } from './action/proxy.js';

/** Códigos de erro que significam "o ficheiro não existe". */
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Indica se o ficheiro existe. Erros que não sejam "não existe" (ex: permissões)
 * propagam-se, para não serem confundidos com um ficheiro em falta.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    const code = /** @type {{code?: unknown}} */ (error)?.code;
    if (typeof code === 'string' && NOT_FOUND_CODES.has(code)) return false;
    throw error;
  }
}

/**
 * Escreve um ficheiro de texto em UTF-8, criando as pastas em falta (como a CLI), para que
 * o input write-baseline aceite um caminho numa pasta nova.
 * @param {string} filePath
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, 'utf8');
}

/** @type {import('./action/main.js').ActionFileSystem} */
const fileSystem = {
  readText: (filePath) => readFile(filePath, 'utf8'),
  exists,
  writeText,
  appendText: (filePath, text) => appendFile(filePath, text, 'utf8'),
};

process.exitCode = await runAction({
  env: process.env,
  fetch: globalThis.fetch.bind(globalThis),
  fs: fileSystem,
  write: (line) => process.stdout.write(`${line}\n`),
  now: () => new Date(),
  randomId: () => randomUUID(),
  sleep: (ms) => wait(ms),
  proxy: () => configureProxy({ env: process.env, http }),
});
