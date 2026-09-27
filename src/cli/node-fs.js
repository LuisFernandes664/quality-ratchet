// @ts-check
/**
 * Sistema de ficheiros real da CLI, sobre `node:fs/promises`. Só o ponto de entrada o
 * liga; os comandos recebem-no injectado.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** @typedef {import('./context.js').CliFileSystem} CliFileSystem */

/** Códigos de erro que significam que o caminho não existe. */
const MISSING = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Cria o acesso ao sistema de ficheiros real.
 * @returns {CliFileSystem}
 */
export function createNodeFileSystem() {
  return { readText, exists, writeText };
}

/**
 * Lê um ficheiro de texto em UTF-8.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readText(filePath) {
  return readFile(filePath, 'utf8');
}

/**
 * Indica se o caminho existe. Erros que não sejam de caminho inexistente (ex: permissões)
 * propagam, para não serem confundidos com um ficheiro em falta.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (cause) {
    if (MISSING.has(String(/** @type {{code?: unknown}} */ (cause).code))) return false;
    throw cause;
  }
}

/**
 * Escreve um ficheiro de texto em UTF-8, criando as pastas em falta.
 * @param {string} filePath
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, 'utf8');
}
