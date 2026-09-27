// @ts-check
/**
 * Utilitários comuns aos extractors de relatórios: construção de extractors, leitura de JSON,
 * percentagens, JSON Pointer (RFC 6901) e contagem de elementos XML.
 */

import { ExtractorError } from '../core/errors.js';
import { isFiniteNumber, isPlainObject } from '../core/guards.js';

/** @typedef {import('../core/types.js').MetricSource} MetricSource */

/**
 * Extractor de um formato de relatório.
 * @typedef {object} Extractor
 * @property {string} format identificador do formato (ex: 'lcov')
 * @property {string[]} fields campos suportados, com o campo por omissão em primeiro
 * @property {string} defaultField campo usado quando a origem não indica nenhum
 * @property {(text: string, source: MetricSource) => number} extract lê o valor do relatório
 */

/**
 * Pedido entregue à função de leitura de um formato, com o campo já validado.
 * @typedef {object} ReadRequest
 * @property {string} field
 * @property {MetricSource} source
 */

/**
 * Especificação a partir da qual se constrói um extractor.
 * @typedef {object} ExtractorSpec
 * @property {string} format
 * @property {string[]} fields o primeiro é o campo por omissão
 * @property {(text: string, request: ReadRequest) => number} read
 */

/**
 * Resultado da resolução de um JSON Pointer.
 * @typedef {{found: true, value: unknown} | {found: false}} PointerTarget
 */

/** Índice de array válido segundo a RFC 6901: sem zeros à esquerda nem sinal. */
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

/** Número decimal estrito: sem espaços, sem hexadecimal e sem texto adicional. */
const STRICT_NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/** Comentários, secções CDATA e instruções de processamento de um documento XML. */
const XML_NOISE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g;

/** Caracteres com significado especial numa expressão regular. */
const REGEXP_SPECIAL = /[\\^$.*+?()[\]{}|]/g;

/** Marca de ordem de bytes (BOM) que alguns editores e ferramentas escrevem no início. */
const BYTE_ORDER_MARK = /^\uFEFF/;

/**
 * Constrói um extractor imutável que valida o texto e o campo e garante um valor finito.
 * @param {ExtractorSpec} spec
 * @returns {Extractor}
 */
export function defineExtractor(spec) {
  const fields = [...spec.fields];
  Object.freeze(fields);
  /** @type {Extractor} */
  const extractor = {
    format: spec.format,
    fields,
    defaultField: fields[0],
    extract: (text, source) => {
      const field = resolveField(extractor, source);
      const value = spec.read(requireText(text, spec.format), { field, source });
      return ensureFinite(value, spec.format);
    },
  };
  return Object.freeze(extractor);
}

/**
 * Devolve o campo pedido pela origem ou, se omitido, o campo por omissão do extractor.
 * @param {Extractor} extractor
 * @param {MetricSource} source
 * @returns {string}
 * @throws {ExtractorError} extractor_field_unknown quando o formato não tem o campo
 */
export function resolveField(extractor, source) {
  const field = source.field ?? extractor.defaultField;
  if (extractor.fields.includes(field)) return field;
  throw new ExtractorError('extractor_field_unknown', {
    format: extractor.format,
    field,
    known: extractor.fields.join(', '),
  });
}

/**
 * Garante que o valor extraído é um número finito.
 * @param {unknown} value
 * @param {string} format
 * @returns {number}
 * @throws {ExtractorError} extractor_report_unparseable para NaN, Infinity ou não números
 */
export function ensureFinite(value, format) {
  if (isFiniteNumber(value)) return value;
  throw unparseable(format, `extracted value is not a finite number: ${String(value)}`);
}

/**
 * Cria o erro de relatório impossível de interpretar.
 * @param {string} format
 * @param {string} reason motivo técnico, curto
 * @returns {ExtractorError}
 */
export function unparseable(format, reason) {
  return new ExtractorError('extractor_report_unparseable', { format, reason });
}

/**
 * Cria o erro de relatório sem nada para medir.
 * @param {string} format
 * @returns {ExtractorError}
 */
export function reportEmpty(format) {
  return new ExtractorError('extractor_report_empty', { format });
}

/**
 * Cria o erro de opção da origem inválida.
 * @param {string} format
 * @param {string} option nome da opção em `source` (ex: 'pointer')
 * @param {string} reason
 * @returns {ExtractorError}
 */
export function invalidOption(format, option, reason) {
  return new ExtractorError('extractor_option_invalid', { format, option, reason });
}

/**
 * Remove a marca de ordem de bytes inicial e garante que o relatório tem conteúdo. Um
 * ficheiro vazio (ex: a ferramenta falhou depois de a shell o ter criado) não tem nada
 * para medir.
 * @param {string} text
 * @param {string} format
 * @returns {string} texto sem a marca de ordem de bytes
 * @throws {ExtractorError} extractor_report_empty quando só há espaços em branco
 */
export function requireContent(text, format) {
  const content = text.replace(BYTE_ORDER_MARK, '');
  if (content.trim() === '') throw reportEmpty(format);
  return content;
}

/**
 * Interpreta o texto de um relatório JSON, tolerando a marca de ordem de bytes inicial.
 * @param {string} text
 * @param {string} format
 * @returns {unknown}
 * @throws {ExtractorError} extractor_report_empty quando o ficheiro está vazio e
 *   extractor_report_unparseable quando o JSON é inválido
 */
export function parseJson(text, format) {
  const content = requireContent(text, format);
  try {
    return JSON.parse(content);
  } catch (cause) {
    const error = unparseable(format, cause instanceof Error ? cause.message : String(cause));
    error.cause = cause;
    throw error;
  }
}

