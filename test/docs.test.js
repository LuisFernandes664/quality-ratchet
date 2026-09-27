// @ts-check
/**
 * Coerência da documentação com o código: as tabelas de inputs e outputs do README seguem o
 * action.yml, o CHANGELOG tem a versão do package.json, as referências a esta action, à CLI
 * e ao schema usam a major do package.json, e os workflows fixam as actions externas por
 * major e correm o gate nos eventos que o README explica. Os scripts dos passos que o
 * README descreve (o `collect` do workflow reutilizável, a tag major do release) e a
 * receita de fusão de relatórios JUnit correm aqui com o bash e o git reais.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SCHEMA_URL } from '../src/cli/defaults.js';
import { extract } from '../src/extractors/index.js';

/** Raiz do repositório. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Pastas com workflows do GitHub Actions, relativas à raiz. */
const WORKFLOW_DIRS = ['.github/workflows', 'examples/workflows'];

/** Pastas de exemplos, relativas à raiz. */
const EXAMPLE_DIRS = ['examples/baselines', 'examples/workflows'];

/** Workflow reutilizável, relativo à raiz. */
const REUSABLE_WORKFLOW = '.github/workflows/quality-ratchet.yml';

/** Workflow que move a tag major, relativo à raiz. */
const RELEASE_WORKFLOW = '.github/workflows/release.yml';

/** Eventos de pull request que voltam a correr o gate quando o título ou as labels mudam. */
const PULL_REQUEST_TYPES = 'types: [opened, synchronize, reopened, edited, labeled, unlabeled]';

/** Referência de uma action fixada por major (ex: `v7`). */
const MAJOR_REF = /^v\d+$/;

/** Commit SHA completo. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Linha `uses:` de um passo ou job, com o valor capturado. */
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(\S+)\s*$/gm;

/** Referência a esta action ou ao workflow reutilizável por tag major, com a major. */
const ACTION_MAJOR = /LuisFernandes664\/quality-ratchet(?:\/\.github\/workflows\/[^@\s]+)?@v(\d+)/g;

/** Passo que corre esta action, com a referência capturada. */
const ACTION_STEP = /^\s*(?:-\s+)?uses:\s*LuisFernandes664\/quality-ratchet@(\S+)\s*$/m;

/** Invocação da CLI a partir do repositório git, com o que vem a seguir (a ref). */
const CLI_FROM_GIT = /github:LuisFernandes664\/quality-ratchet(\S*)/g;

/** Invocação da CLI publicada no npm, com o que vem a seguir ao nome (a versão). */
const CLI_FROM_NPM = /npx (?:--yes )?quality-ratchet(\S*)/g;

/** URL do schema numa tag major, com a major. */
const SCHEMA_MAJOR = /quality-ratchet\/(?:raw\/)?v(\d+)\/schema\//g;

