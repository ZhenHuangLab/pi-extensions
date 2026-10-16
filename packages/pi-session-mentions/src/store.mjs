import { Worker } from 'node:worker_threads';
import { abortError, asError, throwIfAborted } from './model.mjs';

/** @typedef {import('./model.mjs').StoreOptions} StoreOptions */
/** @typedef {import('./model.mjs').SearchOptions} SearchOptions */
/** @typedef {import('./model.mjs').SessionSummary} SessionSummary */
/** @typedef {import('./model.mjs').SessionExport} SessionExport */
/**
 * @typedef {object} PendingRequest
 * @property {(value: any) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {() => void} cleanup
 */

/** A lazy client. File access, source parsing and searches run in a native worker. */
export class SessionStore {
  /** @type {StoreOptions} */
  #options;
  /** @type {Worker | null} */
  #worker = null;
  /** @type {Map<number, PendingRequest>} */
  #pending = new Map();
  #nextId = 0;
  #closed = false;
  /** @type {Error | null} */
  #failure = null;
  /** @type {Promise<void> | null} */
  #closing = null;

  /** @param {StoreOptions} options */
  constructor(options) {
    if (!options || typeof options.cacheDir !== 'string' || !options.cacheDir ||
        typeof options.agentDir !== 'string' || !options.agentDir ||
        (options.sessionDir !== undefined && (typeof options.sessionDir !== 'string' || !options.sessionDir))) {
      throw new TypeError('SessionStore requires cacheDir and agentDir paths.');
    }
    this.#options = { cacheDir: options.cacheDir, agentDir: options.agentDir, sessionDir: options.sessionDir };
  }

  /** Starts background indexing without waiting for discovery. */
  start() {
    if (this.#closed) throw new Error('SessionStore is closed.');
    if (this.#failure) throw this.#failure;
    if (this.#worker) return;
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: this.#options,
      // Pi's loaders and command line arguments do not apply to this native ESM worker.
      execArgv: [],
    });
    this.#worker = worker;
    worker.on('message', (message) => {
      if (!message || message.type !== 'response' || !Number.isSafeInteger(message.id)) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      pending.cleanup();
      if (message.error) {
        const error = new Error(String(message.error.message));
        error.name = String(message.error.name || 'Error');
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      if (this.#pending.size === 0) worker.unref();
    });
    worker.on('error', (error) => this.#fail(error));
    worker.on('exit', (code) => {
      if (this.#worker === worker) this.#worker = null;
      if (!this.#closed) this.#fail(new Error(`Session worker exited unexpectedly (${code}).`));
    });
    worker.unref();
  }

  /**
   * Returns up to eight current matches, including during background indexing.
   * @param {string} query
   * @param {SearchOptions} options
   * @returns {Promise<{sessions: SessionSummary[], loading: boolean}>}
   */
  async search(query, options) {
    if (typeof query !== 'string' || !options || typeof options.cwd !== 'string' ||
        (options.excludePath !== undefined && typeof options.excludePath !== 'string')) {
      throw new TypeError('Search requires a query and cwd.');
    }
    return this.#request('search', { query, cwd: options.cwd, excludePath: options.excludePath }, options.signal);
  }

  /**
   * Resolves a known opaque key. Callers cannot supply source or output paths.
   * @param {string} key
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<SessionExport>}
   */
  async exportSession(key, options = {}) {
    if (typeof key !== 'string' || !/^[a-f0-9]{24}$/.test(key)) throw new TypeError('Invalid session key.');
    return this.#request('export', { key }, options.signal);
  }

  /** @returns {Promise<void>} */
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(new Error('SessionStore is closed.'));
    }
    this.#pending.clear();
    const worker = this.#worker;
    if (!worker) return Promise.resolve();
    /** @type {Promise<void>} */
    const closing = new Promise((resolve) => {
      const timer = setTimeout(() => { void worker.terminate(); }, 1000);
      worker.once('exit', () => { clearTimeout(timer); resolve(); });
      worker.ref();
      worker.postMessage({ type: 'close' });
    });
    this.#closing = closing;
    return closing;
  }

  /** @param {unknown} cause */
  #fail(cause) {
    const error = asError(cause);
    this.#failure ??= error;
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
    this.#worker?.unref();
  }

  /**
   * @param {'search' | 'export'} type
   * @param {Record<string, unknown>} payload
   * @param {AbortSignal} [signal]
   * @returns {Promise<any>}
   */
  #request(type, payload, signal) {
    throwIfAborted(signal);
    this.start();
    const worker = /** @type {Worker} */ (this.#worker);
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.#pending.delete(id)) return;
        signal?.removeEventListener('abort', onAbort);
        worker.postMessage({ type: 'cancel', id });
        if (this.#pending.size === 0) worker.unref();
        reject(abortError());
      };
      this.#pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', onAbort) });
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.ref();
      try {
        worker.postMessage({ type, id, ...payload });
      } catch (error) {
        this.#pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        if (this.#pending.size === 0) worker.unref();
        reject(asError(error));
      }
    });
  }
}
