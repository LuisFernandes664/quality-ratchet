// @ts-check
/**
 * Validação dos exemplos publicados: os baselines de exemplo têm de ser aceites pelo
 * núcleo sem avisos, só podem usar formatos e campos que os extractors conhecem, estão na
 * forma exacta que a CLI escreve, e o schema JSON descreve exactamente o que o código aceita.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SCHEMA_URL } from '../src/cli/defaults.js';
import { parseBaseline, serializeBaseline } from '../src/core/baseline.js';
import { EXTRACTORS, listFormats } from '../src/extractors/index.js';

/** Raiz do repositório. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Pasta dos baselines de exemplo. */
const BASELINES_DIR = path.join(ROOT, 'examples', 'baselines');

/** Pasta dos workflows de exemplo, um por baseline com o mesmo nome. */
const WORKFLOWS_DIR = path.join(ROOT, 'examples', 'workflows');

/** Caminho do schema JSON do baseline v2, relativo à raiz do repositório. */
const SCHEMA_FILE = 'schema/baseline.v2.schema.json';

/** Schema JSON do baseline v2. */
const SCHEMA_PATH = path.join(ROOT, SCHEMA_FILE);

/** Fim esperado do `$id` do schema: o ficheiro na tag major `v1`. */
const SCHEMA_ID_SUFFIX = `/quality-ratchet/raw/v1/${SCHEMA_FILE}`;

/** Exemplos que o README promete. */
const EXPECTED_EXAMPLES = ['dotnet.json', 'node.json', 'python.json'];

/** Métrica com todos os campos do formato v2, usada para comparar com o schema. */
const FULL_METRIC = Object.freeze({
  value: 10,
  direction: 'up',
  tolerance: 0.5,
  min: 5,
  max: 20,
  target: 15,
  description: 'exemplo',
  source: { format: 'json', path: 'report.json', pointer: '/total' },
});

/** Raiz com todos os campos do formato v2, usada para comparar com o schema. */
const FULL_ROOT = Object.freeze({
  $schema: 'schema.json',
  version: 2,
  frozen_at: '2026-09-27',
  metrics: { exemplo: FULL_METRIC },
});

/**
 * @typedef {object} SchemaNode
 * @property {Record<string, SchemaNode>} [properties]
 * @property {unknown[]} [enum]
 * @property {unknown} [const]
 * @property {string} [$id]
 * @property {string[]} [required]
 * @property {Array<{if: SchemaNode, then: SchemaNode}>} [allOf]
 * @property {Record<string, SchemaNode>} [definitions]
 */

/**
 * @typedef {object} RawSource
 * @property {string} format
 * @property {string} path
 * @property {string} [field]
 */

/**
 * @typedef {object} Example
 * @property {string} file nome do ficheiro (ex: 'node.json')
 * @property {string} text conteúdo tal como está no disco
 * @property {any} raw JSON interpretado
 */

/**
 * Lê e interpreta um ficheiro JSON.
 * @param {string} filePath
 * @returns {Promise<any>}
 */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/**
 * Baselines de exemplo, por nome de ficheiro.
 * @returns {Promise<Example[]>}
 */
async function loadExamples() {
  const files = (await readdir(BASELINES_DIR)).filter((file) => file.endsWith('.json'));
  const read = (/** @type {string} */ file) => readFile(path.join(BASELINES_DIR, file), 'utf8');
  const texts = await Promise.all(files.map(read));
  return files.map((file, index) => ({ file, text: texts[index], raw: JSON.parse(texts[index]) }));
}

/**
 * Sources de um exemplo, com a identificação da métrica.
 * @param {Example} example
 * @returns {Array<{where: string, source: RawSource}>}
 */
function sourcesOf({ file, raw }) {
  return Object.entries(raw.metrics)
    .filter(([, metric]) => metric.source !== undefined)
    .map(([name, metric]) => ({ where: `${file}:${name}`, source: metric.source }));
}

/**
 * Todas as sources dos exemplos, com a identificação da métrica.
 * @returns {Promise<Array<{where: string, source: RawSource}>>}
 */
async function exampleSources() {
  return (await loadExamples()).flatMap(sourcesOf);
}

/**
 * Lê o schema e devolve as definições da métrica e da source.
 * @returns {Promise<{schema: SchemaNode, metric: SchemaNode, source: SchemaNode}>}
 */
async function loadSchema() {
  /** @type {SchemaNode} */
  const schema = await readJson(SCHEMA_PATH);
  const definitions = schema.definitions ?? {};
  return { schema, metric: definitions.metric, source: definitions.source };
}

/**
 * Campos por formato declarados nos blocos `if/then` da source do schema.
 * @param {SchemaNode} source
 * @returns {Record<string, unknown[]>}
 */
function schemaFieldsByFormat(source) {
  const entries = (source.allOf ?? []).map((rule) => [
    rule.if.properties?.format.const,
    rule.then.properties?.field.enum,
  ]);
  return Object.fromEntries(entries);
}

/**
 * Nomes das propriedades de um nó do schema, ordenados.
 * @param {SchemaNode} node
 * @returns {string[]}
 */
