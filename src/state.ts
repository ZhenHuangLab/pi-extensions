/**
 * Shared, session-scoped state. Kept in one module so the render patches can
 * read it with a plain property access — they run inside the TUI render loop
 * and must not do work when folding is off.
 */

import type { ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, type FoldConfig, saveConfig } from "./config.ts";
import { buildFoldPlan, EMPTY_PLAN, type FoldPlan } from "./plan.ts";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

class FoldState {
	config: FoldConfig = { ...DEFAULT_CONFIG };

	private sessionManager: ReadonlySessionManager | undefined;
	private ui: ExtensionUIContext | undefined;
	/** Captured from the first tool component that renders, to force a redraw on toggle. */
	tui: TUI | undefined;

	private plan: FoldPlan | undefined;
	private planLeafId: string | null | undefined;
	private planMode: FoldConfig["mode"] = DEFAULT_CONFIG.mode;
	private stale = true;

	bindSession(ctx: ExtensionContext): void {
		this.sessionManager = ctx.sessionManager;
		this.ui = ctx.ui;
		this.tui = undefined;
		this.invalidate();
	}

	get theme(): Theme | undefined {
		return this.ui?.theme;
	}

	get collapsed(): boolean {
		return this.config.collapsed;
	}

	/** Mark the plan for a rebuild on the next frame that needs it. */
	invalidate(): void {
		this.stale = true;
	}

	/**
	 * The plan for the current branch. Rebuilt only when an event marked it
	 * stale or the branch leaf moved, so a steady frame costs one map lookup.
	 */
	getPlan(): FoldPlan {
		const sessionManager = this.sessionManager;
		if (!sessionManager) return EMPTY_PLAN;
		const leafId = sessionManager.getLeafId();
		if (!this.stale && this.plan && this.planLeafId === leafId && this.planMode === this.config.mode) {
			return this.plan;
		}
		this.plan = buildFoldPlan(sessionManager.buildContextEntries(), this.config.mode);
		this.planLeafId = leafId;
		this.planMode = this.config.mode;
		this.stale = false;
		return this.plan;
	}

	/** Apply a config change, persist it, and repaint the transcript. */
	update(changes: Partial<FoldConfig>): void {
		this.config = { ...this.config, ...changes };
		saveConfig(this.config);
		this.invalidate();
		this.tui?.requestRender(true);
	}
}

export const state = new FoldState();
