/**
 * Turns the session's entry list into a per-tool-call render decision.
 *
 * The plan is the only place that needs to know about ordering and timing, so
 * the render patches stay a single map lookup. It is rebuilt lazily (see
 * `state.ts`), never per frame.
 *
 * Only tool calls that actually returned a `toolResult` are folded. A call that
 * is still running, or that was cut short by an abort or an error, is absent
 * from the plan and keeps rendering normally — toggling while the agent works
 * folds the completed history, and a fold line never swallows an abort notice.
 */

import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { FoldMode } from "./config.ts";

export interface FoldGroup {
	/** Leading tool call id of the group. Stable, so the verb never flickers. */
	key: string;
	/** How many tool calls this line stands in for. */
	count: number;
	/** Wall-clock span the line reports, in milliseconds. */
	durationMs: number;
}

export type FoldDecision = { kind: "hidden" } | { kind: "summary"; group: FoldGroup };

export interface FoldPlan {
	byToolCallId: Map<string, FoldDecision>;
}

export const EMPTY_PLAN: FoldPlan = { byToolCallId: new Map() };

/**
 * Messages carry a precise Unix-ms timestamp (assistant: request start,
 * toolResult: completion). The entry's ISO timestamp is the fallback for
 * sessions written before that field existed.
 */
function timeOf(entry: SessionMessageEntry): number {
	const fromMessage = (entry.message as { timestamp?: unknown }).timestamp;
	if (typeof fromMessage === "number" && Number.isFinite(fromMessage) && fromMessage > 0) {
		return fromMessage;
	}
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function buildFoldPlan(entries: readonly SessionEntry[], mode: FoldMode): FoldPlan {
	const byToolCallId = new Map<string, FoldDecision>();

	// Pass 1: completion time of every tool call that has already returned.
	const completedAt = new Map<string, number>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "toolResult") continue;
		completedAt.set(entry.message.toolCallId, timeOf(entry));
	}

	// Pass 2: walk in order and cut the finished calls into groups.
	let members: string[] = [];
	let startMs = 0;
	let endMs = 0;
	let turnStartMs = 0;

	const flush = (): void => {
		const leader = members[0];
		if (leader === undefined) return;
		byToolCallId.set(leader, {
			kind: "summary",
			group: { key: leader, count: members.length, durationMs: Math.max(0, endMs - startMs) },
		});
		for (let i = 1; i < members.length; i++) {
			byToolCallId.set(members[i] as string, { kind: "hidden" });
		}
		members = [];
	};

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;

		if (message.role === "user") {
			// A user message always ends a turn, including steering and follow-ups
			// injected mid-turn.
			flush();
			turnStartMs = timeOf(entry);
			continue;
		}
		if (message.role !== "assistant") continue;

		const messageMs = timeOf(entry);
		const finished: string[] = [];
		let blockEndMs = messageMs;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			// Aborted and errored calls never produce a toolResult. pi renders them
			// with the failure inline, which is the one thing worth keeping.
			const doneMs = completedAt.get(block.id);
			if (doneMs === undefined) continue;
			finished.push(block.id);
			if (doneMs > blockEndMs) blockEndMs = doneMs;
		}
		if (finished.length === 0) continue;

		if (mode === "block") flush();
		if (members.length === 0) {
			// Turn mode reports the whole turn, starting at the user's prompt.
			// Block mode reports this step only, starting when the request went out.
			startMs = mode === "turn" && turnStartMs > 0 && turnStartMs <= messageMs ? turnStartMs : messageMs;
		}
		members.push(...finished);
		endMs = blockEndMs;
	}
	flush();

	return { byToolCallId };
}
