// @ts-check
/**
 * Valores por omissão e constantes da CLI. Os valores por omissão são os mesmos da action,
 * para que um projecto possa correr a catraca localmente e no CI sem configurar nada.
 */

/** Valores por omissão das opções. */
export const DEFAULTS = Object.freeze({
  baseline: 'quality-baseline.json',
  metrics: 'metrics-current.json',
  bypassLabel: 'hotfix-bypass-ratchet',
  lowerBaselinePattern: '^chore(\\([^)]*\\))?: lower baseline',
  language: 'en',
  format: 'markdown',
});

/** Formatos de saída do comando `check`. */
export const OUTPUT_FORMATS = Object.freeze(['markdown', 'json']);

/** Schema JSON do baseline v2, gravado em `$schema` pelos comandos `init` e `migrate`. */
export const SCHEMA_URL = 'https://raw.githubusercontent.com/LuisFernandes664/quality-ratchet/'
  + 'v2/schema/baseline.v2.schema.json';

/** Códigos de saída do processo. */
export const EXIT = Object.freeze({
  /** a catraca passou, ou o comando terminou sem problemas */
  ok: 0,
  /** a catraca falhou */
  failed: 1,
  /** erro de utilização ou de configuração */
  usage: 2,
});
