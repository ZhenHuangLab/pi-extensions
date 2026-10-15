/**
 * Guard against unbounded `read` calls.
 *
 * A read without offset/limit pulls the whole file into context. For anything
 * sizeable the model should locate first and then read the region, so this rule
 * reports the file's shape and lets the model decide again.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** Below this the whole-file read is cheap enough to never be worth a round trip. */
const ALWAYS_ALLOWED_BYTES = 8_000;

/** Above either threshold an unbounded read is blocked. */
const MAX_BYTES = 20_000;
const MAX_LINES = 600;

/** Reading a file this large just to count its lines is not worth it. */
const COUNT_LIMIT_BYTES = 5_000_000;

/** Extensions pi does not deliver as plain text, so the line budget is meaningless. */
const OPAQUE_EXTENSIONS = new Set([
	"bmp",
	"gif",
	"gz",
	"ico",
	"jpeg",
	"jpg",
	"mp4",
	"pdf",
	"png",
	"tar",
	"tgz",
	"webp",
	"zip",
	"zst",
]);

export interface OversizedRead {
	bytes: number;
	/** Null when the file was too large to count. */
	lines: number | null;
}

export function resolveReadPath(path: string, cwd: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function isOpaque(path: string): boolean {
	const base = path.split("/").pop() ?? path;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return false;
	return OPAQUE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * Returns the file's shape when an unbounded read should be blocked, or null
 * when it should be allowed through.
 */
export async function inspectRead(absolutePath: string): Promise<OversizedRead | null> {
	if (isOpaque(absolutePath)) return null;

	let bytes: number;
	try {
		const stats = await stat(absolutePath);
		if (!stats.isFile()) return null;
		bytes = stats.size;
	} catch {
		// Missing or unreadable: let the read tool report its own error.
		return null;
	}

	if (bytes <= ALWAYS_ALLOWED_BYTES) return null;
	if (bytes > COUNT_LIMIT_BYTES) return { bytes, lines: null };

	let lines: number;
	try {
		const text = await readFile(absolutePath, "utf8");
		if (text.includes("\u0000")) return null;
		lines = text.length === 0 ? 0 : text.split("\n").length;
	} catch {
		return null;
	}

	if (bytes <= MAX_BYTES && lines <= MAX_LINES) return null;
	return { bytes, lines };
}
