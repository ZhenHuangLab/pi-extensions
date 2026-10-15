/**
 * pi-better-explore
 *
 * Keeps exploration output small by enforcing, at the tool boundary, what
 * would otherwise be prompt rules:
 *
 *   1. Searching through bash (`grep`, `rg`, `find`, `fd`) is blocked in favour
 *      of the session's search tool, sift-light first.
 *   2. Large dumps through bash (`cat` of a big file, `ls -R` of a big tree) are
 *      blocked in favour of bounded reads and file search. Small ones pass,
 *      because blocking them costs a turn and saves nothing.
 *   3. `read` without offset/limit on a large file is blocked, and the model is
 *      told the file's real size so it can pick a region.
 *
 * Calls made by another tool, such as a codemode script, return their output to
 * that tool and not to the context, so the size rules leave them alone.
 *
 * Everything happens in `tool_call`, which is append-only with respect to the
 * request: no system-prompt or tool-schema mutation, so the prompt cache prefix
 * is never invalidated.
 *
 * Block messages are short and phrased as positive directives. Prohibitions
 * ("do not use X") prime the very behaviour they forbid, so every message names
 * only the action to take.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { type Finding, inspectBashCommand, type SearchCapability } from "./src/bash-rules.ts";
import { isLargeListing, MAX_LISTING_ENTRIES } from "./src/listing-rule.ts";
import { inspectRead, type OversizedRead, resolveReadPath } from "./src/read-rule.ts";

interface Route {
	/** Tool that should do the job. */
	tool: string;
	/** True for pi's own tools, whose names are also shell commands. */
	builtIn?: boolean;
	/** Call shape the job needs, e.g. "mode=files". */
	hint?: string;
	/** Bash command left allowed for the cases the tool cannot cover. */
	bash?: string;
}

interface Guidance {
	/** Imperative opening, e.g. "Search content with". */
	verb: string;
	/** Candidate tools, best first. The first one active in the session is named. */
	routes: Route[];
}

const SEARCH_GUIDANCE: Record<SearchCapability, Guidance> = {
	searchContent: {
		verb: "Search content with",
		routes: [{ tool: "sift-light" }, { tool: "grep", builtIn: true, bash: "rg" }, { tool: "signal_grep", bash: "rg" }],
	},
	findFiles: {
		verb: "Find files with",
		routes: [
			{ tool: "sift-light", hint: "mode=files" },
			{ tool: "fffind", bash: "fd" },
			{ tool: "find", builtIn: true, bash: "fd" },
		],
	},
};

const READ_TOOL = "read";

/**
 * How many times one path may be blocked before it is let through. Keeps a
 * model that never adds offset/limit from looping.
 */
const READ_BLOCK_ALLOWANCE = 2;

interface BashInput {
	command?: unknown;
}

interface ReadInput {
	path?: unknown;
	offset?: unknown;
	limit?: unknown;
}

type Block = { block: true; reason: string };

function describe(route: Route): string {
	const hint = route.hint ? ` (${route.hint})` : "";
	return `the ${route.builtIn ? "built-in " : ""}${route.tool} tool${hint}`;
}

function isSet(value: unknown): boolean {
	return value !== undefined && value !== null;
}

function describeShape({ bytes, lines }: OversizedRead): string {
	return lines === null ? `${Math.round(bytes / 1024)} KB` : `${lines.toLocaleString("en-US")} lines`;
}

export default function (pi: ExtensionAPI) {
	const readBlocks = new Map<string, number>();

	const isActive = (tool: string): boolean => pi.getActiveTools().includes(tool);

	const activeRoute = (capability: SearchCapability): Route | undefined => {
		const active = new Set(pi.getActiveTools());
		return SEARCH_GUIDANCE[capability].routes.find((route) => active.has(route.tool));
	};

	/** "Locate with …, then <action>", or just the action when no search tool is active. */
	const locateThen = (action: string): string => {
		const route = activeRoute("searchContent");
		return route ? `Locate with ${describe(route)}, then ${action}` : action[0].toUpperCase() + action.slice(1);
	};

	/** The file's shape when an unbounded read of it should be blocked, counting the block. */
	const oversized = async (absolutePath: string): Promise<OversizedRead | null> => {
		const strikes = readBlocks.get(absolutePath) ?? 0;
		if (strikes >= READ_BLOCK_ALLOWANCE) return null;
		const shape = await inspectRead(absolutePath);
		if (shape) readBlocks.set(absolutePath, strikes + 1);
		return shape;
	};

	const judge = async (finding: Finding, nested: boolean): Promise<string | undefined> => {
		switch (finding.kind) {
			case "search": {
				const route = activeRoute(finding.capability);
				// Nothing better is active, or this is the route's own fallback.
				if (!route || route.bash === finding.binary) return undefined;
				const fallback = route.bash ? ` If the tool cannot cover it, use \`${route.bash}\` in bash instead.` : "";
				return `${SEARCH_GUIDANCE[finding.capability].verb} ${describe(route)}.${fallback}`;
			}
			case "listing": {
				if (nested) return undefined;
				const route = activeRoute("findFiles");
				if (!route) return undefined;
				if (!(await isLargeListing(finding.directories, finding.includeHidden))) return undefined;
				return `This recursive listing has over ${MAX_LISTING_ENTRIES} entries. ${SEARCH_GUIDANCE.findFiles.verb} ${describe(route)}.`;
			}
			case "dump": {
				if (nested || !isActive(READ_TOOL)) return undefined;
				for (const { operand, path } of finding.files) {
					const shape = await oversized(path);
					if (!shape) continue;
					const read = locateThen(`read it with the built-in ${READ_TOOL} tool and offset+limit`);
					return `\`${operand}\` is ${describeShape(shape)}. ${read}. Whole file: read with limit=2000.`;
				}
				return undefined;
			}
		}
	};

	const checkBash = async (input: BashInput, cwd: string, nested: boolean): Promise<Block | undefined> => {
		if (typeof input.command !== "string") return undefined;
		for (const finding of inspectBashCommand(input.command, cwd)) {
			const reason = await judge(finding, nested);
			if (reason) return { block: true, reason };
		}
		return undefined;
	};

	const checkRead = async (input: ReadInput, cwd: string, nested: boolean): Promise<Block | undefined> => {
		if (nested || typeof input.path !== "string") return undefined;
		// Strict tool schemas send omitted optional fields as null.
		if (isSet(input.offset) || isSet(input.limit)) return undefined;

		const shape = await oversized(resolveReadPath(input.path, cwd));
		if (!shape) return undefined;
		return {
			block: true,
			reason: `This file is ${describeShape(shape)}. ${locateThen("read with offset+limit")}. Whole file: repeat with limit=2000.`,
		};
	};

	pi.on("tool_call", async (event, ctx) => {
		// Output of a nested call goes to the calling tool, e.g. a codemode script.
		const nested = event.parentToolCallId !== undefined;
		switch (event.toolName.toLowerCase()) {
			case "bash":
				return await checkBash(event.input as BashInput, ctx.cwd, nested);
			case "read":
				return await checkRead(event.input as ReadInput, ctx.cwd, nested);
			default:
				return undefined;
		}
	});
}
