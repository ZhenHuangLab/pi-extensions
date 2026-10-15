import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadXaiSearchConfig, parseXaiSearchConfig, saveXaiSearchConfig } from "../src/config.ts";
import { DEFAULT_XAI_SEARCH_MODEL } from "../src/schema.ts";

const temporaryDirectories: string[] = [];

async function temporaryConfigPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-xai-search-"));
  temporaryDirectories.push(directory);
  return join(directory, "config.json");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("xAI search config", () => {
  it("uses grok-4.5 by default and validates configured models", () => {
    expect(parseXaiSearchConfig(undefined)).toEqual({
      config: { model: DEFAULT_XAI_SEARCH_MODEL },
      warnings: [],
    });
    expect(parseXaiSearchConfig({ model: " grok-4.20 " })).toEqual({
      config: { model: "grok-4.20" },
      warnings: [],
    });

    const invalid = parseXaiSearchConfig({ model: "  " });
    expect(invalid.config.model).toBe(DEFAULT_XAI_SEARCH_MODEL);
    expect(invalid.warnings[0]).toContain("non-empty string");
  });

  it("loads missing or malformed files without failing startup", async () => {
    const path = await temporaryConfigPath();
    await expect(loadXaiSearchConfig(path)).resolves.toEqual({
      config: { model: DEFAULT_XAI_SEARCH_MODEL },
      warnings: [],
    });

    await writeFile(path, "{not json", "utf8");
    const malformed = await loadXaiSearchConfig(path);
    expect(malformed.config.model).toBe(DEFAULT_XAI_SEARCH_MODEL);
    expect(malformed.warnings[0]).toContain("Could not parse");
  });

  it("saves atomically, preserves future keys, and restricts file permissions", async () => {
    const path = await temporaryConfigPath();
    await writeFile(path, `${JSON.stringify({ futureOption: true })}\n`, "utf8");

    await saveXaiSearchConfig(path, { model: " grok-4.20 " });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      futureOption: true,
      model: "grok-4.20",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects an empty model before writing", async () => {
    const path = await temporaryConfigPath();
    await expect(saveXaiSearchConfig(path, { model: " " })).rejects.toThrow(
      "model must not be empty",
    );
  });
});
