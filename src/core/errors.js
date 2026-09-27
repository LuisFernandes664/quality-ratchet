// @ts-check
/**
 * Excepções específicas do projecto. Cada erro transporta um código e parâmetros,
 * e a mensagem legível é produzida pelo catálogo de mensagens na língua escolhida.
 */

/** Erro base. O código identifica a entrada no catálogo de mensagens. */
export class RatchetError extends Error {
  /**
   * @param {string} code código da mensagem no catálogo
   * @param {Record<string, unknown>} [params] valores a interpolar na mensagem
   */
  constructor(code, params = {}) {
    super(`${code} ${JSON.stringify(params)}`);
    this.name = new.target.name;
    this.code = code;
    this.params = params;
  }
}

/** Configuração inválida: inputs da action, opções da CLI, padrões. */
export class ConfigError extends RatchetError {}

/** Ficheiro de baseline ilegível ou com estrutura inválida. */
export class BaselineError extends RatchetError {}

/** Ficheiro de métricas ilegível ou incoerente com o baseline. */
export class MetricsError extends RatchetError {}

/** Relatório de uma ferramenta que não foi possível interpretar. */
export class ExtractorError extends RatchetError {}

/** Resposta de erro da API do GitHub (ou compatível). */
export class GitHubApiError extends RatchetError {
  /**
   * @param {string} code código da mensagem no catálogo
   * @param {Record<string, unknown>} params valores a interpolar na mensagem
   * @param {number} status código HTTP devolvido
   */
  constructor(code, params, status) {
    super(code, params);
    this.status = status;
  }
}
