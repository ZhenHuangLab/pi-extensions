import type { FetchFunction } from "@earendil-works/pi-ai";

function retryAfter(headers: Headers): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Number(ms);
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  if (Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function captureResponse() {
  const captured: {
    started: boolean;
    failed: boolean;
    status?: number;
    retryAfter?: number;
    text?: string;
  } = { started: false, failed: false };
  const fetch: FetchFunction = async (input, init) => {
    captured.started = true;
    try {
      const response = await globalThis.fetch(input, init);
      // Preserve HTTP errors even when reading their response body fails.
      captured.status = response.status;
      captured.retryAfter = retryAfter(response.headers);
      // Read to EOF before Pi consumes a copy. Codex stops at its first terminal
      // event, which must not conceal trailing failures or incomplete output.
      const bytes = new Uint8Array(await response.arrayBuffer());
      captured.text = new TextDecoder().decode(bytes);
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      captured.failed = true;
      throw error;
    }
  };
  return { captured, fetch };
}
