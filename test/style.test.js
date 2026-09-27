// @ts-check
/**
 * Regras de estilo que valem para todo o repositório: sem travessão tipográfico, linhas de
 * código com no máximo 100 caracteres, todo o JavaScript verificado pelo typecheck e sem
 * tipos typedef por usar, funções com no máximo 15 linhas de lógica, e a grafia anterior ao
 * Acordo Ortográfico de 1990 nos comentários e nas mensagens em português. As regras que
 * precisam da árvore sintáctica usam o typescript das devDependencies.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** @typedef {typeof import('typescript')} TypeScript */
/** @typedef {import('typescript').Node} TsNode */
/** @typedef {import('typescript').SourceFile} SourceFile */

/**
 * Token da árvore sintáctica, com as linhas (a começar em 1) que ocupa.
 * @typedef {object} Token
 * @property {number} start
 * @property {number} end
 * @property {number} firstLine
 * @property {number} lastLine
 * @property {boolean} closer só fecha uma construção: `}`, `)`, `]`, `;` ou `,`
 */

/**
 * Texto encontrado num ficheiro, com a linha (a começar em 1) onde começa.
 * @typedef {{line: number, text: string}} Located
 */

/**
 * Verificação de um ficheiro pela árvore sintáctica: devolve os problemas encontrados.
 * @typedef {(ts: TypeScript, file: string, source: SourceFile) => string[]} SourceCheck
 */

/** Raiz do repositório. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Pastas que não são código do projecto. */
const SKIPPED = new Set(['node_modules', '.git', 'coverage']);

/** Extensões sujeitas ao limite de comprimento de linha. */
const CODE = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml']);

/** Extensões de JavaScript. */
const JAVASCRIPT = new Set(['.js', '.mjs', '.cjs']);

/** Pastas de JavaScript que o typecheck tem de cobrir, relativas à raiz. */
const TYPECHECKED_DIRS = ['src', 'bin', 'test'];

/** Directiva que liga a verificação de tipos num ficheiro JavaScript. */
const TS_CHECK = '// @ts-check';

/** Travessão tipográfico, proibido em todo o repositório (usar hífen simples). */
const EM_DASH = String.fromCharCode(0x2014);

/** Comprimento máximo de uma linha de código. */
const MAX_LINE = 100;

/** Máximo de linhas de lógica de uma função (sem JSDoc, linhas em branco nem assinatura). */
const MAX_LOGIC_LINES = 15;

/** Chamadas cujo callback só agrupa testes: não conta como função. */
const GROUPING_CALL = /^describe(?:\.\w+)?$/;

/** Chamadas que declaram testes: o primeiro argumento é o título, em português. */
const TEST_CALL = /^(?:describe|it|\w*[tT]est)(?:\.\w+)?$/;

/** `import('<caminho>').Nome` num tipo JSDoc: caminho e nome. */
const TYPE_IMPORT = /import\(\s*['"]([^'"]+)['"]\s*\)\.([A-Za-z_$][\w$]*)/g;

/** Tag typedef no início de uma linha de JSDoc, a seguir a `/**` ou a ` * `. */
const TYPEDEF_TAG = /^[ \t]*(?:\/\*\*|\*)[ \t]*@typedef\b/gm;

/** Nome declarado a seguir ao tipo de uma tag typedef, talvez na linha seguinte. */
const TYPEDEF_NAME = /^[\s*]*([A-Za-z_$][\w$]*)/;

/**
 * Inícios de palavras na grafia do Acordo Ortográfico de 1990, proibida nos textos em
 * português: o projecto usa a anterior ("projecto", "objecto", "direcção", "actual",
 * "exacto", "efectivo", "colector", "acção", ...). O resto da palavra é livre.
 */
