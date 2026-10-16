import { createHash } from 'node:crypto';

/** @typedef {'pi' | 'claude' | 'codex'} Provider */
/**
 * @typedef {object} SessionSummary
 * @property {string} key
 * @property {Provider} provider
 * @property {string} id
 * @property {string} path Absolute original session path.
 * @property {string} cwd
 * @property {string} title
 * @property {number} modified Milliseconds since the Unix epoch.
 */
/** @typedef {SessionSummary & {transcriptPath: string, messageCount: number}} SessionExport */
/**
 * @typedef {object} StoreOptions
 * @property {string} cacheDir
 * @property {string} agentDir
 * @property {string} [sessionDir] Additional current Pi session directory, alongside the normal root.
 */
/**
 * @typedef {object} SearchOptions
 * @property {string} cwd
 * @property {string} [excludePath]
 * @property {AbortSignal} [signal]
 */
/**
 * @typedef {object} Stamp
 * @property {number} size
 * @property {number} mtimeMs
 * @property {number} ctimeMs
 * @property {number} dev
 * @property {number} ino
 */
/**
 * @typedef {object} CacheRecord
 * @property {string} key
 * @property {Provider} provider
 * @property {string} path
 * @property {Stamp} stamp
 * @property {SessionSummary | null} summary
 * @property {string} baseTitle Title before applying the Codex title store.
 * @property {string} userText Normalized user text only.
 */
/**
 * @typedef {object} Message
 * @property {'user' | 'assistant'} role
 * @property {string} text
 */

/** @param {string} text */
export function fold(text) {
  return text.normalize('NFKC').toLowerCase();
}

/** @param {Provider} provider @param {string} path */
export function sessionKey(provider, path) {
  return createHash('sha256').update(provider).update('\0').update(path).digest('hex').slice(0, 24);
}

/** @param {Stamp} left @param {Stamp} right */
export function sameStamp(left, right) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs && left.dev === right.dev && left.ino === right.ino;
}

export function abortError() {
  const error = new Error('Session request was cancelled.');
  error.name = 'AbortError';
  return error;
}

/** @param {AbortSignal} [signal] */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/** @param {unknown} error */
export function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : '';
}

/** @param {unknown} error */
export function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

export class SourceChangedError extends Error {
  constructor() {
    super('The session changed during reading. Try again when it is idle.');
    this.name = 'SourceChangedError';
  }
}

export class InvalidSessionError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'InvalidSessionError';
  }
}
