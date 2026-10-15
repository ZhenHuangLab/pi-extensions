/**
 * Isolated libtexprintf renderer.
 *
 * libtexprintf keeps global state inside the WASM linear memory: after a few
 * renders it answers later calls with out-of-bounds garbage, and on some input
 * sequences its parser never terminates. Both are fatal in-process, because
 * pi's markdown transform runs synchronously inside the TUI render loop — a
 * spinning render means the session can never be opened again.
 *
 * So renders happen here, on a worker thread, each on a throwaway WASM
 * instance. The parent drives this loop synchronously through a
 * SharedArrayBuffer and abandons (terminates) the whole thread if a render
 * exceeds its deadline.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

import { createRender } from "libtexprintf";

const {
	sab,
	headerSlots,
	requestOffset,
	requestCapacity,
	responseOffset,
	responseCapacity,
	slotState,
	slotReady,
	slotRequestLength,
	slotResponseLength,
	slotStatus,
	stateIdle,
	stateRequest,
	stateResponse,
} = workerData;

const header = new Int32Array(sab, 0, headerSlots);
const requestBytes = new Uint8Array(sab, requestOffset, requestCapacity);
const responseBytes = new Uint8Array(sab, responseOffset, responseCapacity);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const require = createRequire(import.meta.url);
const wasmModule = new WebAssembly.Module(readFileSync(require.resolve("libtexprintf/libtexprintf.wasm")));
const wasmImports = {
	wasi_snapshot_preview1: {
		proc_exit(code) {
			throw new Error(`WASM requested proc_exit(${code})`);
		},
		fd_close: () => 0,
		fd_write: () => 0,
		fd_seek: () => 0,
	},
};

/** Render TeX on a fresh instance, so no state can leak between calls. */
function renderOnce(tex) {
	const render = createRender(new WebAssembly.Instance(wasmModule, wasmImports));
	const { output, errors } = render(tex);
	if (errors.length > 0 || output.trim().length === 0) return null;
	// A fenced block in the art would break out of the code fence we emit.
	return output.includes("```") ? null : output;
}

parentPort.postMessage("ready");
Atomics.store(header, slotReady, 1);

for (;;) {
	let state = Atomics.load(header, slotState);
	while (state !== stateRequest) {
		Atomics.wait(header, slotState, state);
		state = Atomics.load(header, slotState);
	}

	const requestLength = Atomics.load(header, slotRequestLength);
	const tex = decoder.decode(requestBytes.slice(0, requestLength));

	let art = null;
	try {
		art = renderOnce(tex);
	} catch {
		art = null;
	}

	let status = 0;
	let responseLength = 0;
	if (art !== null) {
		const encoded = encoder.encode(art);
		if (encoded.length <= responseCapacity) {
			responseBytes.set(encoded);
			responseLength = encoded.length;
			status = 1;
		}
	}
	Atomics.store(header, slotResponseLength, responseLength);
	Atomics.store(header, slotStatus, status);
	Atomics.store(header, slotState, stateResponse);
	Atomics.notify(header, slotState);

	while (Atomics.load(header, slotState) === stateResponse) {
		Atomics.wait(header, slotState, stateResponse);
	}
	void stateIdle;
}
