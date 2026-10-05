'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { Connection } = require('./jsonrpc');
const { SERVERS, commandFor, refusedFor } = require('./registry');

const REFUSED_HINT =
  'поставьте TypeScript рядом с сервером (npm i -g typescript typescript-language-server) или включите «Доверять этому репозиторию» в плашке клона';

/** Why a server on PATH was not started for an untrusted clone (registry.refusedFor). */
function refusedMessage(refused) {
  return refused.why === 'in-clone'
    ? `LSP из PATH лежит внутри клона (${refused.command}), а репозиторию не доверено запускать свои программы`
    : `typescript-language-server из PATH (${refused.command}) не запущен: своего TypeScript у него нет, и он загрузил бы node_modules/typescript клона, которому не доверено`;
}

// Language server processes: one per repository × server kind, started on the
// first request that needs it and stopped after a stretch of disuse. All a
// request ever waits for is `ensure()`; everything else — the handshake, the
// documents the server has open, its crashes — is kept here.

const DEFAULTS = {
  /** Unused this long, a server is shut down; the next request starts it again. */
  idleMs: 10 * 60 * 1000,
  /** After a crash, requests fail fast for this long instead of respawning in a loop. */
  restartDelayMs: 10 * 1000,
  /** jdtls on a large Maven project takes most of a minute to say hello. */
  startTimeoutMs: 90 * 1000,
  /** shutdown is polite; a server that ignores it is killed after this. */
  stopTimeoutMs: 3 * 1000,
};

/** Documents a server keeps open at once; the least recently used one is closed. */
const MAX_OPEN_DOCS = 100;
/** A file on disk bigger than this is not kept open (the route refuses such files too). */
const MAX_DOC_BYTES = 5 * 1024 * 1024;
/** How much of a server's stderr is kept to explain a crash. */
const STDERR_TAIL = 4096;

/**
 * Why a request could not be served, in words the file header can show.
 * reason: 'no-server' | 'failed' | 'timeout' | 'aborted'.
 */
class LspError extends Error {
  constructor(reason, message, extra) {
    super(message);
    this.reason = reason;
    Object.assign(this, extra || {});
  }
}

function lastLines(text, n) {
  return String(text || '')
    .trim()
    .split(/\r?\n/)
    .slice(-n)
    .join(' · ')
    .slice(-400);
}

/** One running server process and its connection. */
class ServerProcess {
  constructor(manager, root, def, spec, repoBin) {
    this.manager = manager;
    this.root = root;
    this.def = def;
    this.spec = spec;
    this.repoBin = repoBin;
    this.key = keyOf(root, def.id, repoBin);
    // tsserver or tsgo: which program actually serves this repository.
    this.label = spec.label || def.label;
    this.state = 'starting';
    this.message = null;
    this.progress = new Set();
    this.busyStatus = false;
    this.docs = new Map();
    this.stderr = '';
    this.startedAt = Date.now();
    this.lastUsed = Date.now();
    this.idleTimer = null;
    this.child = null;
    this.conn = null;
    this.ready = null;
    this.exited = null;
  }

