/**
 * pi-tool-fold
 *
 * Folds completed tool calls in the transcript into a single line:
 *
 *     ⋯ Pondered for 1m 04s · 9 tools
 *
 * Toggled with a keybinding (`ctrl+e` by default). Purely a rendering change —
 * the session file, the LLM context and tool state are untouched, so folding
 * and unfolding is lossless and safe to do mid-turn. Only finished tool calls
 * fold; whatever the agent is running right now stays on screen.
 *
 * Two aggregation modes, see `src/config.ts`:
 *   turn  - one line per user turn, intermediate assistant steps hidden too
 *   block - one line per assistant step, intermediate assistant text kept
 *
 * Config: ~/.pi/agent/pi-tool-fold.json
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

import { configPath, ensureConfigFile, type FoldMode, loadConfig } from "./src/config.ts";
import { installFoldPatches } from "./src/patch.ts";
import { state } from "./src/state.ts";

function describe(): string {
	const scope = state.config.mode === "turn" ? "per turn" : "per step";
	return state.config.collapsed ? `Tool calls: folded (${scope})` : "Tool calls: unfolded";
}

function setCollapsed(ctx: ExtensionContext, collapsed: boolean): void {
	state.update({ collapsed });
	ctx.ui.notify(describe());
}

function setMode(ctx: ExtensionContext, mode: FoldMode): void {
	// Picking a mode is only meaningful while folded, so switch folding on with it.
	state.update({ mode, collapsed: true });
	ctx.ui.notify(describe());
}

export default function (pi: ExtensionAPI) {
	state.config = loadConfig();

	pi.on("session_start", (_event, ctx) => {
		state.bindSession(ctx);
		if (ctx.mode !== "tui") return;
		ensureConfigFile(state.config);
		installFoldPatches();
	});

	// Appended entries are picked up for free: the plan cache is keyed on the
	// branch leaf, which moves with every append. Only reshaping the branch
	// without moving the leaf needs an explicit signal.
	const invalidate = () => state.invalidate();
	pi.on("session_compact", invalidate);
	pi.on("session_tree", invalidate);

	pi.registerShortcut(state.config.shortcut as KeyId, {
		description: "Fold or unfold completed tool calls",
		handler: (ctx) => setCollapsed(ctx, !state.config.collapsed),
	});

	pi.registerCommand("tool-fold", {
		description: "Fold completed tool calls into a one-line summary (on | off | turn | block)",
		handler: async (args, ctx) => {
			switch (args.trim().toLowerCase()) {
				case "on":
					return setCollapsed(ctx, true);
				case "off":
					return setCollapsed(ctx, false);
				case "turn":
					return setMode(ctx, "turn");
				case "block":
					return setMode(ctx, "block");
				case "":
					return setCollapsed(ctx, !state.config.collapsed);
				default:
					ctx.ui.notify(
						`Usage: /tool-fold [on|off|turn|block] — ${describe()}, shortcut ${state.config.shortcut}, config ${configPath()}`,
						"warning",
					);
			}
		},
	});
}
