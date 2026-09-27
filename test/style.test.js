import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raiz do repositório. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Pastas que não são código do projecto. */
const SKIPPED = new Set(['node_modules', '.git', 'coverage']);

/** Extensões sujeitas ao limite de comprimento de linha. */
const CODE = new Set(['.js', '.mjs', '.json', '.yml', '.yaml']);

/** Travessão tipográfico, proibido em todo o repositório (usar hífen simples). */
const EM_DASH = String.fromCharCode(0x2014);

/** Comprimento máximo de uma linha de código. */
const MAX_LINE = 100;

/**
 * Lista recursiva dos ficheiros do repositório.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => !SKIPPED.has(entry.name))
    .map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(full) : [full];
    }));
  return nested.flat();
}

/**
 * Conteúdo dos ficheiros de texto, por caminho relativo.
 * @returns {Promise<Array<[string, string]>>}
 */
async function textFiles() {
  const files = (await listFiles(ROOT)).filter((file) => !file.endsWith('package-lock.json'));
  const texts = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  return files.map((file, index) => [path.relative(ROOT, file), texts[index]]);
}

describe('estilo do repositorio', () => {
  test('nenhum ficheiro usa o travessao tipografico', async () => {
    const offenders = (await textFiles())
      .filter(([, text]) => text.includes(EM_DASH))
      .map(([file]) => file);

    assert.deepEqual(offenders, []);
  });

  test('linhas de codigo tem no maximo 100 caracteres', async () => {
    const offenders = (await textFiles())
      .filter(([file]) => CODE.has(path.extname(file)))
      .flatMap(([file, text]) => text.split('\n')
        .map((line, index) => ({ file, line: index + 1, length: [...line].length }))
        .filter((item) => item.length > MAX_LINE));

    assert.deepEqual(offenders, []);
  });
});
