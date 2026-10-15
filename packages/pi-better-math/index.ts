/**
 * pi-better-math — render display math in pi's TUI as real 2D Unicode art.
 *
 * pi's built-in renderer flattens LaTeX to single-line Unicode. This extension
 * intercepts markdown via pi.registerMarkdownTransformer and typesets
 * $$...$$ (and math-looking \[...\]) blocks with libtexprintf (utftex, WASM):
 * stacked fractions, extended brackets, centered sum/integral limits, matrices.
 *
 * Rendering is display-only (session/model context unchanged). Any failure —
 * worker unavailable, unsupported TeX, a render that blows its deadline,
 * output wider than the terminal — falls back to the original text and
 * therefore to pi's built-in LaTeX handling.
 *
 * The /better-math command toggles the transform for newly rendered content.
 */

import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";

import { transformMarkdown } from "./transform.ts";

const MAX_CACHE_ENTRIES = 400;
const LOG_PATH = "/tmp/pi-better-math.log";
const STATE_KEY = Symbol.for("pi-better-math.state");
const PATCH_KEY = Symbol.for("pi-better-math.markdown-render");
const TYPESETTER_KEY = Symbol.for("pi-better-math.typesetter");

/** Shared-memory protocol between this module and render-worker.mjs. */
const HEADER_SLOTS = 8;
const SLOT_STATE = 0;
const SLOT_READY = 1;
const SLOT_REQUEST_LENGTH = 2;
const SLOT_RESPONSE_LENGTH = 3;
const SLOT_STATUS = 4;
const STATE_IDLE = 0;
const STATE_REQUEST = 1;
const STATE_RESPONSE = 2;
const HEADER_BYTES = HEADER_SLOTS * 4;
const REQUEST_CAPACITY = 64 * 1024;
const RESPONSE_CAPACITY = 256 * 1024;
/**
 * A render slower than this is a runaway parser, not a big formula: a fresh
 * WASM instance plus a full page of math costs well under a millisecond.
 */
const RENDER_DEADLINE_MS = 250;
const WORKER_READY_TIMEOUT_MS = 5000;

interface TypesetState {
	enabled: boolean;
	apply: (markdown: string, availableWidth: number) => string;
}

/** The parts of pi-tui's Markdown instance this extension reaches into. */
interface PatchableMarkdown {
	render: ((width: number) => string[]) & { [PATCH_KEY]?: boolean };
	options?: { transform?: (markdown: string, availableWidth: number) => string };
}

interface Typesetter {
	/** Render TeX to Unicode art; null when unavailable, rejected, or too slow. */
	typeset(tex: string): string | null;
	/** Resolves once the worker has compiled its WASM module. */
	whenReady(): Promise<void>;
	/** Number of times a render blew its deadline and cost us the worker. */
	restarts(): number;
	dispose(): void;
}

function getSharedState(): TypesetState {
	const globalState = globalThis as typeof globalThis & { [STATE_KEY]?: TypesetState };
	if (!globalState[STATE_KEY]) {
		globalState[STATE_KEY] = {
			enabled: false,
			apply: (markdown) => markdown,
		};
	}
	return globalState[STATE_KEY];
}

/**
 * pi-thinking-steps replaces AssistantMessageComponent.updateContent and
 * constructs Markdown without the transform option, which would otherwise
 * discard every markdown transformer a few seconds after /reload. Patching
 * Markdown.render keeps typesetting on that path too.
 */
function installMarkdownRenderPatch(): void {
	const proto = Markdown.prototype as unknown as PatchableMarkdown;
	if (proto.render[PATCH_KEY]) return;

	const originalRender = proto.render;
	const patchedRender = function patchedRender(this: PatchableMarkdown, width: number): string[] {
		const state = getSharedState();
		const previousOptions = this.options;
		const existingTransform = previousOptions?.transform;
		this.options = {
			...previousOptions,
			transform: (markdown: string, availableWidth: number) => {
				const typeset = state.enabled ? state.apply(markdown, availableWidth) : markdown;
				return existingTransform ? existingTransform(typeset, availableWidth) : typeset;
			},
		};
		try {
			return originalRender.call(this, width);
		} finally {
			this.options = previousOptions;
		}
	};
	patchedRender[PATCH_KEY] = true;
	proto.render = patchedRender;
}

