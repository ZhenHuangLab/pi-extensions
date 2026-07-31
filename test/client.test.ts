import { describe, expect, it, vi } from "vitest";
import type { ResolvedXaiRuntime } from "../src/auth.ts";
import { callXaiSearch, XaiApiError, type FetchLike } from "../src/client.ts";
import type { NormalizedXaiSearchRequest } from "../src/schema.ts";

const runtime: ResolvedXaiRuntime = {
  apiKey: "current-token",
  baseUrl: "https://api.x.ai/v1",
  headers: { authorization: "Bearer stale-token", "X-Custom": "custom" },
  authSource: "OAuth",
};

const request: NormalizedXaiSearchRequest = {
  query: "What are people saying about xAI?",
  model: "grok-4.5",
  fromDate: "2026-07-01",
  toDate: "2026-07-31",
};

function abortAwareFetch(): FetchLike {
  return vi.fn((_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
}

describe("callXaiSearch", () => {
  it("sends a Responses API request with x_search and date filters", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      new Response(JSON.stringify({ model: "grok-4.5", output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await callXaiSearch(runtime, request, { fetch });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.x.ai/v1/responses");
    expect(init?.method).toBe("POST");

    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer current-token");
    expect(headers.get("x-custom")).toBe("custom");
    expect(headers.get("content-type")).toBe("application/json");

    expect(JSON.parse(String(init?.body))).toEqual({
      model: "grok-4.5",
      input: [{ role: "user", content: "What are people saying about xAI?" }],
      tools: [
        {
          type: "x_search",
          from_date: "2026-07-01",
          to_date: "2026-07-31",
        },
      ],
      store: false,
    });
  });

  it("surfaces compact HTTP errors without changing their status", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response("  entitlement   required  ", { status: 403 }));

    const promise = callXaiSearch(runtime, request, { fetch });
    await expect(promise).rejects.toBeInstanceOf(XaiApiError);
    await expect(promise).rejects.toMatchObject({
      name: "XaiApiError",
      status: 403,
      message: "xAI API error (403): entitlement required",
    });
  });

  it("rejects non-object JSON responses", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(new Response("null", { status: 200 }));

    await expect(callXaiSearch(runtime, request, { fetch })).rejects.toThrow(
      "invalid JSON response",
    );
  });

  it("honors the tool cancellation signal", async () => {
    const controller = new AbortController();
    const promise = callXaiSearch(runtime, request, {
      fetch: abortAwareFetch(),
      signal: controller.signal,
      timeoutMs: 1_000,
    });

    controller.abort();
    await expect(promise).rejects.toThrow("xAI search was cancelled");
  });

  it("times out stalled requests", async () => {
    await expect(
      callXaiSearch(runtime, request, {
        fetch: abortAwareFetch(),
        timeoutMs: 5,
      }),
    ).rejects.toThrow("xAI search timed out after 5ms");
  });

  it("rejects invalid timeout values before making a request", async () => {
    const fetch = vi.fn<FetchLike>();
    await expect(callXaiSearch(runtime, request, { fetch, timeoutMs: 0 })).rejects.toThrow(
      "timeoutMs must be a positive number",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