const POST_AGREEMENT_STEMS = [
  'colet', 'projet', 'objet', 'diret', 'direç[ãõ]', 'atua', 'atuá', 'exat', 'efet',
  'aç[ãõ]', 'corret', 'correç[ãõ]', 'seleç[ãõ]', 'selecion', 'coleç[ãõ]', 'detet',
  'deteç[ãõ]', 'proteç[ãõ]', 'protet', 'exceç[ãõ]', 'excecion', 'receç[ãõ]', 'recet',
  'ótim', 'ótic', 'arquitet', 'respetiv', 'perspetiv', 'caráter', 'aspet', 'inspeç[ãõ]',
  'inspecion', '(?:in|des|re)?ativ', 'fatur', 'redaç[ãõ]', 'injeç[ãõ]', 'injet', 'seç[ãõ]',
  'setor', 'contat', 'adot', 'adoç[ãõ]', 'interaç[ãõ]', 'transaç[ãõ]', 'fraç[ãõ]',
  'extraç[ãõ]', 'extrat', 'conceç[ãõ]', 'contraç[ãõ]', 'elétric',
];

/** Palavras inteiras na grafia do Acordo: "acto" sem o "c", e o plural. */
const POST_AGREEMENT_WORDS = ['atos?'];

/** Formas do Acordo num texto, como palavras inteiras. */
const POST_AGREEMENT_FORMS = postAgreementPattern();

/** Módulo typescript das devDependencies, ou null quando não está instalado. */
const TS = await loadTypeScript();

/** Motivo para saltar os testes que precisam da árvore sintáctica. */
const NO_TYPESCRIPT = TS === null && 'o typescript não está instalado: correr npm ci';

/**
 * Carrega o typescript das devDependencies. Sem ele (ex: `node --test` sem `npm ci`), os
 * testes que precisam da árvore sintáctica são saltados, com o motivo no relatório.
 * @returns {Promise<TypeScript|null>}
 */