function log(message: string): void {
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Diagnostic log must never break rendering.
	}
}

/**
 * Drive render-worker.mjs synchronously, with a hard deadline.
 *
 * The markdown transform runs inside the TUI render loop, so it has to be
 * synchronous — but libtexprintf's parser can spin forever on some inputs, and
 * an in-process spin would freeze pi with no way back into the session. The
 * render therefore happens on a worker thread reached through Atomics on a
 * SharedArrayBuffer: the calling thread blocks for at most RENDER_DEADLINE_MS
 * and, if the worker misses it, the whole thread is terminated and replaced.
 */
function createTypesetter(workerPath: string): Typesetter {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let worker: Worker | null = null;
	let header = new Int32Array(new SharedArrayBuffer(HEADER_BYTES), 0, HEADER_SLOTS);
	let request: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	let response: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	let ready: Promise<void> = Promise.resolve();
	let restartCount = 0;

	function spawn(): void {
		const sab = new SharedArrayBuffer(HEADER_BYTES + REQUEST_CAPACITY + RESPONSE_CAPACITY);
		header = new Int32Array(sab, 0, HEADER_SLOTS);
		request = new Uint8Array(sab, HEADER_BYTES, REQUEST_CAPACITY);
		response = new Uint8Array(sab, HEADER_BYTES + REQUEST_CAPACITY, RESPONSE_CAPACITY);

		const next = new Worker(workerPath, {
			workerData: {
				sab,
				headerSlots: HEADER_SLOTS,
				requestOffset: HEADER_BYTES,
				requestCapacity: REQUEST_CAPACITY,
				responseOffset: HEADER_BYTES + REQUEST_CAPACITY,
				responseCapacity: RESPONSE_CAPACITY,
				slotState: SLOT_STATE,
				slotReady: SLOT_READY,
				slotRequestLength: SLOT_REQUEST_LENGTH,
				slotResponseLength: SLOT_RESPONSE_LENGTH,
				slotStatus: SLOT_STATUS,
				stateIdle: STATE_IDLE,
				stateRequest: STATE_REQUEST,
				stateResponse: STATE_RESPONSE,
			},
		});
		next.unref();
		next.on("error", (error) => {
			log(`worker error ${String(error)}`);
			if (worker === next) worker = null;
		});
		worker = next;
		ready = new Promise<void>((resolve) => {
			next.once("message", () => resolve());
			setTimeout(resolve, WORKER_READY_TIMEOUT_MS).unref();
		});
	}

	function restart(tex: string): void {
		restartCount += 1;
		log(`render exceeded ${RENDER_DEADLINE_MS}ms, replacing worker: ${JSON.stringify(tex.slice(0, 160))}`);
		const stuck = worker;
		worker = null;
		void stuck?.terminate();
		spawn();
	}

	spawn();

	return {
		typeset(tex: string): string | null {
			if (!worker || Atomics.load(header, SLOT_READY) !== 1) return null;

			const encoded = encoder.encode(tex);
			if (encoded.length > REQUEST_CAPACITY) return null;
			request.set(encoded);
			Atomics.store(header, SLOT_REQUEST_LENGTH, encoded.length);
			Atomics.store(header, SLOT_STATE, STATE_REQUEST);
			Atomics.notify(header, SLOT_STATE);

			if (Atomics.wait(header, SLOT_STATE, STATE_REQUEST, RENDER_DEADLINE_MS) === "timed-out") {
				restart(tex);
				return null;
			}

			const ok = Atomics.load(header, SLOT_STATUS) === 1;
			const length = Atomics.load(header, SLOT_RESPONSE_LENGTH);
			const art = ok ? decoder.decode(response.slice(0, length)) : null;
			Atomics.store(header, SLOT_STATE, STATE_IDLE);
			Atomics.notify(header, SLOT_STATE);
			return art;
		},
		whenReady: () => ready,
		restarts: () => restartCount,
		dispose(): void {
			const running = worker;
			worker = null;
			void running?.terminate();
		},
	};
}