/** Célula de uma tabela Markdown que o README usa para os nomes (ex: `| \`baseline\` |`). */
const TABLE_NAME = /^\| `([^`]+)` \| ([^|]*) \|/;

/** Bloco de código Markdown: linguagem e conteúdo. */
const CODE_BLOCK = /^```(\w*)\n([\s\S]*?)^```$/gm;

/**
 * Inputs da action que, vazios, mudam de comportamento em vez de voltarem ao valor por
 * omissão: `readInputs` lê-os sem fallback e `createClient` não cria o cliente sem token
 * (src/action/main.js).
 */
const EMPTY_CHANGES_BEHAVIOUR = ['bypass-label', 'lower-baseline-pattern', 'token'];

/** Secrets que o workflow reutilizável aceita. */
const REUSABLE_SECRETS = ['collect-env', 'github-token'];

/** Secção do README sobre a governação do baseline. */
const GOVERNANCE = 'Governance: who may loosen the baseline';

/** Secção do README sobre as sources. */
const SOURCES = 'Sources: reading reports directly';

/** Nome do passo do workflow reutilizável que corre o `collect`. */
const COLLECT_STEP = 'Collect reports';

/** Nome do passo do release que move a tag major. */
const RELEASE_STEP = 'Move the major tag to the release commit';

/** Argumentos com que o GitHub Actions corre um passo com `shell: bash`. */
const BASH_ARGS = ['--noprofile', '--norc', '-eo', 'pipefail', '-c'];

/** Configuração do git dos repositórios de teste, independente da do utilizador. */
const GIT_CONFIG = ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com',
  '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'init.defaultBranch=main'];

/**
 * Ambiente dos processos filhos: sem a configuração global do git nem variáveis GIT_* de
 * um repositório exterior, e com uma ordenação estável.
 */
const CHILD_ENV = Object.freeze({
  PATH: process.env.PATH ?? '',
  HOME: os.tmpdir(),
  LC_ALL: 'C',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: os.tmpdir(),
});

/** Relatório do Surefire de uma classe: 5 testes, 1 falha, 1 erro, 1 ignorado. */
const SUREFIRE_A = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<testsuite name="demo.ATest" tests="5" failures="1" errors="1" skipped="1">',
  '  <testcase name="a1" classname="demo.ATest"/>',
  '  <testcase name="a2" classname="demo.ATest"><failure message="x">x</failure></testcase>',
  '  <testcase name="a3" classname="demo.ATest"><error message="y">y</error></testcase>',
  '  <testcase name="a4" classname="demo.ATest"><skipped/></testcase>',
  '  <testcase name="a5" classname="demo.ATest"/>',
  '</testsuite>',
  '',
].join('\n');

/** Relatório do Surefire de outra classe: 2 testes, 1 falha. */
const SUREFIRE_B = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<testsuite name="demo.BTest" tests="2" failures="1" errors="0" skipped="0">',
  '  <testcase name="b1" classname="demo.BTest"/>',
  '  <testcase name="b2" classname="demo.BTest"><failure message="z">z</failure></testcase>',
  '</testsuite>',
  '',
].join('\n');

/** Pastas temporárias criadas pelos testes, apagadas no fim. */
const TEMP_DIRS = /** @type {string[]} */ ([]);

/** Versão do package.json. */
const VERSION = String(JSON.parse(await readText('package.json')).version);

/** Major do package.json, sem o `v` (ex: '2'). */
const MAJOR = VERSION.split('.')[0];

/**
 * Indica se um comando existe no PATH.
 * @param {string} command
 * @returns {boolean}
 */
function hasCommand(command) {
  return spawnSync(command, ['--version'], { env: CHILD_ENV }).status === 0;
}

/** Testes que correm scripts com o bash: saltados só quando o bash não existe. */
const bashTest = hasCommand('bash') ? test : test.skip;

/** Testes com o bash e o git reais: saltados só quando um deles não existe. */
const gitTest = hasCommand('bash') && hasCommand('git') ? test : test.skip;

after(() => Promise.all(TEMP_DIRS.map((dir) => rm(dir, { recursive: true, force: true }))));

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
 * Linhas mais indentadas do que `indent` a seguir à linha `index` (o corpo de um bloco
 * YAML), até à primeira que não o seja. As linhas em branco fazem parte do corpo.
 * @param {string[]} lines
 * @param {number} index
 * @param {number} indent
 * @returns {string[]}
 */
function indentedBlock(lines, index, indent) {
  /** @type {string[]} */
  const body = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= indent) break;
    body.push(line);
  }
  return body;
}

/**
 * Descrição de uma chave de um bloco YAML (ex: um output), escrita numa linha ou num
 * bloco dobrado `>-`, com as linhas juntas por espaços.
 * @param {string} text
 * @param {string} header linha que abre o bloco (ex: 'outputs:')
 * @param {number} indent indentação das chaves
 * @param {string} name
 * @returns {string}
 */
function yamlDescription(text, header, indent, name) {
  const lines = text.split('\n');
  const key = lines.indexOf(`${' '.repeat(indent)}${name}:`, lines.indexOf(header));
  const prefix = `${' '.repeat(indent + 2)}description:`;
  const at = lines.findIndex((line, index) => index > key && line.startsWith(prefix));
  assert.notEqual(at, -1, `descrição de "${name}" em falta`);
  const inline = lines[at].slice(prefix.length).trim();
  if (inline !== '>-') return unquote(inline);
  return indentedBlock(lines, at, indent + 2).map((line) => line.trim()).join(' ');
}

/**
 * Script do `run: |` de um passo, sem a indentação do YAML.
 * @param {string} text workflow
 * @param {string} name nome do passo
 * @returns {string}
 */
function stepScript(text, name) {
  const lines = text.split('\n');
  const step = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(step, -1, `passo "${name}" em falta`);
  const run = lines.findIndex((line, index) => index > step && /^\s+run: \|$/.test(line));
  const body = indentedBlock(lines, run, lines[run].search(/\S/));
  const filled = body.filter((line) => line.trim() !== '');
  const margin = Math.min(...filled.map((line) => line.search(/\S/)));
  return body.map((line) => line.slice(margin)).join('\n');
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
 * Texto sem acentos graves nem aspas e com os espaços normalizados, para comparar a mesma
 * frase escrita em Markdown e em YAML.
 * @param {string} text
 * @returns {string}
 */
function plainText(text) {
  return text.replace(/[`"]/g, '').replace(/\s+/g, ' ').trim();
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
 * Texto de uma subsecção `### <título>` do README, até ao título seguinte.
 * @param {string} readme
 * @param {string} title
 * @returns {string}
 */
