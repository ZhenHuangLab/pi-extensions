import { describe, expect, it, vi } from "vitest";
import type { ResolvedXaiRuntime } from "../src/auth.ts";
import { XaiApiError, type FetchLike } from "../src/client.ts";
import { listXaiModels, parseXaiModelList } from "../src/models.ts";

const runtime: ResolvedXaiRuntime = {
  apiKey: "oauth-token",
  baseUrl: "https://api.x.ai/v1",
  headers: { authorization: "Bearer stale-token", "X-Custom": "custom" },
  authSource: "OAuth",
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

describe("xAI model listing", () => {
  it("parses model metadata, aliases, and duplicate IDs", () => {
    expect(
      parseXaiModelList({
        object: "list",
        data: [
          {
            id: "grok-4.5",
            aliases: ["grok-latest", "grok-latest", "grok-4.5"],
            owned_by: "xai",
            context_length: 256_000,
          },
          { id: "grok-4.5", aliases: [] },
          { id: "grok-4.20", aliases: null },
          { object: "model" },
        ],
      }),
    ).toEqual([
      { id: "grok-4.20", aliases: [] },
      {
        id: "grok-4.5",
        aliases: ["grok-latest"],
        ownedBy: "xai",
        contextLength: 256_000,
      },
    ]);
  });

  it("fetches /models with Pi-resolved OAuth headers", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "grok-4.5", aliases: [] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(listXaiModels(runtime, { fetch })).resolves.toEqual([
      { id: "grok-4.5", aliases: [] },
    ]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.x.ai/v1/models");
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer oauth-token");
    expect(headers.get("x-custom")).toBe("custom");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("surfaces compact HTTP errors", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response("  access   denied  ", { status: 403 }));

    const promise = listXaiModels(runtime, { fetch });
    await expect(promise).rejects.toBeInstanceOf(XaiApiError);
    await expect(promise).rejects.toMatchObject({
      status: 403,
      message: "xAI API error (403): access denied",
    });
  });

  it("rejects invalid or empty model responses", () => {
    expect(() => parseXaiModelList(null)).toThrow("invalid response");
    expect(() => parseXaiModelList({ data: [] })).toThrow("no available models");
  });

  it("supports cancellation and a bounded timeout", async () => {
    const controller = new AbortController();
    const cancelled = listXaiModels(runtime, {
      fetch: abortAwareFetch(),
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort();
    await expect(cancelled).rejects.toThrow("model listing was cancelled");

    await expect(
      listXaiModels(runtime, { fetch: abortAwareFetch(), timeoutMs: 5 }),
    ).rejects.toThrow("model listing timed out after 5ms");
  });
});