export default async function (pi: ExtensionAPI) {
	const globalState = globalThis as typeof globalThis & { [TYPESETTER_KEY]?: Typesetter };
	// A /reload re-imports this module; drop the previous module's worker
	// instead of leaking a thread per reload.
	globalState[TYPESETTER_KEY]?.dispose();
	globalState[TYPESETTER_KEY] = undefined;

	let typesetter: Typesetter | null = null;
	let loadError: string | null = null;
	try {
		typesetter = createTypesetter(join(dirname(fileURLToPath(import.meta.url)), "render-worker.mjs"));
		globalState[TYPESETTER_KEY] = typesetter;
		await typesetter.whenReady();
		log(`worker ready url=${String(import.meta.url)}`);
	} catch (error) {
		loadError = String(error);
		log(`worker failed ${loadError}`);
	}

	/** tex source -> typeset art, or null when it cannot be rendered. */
	const cache = new Map<string, string | null>();
	let enabled = typesetter !== null;
	let transformCalls = 0;
	let transformHits = 0;

	function typeset(tex: string): string | null {
		if (!typesetter) return null;
		const cached = cache.get(tex);
		if (cached !== undefined) return cached;

		const art = typesetter.typeset(tex);
		if (cache.size >= MAX_CACHE_ENTRIES) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		cache.set(tex, art);
		return art;
	}

	function apply(markdown: string, availableWidth: number): string {
		transformCalls += 1;
		if (!enabled) return markdown;
		try {
			const out = transformMarkdown(markdown, {
				availableWidth,
				measureWidth: visibleWidth,
				typeset,
			});
			if (out !== markdown) transformHits += 1;
			return out;
		} catch (error) {
			log(`transform threw ${String(error)}`);
			return markdown;
		}
	}

	function setEnabled(next: boolean): void {
		enabled = next && typesetter !== null;
		getSharedState().enabled = enabled;
	}

	function statusLine(): string {
		if (loadError) return `better-math OFF (worker: ${loadError})`;
		const restarts = typesetter?.restarts() ?? 0;
		const stalls = restarts > 0 ? ` stalls=${restarts}` : "";
		return `better-math ${enabled ? "ON" : "OFF"} calls=${transformCalls} hits=${transformHits}${stalls}`;
	}

	installMarkdownRenderPatch();
	const shared = getSharedState();
	shared.enabled = enabled;
	shared.apply = apply;

	if (typesetter) {
		pi.registerMarkdownTransformer((markdown, { availableWidth }) => apply(markdown, availableWidth));
	}

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify(statusLine(), loadError ? "warning" : "info");
	});

	pi.registerCommand("better-math", {
		description: "Better math typesetting: status (default) | on | off | toggle",
		handler: async (args, ctx) => {
			const verb = String(args ?? "")
				.trim()
				.toLowerCase();
			if (verb === "status" || verb === "") {
				ctx.ui.notify(statusLine(), loadError ? "warning" : "info");
				return;
			}
			if (verb === "toggle") {
				setEnabled(!enabled);
				ctx.ui.notify(statusLine(), loadError ? "warning" : "info");
				return;
			}
			if (verb === "on") {
				setEnabled(true);
				ctx.ui.notify(statusLine(), loadError ? "warning" : "info");
				return;
			}
			if (verb === "off") {
				setEnabled(false);
				ctx.ui.notify(statusLine(), "info");
				return;
			}
			ctx.ui.notify("usage: /better-math [status|on|off|toggle]", "warning");
		},
	});
}
