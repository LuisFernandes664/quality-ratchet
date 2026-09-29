// @ts-check
/**
 * Tipos partilhados entre o núcleo, a action e a CLI. Este módulo não exporta valores:
 * serve apenas de fonte de definições de tipos para o typecheck.
 */

/** @typedef {'up'|'down'} Direction */

/**
 * Problema detectado, com código do catálogo de mensagens.
 * @typedef {object} Issue
 * @property {string} code
 * @property {Record<string, unknown>} params
 */

/**
 * Origem automática do valor de uma métrica: um relatório de uma ferramenta.
 * @typedef {object} MetricSource
 * @property {string} format formato do relatório (ex: 'lcov', 'sarif')
 * @property {string} path caminho do relatório, relativo à pasta do baseline
 * @property {string} [field] campo do formato (ex: 'lines', 'branches')
 * @property {string} [pointer] JSON Pointer, só para o formato 'json'
 * @property {string[]} [levels] níveis SARIF a contar
 * @property {string[]} [rules] identificadores de regras SARIF a contar
 */

/**
 * Contrato de uma métrica.
 * @typedef {object} MetricRule
 * @property {string} name
 * @property {number|null} value valor congelado; null só em fluxos de init/update
 * @property {Direction} direction 'up' só pode subir, 'down' só pode descer
 * @property {number} tolerance margem absoluta de ruído aceite, >= 0
 * @property {number} [min] limite absoluto inferior
 * @property {number} [max] limite absoluto superior
 * @property {number} [target] objectivo, apenas informativo
 * @property {MetricSource|MetricSource[]} [source] relatório, ou vários cujos valores se somam
 * @property {'fail'|'skip'} [whenMissing] 'skip': sem medição, a métrica não é verificada
 * @property {string} [description] texto livre, apenas informativo
 * @property {Record<string, unknown>} [extra] campos desconhecidos, mantidos ao reescrever
 */

/**
 * Baseline normalizado, independente do formato do ficheiro.
 * @typedef {object} Baseline
 * @property {1|2} version formato original do ficheiro
 * @property {string} [frozenAt]
 * @property {string} [schema] valor original de "$schema"
 * @property {Record<string, unknown>} [extra] campos desconhecidos da raiz, mantidos ao
 *   reescrever
 * @property {boolean} [versionDeclared] (v1) o ficheiro declarava `version`
 * @property {string[]} [valueOrder] (v1) ordem original das chaves de `metrics`
 * @property {MetricRule[]} metrics por ordem de declaração
 * @property {Record<string, unknown>} untracked valores do v1 sem regra associada
 * @property {Issue[]} warnings
 */

/**
 * Valor medido nesta execução para uma métrica.
 * @typedef {object} Measurement
 * @property {unknown} [value] valor bruto (número ou string numérica)
 * @property {Issue} [error] motivo pelo qual não há valor
 * @property {'file'|'source'} origin
 */

/**
 * @typedef {'improved'|'unchanged'|'tolerated'|'regressed'|'missing'|'invalid'|'limit'
 *   |'skipped'} MetricStatus
 */

/**
 * Resultado da comparação de uma métrica.
 * @typedef {object} MetricResult
 * @property {string} name
 * @property {Direction} direction
 * @property {number|null} before
 * @property {number|null} after
 * @property {number|null} delta
 * @property {number} tolerance
 * @property {number} [target]
 * @property {MetricStatus} status
 * @property {Issue} [detail]
 */

/**
 * Resultado da comparação de todas as métricas.
 * @typedef {object} Outcome
 * @property {MetricResult[]} results
 * @property {MetricResult[]} failures regressed, missing, invalid ou limit
 * @property {MetricResult[]} improvements
 * @property {MetricResult[]} unlocked melhorias por fixar no baseline (modo estrito)
 * @property {boolean} passed
 */

/**
 * 'changed' é uma alteração só a campos informativos (`target`, `description`).
 * @typedef {'loosened'|'tightened'|'changed'|'added'|'removed'|'unchanged'} ChangeKind
 */

/**
 * Diferença de uma métrica entre o baseline do ramo base e o do PR.
 * @typedef {object} BaselineChange
 * @property {string} name
 * @property {ChangeKind} kind
 * @property {string[]} loosenedFields
 * @property {string[]} tightenedFields
 * @property {string[]} changedFields campos informativos alterados
 * @property {MetricRule|null} before
 * @property {MetricRule|null} after
 */

/**
 * @typedef {object} Decision
 * @property {boolean} granted
 * @property {Issue|null} reason
 */

/**
 * Relatório final de uma execução.
 * @typedef {object} Report
 * @property {Outcome} outcome
 * @property {BaselineChange[]} changes alterações relevantes ao baseline (sem 'unchanged')
 * @property {BaselineChange[]} loosened alterações que afrouxam o contrato
 * @property {Decision} authorisation autorização para afrouxar o baseline
 * @property {boolean} loosenable há um padrão de título que autoriza afrouxar (não vazio)
 * @property {Decision} bypass perdão de hotfix
 * @property {boolean} governed true quando havia baseline do ramo base para comparar
 * @property {boolean} passed nenhuma falha, nenhum afrouxamento não autorizado
 * @property {boolean} ok passed ou perdoado
 * @property {Baseline} newBaseline contrato efectivo (o baseline do PR, ou a versão mais
 *   exigente de cada campo quando o afrouxamento não foi autorizado) com as melhorias fixadas
 * @property {string[]} tightened métricas cujo valor o newBaseline aperta face ao contrato
 * @property {string[]} untracked métricas medidas que o contrato não segue
 * @property {Issue[]} warnings
 * @property {string} [frozenAt]
 */

export {};