/**
 * Lê um valor aninhado num documento JSON, seguindo apenas propriedades próprias.
 * @param {unknown} document
 * @param {string[]} path chaves a seguir, da raiz para o valor
 * @param {string} format
 * @returns {unknown}
 * @throws {ExtractorError} extractor_report_unparseable quando falta alguma chave
 */
export function readPath(document, path, format) {
  let current = document;
  for (const key of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) {
      throw unparseable(format, `missing "${path.join('.')}"`);
    }
    current = current[key];
  }
  return current;
}

/**
 * Lê um número finito aninhado num documento JSON.
 * @param {unknown} document
 * @param {string[]} path
 * @param {string} format
 * @returns {number}
 * @throws {ExtractorError} extractor_report_unparseable quando falta ou não é finito
 */
export function readNumber(document, path, format) {
  const value = readPath(document, path, format);
  if (isFiniteNumber(value)) return value;
  throw unparseable(format, `"${path.join('.')}" is not a finite number`);
}

/**
 * Lê uma contagem (inteiro não negativo) aninhada num documento JSON.
 * @param {unknown} document
 * @param {string[]} path
 * @param {string} format
 * @returns {number}
 * @throws {ExtractorError} extractor_report_unparseable quando falta ou não é uma contagem
 */
export function readCount(document, path, format) {
  const value = readPath(document, path, format);
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  throw unparseable(format, `"${path.join('.')}" is not a non-negative integer`);
}

/**
 * Calcula uma percentagem entre 0 e 100, sem arredondamento. Multiplica antes de dividir
 * para que o resultado seja o número mais próximo do valor exacto (57/100 dá 57 e não
 * 56.99999999999999).
 * @param {number} hit parte atingida
 * @param {number} total denominador
 * @param {string} format
 * @returns {number}
 * @throws {ExtractorError} extractor_report_empty quando o denominador é 0 e
 *   extractor_report_unparseable quando a parte excede o total
 */
export function percentage(hit, total, format) {
  if (total === 0) throw reportEmpty(format);
  if (hit > total) throw unparseable(format, `hit count ${hit} exceeds total ${total}`);
  return (hit * 100) / total;
}

/**
 * Converte uma string numérica estrita (ex: "0.85", "-3", "1e2") em número.
 * @param {string} text
 * @returns {number|null} null quando a string não é estritamente numérica
 */
export function parseStrictNumber(text) {
  return STRICT_NUMBER.test(text) ? Number(text) : null;
}

/**
 * Converte um JSON Pointer (RFC 6901) na lista de tokens de referência, já sem escapes.
 * @param {unknown} pointer valor de `source.pointer`
 * @param {string} format
 * @returns {string[]} lista vazia para o ponteiro "" (documento inteiro)
 * @throws {ExtractorError} extractor_option_invalid quando falta ou é inválido
 */
export function parsePointer(pointer, format) {
  if (pointer === undefined || pointer === null) {
    throw invalidOption(format, 'pointer', 'missing');
  }
  if (typeof pointer !== 'string') throw invalidOption(format, 'pointer', 'must be a string');
  if (pointer !== '' && !pointer.startsWith('/')) {
    throw invalidOption(format, 'pointer', `"${pointer}" must be empty or start with "/"`);
  }
  if (/~(?![01])/.test(pointer)) {
    throw invalidOption(format, 'pointer', `"${pointer}" has "~" not followed by "0" or "1"`);
  }
  return pointer === '' ? [] : pointer.slice(1).split('/').map(unescapeToken);
}

/**
 * Desfaz os escapes de um token: primeiro "~1" para "/", depois "~0" para "~".
 * @param {string} token
 * @returns {string}
 */
function unescapeToken(token) {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

/**
 * Resolve os tokens de um JSON Pointer sobre um documento JSON.
 * @param {unknown} document
 * @param {string[]} tokens resultado de parsePointer
 * @returns {PointerTarget}
 */
export function resolvePointer(document, tokens) {
  let current = document;
  for (const token of tokens) {
    const child = childOf(current, token);
    if (!child.found) return child;
    current = child.value;
  }
  return { found: true, value: current };
}

/**
 * Devolve o filho referenciado por um token num array ou objecto.
 * @param {unknown} value
 * @param {string} token
 * @returns {PointerTarget}
 */
function childOf(value, token) {
  if (Array.isArray(value)) {
    const index = ARRAY_INDEX.test(token) ? Number(token) : value.length;
    return index < value.length ? { found: true, value: value[index] } : { found: false };
  }
  if (isPlainObject(value) && Object.hasOwn(value, token)) {
    return { found: true, value: value[token] };
  }
  return { found: false };
}

/**
 * Remove de um documento XML os comentários, as secções CDATA e as instruções de
 * processamento, para que o texto nelas contido não seja confundido com elementos.
 * @param {string} xml
 * @returns {string}
 */
export function stripXmlNoise(xml) {
  return xml.replace(XML_NOISE, '');
}

/**
 * Conta as tags de abertura e as auto-fechadas de um elemento XML (ex: `<testcase>` e
 * `<testcase/>`). Ignora tags de fecho, elementos com nome mais longo e o texto de
 * comentários e CDATA.
 * @param {string} xml
 * @param {string} name nome do elemento
 * @returns {number}
 */
export function countTags(xml, name) {
  const pattern = new RegExp(`<${name.replace(REGEXP_SPECIAL, '\\$&')}(?=[\\s/>])`, 'g');
  return stripXmlNoise(xml).match(pattern)?.length ?? 0;
}

/**
 * Garante que o conteúdo recebido é texto.
 * @param {unknown} text
 * @param {string} format
 * @returns {string}
 */
function requireText(text, format) {
  if (typeof text === 'string') return text;
  throw unparseable(format, 'report content is not text');
}
