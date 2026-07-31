import { describe, expect, it } from "vitest";
import { DEFAULT_XAI_SEARCH_MODEL, normalizeXaiSearchParams } from "../src/schema.ts";

describe("normalizeXaiSearchParams", () => {
  it("normalizes a query and applies the default model", () => {
    expect(normalizeXaiSearchParams({ query: "  latest xAI news  " })).toEqual({
      query: "latest xAI news",
      model: DEFAULT_XAI_SEARCH_MODEL,
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

  it.each([
    [{ query: "   " }, "query must not be empty"],
    [{ query: "test", model: "   " }, "model must not be empty"],
    [{ query: "test", from_date: "2026/07/01" }, "from_date must use YYYY-MM-DD format"],
    [{ query: "test", to_date: "2026-02-30" }, "to_date must be a valid calendar date"],
    [
      { query: "test", from_date: "2026-07-31", to_date: "2026-07-01" },
      "from_date must be on or before to_date",
    ],
  ])("rejects invalid parameters %#", (params, message) => {
    expect(() => normalizeXaiSearchParams(params)).toThrow(message);
  });
});
