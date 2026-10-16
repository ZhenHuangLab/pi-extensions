/** Filesystem execution for a fully preflighted native patch. */
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { applyUpdate, parsePatch, type PatchOperation } from "./patch.ts";

export interface FileChange {
  path: string;
  kind: "add" | "update" | "delete";
  before: string;
  after: string;
}

export interface PatchMove {
  from: string;
  to: string;
}

export interface PatchResult {
  summary: string;
  files: FileChange[];
  moves: PatchMove[];
}

export interface OperationReference {
  path: string;
  kind: FileChange["kind"];
  movePath?: string;
}

export interface FailedOperation extends OperationReference {
  status: "failed" | "uncertain";
  stage: string;
  affectedPath: string;
}

export class PatchApplyError extends Error {
  /** Records confirmed mutations and the operations that did not complete. */
  constructor(
    message: string,
    readonly files: FileChange[],
    readonly failed: FailedOperation | undefined,
    readonly pending: OperationReference[],
    readonly moves: PatchMove[],
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "PatchApplyError";
  }
}

interface Target {
  path: string;
  absolute: string;
  canonical: string;
  symlink: boolean;
}

interface TextState {
  text: string;
  bytes: Buffer;
  mode: number;
  identity?: string;
}

interface Snapshot extends TextState {
  metadata: Stats;
}

interface PlannedOperation {
  operation: PatchOperation;
  source: Target;
  destination?: Target;
  before: TextState | null;
  after: TextState | null;
}

/** Checks a Node filesystem error without suppressing unrelated failures. */
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Reads a directory entry, returning null only for a missing path. */
async function optionalLstat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

/** Stops at an operation boundary while keeping in-flight I/O under the queue. */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Patch application cancelled", { cause: signal.reason });
}

/**
 * Resolves existing symlinks and missing children of an existing directory.
 * Missing targets reached through symlink aliases are rejected because Pi's
 * public queue uses their lexical path until the file exists.
 */
