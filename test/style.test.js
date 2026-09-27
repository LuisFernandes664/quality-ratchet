// @ts-check
/**
 * Regras de estilo que valem para todo o repositório: sem travessão tipográfico, linhas de
 * código com no máximo 100 caracteres, e todo o JavaScript verificado pelo typecheck.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** Raiz do repositório. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Pastas que não são código do projecto. */
const SKIPPED = new Set(['node_modules', '.git', 'coverage']);

/** Extensões sujeitas ao limite de comprimento de linha. */
const CODE = new Set(['.js', '.mjs', '.json', '.yml', '.yaml']);

/** Pastas de JavaScript que o typecheck tem de cobrir, relativas à raiz. */
const TYPECHECKED_DIRS = ['src', 'bin', 'test'];

/** Directiva que liga a verificação de tipos num ficheiro JavaScript. */
const TS_CHECK = '// @ts-check';

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

/**
 * Indica se um ficheiro JavaScript liga a verificação de tipos: `// @ts-check` na
 * primeira linha, ou na segunda quando a primeira é um shebang.
 * @param {string} text
 * @returns {boolean}
 */
function declaresTsCheck(text) {
  const [first, second] = text.split('\n');
  return first === TS_CHECK || (first.startsWith('#!') && second === TS_CHECK);
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

describe('typecheck', () => {
  test('todos os ficheiros .js de src, bin e test declaram // @ts-check', async () => {
    const offenders = (await textFiles())
      .filter(([file]) => TYPECHECKED_DIRS.includes(file.split(path.sep)[0]))
      .filter(([file, text]) => file.endsWith('.js') && !declaresTsCheck(text))
      .map(([file]) => file);

    assert.deepEqual(offenders, []);
  });

  test('o tsconfig verifica src, bin e test', async () => {
    const { include } = JSON.parse(await readFile(path.join(ROOT, 'tsconfig.json'), 'utf8'));
    const expected = TYPECHECKED_DIRS.map((dir) => `${dir}/**/*.js`);

    assert.deepEqual(expected.filter((pattern) => !include.includes(pattern)), []);
  });
});
