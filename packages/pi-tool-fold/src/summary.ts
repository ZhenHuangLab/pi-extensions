/**
 * The text of a fold line: a verb, how long the folded work took, and how many
 * tool calls it stands in for.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

const FOLD_MARKER = "⋯";

function pad(value: number): string {
	return value < 10 ? `0${value}` : `${value}`;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
	if (m > 0) return `${m}m ${pad(s)}s`;
	return `${s}s`;
}

/**
 * FNV-1a over the group key. Deterministic, so a group keeps its verb across
 * every re-render, width change and restart.
 */
export function pickVerb(verbs: readonly string[], key: string): string {
	if (verbs.length === 0) return "Worked";
	let hash = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return verbs[(hash >>> 0) % verbs.length] as string;
}

export function foldLineText(theme: Theme, verb: string, durationMs: number, count: number): string {
	const label = `${verb} for ${formatDuration(durationMs)}`;
	const tools = count === 1 ? "1 tool" : `${count} tools`;
	return `${theme.fg("dim", FOLD_MARKER)} ${theme.italic(theme.fg("muted", label))} ${theme.fg("dim", `· ${tools}`)}`;
}