async function resolveTarget(path: string, cwd: string): Promise<Target> {
  if (
    path.length === 0 || path.includes("\0") || Buffer.from(path, "utf8").toString("utf8") !== path ||
    path.endsWith(sep) ||
    (sep === "\\" && path.endsWith("/"))
  ) {
    throw new Error(`Invalid file path: '${path}'`);
  }
  const absolute = resolve(cwd, path);
  if (dirname(absolute) === absolute) throw new Error(`A filesystem root is not a file: '${path}'`);
  const entry = await optionalLstat(absolute);
  const suffix: string[] = [];
  let ancestor = absolute;
  let canonical: string;
  for (;;) {
    try {
      canonical = await realpath(ancestor);
      break;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      if (await optionalLstat(ancestor)) throw new Error(`Dangling symlink in path '${path}'`);
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  if (suffix.length && !(await stat(canonical)).isDirectory()) {
    throw new Error(`A parent of '${path}' is not a directory`);
  }
  canonical = resolve(canonical, ...suffix);
  if (entry === null && absolute !== canonical) {
    throw new Error(`Use the canonical path '${canonical}' to create '${path}' through a symlinked directory`);
  }
  return { path, absolute, canonical, symlink: entry?.isSymbolicLink() ?? false };
}

/** Compares metadata around reads and between snapshot validation and writing. */
function sameMetadata(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Reads a regular UTF-8 text file without replacing malformed bytes or BOM. */
async function readSnapshot(path: string): Promise<Snapshot | null> {
  const entry = await optionalLstat(path);
  if (entry === null) return null;
  if (!entry.isFile()) throw new Error(`Expected a regular text file at '${path}'`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`Expected a regular text file at '${path}'`);
    const bytes = await handle.readFile();
    if (!sameMetadata(metadata, await handle.stat())) {
      throw new Error(`File changed while being read: '${path}'`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      throw new Error(`File is not valid UTF-8 text: '${path}'`, { cause: error });
    }
    if (text.includes("\0")) throw new Error(`Binary file contains NUL bytes: '${path}'`);
    return {
      text, bytes, metadata,
      mode: metadata.mode & 0o7777,
      identity: `${metadata.dev}:${metadata.ino}`,
    };
  } finally {
    await handle.close();
  }
}

/** Encodes patch output without silently replacing unpaired UTF-16 surrogates. */
function textState(text: string, mode: number, identity?: string): TextState {
  const bytes = Buffer.from(text, "utf8");
  if (text.includes("\0") || bytes.toString("utf8") !== text) {
    throw new Error("Patch output must be valid Unicode text without NUL characters");
  }
  return { text, bytes, mode, ...(identity === undefined ? {} : { identity }) };
}

/** Reads a resolved snapshot and, when supplied, compares its expected bytes. */
async function assertCurrent(
  target: Target,
  expected?: TextState | null,
): Promise<Snapshot | null> {
  const resolved = await resolveTarget(target.absolute, ".");
  if (resolved.canonical !== target.canonical || resolved.symlink !== target.symlink) {
    throw new Error(`Path resolution changed since preflight: '${target.path}'`);
  }
  const current = await readSnapshot(target.canonical);
  if (
    expected !== undefined && ((expected === null) !== (current === null) ||
    (expected && current && (
      !expected.bytes.equals(current.bytes) || expected.mode !== current.mode ||
      (expected.identity !== undefined && expected.identity !== current.identity)
    )))
  ) {
    throw new Error(`File changed since preflight: '${target.path}'`);
  }
  return current;
}

/** Acquires deduplicated canonical paths in a fixed order for the entire patch. */
async function withPaths<T>(
  paths: readonly string[],
  run: () => Promise<T>,
  signal?: AbortSignal,
  index = 0,
): Promise<T> {
  checkAbort(signal);
  const path = paths[index];
  if (path === undefined) return run();
  return withFileMutationQueue(path, () => withPaths(paths, run, signal, index + 1));
}

/** Creates the small operation description used in failure reports. */
function reference(operation: PatchOperation): OperationReference {
  return {
    kind: operation.kind,
    path: operation.path,
    ...(operation.kind === "update" && operation.movePath !== undefined
      ? { movePath: operation.movePath }
      : {}),
  };
}

/** Describes an operation and its move destination in a readable error. */
function operationLabel(operation: OperationReference): string {
  return `${operation.kind} ${operation.path}${operation.movePath === undefined ? "" : ` -> ${operation.movePath}`}`;
}

/**
 * Preflights every change before writing, then commits in patch order.
 * Existing Add/Move destinations are rejected. Moves create the destination
 * before removing the source and retain the source permission bits.
 */
export async function applyPatch(
  patch: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<PatchResult> {
  const files: FileChange[] = [];
  const moves: PatchMove[] = [];
  let operations: PatchOperation[] = [];
  let activeIndex = -1;
  let completed = 0;
  let committing = false;
  let failed: FailedOperation | undefined;
  let createdParents = false;
  try {
    checkAbort(signal);
    operations = parsePatch(patch);
    if (cwd.includes("\0") || !(await stat(cwd)).isDirectory()) {
      throw new Error(`Working directory is not a directory: '${cwd}'`);
    }
    const plan: PlannedOperation[] = [];
    for (const [index, operation] of operations.entries()) {
      checkAbort(signal);
      activeIndex = index;
      failed = { ...reference(operation), status: "failed", stage: "resolve paths", affectedPath: operation.path };
      const source = await resolveTarget(operation.path, cwd);
      const destination = operation.kind === "update" && operation.movePath !== undefined
        ? await resolveTarget(operation.movePath, cwd)
        : undefined;
      if (source.symlink && (operation.kind === "delete" || destination)) {
        throw new Error(`Deleting or moving a symlink is unsupported: '${operation.path}'; use its target path explicitly`);
      }
      if ((operation.kind === "add" && source.symlink) || destination?.symlink) {
        throw new Error(`Add or Move destination already exists as a symlink: '${destination?.path ?? source.path}'`);
      }
      if (destination?.canonical === source.canonical) {
        throw new Error(`A file cannot be moved to itself: '${operation.path}'`);
      }
      plan.push({ operation, source, ...(destination ? { destination } : {}), before: null, after: null });
      activeIndex = -1;
      failed = undefined;
    }
    activeIndex = -1;
    failed = undefined;
    const targets = new Map<string, Target>();
    for (const item of plan) {
      targets.set(item.source.canonical, item.source);
      if (item.destination) targets.set(item.destination.canonical, item.destination);
    }
    const paths = [...targets.keys()].sort();
    for (const path of paths) {
      for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
        if (targets.has(parent)) {
          throw new Error(`A patch cannot target both a file and a child of that file: '${parent}', '${path}'`);
        }
      }
    }
    return await withPaths(paths, async () => {
      const initial = new Map<string, Snapshot | null>();
      const identities = new Map<string, string>();
      for (const [path, target] of targets) {
        checkAbort(signal);
        activeIndex = plan.findIndex((item) => item.source.canonical === path || item.destination?.canonical === path);
        failed = {
          ...reference(operations[activeIndex]!),
          status: "failed", stage: "read preflight snapshot", affectedPath: target.path,
        };
        const snapshot = await assertCurrent(target);
        if (snapshot?.identity) {
          const alias = identities.get(snapshot.identity);
          if (alias !== undefined && alias !== path) {
            throw new Error(`Patch paths refer to the same hard-linked file: '${alias}', '${path}'`);
          }
          identities.set(snapshot.identity, path);
        }
        initial.set(path, snapshot);
        activeIndex = -1;
        failed = undefined;
      }
      const states = new Map<string, TextState | null>(initial);
      for (const [index, item] of plan.entries()) {
        checkAbort(signal);
        activeIndex = index;
        const { operation, source, destination } = item;
        failed = { ...reference(operation), status: "failed", stage: "preflight", affectedPath: operation.path };
        const before = states.get(source.canonical)!;
        item.before = before;
        if (operation.kind === "add") {
          if (before) throw new Error(`Add destination already exists: '${operation.path}'`);
          item.after = textState(operation.contents, 0o666 & ~process.umask());
        } else {
          if (!before) throw new Error(`File does not exist: '${operation.path}'`);
          if (operation.kind === "update") {
            item.after = textState(
              applyUpdate(operation.path, before.text, operation.chunks),
              before.mode,
              destination ? undefined : before.identity,
            );
          }
        }
        if (destination) {
          if (states.get(destination.canonical)) {
            throw new Error(`Move destination already exists: '${destination.path}'`);
          }
          states.set(destination.canonical, item.after);
          states.set(source.canonical, null);
        } else {
          states.set(source.canonical, item.after);
        }
        activeIndex = -1;
        failed = undefined;
      }
      activeIndex = -1;
      failed = undefined;
      for (const [index, item] of plan.entries()) {
        checkAbort(signal);
        activeIndex = index;
        failed = {
          ...reference(item.operation),
          status: "failed", stage: "recheck preflight snapshots", affectedPath: item.source.path,
        };
        await assertCurrent(item.source, initial.get(item.source.canonical)!);
        if (item.destination) {
          failed.affectedPath = item.destination.path;
          await assertCurrent(item.destination, initial.get(item.destination.canonical)!);
        }
        activeIndex = -1;
        failed = undefined;
      }
      checkAbort(signal);
      committing = true;
      for (const [index, item] of plan.entries()) {
        checkAbort(signal);
        activeIndex = index;
        const { operation, source, destination, before, after } = item;
        failed = { ...reference(operation), status: "failed", stage: "check snapshot", affectedPath: source.path };
        const current = await assertCurrent(source, before);
        if (destination) await assertCurrent(destination, null);
        checkAbort(signal);
        if (operation.kind === "add" || destination) {
          const target = destination ?? source;
          failed.affectedPath = dirname(target.canonical);
          failed.stage = "create parent directories";
          failed.status = "uncertain";
          createdParents = true;
          await mkdir(dirname(target.canonical), { recursive: true });
          failed.affectedPath = target.path;
          failed.stage = "create destination";
          failed.status = "failed";
          checkAbort(signal);
          const handle = await open(target.canonical, "wx", after!.mode);
          try {
            failed.stage = "write destination";
            failed.status = "uncertain";
            await handle.writeFile(after!.bytes);
            files.push({ path: target.path, kind: "add", before: "", after: after!.text });
            if (destination) await handle.chmod(after!.mode);
          } finally {
            await handle.close();
          }
          if (destination) {
            failed.status = "failed";
            failed.affectedPath = source.path;
            failed.stage = "check move source";
            checkAbort(signal);
            await assertCurrent(source, before);
            await assertCurrent(destination, after);
            checkAbort(signal);
          }
        }
        if (operation.kind === "delete" || destination) {
          failed.stage = "remove source";
          failed.status = "uncertain";
          await unlink(source.canonical);
          files.push({ path: source.path, kind: "delete", before: before!.text, after: "" });
          if (destination) moves.push({ from: source.path, to: destination.path });
        } else if (operation.kind === "update") {
          failed.stage = "open update";
          const handle = await open(source.canonical, constants.O_RDWR | constants.O_NOFOLLOW);
          try {
            if (!sameMetadata(current!.metadata, await handle.stat())) {
              throw new Error(`File changed before writing: '${source.path}'`);
            }
            checkAbort(signal);
            failed.stage = "write update";
            failed.status = "uncertain";
            await handle.truncate(0);
            await handle.writeFile(after!.bytes);
            files.push({ path: source.path, kind: "update", before: before!.text, after: after!.text });
          } finally {
            await handle.close();
          }
        }
        completed++;
        activeIndex = -1;
        failed = undefined;
      }
      return {
        summary: "Success. Updated the following files:\n" + operations.map((operation) =>
          `${operation.kind === "add" ? "A" : operation.kind === "delete" ? "D" : "M"} ${
            operation.kind === "update" ? operation.movePath ?? operation.path : operation.path
          }`,
        ).join("\n"),
        files,
        moves,
      };
    }, signal);
  } catch (error) {
    const pending = operations
      .filter((_, index) => committing ? index >= completed && index !== activeIndex : index !== activeIndex)
      .map(reference);
    const cause = error instanceof Error ? error.message : String(error);
    const confirmed = files.length ? files.map((file) => `- ${file.kind} ${file.path}`).join("\n") : "- none";
    const failure = failed
      ? `${failed.status === "uncertain" ? "Uncertain" : "Failed"} operation: ${operationLabel(failed)}\nStage: ${failed.stage}; path: ${failed.affectedPath}${
          failed.status === "uncertain" ? "\nThe affected path may contain partial changes." : ""
        }`
      : "No active file operation.";
    throw new PatchApplyError(
      `${committing ? "Patch commit" : "Patch preflight"} failed: ${cause}\n\nConfirmed changes:\n${confirmed}\n\n${failure}\n\nPending operations:\n${
        pending.length ? pending.map((operation) => `- ${operationLabel(operation)}`).join("\n") : "- none"
      }${createdParents ? "\n\nParent directories may have been created." : ""}`,
      files, failed, pending, moves, error,
    );
  }
}
