import type { ResolvedXaiRuntime } from "./auth.ts";
import type { NormalizedXaiSearchRequest } from "./schema.ts";
import { DEFAULT_XAI_SEARCH_TIMEOUT_MS } from "./schema.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface XaiSearchClientOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class XaiApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`xAI API error (${status})${detail ? `: ${detail}` : ""}`);
    this.name = "XaiApiError";
    this.status = status;
  }
}

interface ManagedSignal {
  signal: AbortSignal;
  didTimeout(): boolean;
  cleanup(): void;
}

function createManagedSignal(parent: AbortSignal | undefined, timeoutMs: number): ManagedSignal {
  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("xAI search timed out", "TimeoutError"));
  }, timeoutMs);

  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup() {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function compactErrorBody(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function buildXSearchTool(request: NormalizedXaiSearchRequest): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: "x_search" };
  if (request.fromDate) tool.from_date = request.fromDate;
  if (request.toDate) tool.to_date = request.toDate;
  if (request.allowedXHandles) tool.allowed_x_handles = request.allowedXHandles;
  if (request.excludedXHandles) tool.excluded_x_handles = request.excludedXHandles;
  if (request.enableImageUnderstanding !== undefined) {
    tool.enable_image_understanding = request.enableImageUnderstanding;
  }
  if (request.enableVideoUnderstanding !== undefined) {
    tool.enable_video_understanding = request.enableVideoUnderstanding;
  }
  return tool;
}

export async function callXaiSearch(
  runtime: ResolvedXaiRuntime,
  request: NormalizedXaiSearchRequest,
  options: XaiSearchClientOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_XAI_SEARCH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }

  const body = {
    model: request.model,
    input: [{ role: "user", content: request.query }],
    tools: [buildXSearchTool(request)],
    store: false,
  };

  const managedSignal = createManagedSignal(options.signal, timeoutMs);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const headers = new Headers(runtime.headers);
  headers.set("Authorization", `Bearer ${runtime.apiKey}`);
  headers.set("Content-Type", "application/json");

  try {
    const response = await fetchImpl(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: managedSignal.signal,
    });

    if (!response.ok) {
      const detail = compactErrorBody(await response.text().catch(() => ""));
      throw new XaiApiError(response.status, detail);
    }

    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("xAI API returned an invalid JSON response");
    }
    return result;
  } catch (error) {
    if (options.signal?.aborted) {
      throw new Error("xAI search was cancelled", { cause: error });
    }
    if (managedSignal.didTimeout()) {
      throw new Error(`xAI search timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    managedSignal.cleanup();
  }
}
