// @ts-check
/**
 * Coerência da documentação com o código: as tabelas de inputs e outputs do README seguem o
 * action.yml, o CHANGELOG tem a versão do package.json, e os workflows fixam as actions
 * externas por major e correm o gate nos eventos que o README explica.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SCHEMA_URL } from '../src/cli/defaults.js';

/** Raiz do repositório. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Pastas com workflows do GitHub Actions, relativas à raiz. */
const WORKFLOW_DIRS = ['.github/workflows', 'examples/workflows'];

/** Eventos de pull request que voltam a correr o gate quando o título ou as labels mudam. */
const PULL_REQUEST_TYPES = 'types: [opened, synchronize, reopened, edited, labeled, unlabeled]';

/** Referência de uma action fixada por major (ex: `v7`). */
const MAJOR_REF = /^v\d+$/;

/** Linha `uses:` de um passo ou job, com o valor capturado. */
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(\S+)\s*$/gm;

/** Célula de uma tabela Markdown que o README usa para os nomes (ex: `| \`baseline\` |`). */
const TABLE_NAME = /^\| `([^`]+)` \| ([^|]*) \|/;

/**
 * Lê um ficheiro de texto do repositório.
 * @param {string} relative caminho relativo à raiz
 * @returns {Promise<string>}
 */
function readText(relative) {
  return readFile(path.join(ROOT, relative), 'utf8');
}

/**
 * Chaves de um bloco YAML e o respectivo `default`, pela indentação: as chaves estão na
 * indentação `indent` a seguir à linha `header`, e o bloco termina na primeira linha menos
 * indentada.
 * @param {string} text
 * @param {string} header linha que abre o bloco (ex: 'inputs:')
 * @param {number} indent indentação das chaves
 * @returns {Map<string, string|undefined>} nome -> valor por omissão, ainda com aspas
 */
function yamlBlock(text, header, indent) {
  const lines = text.split('\n');
  const start = lines.indexOf(header);
  const key = new RegExp(`^ {${indent}}([\\w-]+):\\s*$`);
  const fallback = new RegExp(`^ {${indent + 2}}default:\\s*(.*)$`);
  /** @type {Map<string, string|undefined>} */
  const block = new Map();
  let current = '';
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break;
    const name = key.exec(line)?.[1];
    const value = fallback.exec(line)?.[1];
    if (name !== undefined) current = name;
    if (name !== undefined || value !== undefined) block.set(current, value);
  }
  return block;
}

/**
 * Tira as aspas de um escalar YAML simples (os valores por omissão do action.yml).
 * @param {string|undefined} value
 * @returns {string}
 */
function unquote(value) {
  const text = value ?? '';
  const quoted = /^(['"])(.*)\1$/.exec(text);
  return quoted ? quoted[2] : text;
}

/**
 * Texto de uma secção `## <título>` do README, até à secção seguinte do mesmo nível.
 * @param {string} readme
 * @param {string} title
 * @returns {string}
 */