async function loadTypeScript() {
  try {
    return (await import('typescript')).default;
  } catch (error) {
    if (/** @type {{code?: unknown}} */ (error)?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

/**
 * O typescript carregado, para os testes que só correm quando ele existe.
 * @returns {TypeScript}
 */
function typescript() {
  assert.ok(TS, 'typescript em falta');
  return TS;
}

/**
 * Expressão que encontra as formas do Acordo como palavras inteiras.
 * @returns {RegExp}
 */
function postAgreementPattern() {
  const forms = [...POST_AGREEMENT_STEMS.map((stem) => `${stem}\\p{L}*`), ...POST_AGREEMENT_WORDS];
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${forms.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
}

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
 * Conteúdo dos ficheiros JavaScript, por caminho relativo.
 * @returns {Promise<Array<[string, string]>>}
 */
async function javaScriptFiles() {
  return (await textFiles()).filter(([file]) => JAVASCRIPT.has(path.extname(file)));
}

/**
 * Primeira pasta de um caminho relativo (ex: 'src' para 'src/core/x.js').
 * @param {string} file
 * @returns {string}
 */
function topDir(file) {
  return file.split(path.sep)[0];
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

/**
 * Linha (a começar em 1) de uma posição de um texto.
 * @param {string} text
 * @param {number} position
 * @returns {number}
 */
function lineOf(text, position) {
  return text.slice(0, position).split('\n').length;
}

/**
 * Posição a seguir ao tipo `{...}` de uma tag typedef, com chavetas equilibradas, ou a
 * própria posição quando a tag não tem tipo.
 * @param {string} text
 * @param {number} position logo a seguir à tag
 * @returns {number}
 */
function skipType(text, position) {
  const open = position + text.slice(position).search(/\S/);
  if (text[open] !== '{') return position;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') depth -= 1;
    if (depth === 0) return index + 1;
  }
  return text.length;
}

/**
 * Tipos declarados com a tag typedef num texto: o nome e o trecho da declaração. O tipo pode
 * ter chavetas aninhadas e o nome pode vir na linha seguinte, depois do ` * ` do JSDoc.
 * @param {string} text
 * @returns {Array<{name: string, start: number, end: number}>}
 */
function typedefs(text) {
  return [...text.matchAll(TYPEDEF_TAG)].flatMap((match) => {
    const start = (match.index ?? 0) + match[0].indexOf('@');
    const typeEnd = skipType(text, (match.index ?? 0) + match[0].length);
    const name = TYPEDEF_NAME.exec(text.slice(typeEnd));
    return name ? [{ name: name[1], start, end: typeEnd + name[0].length }] : [];
  });
}

/**
 * Tipos que os ficheiros importam de outros com `import('<caminho>').Nome`, como
 * `<caminho absoluto>#Nome`.
 * @param {Array<[string, string]>} files
 * @returns {Set<string>}
 */
function importedTypes(files) {
  return new Set(files.flatMap(([file, text]) => [...text.matchAll(TYPE_IMPORT)]
    .map((match) => `${path.resolve(ROOT, path.dirname(file), match[1])}#${match[2]}`)));
}

/**
 * Tipos typedef que nem o próprio ficheiro usa nem outro ficheiro importa, como
 * `ficheiro:linha Nome`.
 * @param {string} file caminho relativo à raiz
 * @param {string} text
 * @param {Set<string>} imported resultado de importedTypes
 * @returns {string[]}
 */
function unusedTypedefs(file, text, imported) {
  const self = path.resolve(ROOT, file);
  return typedefs(text)
    .filter(({ name, start, end }) => !mentions(text.slice(0, start) + text.slice(end), name))
    .filter(({ name }) => !imported.has(`${self}#${name}`))
    .map(({ name, start }) => `${file}:${lineOf(text, start)} ${name}`);
}

/**
 * Indica se um identificador aparece num texto como palavra inteira.
 * @param {string} text
 * @param {string} name
 * @returns {boolean}
 */
function mentions(text, name) {
  const escaped = name.replace(/\$/g, '\\$');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(text);
}

/**
 * Árvore sintáctica de um ficheiro JavaScript.
 * @param {TypeScript} ts
 * @param {string} file
 * @param {string} text
 * @returns {SourceFile}
 */
function parse(ts, file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

/**
 * Linha (a começar em 1) de uma posição de um ficheiro já interpretado.
 * @param {SourceFile} source
 * @param {number} position
 * @returns {number}
 */
function lineAt(source, position) {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

/**
 * Nós sem filhos da árvore (os tokens), por ordem, sem os comentários JSDoc: o typescript
 * põe as tags do JSDoc na árvore, mas não são lógica.
 * @param {TypeScript} ts
 * @param {SourceFile} source
 * @returns {TsNode[]}
 */
function leafNodes(ts, source) {
  /** @type {TsNode[]} */
  const found = [];
  const visit = (/** @type {TsNode} */ node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    const children = node.getChildren(source);
    if (children.length === 0) found.push(node);
    children.forEach(visit);
  };
  visit(source);
  return found;
}

/**
 * Tokens com texto, por ordem, com as linhas que ocupam.
 * @param {TypeScript} ts
 * @param {SourceFile} source
 * @returns {Token[]}
 */
function tokens(ts, source) {
  const { SyntaxKind } = ts;
  const closers = new Set([SyntaxKind.CloseBraceToken, SyntaxKind.CloseParenToken,
    SyntaxKind.CloseBracketToken, SyntaxKind.SemicolonToken, SyntaxKind.CommaToken]);
  return leafNodes(ts, source)
    .filter((node) => node.getWidth(source) > 0)
    .map((node) => ({
      start: node.getStart(source),
      end: node.getEnd(),
      firstLine: lineAt(source, node.getStart(source)),
      lastLine: lineAt(source, node.getEnd()),
      closer: closers.has(node.kind),
    }));
}

/**
 * Índice do primeiro token que começa em `position` ou depois (pesquisa binária).
 * @param {Token[]} list tokens por ordem
 * @param {number} position
 * @returns {number}
 */
function firstTokenFrom(list, position) {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (list[middle].start < position) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Linhas de lógica do corpo de uma função: as linhas depois da assinatura com algum token
 * do corpo que não seja só de fecho. Não contam o JSDoc, os comentários, as linhas em
 * branco nem as linhas só com `}`, `)`, `]`, `;` ou `,`.
 * @param {SourceFile} source
 * @param {Token[]} list tokens do ficheiro, por ordem
 * @param {TsNode} body
 * @returns {number}
 */
function logicLineCount(source, list, body) {
  const signature = lineAt(source, body.getStart(source));
  /** @type {Set<number>} */
  const lines = new Set();
  let index = firstTokenFrom(list, body.getStart(source));
  for (; index < list.length && list[index].end <= body.getEnd(); index += 1) {
    const { closer, firstLine, lastLine } = list[index];
    for (let line = Math.max(firstLine, signature + 1); !closer && line <= lastLine; line += 1) {
      lines.add(line);
    }
  }
  return lines.size;
}

/**
 * Indica se a função é o callback de uma chamada que só agrupa testes (`describe`).
 * @param {TypeScript} ts
 * @param {SourceFile} source
 * @param {TsNode} node
 * @returns {boolean}
 */
function isGrouping(ts, source, node) {
  const { parent } = node;
  return ts.isCallExpression(parent) && GROUPING_CALL.test(parent.expression.getText(source));
}

/**
 * Nome de uma função para as mensagens: o seu, o da variável ou propriedade que a guarda,
 * ou "(anónima)".
 * @param {TsNode} node
 * @param {SourceFile} source
 * @returns {string}
 */
function functionName(node, source) {
  const own = /** @type {{name?: TsNode}} */ (node).name;
  const holder = /** @type {{name?: TsNode}} */ (node.parent).name;
  return (own ?? holder)?.getText(source) ?? '(anónima)';
}

/**
 * Funções com mais linhas de lógica do que o máximo, como `ficheiro:linha nome (n)`.
 * @type {SourceCheck}
 */
function longFunctions(ts, file, source) {
  const list = tokens(ts, source);
  /** @type {string[]} */
  const found = [];
  const visit = (/** @type {TsNode} */ node) => {
    const body = ts.isFunctionLike(node) ? /** @type {{body?: TsNode}} */ (node).body : undefined;
    const count = body && !isGrouping(ts, source, node) ? logicLineCount(source, list, body) : 0;
    if (count > MAX_LOGIC_LINES) {
      const line = lineAt(source, node.getStart(source));
      found.push(`${file}:${line} ${functionName(node, source)} (${count})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Comentários de um ficheiro, com a linha onde começam. Cada comentário fica antes de um
 * token, ou depois do último, por isso lêem-se os comentários à volta de cada token.
 * @param {TypeScript} ts
 * @param {SourceFile} source
 * @returns {Located[]}
 */
function comments(ts, source) {
  const text = source.getFullText();
  /** @type {Map<number, Located>} */
  const found = new Map();
  for (const node of leafNodes(ts, source)) {
    for (const position of [node.pos, node.end]) {
      for (const range of ts.getLeadingCommentRanges(text, position) ?? []) {
        const line = lineAt(source, range.pos);
        found.set(range.pos, { line, text: text.slice(range.pos, range.end) });
      }
    }
  }
  return [...found.values()];
}

/**
 * Textos das strings e dos templates de um ficheiro, com a linha onde começam.
 * @param {TypeScript} ts
 * @param {SourceFile} source
 * @returns {Located[]}
 */
function strings(ts, source) {
  /** @type {Located[]} */
  const found = [];
  const visit = (/** @type {TsNode} */ node) => {
    if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) {
      found.push({ line: lineAt(source, node.getStart(source)), text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Títulos dos testes e dos grupos de testes de um ficheiro, com a linha onde começam.
 * @param {TypeScript} ts
 * @param {SourceFile} source
 * @returns {Located[]}
 */
function testTitles(ts, source) {
  /** @type {Located[]} */
  const found = [];
  const visit = (/** @type {TsNode} */ node) => {
    const call = ts.isCallExpression(node) && TEST_CALL.test(node.expression.getText(source));
    const title = call ? /** @type {import('typescript').CallExpression} */ (node).arguments[0]
      : undefined;
    if (title && ts.isStringLiteralLike(title)) {
      found.push({ line: lineAt(source, title.getStart(source)), text: title.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Formas do Acordo encontradas nos textos de um ficheiro, como `ficheiro:linha palavra`.
 * @param {string} file
 * @param {Located[]} texts
 * @returns {string[]}
 */
function postAgreementForms(file, texts) {
  return texts.flatMap(({ line, text }) => [...text.matchAll(POST_AGREEMENT_FORMS)]
    .map((match) => `${file}:${line + lineOf(text, match.index ?? 0) - 1} ${match[0]}`));
}

/**
 * Aplica uma verificação à árvore sintáctica dos ficheiros JavaScript de algumas pastas.
 * @param {string[]} dirs pastas relativas à raiz
 * @param {SourceCheck} check
 * @returns {Promise<string[]>} problemas encontrados
 */
async function scanJavaScript(dirs, check) {
  const ts = typescript();
  const files = (await javaScriptFiles()).filter(([file]) => dirs.includes(topDir(file)));
  return files.flatMap(([file, text]) => check(ts, file, parse(ts, file, text)));
}

/**
 * Aplica uma verificação a um exemplo de código, como se fosse o ficheiro `exemplo.js`.
 * @param {SourceCheck} check
 * @param {string[]} lines linhas do exemplo
 * @returns {string[]}
 */
function checkSample(check, lines) {
  const ts = typescript();
  return check(ts, 'exemplo.js', parse(ts, 'exemplo.js', lines.join('\n')));
}

/**
 * Função de exemplo com `count` linhas de lógica, e ainda JSDoc, um comentário, uma linha
 * em branco e linhas só de fecho, que não contam.
 * @param {number} count
 * @returns {string[]}
 */
function sampleFunction(count) {
  const statements = Array.from({ length: count - 3 }, (_, index) => `  total += ${index};`);
  return [
    '/** @returns {number} */',
    'function exemplo() {',
    '  /** @type {number} */',
    '  let total = 0;',
    '  // comentário',
    '',
    ...statements,
    '  [1].forEach((value) => {',
    '  });',
    '  return total;',
    '}',
  ];
}

/**
 * Comentário de exemplo com a palavra dada.
 * @type {(word: string) => string[]}
 */
const commentWith = (word) => ['// @ts-check', `// um ${word} de exemplo`, 'export {};'];

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
  test('todos os ficheiros JavaScript declaram // @ts-check', async () => {
    const offenders = (await javaScriptFiles())
      .filter(([, text]) => !declaresTsCheck(text))
      .map(([file]) => file);

    assert.deepEqual(offenders, []);
  });

  test('todos os ficheiros JavaScript estao em src, bin ou test', async () => {
    const offenders = (await javaScriptFiles())
      .map(([file]) => file)
      .filter((file) => !TYPECHECKED_DIRS.includes(topDir(file)));

    assert.deepEqual(offenders, []);
  });

  test('o tsconfig verifica src, bin e test', async () => {
    const { include } = JSON.parse(await readFile(path.join(ROOT, 'tsconfig.json'), 'utf8'));
    const expected = TYPECHECKED_DIRS.map((dir) => `${dir}/**/*.js`);

    assert.deepEqual(expected.filter((pattern) => !include.includes(pattern)), []);
  });

  test('a directiva pode vir na segunda linha, depois de um shebang', () => {
    assert.ok(declaresTsCheck(`#!/usr/bin/env node\n${TS_CHECK}\n`));
  });

  test('nenhum @typedef fica por usar', async () => {
    const files = await javaScriptFiles();
    const imported = importedTypes(files);
    const offenders = files.flatMap(([file, text]) => unusedTypedefs(file, text, imported));

    assert.deepEqual(offenders, []);
  });

  test('um @typedef de um import que o ficheiro nao usa e detectado', () => {
    const text = `/** @${'typedef'} {import('./a.js').Coisa} Coisa */\nexport const x = 1;\n`;

    assert.deepEqual(unusedTypedefs('b.js', text, new Set()), ['b.js:1 Coisa']);
  });

  test('um @typedef com o nome na linha seguinte e usado no ficheiro nao e detectado', () => {
    const declaration = `/**\n * @${'typedef'} {Pick<A, 'b'|'c'>}\n *   Coisa\n */\n`;
    const text = `${declaration}/** @type {Coisa} */\n`;

    assert.deepEqual(unusedTypedefs('b.js', text, new Set()), []);
  });

  test('um @typedef que outro ficheiro importa nao e detectado', () => {
    const text = `/** @${'typedef'} {object} Coisa */\nexport {};\n`;
    const imported = importedTypes([['test/c.js', "/** @type {import('./b.js').Coisa} */"]]);

    assert.deepEqual(unusedTypedefs(path.join('test', 'b.js'), text, imported), []);
  });
});

describe('tamanho das funcoes', () => {
  test('nenhuma funcao passa de 15 linhas de logica', { skip: NO_TYPESCRIPT }, async () => {
    assert.deepEqual(await scanJavaScript(TYPECHECKED_DIRS, longFunctions), []);
  });

  test('uma funcao com 16 linhas de logica e detectada', { skip: NO_TYPESCRIPT }, () => {
    assert.deepEqual(checkSample(longFunctions, sampleFunction(16)), ['exemplo.js:2 exemplo (16)']);
  });

  test('JSDoc, comentarios, linhas em branco e fechos nao contam', { skip: NO_TYPESCRIPT }, () => {
    assert.deepEqual(checkSample(longFunctions, sampleFunction(15)), []);
  });

  test('o callback de describe nao conta como funcao', { skip: NO_TYPESCRIPT }, () => {
    const tests = Array.from({ length: 20 }, (_, index) => `  test('t${index}', () => {});`);

    assert.deepEqual(checkSample(longFunctions, ['describe(\'g\', () => {', ...tests, '});']), []);
  });
});

describe('grafia portuguesa', () => {
  test('nenhum comentario usa a grafia do Acordo Ortografico de 1990', { skip: NO_TYPESCRIPT },
    async () => {
      const check = /** @type {SourceCheck} */ ((ts, file, source) => (
        postAgreementForms(file, comments(ts, source))));

      assert.deepEqual(await scanJavaScript(TYPECHECKED_DIRS, check), []);
    });

  test('nenhuma mensagem de src usa a grafia do Acordo Ortografico de 1990',
    { skip: NO_TYPESCRIPT }, async () => {
      const check = /** @type {SourceCheck} */ ((ts, file, source) => (
        postAgreementForms(file, strings(ts, source))));

      assert.deepEqual(await scanJavaScript(['src', 'bin'], check), []);
    });

  test('nenhum titulo de teste usa a grafia do Acordo Ortografico de 1990',
    { skip: NO_TYPESCRIPT }, async () => {
      const check = /** @type {SourceCheck} */ ((ts, file, source) => (
        postAgreementForms(file, testTitles(ts, source))));

      assert.deepEqual(await scanJavaScript(['test'], check), []);
    });

  test('uma forma do Acordo num comentario e detectada', { skip: NO_TYPESCRIPT }, () => {
    const check = /** @type {SourceCheck} */ ((ts, file, source) => (
      postAgreementForms(file, comments(ts, source))));

    assert.deepEqual(checkSample(check, commentWith('projeto')), ['exemplo.js:2 projeto']);
  });

  test('a grafia anterior ao Acordo e as palavras que a contem sao aceites', () => {
    const texts = [{ line: 1, text: 'o projecto actual, a configuração e o project' }];

    assert.deepEqual(postAgreementForms('exemplo.js', texts), []);
  });

  test('as formas do Acordo sao detectadas em maiusculas e no plural', () => {
    const texts = [{ line: 3, text: 'Objetos e\nDIREÇÕES' }];

    assert.deepEqual(postAgreementForms('exemplo.js', texts),
      ['exemplo.js:3 Objetos', 'exemplo.js:4 DIREÇÕES']);
  });
});