function readmeSubsection(readme, title) {
  const start = readme.indexOf(`\n### ${title}\n`);
  assert.notEqual(start, -1, `subsecção "${title}" em falta no README`);
  const end = readme.slice(start + 1).search(/\n#{2,3} /);
  return readme.slice(start, end === -1 ? undefined : start + 1 + end);
}

/**
 * Conteúdo do bloco de código de uma linguagem que contém um marcador.
 * @param {string} markdown
 * @param {string} language
 * @param {string} marker
 * @returns {string}
 */
function codeBlock(markdown, language, marker) {
  const blocks = [...markdown.matchAll(CODE_BLOCK)];
  const found = blocks.find(([, lang, body]) => lang === language && body.includes(marker));
  assert.ok(found, `bloco ${language} com "${marker}" em falta`);
  return found[2];
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
 * Conteúdo dos ficheiros de algumas pastas, por caminho relativo.
 * @param {string[]} dirs pastas relativas à raiz
 * @param {string} [extension] só os ficheiros com esta extensão
 * @returns {Promise<Array<[string, string]>>}
 */
async function filesIn(dirs, extension = '') {
  const nested = await Promise.all(dirs.map(async (dir) => {
    const names = (await readdir(path.join(ROOT, dir))).filter((name) => name.endsWith(extension));
    return names.map((name) => path.posix.join(dir, name));
  }));
  const files = nested.flat();
  const texts = await Promise.all(files.map(readText));
  return files.map((file, index) => [file, texts[index]]);
}

/**
 * Conteúdo de todos os workflows do GitHub Actions do repositório, por caminho relativo.
 * @returns {Promise<Array<[string, string]>>}
 */
function workflowFiles() {
  return filesIn(WORKFLOW_DIRS, '.yml');
}

/**
 * O README e os exemplos, por caminho relativo: o que um utilizador copia.
 * @returns {Promise<Array<[string, string]>>}
 */
async function copiedFiles() {
  return [['README.md', await readText('README.md')], ...await filesIn(EXAMPLE_DIRS)];
}

/**
 * Todas as ocorrências de uma expressão nos ficheiros, com o primeiro grupo capturado.
 * @param {Array<[string, string]>} files
 * @param {RegExp} pattern expressão com a flag `g`
 * @returns {Array<{file: string, value: string}>}
 */
function occurrences(files, pattern) {
  return files.flatMap(([file, text]) => [...text.matchAll(pattern)]
    .map((match) => ({ file, value: match[1] })));
}

/**
 * Corre um script como o GitHub Actions corre um passo com `shell: bash`.
 * @param {string} script
 * @param {Record<string, string>} env variáveis do passo
 * @param {string} [cwd]
 * @returns {{status: number|null, stdout: string, output: string}}
 */
function runBash(script, env, cwd) {
  const options = { cwd, env: { ...CHILD_ENV, ...env }, encoding: /** @type {const} */ ('utf8') };
  const result = spawnSync('bash', [...BASH_ARGS, script], options);
  return { status: result.status, stdout: result.stdout, output: result.stdout + result.stderr };
}

/**
 * Cria uma pasta temporária, apagada no fim dos testes.
 * @returns {Promise<string>}
 */
async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quality-ratchet-docs-'));
  TEMP_DIRS.push(dir);
  return dir;
}

/**
 * Corre o git com a configuração dos testes.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string} stdout sem espaços nas pontas
 */
function git(cwd, args) {
  const options = { cwd, env: CHILD_ENV, encoding: /** @type {const} */ ('utf8') };
  return execFileSync('git', [...GIT_CONFIG, ...args], { ...options, stdio: 'pipe' }).trim();
}

/**
 * @typedef {object} ReleaseRepository
 * @property {string} dir pasta temporária
 * @property {string} origin repositório remoto (bare)
 * @property {string} work repositório onde as tags foram criadas
 */

/**
 * Repositório remoto com um commit por tag. Cada commit nasce do da tag `parent`, ou do
 * commit anterior quando não há `parent`.
 * @param {Array<[string, string?]>} tags pares [tag, parent]
 * @returns {Promise<ReleaseRepository>}
 */
async function releaseRepository(tags) {
  const dir = await makeTempDir();
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  git(dir, ['init', '--quiet', '--bare', origin]);
  git(dir, ['init', '--quiet', work]);
  for (const [tag, parent] of tags) {
    if (parent !== undefined) git(work, ['checkout', '--quiet', '--detach', parent]);
    git(work, ['commit', '--quiet', '--allow-empty', '-m', tag]);
    git(work, ['tag', tag]);
  }
  git(work, ['push', '--quiet', origin, '--tags', 'HEAD:refs/heads/main']);
  return { dir, origin, work };
}

/**
 * Publica uma release: como o workflow, faz checkout da tag num clone e corre o passo
 * que move a tag major.
 * @param {ReleaseRepository} repo
 * @param {string} tag
 * @returns {Promise<{status: number|null, stdout: string, output: string}>}
 */
async function publishRelease(repo, tag) {
  const script = stepScript(await readText(RELEASE_WORKFLOW), RELEASE_STEP);
  const clone = path.join(repo.dir, `clone-${tag}`);
  git(repo.dir, ['clone', '--quiet', repo.origin, clone]);
  git(clone, ['checkout', '--quiet', '--detach', tag]);
  return runBash(script, { TAG: tag }, clone);
}

/**
 * Commit para onde uma tag aponta no repositório remoto ('' quando não existe).
 * @param {ReleaseRepository} repo
 * @param {string} tag
 * @returns {string}
 */
function remoteTag(repo, tag) {
  return git(repo.dir, ['ls-remote', repo.origin, `refs/tags/${tag}`]).split('\t')[0];
}

/**
 * Commit de uma tag no repositório onde foi criada.
 * @param {ReleaseRepository} repo
 * @param {string} tag
 * @returns {string}
 */
function commitOf(repo, tag) {
  return git(repo.work, ['rev-parse', `${tag}^{commit}`]);
}

/**
 * Corre o `collect` do workflow reutilizável com o secret collect-env.
 * @param {string} collect
 * @param {string} collectEnv
 * @returns {Promise<{status: number|null, stdout: string, output: string}>}
 */
async function runCollect(collect, collectEnv) {
  const script = stepScript(await readText(REUSABLE_WORKFLOW), COLLECT_STEP);
  return runBash(script, { COLLECT: collect, COLLECT_ENV: collectEnv });
}

/**
 * Funde dois relatórios do Surefire com a receita do README e lê o campo pedido.
 * @param {string} field campo do formato junit
 * @returns {Promise<number>}
 */
async function measureReadmeJunitMerge(field) {
  const dir = await makeTempDir();
  const reports = path.join(dir, 'target', 'surefire-reports');
  await mkdir(reports, { recursive: true });
  await writeFile(path.join(reports, 'TEST-demo.ATest.xml'), SUREFIRE_A);
  await writeFile(path.join(reports, 'TEST-demo.BTest.xml'), SUREFIRE_B);
  const recipe = codeBlock(await readText('README.md'), 'sh', '<testsuites>');
  assert.equal(runBash(recipe, {}, dir).status, 0);
  const merged = await readFile(path.join(dir, 'reports', 'junit.xml'), 'utf8');
  return extract({ format: 'junit', path: 'reports/junit.xml', field }, merged);
}

/**
 * Tipos de evento de release em que o workflow de release corre.
 * @returns {Promise<string[]>}
 */
async function releaseTypes() {
  const text = await readText(RELEASE_WORKFLOW);
  const types = /^\s+release:\s*\n\s+types:\s*\[([^\]]*)\]/m.exec(text)?.[1] ?? '';
  return types.split(',').map((type) => type.trim()).filter(Boolean);
}

