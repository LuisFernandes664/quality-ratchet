// @ts-check
/**
 * Proxy dos pedidos à API. O fetch do Node ignora HTTPS_PROXY e HTTP_PROXY, a não ser que
 * o processo arranque com NODE_USE_ENV_PROXY=1 ou que o proxy global seja configurado com
 * http.setGlobalProxyFromEnv (Node 24). Nos runners self-hosted atrás de um proxy, sem
 * isto, todos os pedidos à API falham.
 */

import { ConfigError } from '../core/errors.js';

/** @typedef {import('./io.js').Env} Env */

/**
 * Modo do proxy: 'none' sem variáveis de proxy; 'native' quando o Node já as aplica
 * (NODE_USE_ENV_PROXY=1); 'enabled' quando foram aplicadas agora; 'unsupported' quando
 * este Node não as consegue aplicar ao fetch.
 * @typedef {'none'|'native'|'enabled'|'unsupported'} ProxyMode
 */

/**
 * Parte do módulo node:http usada aqui; setGlobalProxyFromEnv só existe no Node 24.
 * @typedef {object} ProxyHttp
 * @property {(env: Env) => unknown} [setGlobalProxyFromEnv]
 */

/** Variáveis de proxy reconhecidas pelo Node (e pelos runners). */
const PROXY_VARS = Object.freeze(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']);

/**
 * Aplica as variáveis de proxy do ambiente ao fetch, quando as há e o Node o permite. O
 * NO_PROXY é respeitado pelo próprio Node.
 * @param {{env: Env, http: object}} deps `http` é o módulo node:http
 * @returns {ProxyMode}
 * @throws {ConfigError} proxy_invalid quando o Node recusa a configuração
 */
export function configureProxy({ env, http }) {
  if (!PROXY_VARS.some((name) => (env[name] ?? '').trim() !== '')) return 'none';
  if (env.NODE_USE_ENV_PROXY === '1') return 'native';
  const target = /** @type {ProxyHttp} */ (http);
  if (typeof target.setGlobalProxyFromEnv !== 'function') return 'unsupported';
  try {
    target.setGlobalProxyFromEnv(env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError('proxy_invalid', { reason });
  }
  return 'enabled';
}
