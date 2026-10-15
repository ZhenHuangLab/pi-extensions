import { describe, expect, it } from "vitest";
import { DEFAULT_XAI_SEARCH_MODEL, normalizeXaiSearchParams } from "../src/schema.ts";

describe("normalizeXaiSearchParams", () => {
  it("normalizes a query and applies the default model", () => {
    expect(normalizeXaiSearchParams({ query: "  latest xAI news  " })).toEqual({
      query: "latest xAI news",
      model: DEFAULT_XAI_SEARCH_MODEL,
    });
  });

  it("uses a configured default model when the call does not override it", () => {
    expect(normalizeXaiSearchParams({ query: "test" }, " grok-configured ")).toEqual({
      query: "test",
      model: "grok-configured",
    });
  });

  it("keeps a model override and an inclusive date range", () => {
    expect(
      normalizeXaiSearchParams({
        query: "release reactions",
        model: " grok-4.20-0309-reasoning ",
        from_date: "2026-07-01",
        to_date: "2026-07-31",
      }),
    ).toEqual({
      query: "release reactions",
      model: "grok-4.20-0309-reasoning",
      fromDate: "2026-07-01",
      toDate: "2026-07-31",
    });
  });

  it("normalizes handle filters and media-understanding flags", () => {
    expect(
      normalizeXaiSearchParams({
        query: "media posts",
        allowed_x_handles: [" @xai ", "Grok"],
        enable_image_understanding: true,
        enable_video_understanding: false,
      }),
    ).toEqual({
      query: "media posts",
      model: DEFAULT_XAI_SEARCH_MODEL,
      allowedXHandles: ["xai", "Grok"],
      enableImageUnderstanding: true,
      enableVideoUnderstanding: false,
    });
  });

  it("normalizes an excluded-handle filter", () => {
    expect(
      normalizeXaiSearchParams({
        query: "exclude spam",
        excluded_x_handles: [" @spam_bot "],
      }),
    ).toMatchObject({ excludedXHandles: ["spam_bot"] });
  });

  it.each([
    [{ query: "   " }, "query must not be empty"],
    [{ query: "test", model: "   " }, "model must not be empty"],
    [{ query: "test", from_date: "2026/07/01" }, "from_date must use YYYY-MM-DD format"],
    [{ query: "test", to_date: "2026-02-30" }, "to_date must be a valid calendar date"],
    [
      { query: "test", from_date: "2026-07-31", to_date: "2026-07-01" },
      "from_date must be on or before to_date",
    ],
    [
      {
        query: "test",
        allowed_x_handles: ["xai"],
        excluded_x_handles: ["spam"],
      },
      "allowed_x_handles and excluded_x_handles cannot be used together",
    ],
    [
      { query: "test", allowed_x_handles: ["xai", "@XAI"] },
      "allowed_x_handles must not contain duplicate handles",
    ],
    [
      { query: "test", excluded_x_handles: ["not a handle"] },
      "excluded_x_handles[0] must be a valid X handle",
    ],
    [
      {
        query: "test",
        allowed_x_handles: Array.from({ length: 21 }, (_, index) => `user${index}`),
      },
      "allowed_x_handles must contain between 1 and 20 handles",
    ],
  ])("rejects invalid parameters %#", (params, message) => {
    expect(() => normalizeXaiSearchParams(params)).toThrow(message);
  });
});
