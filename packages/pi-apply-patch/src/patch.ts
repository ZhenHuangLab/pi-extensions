/**
 * Native apply_patch parsing and text updates, adapted from OpenAI Codex at
 * 4eb4a65407d98cebc4c83bf13be440b9fbc78a7c (Apache-2.0).
 */

export interface UpdateFileChunk {
  line: number;
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  contextLineIndices: [number, number][];
  isEndOfFile: boolean;
}

export type PatchOperation =
  | { kind: "add"; path: string; contents: string; line: number }
  | { kind: "delete"; path: string; line: number }
  | {
      kind: "update";
      path: string;
      movePath?: string;
      chunks: UpdateFileChunk[];
      line: number;
    };

export class PatchParseError extends Error {
  /** Creates a syntax error with a one-based source line number. */
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`Invalid patch at line ${line}: ${message}`);
    this.name = "PatchParseError";
  }
}

/** Trims the Unicode White_Space characters used by Rust's str::trim. */
function trim(text: string): string {
  return text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

/** Trims trailing Unicode White_Space without removing a leading diff marker. */
function trimEnd(text: string): string {
  return text.replace(/\p{White_Space}+$/u, "");
}

/** Creates an update chunk, including the location of its first patch line. */
function newChunk(line: number, changeContext?: string): UpdateFileChunk {
  return {
    line,
    ...(changeContext === undefined ? {} : { changeContext }),
    oldLines: [],
    newLines: [],
    contextLineIndices: [],
    isEndOfFile: false,
  };
}

/** Rejects file hunks and update chunks that contain no lines. */
function finishOperation(operation: PatchOperation, line: number): void {
  if (operation.kind === "add" && operation.contents.length === 0) {
    throw new PatchParseError(operation.line, `Add hunk for '${operation.path}' is empty`);
  }
  if (operation.kind !== "update") return;
  if (operation.chunks.length === 0) {
    throw new PatchParseError(operation.line, `Update hunk for '${operation.path}' is empty`);
  }
  const chunk = operation.chunks[operation.chunks.length - 1]!;
  if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
    throw new PatchParseError(line, "Update chunk does not contain any lines");
  }
}

/**
 * Parses one native Add/Delete/Update patch, with optional Move and EOF markers.
 * Shell wrappers and environment identifiers are rejected.
 */
export function parsePatch(text: string): PatchOperation[] {
  const lines = text.split("\n").map((line) => line.replace(/\r$/u, ""));
  let first = 0;
  let last = lines.length - 1;
  while (first < lines.length && trim(lines[first]!) === "") first++;
  while (last > first && trim(lines[last]!) === "") last--;
  if (trim(lines[first] ?? "") !== "*** Begin Patch") {
    throw new PatchParseError(Math.min(first + 1, lines.length), "The first line must be '*** Begin Patch'");
  }
  if (last <= first || trim(lines[last]!) !== "*** End Patch") {
    throw new PatchParseError(last + 1, "The last line must be '*** End Patch'");
  }

  const operations: PatchOperation[] = [];
  let operation: PatchOperation | undefined;
  for (let index = first + 1; index <= last; index++) {
    const raw = lines[index]!;
    const line = index + 1;
    if (raw.includes("\0")) throw new PatchParseError(line, "NUL characters are not allowed");
    const marker = index === last || operation?.kind !== "update" ? trim(raw) : trimEnd(raw);
    const header = /^\*\*\* (Add|Delete|Update) File: ([\s\S]*)$/u.exec(marker);
    if (marker === "*** End Patch" || header) {
      if (operation) finishOperation(operation, line);
      if (marker === "*** End Patch") {
        if (index !== last) throw new PatchParseError(line, "Unexpected '*** End Patch'");
        break;
      }
      const path = header![2]!;
      if (trim(path) === "") throw new PatchParseError(line, "A file path is required");
      switch (header![1]) {
        case "Add":
          operation = { kind: "add", path, contents: "", line };
          break;
        case "Delete":
          operation = { kind: "delete", path, line };
          break;
        default:
          operation = { kind: "update", path, chunks: [], line };
      }
      operations.push(operation);
      continue;
    }
    if (operation?.kind === "add" && raw.startsWith("+")) {
      operation.contents += `${raw.slice(1)}\n`;
      continue;
    }
    if (operation?.kind !== "update") {
      throw new PatchParseError(line, `Expected an Add, Delete, or Update file header, got '${raw}'`);
    }

    let chunk = operation.chunks[operation.chunks.length - 1];
    const updateLine = trimEnd(raw);
    const contextMarker = updateLine === "@@" || updateLine.startsWith("@@ ");
    if (chunk?.isEndOfFile) {
      if (updateLine === "") continue;
      if (!contextMarker) {
        throw new PatchParseError(line, "Expected an @@ marker after '*** End of File'");
      }
    }
    if (
      operation.chunks.length === 0 &&
      operation.movePath === undefined &&
      updateLine.startsWith("*** Move to: ")
    ) {
      const movePath = updateLine.slice("*** Move to: ".length);
      if (trim(movePath) === "") throw new PatchParseError(line, "A move destination is required");
      operation.movePath = movePath;
      continue;
    }
    if (contextMarker) {
      if (chunk && chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
        throw new PatchParseError(line, "The preceding update chunk is empty");
      }
      operation.chunks.push(newChunk(line, updateLine === "@@" ? undefined : updateLine.slice(3)));
      continue;
    }
    if (updateLine === "*** End of File") {
      if (!chunk || (chunk.oldLines.length === 0 && chunk.newLines.length === 0)) {
        throw new PatchParseError(line, "An EOF marker must follow a nonempty update chunk");
      }
      chunk.isEndOfFile = true;
      continue;
    }
    if (raw !== "" && ![" ", "+", "-"].includes(raw[0]!)) {
      throw new PatchParseError(line, "Update lines must start with ' ', '+', or '-'");
    }
    if (!chunk) {
      chunk = newChunk(line);
      operation.chunks.push(chunk);
    }
    const content = raw.slice(1);
    switch (raw[0]) {
      case "+":
        chunk.newLines.push(content);
        break;
      case "-":
        chunk.oldLines.push(content);
        break;
      default:
        chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
        chunk.oldLines.push(content);
        chunk.newLines.push(content);
    }
  }
  if (operations.length === 0) throw new PatchParseError(last + 1, "The patch contains no file hunks");
  return operations;
}

