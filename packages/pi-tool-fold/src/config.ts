/**
 * Persisted configuration for pi-tool-fold.
 *
 * Lives next to pi's other extension configs in the agent directory
 * (`~/.pi/agent/pi-tool-fold.json`). The session file is never touched.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How completed tool calls are aggregated into a single fold line.
 *
 * - `turn`: everything between two user messages folds into one line, and the
 *   intermediate assistant messages (the ones that only exist to carry tool
 *   calls) are hidden too. Only the user prompt and the final reply remain.
 * - `block`: each assistant step's batch of tool calls folds into its own line.
 *   Intermediate assistant text stays visible.
 */
export type FoldMode = "turn" | "block";

export interface FoldConfig {
	/** Keybinding that toggles folding. See pi's keybindings.md for the format. */
	shortcut: string;
	mode: FoldMode;
	/** Persisted toggle state, restored on the next start. */
	collapsed: boolean;
	/** Past-tense verbs used in the fold line, picked deterministically per group. */
	verbs: string[];
}

const FILE_NAME = "pi-tool-fold.json";

export const DEFAULT_VERBS = [
	"Worked",
	"Pondered",
	"Solved",
	"Cooked",
	"Tinkered",
	"Noodled",
	"Wrangled",
	"Schemed",
	"Deliberated",
	"Ruminated",
	"Spelunked",
	"Untangled",
	"Forged",
	"Chiseled",
	"Brewed",
	"Conjured",
	"Percolated",
	"Marinated",
	"Whittled",
	"Grokked",
	"Rummaged",
	"Excavated",
	"Distilled",
	"Orchestrated",
	"Toiled",
	"Mulled",
	"Puttered",
	"Hustled",
];

export const DEFAULT_CONFIG: FoldConfig = {
	shortcut: "ctrl+e",
	mode: "turn",
	collapsed: false,
	verbs: DEFAULT_VERBS,
};

export function configPath(): string {
	return join(getAgentDir(), FILE_NAME);
}

function isFoldMode(value: unknown): value is FoldMode {
	return value === "turn" || value === "block";
}

function readVerbs(value: unknown): string[] {
	if (!Array.isArray(value)) return DEFAULT_VERBS;
	const verbs = value.filter((verb): verb is string => typeof verb === "string" && verb.trim().length > 0);
	return verbs.length > 0 ? verbs : DEFAULT_VERBS;
}

/** Read the config file, falling back to defaults for anything missing or malformed. */
export function loadConfig(): FoldConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath(), "utf8"));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
	if (typeof raw !== "object" || raw === null) return { ...DEFAULT_CONFIG };
	const record = raw as Record<string, unknown>;
	return {
		shortcut: typeof record.shortcut === "string" && record.shortcut.trim() ? record.shortcut.trim() : DEFAULT_CONFIG.shortcut,
		mode: isFoldMode(record.mode) ? record.mode : DEFAULT_CONFIG.mode,
		collapsed: typeof record.collapsed === "boolean" ? record.collapsed : DEFAULT_CONFIG.collapsed,
		verbs: readVerbs(record.verbs),
	};
}

/**
 * Persist the config. Failures are swallowed: a read-only agent directory must
 * never break the toggle.
 */
export function saveConfig(config: FoldConfig): void {
	try {
		writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} catch {
		// Ignore - the toggle still works for this session.
	}
}

/** Materialize the defaults on first run so the options are discoverable. */
export function ensureConfigFile(config: FoldConfig): void {
	if (existsSync(configPath())) return;
	saveConfig(config);
}