/**
 * Entradas (`- ...`) da secção `### Breaking changes` da versão do package.json.
 * @returns {Promise<string[]>}
 */
async function breakingChanges() {
  const changelog = await readText('CHANGELOG.md');
  const release = changelog.slice(changelog.indexOf(`## [${VERSION}]`));
  const start = release.indexOf('### Breaking changes');
  const section = release.slice(start, release.indexOf('\n### ', start + 1));
  return section.split('\n- ').slice(1);
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

  test('o README diz quais inputs vazios nao voltam ao valor por omissao', async () => {
    const section = readmeSection(await readText('README.md'), 'Inputs');
    const paragraph = section.split('\n\n').find((part) => part.includes('fall back')) ?? '';
    const missing = EMPTY_CHANGES_BEHAVIOUR.filter((name) => !paragraph.includes(`\`${name}\``));

    assert.deepEqual(missing, []);
  });

  test('a tabela de outputs do README tem exactamente os outputs do action.yml', async () => {
    const outputs = yamlBlock(await readText('action.yml'), 'outputs:', 2);
    const documented = tableRows(readmeSection(await readText('README.md'), 'Outputs'));

    assert.deepEqual([...documented.keys()].sort(), [...outputs.keys()].sort());
  });

  test('a descricao do output passed do action.yml e a do README', async () => {
    const readme = tableRows(readmeSection(await readText('README.md'), 'Outputs'));
    const action = yamlDescription(await readText('action.yml'), 'outputs:', 2, 'passed');

    assert.equal(plainText(action), plainText(String(readme.get('passed'))));
  });

  test('o README mostra o mesmo URL do schema que a CLI grava', async () => {
    const readme = await readText('README.md');

    assert.ok(readme.includes(`"$schema": "${SCHEMA_URL}"`));
  });

  test('os URLs do schema no README usam a major do package.json', async () => {
    const found = occurrences([['README.md', await readText('README.md')]], SCHEMA_MAJOR);

    assert.ok(found.length > 0);
    assert.deepEqual(found.filter(({ value }) => value !== MAJOR), []);
  });
});