  start() {
    const { command, args } = this.spec;
    const win = process.platform === 'win32';
    // A .cmd shim (npm's node_modules/.bin on Windows) runs only through the
    // shell since Node 20; quoting is then ours to do.
    const viaShell = win && /\.(cmd|bat)$/i.test(command);
    // cmd.exe metacharacters too: a path with `&` or `(` would otherwise split the command.
    const quote = (s) => (/[\s"&|<>^()]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
    this.child = spawn(viaShell ? quote(command) : command, viaShell ? args.map(quote) : args, {
      cwd: this.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: viaShell,
      // Its own process group, so stopping it takes along whatever it started
      // (jdtls is a launcher script around a JVM).
      detached: !win,
      env: process.env,
    });
    const child = this.child;
    this.manager.live.add(this);
    this.exited = new Promise((resolve) => child.once('close', resolve));
    child.once('close', () => this.manager.live.delete(this));
    this.conn = new Connection(
      { write: (buf) => child.stdin.write(buf) },
      {
        onNotification: (method, params) => this.onNotification(method, params),
        onRequest: (method, params) => this.onRequest(method, params),
      }
    );
    child.stdout.on('data', (chunk) => this.conn.feed(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    // Writing to a server that just died raises EPIPE here; the exit handler reports it.
    child.stdin.on('error', () => {});
    child.on('error', (e) => this.onExit(null, null, e));
    child.on('exit', (code, signal) => this.onExit(code, signal, null));
    this.manager.watchExit();

    const rootUri = pathToFileURL(this.root).href;
    this.ready = this.conn
      .request(
        'initialize',
        {
          processId: process.pid,
          clientInfo: { name: 'local-review' },
          rootUri,
          rootPath: this.root,
          ...(this.spec.initializationOptions ? { initializationOptions: this.spec.initializationOptions } : {}),
          workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
          capabilities: {
            general: { positionEncodings: ['utf-16'] },
            window: { workDoneProgress: true },
            workspace: { configuration: true, workspaceFolders: true },
            textDocument: {
              synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
              hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
              definition: { dynamicRegistration: false, linkSupport: true },
              references: { dynamicRegistration: false },
              implementation: { dynamicRegistration: false, linkSupport: true },
              callHierarchy: { dynamicRegistration: false },
            },
          },
        },
        { timeoutMs: this.manager.options.startTimeoutMs }
      )
      .then((result) => {
        this.capabilities = (result && result.capabilities) || {};
        this.conn.notify('initialized', {});
        if (this.state === 'starting') this.state = 'running';
        this.touch();
        return this;
      });
    return this.ready;
  }

  busy() {
    return this.progress.size > 0 || this.busyStatus;
  }

  /**
   * Waits out the indexing a server reports, up to `timeoutMs`. Asked while
   * tsserver is still loading the project, «definition» lands on the import
   * line instead of the declaration — a wrong answer is worse than a slow one.
   * `graceMs` is for the first document a server ever sees: the indexing it
   * triggers is announced a moment after didOpen, not with it.
   */
  async settled(graceMs, timeoutMs) {
    const until = (cond, ms) =>
      new Promise((resolve) => {
        const end = Date.now() + ms;
        const tick = () => (cond() || Date.now() >= end ? resolve() : setTimeout(tick, 50));
        tick();
      });
    if (graceMs > 0) await until(() => this.busy(), graceMs);
    if (this.busy()) await until(() => !this.busy() || this.state !== 'running', timeoutMs);
  }

  /** What the file header shows: starting / indexing / ready / failed / stopped. */
  publicState() {
    if (this.state === 'running') return this.busy() ? 'indexing' : 'ready';
    return this.state;
  }

  onNotification(method, params) {
    if (method === '$/progress' && params && params.value) {
      const kind = params.value.kind;
      if (kind === 'begin') this.progress.add(params.token);
      else if (kind === 'end') this.progress.delete(params.token);
    } else if (method === 'language/status' && params) {
      // jdtls reports its own start-up this way rather than with $/progress.
      const type = String(params.type || '');
      if (type === 'Starting') this.busyStatus = true;
      else if (type === 'Started' || type === 'ServiceReady' || type === 'Error') this.busyStatus = false;
    }
  }

  /** Requests the server makes of us; answering is mandatory, the content mostly isn't. */
  onRequest(method, params) {
    switch (method) {
      case 'workspace/configuration':
        return ((params && params.items) || []).map(() => null);
      case 'workspace/workspaceFolders':
        return [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }];
      case 'window/workDoneProgress/create':
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/showMessageRequest':
        return null;
      case 'workspace/applyEdit':
        return { applied: false };
      default:
        return undefined;
    }
  }

  /**
   * Makes the server see `text` as the content of `uri`. The text is whatever
   * the diff shows — the working tree, the index or a commit — so positions
   * from the browser are positions in the server's copy too. `mtimeMs` is
   * given when the text was read from disk (null for a shown version, a
   * «virtual» document). True when this is the first document the server
   * has ever been given.
   */
  sync(uri, languageId, text, abs, mtimeMs) {
    const doc = this.docs.get(uri);
    if (doc) {
      // Re-inserted: Map order is the LRU order.
      this.docs.delete(uri);
      this.docs.set(uri, doc);
      doc.mtimeMs = mtimeMs;
      this.change(uri, doc, text);
      return false;
    }
    const first = !this.everOpened;
    this.everOpened = true;
    this.docs.set(uri, { version: 1, text, abs, mtimeMs, languageId });
    this.conn.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
    if (this.docs.size > MAX_OPEN_DOCS) {
      const oldest = this.docs.keys().next().value;
      this.docs.delete(oldest);
      this.conn.notify('textDocument/didClose', { textDocument: { uri: oldest } });
    }
    return first;
  }

  change(uri, doc, text) {
    if (doc.text === text) return;
    doc.version += 1;
    doc.text = text;
    this.conn.notify('textDocument/didChange', {
      textDocument: { uri, version: doc.version },
      contentChanges: [{ text }],
    });
  }

  /**
   * An open document overrides the file on disk for the server, so one that
   * was opened from disk must follow the disk: a file edited (or deleted)
   * since is re-sent (or closed). With `toDisk`, documents opened with a
   * shown version (staged, a commit) go back to the disk too: the request at
   * hand is about the working tree, and so is the rest of the project.
   */
  refreshFromDisk(toDisk) {
    for (const [uri, doc] of [...this.docs]) {
      if (doc.mtimeMs === null && !toDisk) continue;
      let stat = null;
      try {
        stat = fs.statSync(doc.abs);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isFile() || stat.size > MAX_DOC_BYTES) {
        this.docs.delete(uri);
        this.conn.notify('textDocument/didClose', { textDocument: { uri } });
        continue;
      }
      if (doc.mtimeMs === stat.mtimeMs) continue;
      let text;
      try {
        text = fs.readFileSync(doc.abs, 'utf8');
      } catch {
        // Gone between the stat and the read: as good as deleted.
        this.docs.delete(uri);
        this.conn.notify('textDocument/didClose', { textDocument: { uri } });
        continue;
      }
      doc.mtimeMs = stat.mtimeMs;
      this.change(uri, doc, text);
    }
  }

  async request(method, params, options) {
    this.touch();
    try {
      return await this.conn.request(method, params, options);
    } catch (e) {
      if (e.code === 'ETIMEDOUT') throw new LspError('timeout', `${e.message}. Возможно, ещё идёт индексация — попробуйте позже.`);
      if (e.code === 'ABORTED') throw new LspError('aborted', e.message);
      if (this.state === 'failed') throw new LspError('failed', this.message || e.message);
      throw new LspError('failed', `${this.label}: ${e.message}`);
    } finally {
      this.touch();
    }
  }

  touch() {
    this.lastUsed = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.state !== 'running') return;
    this.idleTimer = setTimeout(() => void this.stop(), this.manager.options.idleMs);
    // An idle timer must not keep the review server (or a test) alive.
    this.idleTimer.unref();
  }

  /** shutdown → exit, as the protocol asks; a server that does not leave in time is killed. */
  async stop() {
    if (this.state === 'stopping' || this.state === 'stopped' || this.state === 'failed') return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.state = 'stopping';
    this.manager.forget(this);
    const timeout = this.manager.options.stopTimeoutMs;
    try {
      await this.conn.request('shutdown', null, { timeoutMs: timeout });
      this.conn.notify('exit', null);
    } catch {
      /* killed below */
    }
    const killer = setTimeout(() => this.kill(), timeout);
    killer.unref();
    await this.exited;
    clearTimeout(killer);
    // The launcher left; whatever it started (jdtls's JVM) goes with it.
    this.kill({ group: true });
  }

  /**
   * Synchronous, for process exit: the whole process group goes. With
   * `group`, also after the process itself has exited — a launcher script
   * that died leaves its group (the JVM it started) behind.
   */
  kill(options) {
    const child = this.child;
    if (!child || !child.pid) return;
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (exited && !(options && options.group && process.platform !== 'win32')) return;
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      if (exited) return; // ESRCH: nothing of the group is left
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }

  onExit(code, signal, error) {
    if (this.state === 'stopped' || this.state === 'failed') return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const expected = this.state === 'stopping';
    if (expected) {
      this.state = 'stopped';
      this.conn.close(new Error(`${this.label} остановлен`));
      return;
    }
    const why = error
      ? error.code === 'ENOENT'
        ? `не удалось запустить ${this.spec.command}`
        : error.message
      : `завершился (${signal ? `сигнал ${signal}` : `код ${code}`})`;
    const tail = lastLines(this.stderr, 3);
    this.state = 'failed';
    this.message = `LSP-сервер ${this.label} ${why}${tail ? `: ${tail}` : ''}`;
    this.conn.close(new LspError('failed', this.message));
    this.manager.crashed(this);
    // A launcher that died may leave its JVM behind.
    this.kill({ group: true });
  }
}

/**
 * A server per repository, kind and trust: one started from the repository's
 * node_modules/.bin is not the one an untrusted view of the same folder (a PR's
 * clone) may use.
 */
function keyOf(root, id, repoBin = true) {
  return `${root}\u0000${id}\u0000${repoBin ? 'repo' : 'path'}`;
}

class LspManager {
  constructor(options) {
    this.options = Object.assign({}, DEFAULTS, options || {});
    this.servers = new Map();
    /**
     * Every process not yet reaped, including those being stopped or that
     * failed (no longer in `servers`): process exit must kill them all.
     */
    this.live = new Set();
    this.failures = new Map();
    this.exitHooked = false;
  }

  configure(options) {
    Object.assign(this.options, options || {});
  }

  /**
   * The initialized server of kind `def` for `root`, started if need be.
   * Throws LspError: 'no-server' when it is not installed, 'failed' when it
   * crashed (recently, or now while starting).
   */
  async ensure(root, def, options) {
    const repoBin = !(options && options.repoBin === false);
    const key = keyOf(root, def.id, repoBin);
    const running = this.servers.get(key);
    if (running) return running.ready;

    const failure = this.failures.get(key);
    if (failure) {
      const left = failure.at + this.options.restartDelayMs - Date.now();
      if (left > 0) {
        throw new LspError('failed', `${failure.message} — повторный запуск через ${Math.ceil(left / 1000)} с`);
      }
      this.failures.delete(key);
    }

    const spec = commandFor(def, root, { homeDir: this.options.homeDir, repoBin });
    if (!spec) {
      const refused = refusedFor(def, root, { homeDir: this.options.homeDir, repoBin });
      if (refused) throw new LspError('no-server', refusedMessage(refused), { hint: REFUSED_HINT });
      const blocked = !repoBin && commandFor(def, root, { homeDir: this.options.homeDir });
      throw new LspError(
        'no-server',
        blocked
          ? `LSP не найден в PATH; в node_modules/.bin клона он есть, но репозиторию не доверено запускать свои программы`
          : `LSP не найден: ${def.commands.map((c) => c.bin).join(' / ')}`,
        { hint: blocked ? 'включите «Доверять этому репозиторию» в плашке клона или поставьте сервер глобально' : def.hint }
      );
    }
    if (def.id === 'java') {
      const dataDir = spec.args[spec.args.indexOf('-data') + 1];
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const server = new ServerProcess(this, root, def, spec, repoBin);
    this.servers.set(key, server);
    // `ready` is what a second request arriving during the handshake awaits
    // too, so it is the promise that must fail with an LspError.
    // A synchronous throw of spawn() lands in the same place as a failed handshake.
    server.ready = new Promise((resolve) => resolve(server.start())).catch((e) => {
      // A handshake that failed or timed out leaves nothing usable behind.
      if (server.state !== 'failed') {
        server.state = 'failed';
        server.message = e instanceof LspError ? e.message : `LSP-сервер ${server.label} не запустился: ${e.message}`;
        if (server.conn) server.conn.close(e);
        this.crashed(server);
        server.kill({ group: true });
      }
      throw e instanceof LspError ? e : new LspError('failed', server.message);
    });
    return server.ready;
  }

  /** Every server of a folder goes: its clone was unbound, or its trust changed. */
  async stopRoot(root) {
    // By real path: the binding and git's top level may spell one folder differently.
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    const resolved = real(root);
    await Promise.all([...this.servers.values()].filter((s) => real(s.root) === resolved).map((s) => s.stop()));
    for (const key of [...this.failures.keys()]) if (real(key.split('\u0000')[0]) === resolved) this.failures.delete(key);
  }

  forget(server) {
    if (this.servers.get(server.key) === server) this.servers.delete(server.key);
  }

  crashed(server) {
    this.forget(server);
    this.failures.set(server.key, { at: Date.now(), message: server.message });
  }

  /** Every running server, for the status page. */
  running() {
    return [...this.servers.values()].map((s) => ({
      root: s.root,
      id: s.def.id,
      repoBin: s.repoBin,
      label: s.label,
      state: s.publicState(),
      pid: s.child && s.child.pid,
      startedAt: new Date(s.startedAt).toISOString(),
      lastUsed: new Date(s.lastUsed).toISOString(),
    }));
  }

  /**
   * Per server kind, for one repository (or for none: `root` null looks on
   * PATH only): is it installed, where, and what it is doing.
   */
  status(root, options) {
    const repoBin = !(options && options.repoBin === false);
    return SERVERS.map((def) => {
      const spec = commandFor(def, root || null, { homeDir: this.options.homeDir, repoBin });
      // What trusting the repository would add: a server only its node_modules/.bin has.
      const own = !repoBin && root ? commandFor(def, root, { homeDir: this.options.homeDir }) : null;
      const key = root ? keyOf(root, def.id, repoBin) : null;
      const server = key ? this.servers.get(key) : null;
      const failure = key ? this.failures.get(key) : null;
      return {
        id: def.id,
        name: def.name,
        label: server ? server.label : spec ? spec.label : def.label,
        extensions: Object.keys(def.languageIds),
        found: spec ? { command: spec.command, source: spec.source } : null,
        untrusted: own && own.source === 'node_modules' ? { command: own.command } : null,
        // A server on PATH that was not started for an untrusted clone, and why.
        refused: spec ? null : refusedFor(def, root || null, { homeDir: this.options.homeDir, repoBin }),
        hint: def.hint,
        state: server ? server.publicState() : failure ? 'failed' : 'stopped',
        message: server ? server.message : failure ? failure.message : null,
      };
    });
  }

  /** On the way out of the process nothing may outlive us. */
  watchExit() {
    if (this.exitHooked) return;
    this.exitHooked = true;
    process.once('exit', () => this.killAll());
  }

  killAll() {
    for (const server of this.live) server.kill({ group: true });
  }

  async stopAll() {
    await Promise.all([...this.servers.values()].map((s) => s.stop()));
  }
}

module.exports = { LspManager, LspError, DEFAULTS };
