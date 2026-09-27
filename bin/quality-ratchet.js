#!/usr/bin/env node
// @ts-check
/**
 * Ponto de entrada da CLI: liga as dependências reais (argumentos, sistema de ficheiros,
 * consola, relógio e git) e define o código de saída do processo.
 */
import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { createGit } from '../src/cli/git.js';
import { runCli } from '../src/cli/main.js';
import { createNodeFileSystem } from '../src/cli/node-fs.js';

/**
 * Versão do pacote, lida do package.json instalado ao lado da CLI.
 * @returns {Promise<string>}
 */
async function readVersion() {
  const text = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  return String(JSON.parse(text).version);
}

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  fs: createNodeFileSystem(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  now: () => new Date(),
  git: createGit(),
  version: await readVersion(),
});
