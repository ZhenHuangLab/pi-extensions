import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { setImmediate as yieldThread } from 'node:timers/promises';
import { errorCode, sameStamp, SourceChangedError, throwIfAborted } from './model.mjs';

/** @typedef {import('./model.mjs').Provider} Provider */
/** @typedef {import('./model.mjs').Stamp} Stamp */
/** @typedef {import('./model.mjs').StoreOptions} StoreOptions */
/** @typedef {{pi: string[], claude: string, codex: string}} Roots */
/** @typedef {{provider: Provider, path: string, stamp: Stamp}} Candidate */
/** External JSON records are checked by each format parser. @typedef {Record<string, any>} JsonRecord */

/** @param {string} path */
export function absolutePath(path) {
  if (path === '~') return homedir();
  return resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
}

/** @param {StoreOptions} options @returns {Roots} */
export function sourceRoots(options) {
  const root = absolutePath(process.env.PI_CODING_AGENT_SESSION_DIR || join(absolutePath(options.agentDir), 'sessions'));
  const pi = [root];
  if (options.sessionDir) {
    const current = absolutePath(options.sessionDir);
    // A normal project's directory is already covered. Keep one shared index
    // across projects, and do not descend into its nested agent directories.
    if (current !== root && dirname(current) !== root) pi.push(current);
  }
  return {
    pi,
    claude: absolutePath(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')),
    codex: absolutePath(process.env.CODEX_HOME || join(homedir(), '.codex')),
  };
}

/** @param {string} name */
function ignoredDirectory(name) {
  return ['agent', 'agents', 'subagents'].includes(name.toLowerCase());
}

/** @param {string} path @param {string} root */
export function within(path, root) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Enforces discovery's layouts also when reading an untrusted persistent index.
 * @param {Provider} provider @param {string} path @param {Roots} roots
 */
export function allowedSource(provider, path, roots) {
  if (!isAbsolute(path) || resolve(path) !== path || !path.endsWith('.jsonl')) return false;
  if (provider === 'pi') {
    return roots.pi.some((root, index) => {
      if (ignoredDirectory(basename(root)) || !within(path, root)) return false;
      const parts = relative(root, path).split(sep);
      return parts.length === 1 || (index === 0 && parts.length === 2 && !ignoredDirectory(parts[0]));
    });
  }
  if (provider === 'claude') {
    const root = join(roots.claude, 'projects');
    const parts = relative(root, path).split(sep);
    return within(path, root) && parts.length === 2 && !ignoredDirectory(parts[0]) &&
      !basename(path).startsWith('agent-');
  }
  return ['sessions', 'archived_sessions'].some((name) => {
    const root = join(roots.codex, name);
    const parts = relative(root, path).split(sep);
    return within(path, root) && /^rollout-.*\.jsonl$/.test(basename(path)) &&
      !parts.slice(0, -1).some(ignoredDirectory);
  });
}

/** @param {import('node:fs').Stats} stat @returns {Stamp} */
function stampOf(stat) {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino };
}

/** @param {string} path */
export async function sourceStamp(path) {
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error('Session source is not a regular file.');
  return stampOf(stat);
}

/** @param {unknown} error */
export function missing(error) {
  return ['ENOENT', 'ENOTDIR'].includes(errorCode(error));
}

/** @param {Roots} roots @param {AbortSignal} signal */
export async function discover(roots, signal) {
  /** @type {Map<string, Candidate>} */
  const candidates = new Map();
  /** @type {string[]} */
  const inaccessible = [];
  /** @type {Error[]} */
  const issues = [];

  /** @param {Provider} provider @param {string} directory @param {number} depth */
  async function walk(provider, directory, depth) {
    throwIfAborted(signal);
    try {
      const entries = await opendir(directory);
      for await (const entry of entries) {
        throwIfAborted(signal);
        const path = join(directory, entry.name);
        if (entry.isDirectory() && depth > 0 && !ignoredDirectory(entry.name)) {
          await walk(provider, path, depth - 1);
        } else if (entry.isFile() && allowedSource(provider, path, roots)) {
          try {
            const stamp = await sourceStamp(path);
            candidates.set(`${provider}\0${path}`, { provider, path, stamp });
          } catch (error) {
            if (!missing(error)) {
              inaccessible.push(path);
              issues.push(new Error(`Cannot inspect ${provider} session: ${String(error)}`));
            }
          }
        }
      }
    } catch (error) {
      throwIfAborted(signal);
      if (!missing(error)) {
        inaccessible.push(directory);
        issues.push(new Error(`Cannot scan ${provider} session directory: ${String(error)}`));
      }
    }
  }

  for (const [index, root] of roots.pi.entries()) {
    if (!ignoredDirectory(basename(root))) await walk('pi', root, index === 0 ? 1 : 0);
  }
  await walk('claude', join(roots.claude, 'projects'), 1);
  await walk('codex', join(roots.codex, 'sessions'), Infinity);
  await walk('codex', join(roots.codex, 'archived_sessions'), Infinity);
  return { candidates: [...candidates.values()].sort((a, b) => b.stamp.mtimeMs - a.stamp.mtimeMs), inaccessible, issues };
}