/** Maps only Codex's explicit punctuation and space characters to ASCII. */
function normalizePunctuation(text: string): string {
  return trim(text)
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/[\u2018-\u201b]/gu, "'")
    .replace(/[\u201c-\u201f]/gu, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/gu, " ");
}

/** Returns the input unchanged for the first, exact matching pass. */
function exact(text: string): string {
  return text;
}

/** Searches in four ordered passes, without allowing EOF to move before start. */
function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
): number | undefined {
  if (pattern.length === 0) return start <= lines.length ? start : undefined;
  const last = lines.length - pattern.length;
  const from = eof ? Math.max(start, last) : start;
  for (const normalize of [exact, trimEnd, trim, normalizePunctuation]) {
    const expected = pattern.map(normalize);
    for (let index = from; index <= last; index++) {
      if (expected.every((line, offset) => normalize(lines[index + offset]!) === line)) return index;
    }
  }
  return undefined;
}

interface SourceLine {
  text: string;
  ending: string;
}

interface Replacement {
  start: number;
  oldLength: number;
  lines: readonly string[];
  patchLine: number;
}

/**
 * Applies source-ordered update chunks while preserving BOM and unchanged lines.
 * Changed lines use the first existing ending, or LF for unterminated files.
 * As in Codex, every resulting logical line receives a final line ending.
 */
export function applyUpdate(
  path: string,
  originalText: string,
  chunks: readonly UpdateFileChunk[],
): string {
  if (chunks.length === 0) throw new Error(`Update for '${path}' contains no chunks`);
  const bom = originalText.startsWith("\ufeff") ? "\ufeff" : "";
  const text = originalText.slice(bom.length);
  const source: SourceLine[] = [];
  let preferredEnding: string | undefined;
  let lineStart = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/gu)) {
    preferredEnding ??= match[0];
    source.push({ text: text.slice(lineStart, match.index), ending: match[0] });
    lineStart = match.index + match[0].length;
  }
  if (lineStart < text.length) source.push({ text: text.slice(lineStart), ending: "" });
  const ending = preferredEnding ?? "\n";
  const originalLines = source.map((line) => line.text);
  const replacements: Replacement[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
      throw new PatchParseError(chunk.line, `Empty update chunk for '${path}'`);
    }
    if (chunk.changeContext !== undefined) {
      const context = seekSequence(originalLines, [chunk.changeContext], cursor, false);
      if (context === undefined) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in '${path}' (patch line ${chunk.line})`);
      }
      cursor = context + 1;
    }
    if (chunk.oldLines.length === 0) {
      replacements.push({
        start: source.length,
        oldLength: 0,
        lines: chunk.newLines,
        patchLine: chunk.line,
      });
      continue;
    }
    let pattern: readonly string[] = chunk.oldLines;
    let newLines: readonly string[] = chunk.newLines;
    let start = seekSequence(originalLines, pattern, cursor, chunk.isEndOfFile);
    if (start === undefined && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newLines[newLines.length - 1] === "") newLines = newLines.slice(0, -1);
      start = seekSequence(originalLines, pattern, cursor, chunk.isEndOfFile);
    }
    if (start === undefined) {
      throw new Error(
        `Failed to find expected lines in '${path}' (patch line ${chunk.line}):\n${chunk.oldLines.join("\n")}`,
      );
    }
    let oldStart = 0;
    let newStart = 0;
    for (const [oldContext, newContext] of chunk.contextLineIndices) {
      if (oldContext >= pattern.length || newContext >= newLines.length) break;
      if (oldContext < oldStart || newContext < newStart) {
        throw new PatchParseError(chunk.line, `Backtracking context indices for '${path}'`);
      }
      if (oldStart !== oldContext || newStart !== newContext) {
        replacements.push({
          start: start + oldStart,
          oldLength: oldContext - oldStart,
          lines: newLines.slice(newStart, newContext),
          patchLine: chunk.line,
        });
      }
      oldStart = oldContext + 1;
      newStart = newContext + 1;
    }
    if (oldStart !== pattern.length || newStart !== newLines.length) {
      replacements.push({
        start: start + oldStart,
        oldLength: pattern.length - oldStart,
        lines: newLines.slice(newStart),
        patchLine: chunk.line,
      });
    }
    cursor = start + pattern.length;
  }

  // Stable sorting keeps multiple appends in their original patch order.
  replacements.sort((a, b) => a.start - b.start);
  const result: SourceLine[] = [];
  let sourceIndex = 0;
  for (const replacement of replacements) {
    if (replacement.start < sourceIndex || replacement.start + replacement.oldLength > source.length) {
      throw new PatchParseError(replacement.patchLine, `Overlapping or backtracking replacements for '${path}'`);
    }
    for (let index = sourceIndex; index < replacement.start; index++) result.push(source[index]!);
    for (const line of replacement.lines) result.push({ text: line, ending });
    sourceIndex = replacement.start + replacement.oldLength;
  }
  for (let index = sourceIndex; index < source.length; index++) result.push(source[index]!);
  return bom + result.map((line) => line.text + (line.ending || ending)).join("");
}
