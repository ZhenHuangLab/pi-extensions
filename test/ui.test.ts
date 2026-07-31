import { describe, expect, it } from "vitest";
import { createXaiModelChoices, filterXaiModelChoices } from "../src/ui.ts";

describe("xAI model picker", () => {
  const models = [
    {
      id: "grok-4.20",
      aliases: ["grok-latest"],
      ownedBy: "xai",
      contextLength: 256_000,
    },
    { id: "grok-4.5", aliases: [] },
  ];

  it("puts the configured model first and exposes API aliases", () => {
    const choices = createXaiModelChoices(models, "grok-4.5");
    expect(choices[0]?.id).toBe("grok-4.5");
    expect(choices.find((choice) => choice.id === "grok-latest")).toMatchObject({
      description: "Alias for grok-4.20",
    });
    expect(choices.find((choice) => choice.id === "grok-4.20")?.description).toContain(
      "256,000 tokens",
    );
  });

  it("keeps a configured model that the API does not return", () => {
    expect(createXaiModelChoices(models, "grok-private")[0]).toMatchObject({
      id: "grok-private",
      description: expect.stringContaining("not returned"),
    });
  });

  it("fuzzy-filters model IDs and aliases", () => {
    const choices = createXaiModelChoices(models, "grok-4.5");
    expect(filterXaiModelChoices(choices, "g45").map((choice) => choice.id)).toContain("grok-4.5");
    expect(filterXaiModelChoices(choices, "latest")[0]?.id).toBe("grok-latest");
  });
});