function readmeSection(readme, title) {
  const start = readme.indexOf(`\n## ${title}\n`);
  assert.notEqual(start, -1, `secção "${title}" em falta no README`);
  const end = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

/**
 * Linhas de uma tabela Markdown cujo primeiro campo é um nome entre acentos graves.
 * @param {string} section
 * @returns {Map<string, string>} nome -> segunda coluna, sem espaços nas pontas
 */
function tableRows(section) {
  const rows = section.split('\n').map((line) => TABLE_NAME.exec(line)).filter(Boolean);
  return new Map(rows.map((match) => [String(match?.[1]), String(match?.[2]).trim()]));
}

/**
 * Valor por omissão tal como o README o mostra: entre acentos graves, ou `(empty)`.
 * @param {string|undefined} value valor do action.yml
 * @returns {string}
 */
function documentedDefault(value) {
  const text = unquote(value);
  return text === '' ? '(empty)' : `\`${text}\``;
}

/**
 * Conteúdo de todos os workflows do GitHub Actions do repositório, por caminho relativo.
 * @returns {Promise<Array<[string, string]>>}
 */
async function workflowFiles() {
  const nested = await Promise.all(WORKFLOW_DIRS.map(async (dir) => {
    const names = (await readdir(path.join(ROOT, dir))).filter((name) => name.endsWith('.yml'));
    return names.map((name) => path.posix.join(dir, name));
  }));
  const files = nested.flat();
  const texts = await Promise.all(files.map(readText));
  return files.map((file, index) => [file, texts[index]]);
}

describe('README e action.yml', () => {
  test('a tabela de inputs do README tem exactamente os inputs do action.yml', async () => {
    const inputs = yamlBlock(await readText('action.yml'), 'inputs:', 2);
    const documented = tableRows(readmeSection(await readText('README.md'), 'Inputs'));

    assert.deepEqual([...documented.keys()].sort(), [...inputs.keys()].sort());
  });

  test('os valores por omissao do README sao os do action.yml', async () => {
    const inputs = yamlBlock(await readText('action.yml'), 'inputs:', 2);
    const documented = tableRows(readmeSection(await readText('README.md'), 'Inputs'));
    const expected = [...inputs].map(([name, value]) => [name, documentedDefault(value)]);

    assert.deepEqual([...documented].sort(), expected.sort());
  });

  test('a tabela de outputs do README tem exactamente os outputs do action.yml', async () => {
    const outputs = yamlBlock(await readText('action.yml'), 'outputs:', 2);
    const documented = tableRows(readmeSection(await readText('README.md'), 'Outputs'));

    assert.deepEqual([...documented.keys()].sort(), [...outputs.keys()].sort());
  });

  test('o README mostra o mesmo URL do schema que a CLI grava', async () => {
    const readme = await readText('README.md');

    assert.ok(readme.includes(`"$schema": "${SCHEMA_URL}"`));
  });

  test('o README documenta cada input do workflow reutilizavel', async () => {
    const workflow = await readText('.github/workflows/quality-ratchet.yml');
    const section = readmeSection(await readText('README.md'), 'Reusable workflow');
    const inputs = [...yamlBlock(workflow, '    inputs:', 6).keys()];

    assert.deepEqual(inputs.filter((name) => !section.includes(`\`${name}\``)), []);
  });
});

describe('CHANGELOG', () => {
  test('tem uma entrada para a versao do package.json', async () => {
    const { version } = JSON.parse(await readText('package.json'));
    const changelog = await readText('CHANGELOG.md');

    assert.match(changelog, new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] - `, 'm'));
  });

  test('a versao do package.json liga a tag da release', async () => {
    const { version } = JSON.parse(await readText('package.json'));
    const changelog = await readText('CHANGELOG.md');
    const link = `[${version}]: https://github.com/LuisFernandes664/quality-ratchet/releases/`
      + `tag/v${version}`;

    assert.ok(changelog.includes(link), link);
  });
});

describe('workflows', () => {
  test('as actions externas estao fixadas por major', async () => {
    const refs = (await workflowFiles()).flatMap(([file, text]) => [...text.matchAll(USES_LINE)]
      .map((match) => ({ file, uses: match[1] }))
      .filter(({ uses }) => !uses.startsWith('./')));
    const unpinned = refs.filter(({ uses }) => !MAJOR_REF.test(uses.split('@')[1] ?? ''));

    assert.deepEqual(unpinned, []);
  });

  test('os workflows de pull request correm nos eventos edited, labeled e unlabeled', async () => {
    const pullRequest = (await workflowFiles())
      .filter(([, text]) => /^\s+pull_request:\s*$/m.test(text));
    const missing = pullRequest.filter(([, text]) => !text.includes(PULL_REQUEST_TYPES));

    assert.deepEqual(missing.map(([file]) => file), []);
  });
});
