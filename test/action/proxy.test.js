// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { configureProxy } from '../../src/action/proxy.js';
import { ConfigError } from '../../src/core/errors.js';

/** Proxy de um runner self-hosted. */
const PROXY = 'http://proxy.corp.test:3128';

/**
 * Módulo http falso: regista as chamadas a setGlobalProxyFromEnv.
 * @param {(env: unknown) => void} [behaviour] o que a função faz além de registar
 */
function fakeHttp(behaviour = () => {}) {
  /** @type {unknown[]} */
  const calls = [];
  const http = {
    setGlobalProxyFromEnv: (/** @type {unknown} */ env) => {
      calls.push(env);
      behaviour(env);
    },
  };
  return { http, calls };
}

describe('configureProxy', () => {
  test('sem variáveis de proxy devolve none', () => {
    const { http } = fakeHttp();
    assert.equal(configureProxy({ env: {}, http }), 'none');
  });

  test('sem variáveis de proxy não configura nada', () => {
    const { http, calls } = fakeHttp();
    configureProxy({ env: {}, http });
    assert.deepEqual(calls, []);
  });

  test('uma variável de proxy vazia conta como ausente', () => {
    const { http } = fakeHttp();
    assert.equal(configureProxy({ env: { HTTPS_PROXY: ' ' }, http }), 'none');
  });

  test('com NODE_USE_ENV_PROXY=1 devolve native', () => {
    const { http } = fakeHttp();
    const env = { HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: '1' };
    assert.equal(configureProxy({ env, http }), 'native');
  });

  test('com NODE_USE_ENV_PROXY=1 deixa o proxy ao Node', () => {
    const { http, calls } = fakeHttp();
    configureProxy({ env: { HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: '1' }, http });
    assert.deepEqual(calls, []);
  });

  test('com https_proxy em minúsculas devolve enabled', () => {
    const { http } = fakeHttp();
    assert.equal(configureProxy({ env: { https_proxy: PROXY }, http }), 'enabled');
  });

  test('aplica o proxy com as variáveis do ambiente recebido', () => {
    const { http, calls } = fakeHttp();
    const env = { HTTP_PROXY: PROXY, NO_PROXY: 'ghe.corp.test' };
    configureProxy({ env, http });
    assert.deepEqual(calls, [env]);
  });

  test('sem setGlobalProxyFromEnv (Node 20, 22) devolve unsupported', () => {
    assert.equal(configureProxy({ env: { http_proxy: PROXY }, http: {} }), 'unsupported');
  });

  test('uma configuração recusada pelo Node lança ConfigError', () => {
    const { http } = fakeHttp(() => { throw new TypeError('Invalid proxy URL'); });
    assert.throws(() => configureProxy({ env: { HTTPS_PROXY: 'nope' }, http }), ConfigError);
  });

  test('uma configuração recusada usa o código proxy_invalid com o motivo', () => {
    const { http } = fakeHttp(() => { throw new TypeError('Invalid proxy URL'); });
    assert.throws(() => configureProxy({ env: { HTTPS_PROXY: 'nope' }, http }), {
      code: 'proxy_invalid', params: { reason: 'Invalid proxy URL' },
    });
  });
});
