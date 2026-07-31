import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerXaiSearch from "../index.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("pi extension", () => {
  it("registers only xai_search and executes independently of the active model", async () => {
    const registerTool = vi.fn();
    registerXaiSearch({ registerTool } as unknown as ExtensionAPI);

    expect(registerTool).toHaveBeenCalledOnce();
    const tool = registerTool.mock.calls[0]![0];
    expect(tool.name).toBe("xai_search");

    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "grok-4.5",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Live X result" }],
            },
          ],
          citations: ["https://x.com/example/status/1"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetch;

    const ctx = {
      model: { provider: "anthropic", id: "claude-opus" },
      modelRegistry: {
        getProvider: vi.fn().mockReturnValue({ baseUrl: "https://api.x.ai/v1" }),
        getProviderAuth: vi.fn().mockResolvedValue({
          auth: { apiKey: "oauth-token" },
          source: "OAuth",
        }),
        find: vi.fn().mockReturnValue({ baseUrl: "https://api.x.ai/v1" }),
      },
    };

    const result = await tool.execute(
      "call-1",
      { query: "latest xAI discussion" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("Live X result");
    expect(result.details).toMatchObject({ model: "grok-4.5", provider: "xai" });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(body.model).toBe("grok-4.5");
    expect(body.tools).toEqual([{ type: "x_search" }]);
    expect(ctx.model.provider).toBe("anthropic");
  });
});
