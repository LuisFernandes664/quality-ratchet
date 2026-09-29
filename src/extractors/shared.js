// @ts-check
/**
 * Utilitários comuns aos extractors de relatórios: construção de extractors, erros com motivo
 * do catálogo de mensagens, leitura de JSON, percentagens, JSON Pointer (RFC 6901) e
 * leitura de elementos XML (elemento raiz, atributos e contagem de tags).
 */

import { ExtractorError } from '../core/errors.js';
import { isFiniteNumber, isPlainObject } from '../core/guards.js';

/** @typedef {import('../core/types.js').Issue} Issue */
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

/** Primeira tag de abertura bem formada: nome e lista de atributos. */
const XML_START_TAG = /<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/;

/** Atributo XML com valor entre aspas ou plicas. */
const XML_ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Caracteres com significado especial numa expressão regular. */
const REGEXP_SPECIAL = /[\\^$.*+?()[\]{}|]/g;

/** Marca de ordem de bytes (BOM) que alguns editores e ferramentas escrevem no início. */
const BYTE_ORDER_MARK = /^\uFEFF/;

/**
 * Códigos do catálogo de mensagens usados como motivo (`reason`) dos erros dos extractors.
 * O motivo é um Issue traduzido pelo catálogo, para que a mensagem final saia inteira na
 * língua escolhida; só o texto do motor (ex: a mensagem do JSON.parse) segue como string.
 */
export const REASON_CODES = Object.freeze([
  'reason_value_not_finite',
  'reason_key_missing',
  'reason_not_number',
  'reason_not_count',
  'reason_not_array',
  'reason_not_object',
  'reason_not_array_of_objects',
  'reason_not_string',
  'reason_not_text',
  'reason_hit_exceeds_total',
  'reason_pointer_missing',
  'reason_pointer_not_string',
  'reason_pointer_not_absolute',
  'reason_pointer_bad_escape',
  'reason_pointer_not_found',
  'reason_pointer_not_numeric',
  'reason_xml_no_element',
  'reason_xml_root',
  'reason_attribute_missing',
  'reason_attribute_not_number',
  'reason_attribute_not_count',
  'reason_attribute_out_of_range',
  'reason_junit_no_suite',
  'reason_trx_no_counters',
  'reason_lcov_no_record',
  'reason_lcov_invalid_value',
  'reason_levels_invalid',
  'reason_level_unknown',
  'reason_severity_unknown',
  'reason_rules_invalid',
  'reason_sarif_version',
  'reason_sarif_version_missing',
  'reason_sarif_execution_failed',
  'reason_eslint_not_array',
  'reason_stylelint_not_array',
  'reason_stylelint_invalid_options',
  'reason_npm_audit_failed',
  'reason_dotnet_list_errors',
  'reason_dotnet_not_vulnerable',
  'reason_mutant_status_unknown',
]);

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
  throw unparseable(format, because('reason_value_not_finite', { value: String(value) }));
}

/**
 * Cria o motivo de um erro, identificado por um código do catálogo de mensagens
 * (ver REASON_CODES).
 * @param {string} code
 * @param {Record<string, unknown>} [params]
 * @returns {Issue}
 */
export function because(code, params = {}) {
  return { code, params };
}

/**
 * Cria o erro de relatório impossível de interpretar.
 * @param {string} format
 * @param {Issue|string} reason motivo: um Issue do catálogo ou, só para texto do motor
 *   (ex: JSON.parse), a mensagem original
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
 * @param {Issue} reason
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
      throw unparseable(format, because('reason_key_missing', { path: path.join('.') }));
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
  throw unparseable(format, because('reason_not_number', { path: path.join('.') }));
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
  if (isCount(value)) return value;
  throw unparseable(format, because('reason_not_count', { path: path.join('.') }));
}

/**
 * Indica se o valor é uma contagem: um inteiro seguro não negativo.
 * @param {unknown} value
 * @returns {value is number}
 */
export function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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
  if (hit > total) throw unparseable(format, because('reason_hit_exceeds_total', { hit, total }));
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
    throw invalidOption(format, 'pointer', because('reason_pointer_missing'));
  }
  if (typeof pointer !== 'string') {
    throw invalidOption(format, 'pointer', because('reason_pointer_not_string'));
  }
  if (pointer !== '' && !pointer.startsWith('/')) {
    throw invalidOption(format, 'pointer', because('reason_pointer_not_absolute', { pointer }));
  }
  if (/~(?![01])/.test(pointer)) {
    throw invalidOption(format, 'pointer', because('reason_pointer_bad_escape', { pointer }));
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
 * Localiza o elemento raiz de um documento XML, depois da declaração XML, do DOCTYPE e de
 * comentários, e exige o nome esperado.
 * @param {string} xml
 * @param {string} expected nome do elemento raiz
 * @param {string} format
 * @returns {Map<string, string>} atributos do elemento raiz
 * @throws {ExtractorError} extractor_report_unparseable quando não há nenhum elemento ou a
 *   raiz tem outro nome
 */
export function rootAttributes(xml, expected, format) {
  const match = XML_START_TAG.exec(stripXmlNoise(xml));
  if (!match) throw unparseable(format, because('reason_xml_no_element'));
  const [, name, attributes] = match;
  if (name !== expected) {
    throw unparseable(format, because('reason_xml_root', { found: name, expected }));
  }
  return parseAttributes(attributes);
}

/**
 * Atributos de cada tag de abertura ou auto-fechada de um elemento XML, pela ordem do
 * documento. Como em countTags, ignora os elementos com nome mais longo e o texto de
 * comentários e de CDATA. Os valores dos atributos podem ter `>`.
 * @param {string} xml
 * @param {string} name nome do elemento
 * @returns {Map<string, string>[]}
 */
export function tagAttributes(xml, name) {
  const element = name.replace(REGEXP_SPECIAL, '\\$&');
  const pattern = new RegExp(`<${element}(?=[\\s/>])((?:"[^"]*"|'[^']*'|[^'">])*)>`, 'g');
  return [...stripXmlNoise(xml).matchAll(pattern)].map((match) => parseAttributes(match[1]));
}

/**
 * Converte a lista de atributos de uma tag num mapa nome -> valor.
 * @param {string} source
 * @returns {Map<string, string>}
 */
function parseAttributes(source) {
  /** @type {Map<string, string>} */
  const attributes = new Map();
  for (const [, name, doubleQuoted, singleQuoted] of source.matchAll(XML_ATTRIBUTE)) {
    attributes.set(name, doubleQuoted ?? singleQuoted);
  }
  return attributes;
}

/**
 * Garante que o conteúdo recebido é texto.
 * @param {unknown} text
 * @param {string} format
 * @returns {string}
 */
function requireText(text, format) {
  if (typeof text === 'string') return text;
  throw unparseable(format, because('reason_not_text'));
}
