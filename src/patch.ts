/**
 * Display-only render patches.
 *
 * pi builds the transcript from `ToolExecutionComponent` and
 * `AssistantMessageComponent` instances it owns, so there is no seam to hook
 * other than their `render`. Both classes are part of the package's public API.
 * Nothing here touches the session file, the agent loop, or tool state: the
 * components keep their full content and simply draw fewer lines.
 *
 * Cost when folding is off: one boolean read per component per frame.
 * Cost when folding is on: one map lookup, and for a folded component either an
 * empty array or a cached single line — strictly less work than drawing the
 * tool output it replaces.
 */

import { AssistantMessageComponent, type Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import type { FoldGroup } from "./plan.ts";
import { state } from "./state.ts";
import { foldLineText, pickVerb } from "./summary.ts";

/** Internals of the patched components that pi declares private. */
type ToolInternals = { toolCallId: string; ui?: TUI };
type AssistantInternals = { hasToolCalls: boolean; isStreaming: boolean; lastMessage?: { stopReason?: string } };

interface CachedLine {
	theme: Theme;
	width: number;
	lines: string[];
}

/**
 * Fold lines are cheap to build but every group in the transcript re-renders on
 * every frame in fullscreen mode, so memoize per group. Groups are replaced
 * wholesale when the plan is rebuilt, which drops their entries with them.
 */
const lineCache = new WeakMap<FoldGroup, CachedLine>();

function renderFoldLine(group: FoldGroup, width: number): string[] | undefined {
	const theme = state.theme;
	if (!theme) return undefined;

	const cached = lineCache.get(group);
	if (cached && cached.theme === theme && cached.width === width) return cached.lines;

	const verb = pickVerb(state.config.verbs, group.key);
	const text = new Text(foldLineText(theme, verb, group.durationMs, group.count), 1, 0);
	const lines = ["", ...text.render(width)];
	lineCache.set(group, { theme, width, lines });
	return lines;
}

let installed = false;

export function installFoldPatches(): void {
	if (installed) return;
	installed = true;

	const renderTool = ToolExecutionComponent.prototype.render;
	ToolExecutionComponent.prototype.render = function (this: ToolExecutionComponent, width: number): string[] {
		const self = this as unknown as ToolInternals;
		// The component holds the live TUI reference; borrow it once so a toggle
		// can force a repaint without registering a dummy widget.
		if (!state.tui && self.ui) state.tui = self.ui;

		if (!state.collapsed) return renderTool.call(this, width);

		const decision = state.getPlan().byToolCallId.get(self.toolCallId);
		// Unknown id means the call is still running, was aborted before it
		// returned, or predates the rendered context window. Either way, show it.
		if (!decision) return renderTool.call(this, width);
		if (decision.kind === "hidden") return [];

		return renderFoldLine(decision.group, width) ?? renderTool.call(this, width);
	};

	const renderAssistant = AssistantMessageComponent.prototype.render;
	AssistantMessageComponent.prototype.render = function (this: AssistantMessageComponent, width: number): string[] {
		if (state.collapsed && state.config.mode === "turn") {
			const self = this as unknown as AssistantInternals;
			// A settled message that carries tool calls is an intermediate step, so it
			// folds away with them. The streaming one stays visible so the live turn
			// keeps narrating itself, and any stop reason other than a clean handoff
			// to tools (aborted, error, length) stays visible so its notice survives.
			if (self.hasToolCalls && !self.isStreaming && self.lastMessage?.stopReason === "toolUse") return [];
		}
		return renderAssistant.call(this, width);
	};
}