describe('README: governacao e plataformas', () => {
  test('o README avisa que a governacao precisa do merge commit', async () => {
    const section = readmeSection(await readText('README.md'), GOVERNANCE);

    assert.ok(section.includes('head.sha') && section.includes('merge commit'));
  });

  test('o README do GitLab usa a merge base como o exemplo', async () => {
    const section = readmeSection(await readText('README.md'), 'Other platforms');
    const example = await readText('examples/workflows/gitlab-ci.yml');
    const key = example.split('\n').map((line) => line.trim())
      .filter((line) => /GIT_DEPTH:|merge-base|--base-ref/.test(line) && !line.startsWith('#'));

    assert.deepEqual(key.filter((line) => !section.includes(line)), []);
  });

  test('o README pede Node.js 20 na imagem do job em Gitea e Forgejo', async () => {
    const section = readmeSubsection(await readText('README.md'), 'Gitea and Forgejo Actions');

    assert.match(section, /image[^.]*Node\.js 20 or later|Node\.js 20 or later[^.]*image/);
  });

  test('o README explica que os relatorios JUnit de uma classe por ficheiro se fundem',
    async () => {
      const section = readmeSection(await readText('README.md'), SOURCES);
      const named = /Surefire|Gradle/.test(section);

      assert.ok(!named || (section.includes('TEST-*.xml') && /merg/i.test(section)));
    });

  bashTest('a receita do README para fundir relatorios JUnit conta os testes de todas as classes',
    async () => {
      assert.equal(await measureReadmeJunitMerge('tests'), 7);
    });

  bashTest('a receita do README para fundir relatorios JUnit conta as falhas de todas as classes',
    async () => {
      assert.equal(await measureReadmeJunitMerge('failures'), 2);
    });
});

