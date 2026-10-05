'use strict';

// JSON-RPC 2.0 over a byte stream, framed the way the Language Server
// Protocol frames it: a `Content-Length: <bytes>` header, an empty line, then
// exactly that many bytes of UTF-8 JSON. Node built-ins only — the tool has no
// runtime dependencies and a language client is small enough to own.

const HEADER_END = Buffer.from('\r\n\r\n', 'ascii');
/** A header block longer than this is not LSP: the stream is garbage. */
const MAX_HEADER_BYTES = 8 * 1024;
/** A body announced bigger than this is a garbled length, not a message to wait for. */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** Standard JSON-RPC error codes the client side ever sends back. */
const ErrorCodes = {
  MethodNotFound: -32601,
  RequestCancelled: -32800,
};

/** One message, ready to write to the server's stdin. */
function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * Turns stdout chunks back into messages. Chunks split anywhere — inside the
 * header, inside a multi-byte character of the body — and one chunk can hold
 * several messages, so bytes are kept until a whole message is there.
 * Content-Length counts bytes, not characters: the body is cut as a Buffer
 * and only then decoded.
 */
class MessageReader {
  constructor(onMessage, onError) {
    this.onMessage = onMessage;
    this.onError = onError || (() => {});
    this.buffer = Buffer.alloc(0);
    this.expected = -1;
  }

  feed(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.expected < 0) {
        const end = this.buffer.indexOf(HEADER_END);
        if (end < 0) {
          if (this.buffer.length > MAX_HEADER_BYTES) this.fail(new Error('LSP: заголовок сообщения не найден'));
          return;
        }
        const header = this.buffer.subarray(0, end).toString('ascii');
        this.buffer = this.buffer.subarray(end + HEADER_END.length);
        // Any line of the block may carry the length: a server (or the
        // launcher around it) that printed a stray line to stdout before its
        // first message leaves that line glued to the header, with a bare \n.
        const match = /(?:^|[\r\n])content-length[ \t]*:[ \t]*(\d+)/i.exec(header);
        if (!match || Number(match[1]) > MAX_BODY_BYTES) {
          this.fail(new Error(`LSP: нет корректного Content-Length в заголовке «${header.slice(0, 200)}»`));
          return;
        }
        this.expected = Number(match[1]);
      }
      if (this.buffer.length < this.expected) return;
      const body = this.buffer.subarray(0, this.expected);
      this.buffer = this.buffer.subarray(this.expected);
      this.expected = -1;
      let message;
      try {
        message = JSON.parse(body.toString('utf8'));
      } catch (e) {
        // One broken message is skipped, the stream stays in sync: its length was known.
        this.onError(new Error(`LSP: некорректный JSON (${e.message})`));
        continue;
      }
      this.onMessage(message);
    }
  }

  fail(error) {
    this.buffer = Buffer.alloc(0);
    this.expected = -1;
    this.onError(error);
  }
}

/**
 * Both directions of one connection: our requests to the server (with an id,
 * a timeout and cancellation) and notifications, and the server's own
 * messages to us — notifications, and requests such as
 * `workspace/configuration` that must be answered or the server waits forever.
 */
class Connection {
  /**
   * @param {{ write: (buf: Buffer) => void }} output where encoded messages go
   * @param {{ onNotification?: Function, onRequest?: Function }} handlers
   */
  constructor(output, handlers) {
    this.output = output;
    this.onNotification = (handlers && handlers.onNotification) || (() => {});
    this.onRequest = (handlers && handlers.onRequest) || (() => undefined);
    this.nextId = 1;
    this.pending = new Map();
    this.closed = null;
    this.reader = new MessageReader(
      (m) => this.dispatch(m),
      (e) => this.onNotification('$/readerError', { message: e.message })
    );
  }

  /** Bytes from the server's stdout. */
  feed(chunk) {
    this.reader.feed(chunk);
  }

  send(message) {
    if (this.closed) return;
    try {
      this.output.write(encode(message));
    } catch (e) {
      this.close(e);
    }
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /**
   * Resolves with the result, rejects with the server's error (its `code`
   * kept), on timeout (`code: 'ETIMEDOUT'`), on abort and when the connection
   * closes. A timed-out or aborted request is cancelled on the server too, so
   * it stops working on an answer nobody will read.
   */
  request(method, params, options) {
    const { timeoutMs = 0, signal = null } = options || {};
    if (this.closed) return Promise.reject(this.closed);
    if (signal && signal.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { method, resolve, reject, timer: null, cleanup: null };
      const settle = () => {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.cleanup) entry.cleanup();
      };
      entry.settle = settle;
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          settle();
          this.notify('$/cancelRequest', { id });
          const err = new Error(`LSP не ответил на ${method} за ${Math.round(timeoutMs / 1000)} с`);
          err.code = 'ETIMEDOUT';
          reject(err);
        }, timeoutMs);
      }
      if (signal) {
        const onAbort = () => {
          settle();
          this.notify('$/cancelRequest', { id });
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, entry);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  dispatch(message) {
    if (!message || typeof message !== 'object') return;
    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return; // timed out or cancelled already
      entry.settle();
      if (message.error) {
        const err = new Error(message.error.message || `LSP: ошибка ${message.error.code}`);
        err.code = message.error.code;
        entry.reject(err);
      } else {
        entry.resolve(message.result === undefined ? null : message.result);
      }
      return;
    }
    if (hasId) {
      void this.answer(message);
      return;
    }
    if (typeof message.method === 'string') this.onNotification(message.method, message.params);
  }

  /** A request from the server: the handler's value is the result, `undefined` = not supported. */
  async answer(message) {
    try {
      const result = await this.onRequest(message.method, message.params);
      if (result === undefined) {
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: ErrorCodes.MethodNotFound, message: `Unhandled method ${message.method}` },
        });
        return;
      }
      this.send({ jsonrpc: '2.0', id: message.id, result });
    } catch (e) {
      this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(e && e.message) } });
    }
  }

  /** Every request still waiting fails with `reason`; nothing is sent after this. */
  close(reason) {
    if (this.closed) return;
    this.closed = reason instanceof Error ? reason : new Error(String(reason || 'LSP: соединение закрыто'));
    for (const entry of [...this.pending.values()]) {
      entry.settle();
      entry.reject(this.closed);
    }
  }
}

function abortError() {
  const err = new Error('Запрос отменён');
  err.code = 'ABORTED';
  return err;
}

module.exports = { encode, MessageReader, Connection, ErrorCodes };
