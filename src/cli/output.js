// @ts-check
/**
 * Escrita das linhas da CLI no stdout e no stderr do processo. Quem lê pode fechar o pipe
 * antes do fim (ex: `quality-ratchet check | head -n 5`, ou `grep -q`): o resto da saída já
 * não tem leitor, e isso não pode mudar o código de saída, que diz se a catraca passou.
 */

/**
 * Stream de saída, como `process.stdout`.
 * @typedef {object} OutputStream
 * @property {(text: string) => unknown} write
 * @property {(event: 'error', listener: (error: Error) => void) => unknown} on
 */

/**
 * Códigos de erro de uma saída cujo leitor já fechou: EPIPE na escrita que o descobre, e
 * ERR_STREAM_DESTROYED nas que a seguem.
 */
const READER_CLOSED = new Set(['EPIPE', 'ERR_STREAM_DESTROYED']);

/**
 * Cria a função que escreve uma linha na stream, terminada com fim de linha. Quando o
 * leitor fecha o pipe, as linhas seguintes são descartadas e o erro não termina o
 * processo, que sai com o código já calculado pela CLI. Os outros erros da stream propagam,
 * como aconteceria sem esta função.
 * @param {OutputStream} stream
 * @returns {(line: string) => void}
 */
export function createLineWriter(stream) {
  let closed = false;
  stream.on('error', (error) => {
    const code = /** @type {{code?: unknown}} */ (error).code;
    if (!READER_CLOSED.has(String(code))) throw error;
    closed = true;
  });
  return (line) => {
    if (!closed) stream.write(`${line}\n`);
  };
}
