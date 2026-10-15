import { describe, expect, it } from "vitest";
import { formatXaiSearchResponse } from "../src/format.ts";

describe("formatXaiSearchResponse", () => {
  it("formats text, searches, usage, tool counts, and deduplicated citations", () => {
    const response = {
      model: "grok-4.5",
      output: [
        {
          type: "x_search_call",
          status: "completed",
          action: { query: "xAI launch" },
        },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "People are discussing the launch.",
              annotations: [
                { type: "url_citation", url: "https://x.com/xai/status/1" },
                { type: "url_citation", url: "https://x.com/user/status/2" },
              ],
            },
          ],
        },
      ],
      usage: {
        input_tokens: 120,
        output_tokens: 80,
        output_tokens_details: { reasoning_tokens: 30 },
      },
      citations: ["https://x.com/xai/status/1"],
      server_side_tool_usage: { SERVER_SIDE_TOOL_X_SEARCH: 2 },
    };

    const formatted = formatXaiSearchResponse(response, "fallback", "OAuth");

    expect(formatted.text).toContain("**xAI X Search** (grok-4.5)");
    expect(formatted.text).toContain("People are discussing the launch.");
    expect(formatted.text).toContain("X search: “xAI launch” [completed]");
    expect(formatted.text).toContain("Tokens: 120 in / 80 out (30 reasoning)");
    expect(formatted.text).toContain("Server-side tools: x_search×2");
    expect(formatted.text.match(/https:\/\/x\.com\/xai\/status\/1/g)).toHaveLength(1);
    expect(formatted.details).toEqual({
      model: "grok-4.5",
      provider: "xai",
      authSource: "OAuth",
      citations: ["https://x.com/xai/status/1", "https://x.com/user/status/2"],
      searchCount: 1,
      serverSideToolUsage: { SERVER_SIDE_TOOL_X_SEARCH: 2 },
      truncated: false,
    });
  });

  it("uses the requested model and a no-output placeholder when fields are absent", () => {
    const formatted = formatXaiSearchResponse({}, "grok-4.5");
    expect(formatted.text).toContain("**xAI X Search** (grok-4.5)");
    expect(formatted.text).toContain("(no text output)");
    expect(formatted.details.citations).toEqual([]);
  });

  it("truncates oversized output using Pi's standard limits", () => {
    const text = Array.from({ length: 2_100 }, (_, index) => `line ${index}`).join("\n");
    const formatted = formatXaiSearchResponse(
      {
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
      },
      "grok-4.5",
    );

    expect(formatted.details.truncated).toBe(true);
    expect(formatted.text).toContain("[Output truncated to");
  });

  it("rejects invalid response values", () => {
    expect(() => formatXaiSearchResponse(null, "grok-4.5")).toThrow(
      "Cannot format an invalid xAI response",
    );
  });
});