/**
 * Opens originals strictly read-only. A record stream is valid only if both the
 * open file and its directory entry still identify the same unchanged snapshot.
 * @param {string} path
 * @param {(record: JsonRecord) => void} consume
 * @param {AbortSignal} signal
 * @param {boolean} [strict] Persistent indexes reject malformed records.
 * @returns {Promise<Stamp>}
 */
export async function readRecords(path, consume, signal, strict = false) {
  throwIfAborted(signal);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  /** @type {import('node:fs').ReadStream | undefined} */
  let stream;
  /** @type {import('node:readline').Interface | undefined} */
  let lines;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Session source is not a regular file.');
    const before = stampOf(stat);
    if (!sameStamp(before, await sourceStamp(path))) throw new SourceChangedError();
    if (before.size > 0) {
      stream = file.createReadStream({ encoding: 'utf8', autoClose: false, start: 0, end: before.size - 1, signal });
      lines = createInterface({ input: stream, crlfDelay: Infinity });
      let nextYield = performance.now() + 8;
      for await (const line of lines) {
        throwIfAborted(signal);
        if (line.trim()) {
          /** @type {unknown} */
          let record;
          try { record = JSON.parse(line); } catch {
            if (strict) throw new Error('Invalid JSON in session index.');
          }
          if (record && typeof record === 'object' && !Array.isArray(record)) {
            consume(/** @type {JsonRecord} */ (record));
          } else if (strict) {
            throw new Error('Invalid record in session index.');
          }
        }
        if (performance.now() >= nextYield) {
          await yieldThread();
          nextYield = performance.now() + 8;
        }
      }
    }
    throwIfAborted(signal);
    if (!sameStamp(before, stampOf(await file.stat())) || !sameStamp(before, await sourceStamp(path))) {
      throw new SourceChangedError();
    }
    return before;
  } finally {
    lines?.close();
    if (stream) {
      stream.destroy();
      await finished(stream, { cleanup: true }).catch(() => {});
    }
    await file.close();
  }
}

/** @param {string} directory */
export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Session cache must be a real directory.');
  await chmod(directory, 0o700);
}

/** @param {string} path */
async function removeTemporary(path) {
  try { await unlink(path); } catch (error) { if (!missing(error)) throw error; }
}

/** @param {string} path @param {Iterable<string> | AsyncIterable<string>} chunks @param {AbortSignal} signal */
export async function atomicWrite(path, chunks, signal) {
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      for await (const chunk of chunks) {
        throwIfAborted(signal);
        await file.writeFile(chunk, 'utf8');
      }
      await file.sync();
    } finally { await file.close(); }
    throwIfAborted(signal);
    await rename(temporary, path);
  } finally { await removeTemporary(temporary); }
}

/** Publishes a private snapshot without replacing any previous reference.
 * @param {string} directory @param {string} key @param {Iterable<string>} chunks @param {AbortSignal} signal
 */
export async function writeSnapshot(directory, key, chunks, signal) {
  await privateDirectory(directory);
  const id = randomUUID();
  const temporary = join(directory, `.${key}-${id}.tmp`);
  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      for (const chunk of chunks) {
        throwIfAborted(signal);
        await file.writeFile(chunk, 'utf8');
      }
      await file.sync();
    } finally { await file.close(); }
    throwIfAborted(signal);
    const path = join(directory, `${id}.txt`);
    await link(temporary, path);
    throwIfAborted(signal);
    return path;
  } finally { await removeTemporary(temporary); }
}