function propertyNames(node) {
  return Object.keys(node.properties ?? {}).sort();
}

/**
 * Texto que os comandos `update` e `migrate`, e o input write-baseline, escreveriam para
 * o mesmo baseline: JSON indentado a dois espaços, terminado com fim de linha.
 * @param {unknown} raw
 * @returns {string}
 */
function canonicalText(raw) {
  return `${JSON.stringify(serializeBaseline(parseBaseline(raw)), null, 2)}\n`;
}

describe('baselines de exemplo', () => {
  test('existem os exemplos de dotnet, node e python', async () => {
    const files = (await loadExamples()).map(({ file }) => file).sort();

    assert.deepEqual(files, EXPECTED_EXAMPLES);
  });

  test('cada exemplo passa parseBaseline sem avisos', async () => {
    for (const { file, raw } of await loadExamples()) {
      const baseline = parseBaseline(raw);

      assert.deepEqual(baseline.warnings, [], file);
    }
  });

  test('cada exemplo esta na forma exacta que o update escreve', async () => {
    for (const { file, text, raw } of await loadExamples()) {
      assert.equal(text, canonicalText(raw), file);
    }
  });

  test('nenhum exemplo tem um $schema que deixa de funcionar quando copiado', async () => {
    const withSchema = (await loadExamples()).filter(({ raw }) => raw.$schema !== undefined);
    for (const { file, raw } of withSchema) {
      assert.equal(raw.$schema, SCHEMA_URL, file);
    }
  });

  test('cada source usa um formato que existe em EXTRACTORS', async () => {
    for (const { where, source } of await exampleSources()) {
      assert.ok(Object.hasOwn(EXTRACTORS, source.format), `${where}: ${source.format}`);
    }
  });

  test('o field de cada source e um campo do seu formato', async () => {
    const withField = (await exampleSources()).filter(({ source }) => source.field);
    for (const { where, source } of withField) {
      const fields = EXTRACTORS[source.format].fields;

      assert.ok(fields.includes(String(source.field)), `${where}: ${source.field}`);
    }
  });

  test('as sources so usam campos previstos no schema', async () => {
    const { source: schemaSource } = await loadSchema();
    const allowed = propertyNames(schemaSource);
    for (const { where, source } of await exampleSources()) {
      const unknown = Object.keys(source).filter((key) => !allowed.includes(key));

      assert.deepEqual(unknown, [], where);
    }
  });

  test('o workflow de cada exemplo produz os relatorios que o baseline le', async () => {
    for (const example of await loadExamples()) {
      const workflowName = example.file.replace(/\.json$/, '.yml');
      const workflow = await readFile(path.join(WORKFLOWS_DIR, workflowName), 'utf8');
      const absent = sourcesOf(example).filter(({ source }) => !workflow.includes(source.path));

      assert.deepEqual(absent, [], workflowName);
    }
  });
});

describe('schema do baseline v2', () => {
  test('o schema e JSON valido', async () => {
    const text = await readFile(SCHEMA_PATH, 'utf8');

    assert.doesNotThrow(() => JSON.parse(text));
  });

  test('o enum de formatos coincide com listFormats()', async () => {
    const { source } = await loadSchema();

    assert.deepEqual(source.properties?.format.enum, listFormats());
  });

  test('os campos de cada formato coincidem com os do extractor', async () => {
    const { source } = await loadSchema();
    const expected = Object.fromEntries(
      Object.values(EXTRACTORS).map((extractor) => [extractor.format, extractor.fields]),
    );

    assert.deepEqual(schemaFieldsByFormat(source), expected);
  });

  test('a metrica com todos os campos do schema passa parseBaseline sem avisos', () => {
    const baseline = parseBaseline(FULL_ROOT);

    assert.deepEqual(baseline.warnings, []);
  });

  test('as propriedades da metrica no schema sao as da metrica completa', async () => {
    const { metric } = await loadSchema();

    assert.deepEqual(propertyNames(metric), Object.keys(FULL_METRIC).sort());
  });

  test('as propriedades da raiz no schema sao as da raiz completa', async () => {
    const { schema } = await loadSchema();

    assert.deepEqual(propertyNames(schema), Object.keys(FULL_ROOT).sort());
  });

  test('a metrica exige value e direction', async () => {
    const { metric } = await loadSchema();

    assert.deepEqual(metric.required, ['value', 'direction']);
  });

  test('o formato json exige pointer', async () => {
    const { source } = await loadSchema();
    const rule = (source.allOf ?? []).find((item) => item.if.properties?.format.const === 'json');

    assert.deepEqual(rule?.then.required, ['pointer']);
  });

  test('o $id aponta para o schema na tag v1', async () => {
    const { schema } = await loadSchema();

    assert.ok(String(schema.$id).endsWith(SCHEMA_ID_SUFFIX), String(schema.$id));
  });

  test('o $schema gravado pela CLI aponta para este ficheiro na tag v1', () => {
    assert.ok(SCHEMA_URL.endsWith(`/v1/${SCHEMA_FILE}`), SCHEMA_URL);
  });
});