describe('versoes e fixacao', () => {
  test('as referencias a esta action usam a major do package.json', async () => {
    const files = [...await copiedFiles(), ...await filesIn(['.github/workflows'], '.yml')];
    const found = occurrences(files, ACTION_MAJOR);

    assert.ok(found.length > 0);
    assert.deepEqual(found.filter(({ value }) => value !== MAJOR), []);
  });

  test('as invocacoes da CLI por git fixam uma ref', async () => {
    const found = occurrences(await copiedFiles(), CLI_FROM_GIT);

    assert.ok(found.length > 0);
    assert.deepEqual(found.filter(({ value }) => !value.startsWith('#')), []);
  });

  test('as invocacoes da CLI fixadas por tag usam a major do package.json', async () => {
    const tags = occurrences(await copiedFiles(), CLI_FROM_GIT)
      .map(({ file, value }) => ({ file, value: /^#v(\d+)/.exec(value)?.[1] }))
      .filter(({ value }) => value !== undefined);

    assert.ok(tags.length > 0);
    assert.deepEqual(tags.filter(({ value }) => value !== MAJOR), []);
  });

  test('o npx do pacote publicado fixa a major do package.json', async () => {
    const found = occurrences([['README.md', await readText('README.md')]], CLI_FROM_NPM);
    const pinned = new RegExp(`^@${MAJOR}(?!\\d)`);

    assert.deepEqual(found.filter(({ value }) => !pinned.test(value)), []);
  });

  test('o README avisa que fixar o workflow reutilizavel por SHA nao fixa a action', async () => {
    const ref = ACTION_STEP.exec(await readText(REUSABLE_WORKFLOW))?.[1] ?? '';
    const section = readmeSection(await readText('README.md'), 'Reusable workflow');
    const warned = section.includes(`\`LuisFernandes664/quality-ratchet@${ref}\``)
      && /\bSHA\b/.test(section);

    assert.ok(FULL_SHA.test(ref) || warned, ref);
  });
});

describe('workflow reutilizavel', () => {
  test('o README documenta cada input do workflow reutilizavel', async () => {
    const workflow = await readText(REUSABLE_WORKFLOW);
    const section = readmeSection(await readText('README.md'), 'Reusable workflow');
    const inputs = [...yamlBlock(workflow, '    inputs:', 6).keys()];

    assert.deepEqual(inputs.filter((name) => !section.includes(`\`${name}\``)), []);
  });

  test('o workflow reutilizavel aceita os secrets collect-env e github-token', async () => {
    const secrets = yamlBlock(await readText(REUSABLE_WORKFLOW), '    secrets:', 6);

    assert.deepEqual([...secrets.keys()], REUSABLE_SECRETS);
  });

  test('o README documenta cada secret do workflow reutilizavel', async () => {
    const secrets = [...yamlBlock(await readText(REUSABLE_WORKFLOW), '    secrets:', 6).keys()];
    const section = readmeSection(await readText('README.md'), 'Reusable workflow');

    assert.deepEqual(secrets.filter((name) => !section.includes(`\`${name}\``)), []);
  });

  test('so o passo Collect recebe o secret collect-env', async () => {
    const lines = (await readText(REUSABLE_WORKFLOW)).split('\n')
      .filter((line) => line.includes('secrets.collect-env'));

    assert.deepEqual(lines, ['          COLLECT_ENV: ${{ secrets.collect-env }}']);
  });

  test('o passo da catraca usa o secret github-token quando e dado', async () => {
    const workflow = await readText(REUSABLE_WORKFLOW);

    assert.ok(workflow.includes('          token: ${{ secrets.github-token || github.token }}'));
  });

  test('a descricao do output passed do workflow reutilizavel e a do README', async () => {
    const readme = tableRows(readmeSection(await readText('README.md'), 'Outputs'));
    const workflow = await readText(REUSABLE_WORKFLOW);
    const description = yamlDescription(workflow, '    outputs:', 6, 'passed');

    assert.equal(plainText(description), plainText(String(readme.get('passed'))));
  });

  bashTest('o passo Collect exporta as linhas de collect-env para o script', async () => {
    const collect = 'printf "%s|%s" "$NPM_TOKEN" "$PIP_INDEX_URL"';
    const result = await runCollect(collect, 'NPM_TOKEN=a=b\n\nPIP_INDEX_URL=https://u:p@h/s');

    assert.equal(result.stdout.split('\n').at(-1), 'a=b|https://u:p@h/s');
  });

  bashTest('o passo Collect mascara cada valor de collect-env', async () => {
    const result = await runCollect('true', 'NPM_TOKEN=a=b\nPIP_INDEX_URL=https://u:p@h/s');
    const masks = result.stdout.split('\n').filter((line) => line.startsWith('::add-mask::'));

    assert.deepEqual(masks, ['::add-mask::a=b', '::add-mask::https://u:p@h/s']);
  });

  bashTest('o passo Collect escapa o % dos valores que mascara', async () => {
    const result = await runCollect('true', 'TOKEN=x%0Ay');

    assert.ok(result.stdout.split('\n').includes('::add-mask::x%250Ay'), result.stdout);
  });

  bashTest('o passo Collect falha com uma linha de collect-env que nao e NAME=VALUE', async () => {
    const result = await runCollect('true', '1BAD=segredo');

    assert.equal(result.status, 1);
  });

  bashTest('o passo Collect nao mostra a linha de collect-env que rejeita', async () => {
    const result = await runCollect('true', 'OK=1\nnao e uma linha segredo');

    assert.ok(!result.output.includes('segredo'), result.output);
  });

  bashTest('o script collect nao ve o texto de collect-env', async () => {
    const result = await runCollect('printf "%s" "${COLLECT_ENV-ausente}"', 'NPM_TOKEN=abc');

    assert.equal(result.stdout.split('\n').at(-1), 'ausente');
  });

  bashTest('sem collect-env o passo Collect corre so o script', async () => {
    const result = await runCollect('printf ok', '');

    assert.deepEqual({ status: result.status, stdout: result.stdout }, { status: 0, stdout: 'ok' });
  });
});

describe('CHANGELOG', () => {
  test('tem uma entrada para a versao do package.json', async () => {
    const changelog = await readText('CHANGELOG.md');

    assert.match(changelog, new RegExp(`^## \\[${VERSION.replaceAll('.', '\\.')}\\] - `, 'm'));
  });

  test('a versao do package.json liga a tag da release', async () => {
    const changelog = await readText('CHANGELOG.md');
    const link = `[${VERSION}]: https://github.com/LuisFernandes664/quality-ratchet/releases/`
      + `tag/v${VERSION}`;

    assert.ok(changelog.includes(link), link);
  });

  test('mantem a entrada da 1.0.0 ja publicada nas tags v1 e v1.0.0', async () => {
    const changelog = await readText('CHANGELOG.md');

    assert.match(changelog, /^## \[1\.0\.0\] - 2026-08-30$/m);
  });

  test('a versao do package.json e posterior a 1.0.0 ja publicada', () => {
    const [major, minor, patch] = VERSION.split('.').map(Number);

    assert.ok(major > 1 || (major === 1 && minor + patch > 0), VERSION);
  });

  test('as breaking changes explicam o valor vazio de bypass-label e lower-baseline-pattern',
    async () => {
      const entries = (await breakingChanges()).filter((entry) => /empty/i.test(entry)
        && entry.includes('`bypass-label`') && entry.includes('`lower-baseline-pattern`'));

      assert.equal(entries.length, 1);
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

  test('os workflows de pull request fazem checkout do merge commit', async () => {
    const headRef = /^\s*ref:\s*\$\{\{\s*github\.(event\.pull_request\.head\.sha|head_ref)\s*\}\}/m;
    const offenders = (await workflowFiles())
      .filter(([, text]) => /^\s+pull_request:\s*$/m.test(text) && headRef.test(text));

    assert.deepEqual(offenders.map(([file]) => file), []);
  });

  test('o release corre quando uma release estavel e publicada ou uma pre-release promovida',
    async () => {
      assert.deepEqual(await releaseTypes(), ['released']);
    });

  gitTest('o release move a tag major para a release mais alta', async () => {
    const repo = await releaseRepository([['v2.0.0'], ['v2.1.0']]);
    await publishRelease(repo, 'v2.1.0');

    assert.equal(remoteTag(repo, 'v2'), commitOf(repo, 'v2.1.0'));
  });

  gitTest('o release nao recua a tag major ao publicar um patch de uma minor antiga', async () => {
    const repo = await releaseRepository([['v2.0.0'], ['v2.1.0'], ['v2.0.1', 'v2.0.0']]);
    await publishRelease(repo, 'v2.1.0');
    await publishRelease(repo, 'v2.0.1');

    assert.equal(remoteTag(repo, 'v2'), commitOf(repo, 'v2.1.0'));
  });

  gitTest('o release sai com 0 quando a release nao e a mais alta', async () => {
    const repo = await releaseRepository([['v2.0.0'], ['v2.1.0'], ['v2.0.1', 'v2.0.0']]);
    const result = await publishRelease(repo, 'v2.0.1');

    assert.equal(result.status, 0, result.output);
  });

  gitTest('o release compara as versoes pela ordem numerica', async () => {
    const repo = await releaseRepository([['v2.9.0'], ['v2.10.0']]);
    await publishRelease(repo, 'v2.10.0');
    await publishRelease(repo, 'v2.9.0');

    assert.equal(remoteTag(repo, 'v2'), commitOf(repo, 'v2.10.0'));
  });
});
