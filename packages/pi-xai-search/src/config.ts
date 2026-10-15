import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_XAI_SEARCH_MODEL } from "./schema.ts";

export const XAI_SEARCH_CONFIG_FILENAME = "pi-xai-search.json";

export interface XaiSearchConfig {
  model: string;
}

export interface XaiSearchConfigLoadResult {
  config: XaiSearchConfig;
  warnings: string[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export function parseXaiSearchConfig(value: unknown): XaiSearchConfigLoadResult {
  const warnings: string[] = [];
  let model = DEFAULT_XAI_SEARCH_MODEL;

  if (!isRecord(value)) {
    if (value !== undefined)
      warnings.push("xAI search config must be a JSON object; using defaults");
    return { config: { model }, warnings };
  }

  if (value.model !== undefined) {
    if (typeof value.model !== "string" || !value.model.trim()) {
      warnings.push(`xAI search config model must be a non-empty string; using ${model}`);
    } else {
      model = value.model.trim();
    }
  }

  return { config: { model }, warnings };
}

export async function loadXaiSearchConfig(path: string): Promise<XaiSearchConfigLoadResult> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return parseXaiSearchConfig(undefined);
    return {
      ...parseXaiSearchConfig(undefined),
      warnings: [`Could not read xAI search config at ${path}: ${errorMessage(error)}`],
    };
  }

  try {
    return parseXaiSearchConfig(JSON.parse(content));
  } catch (error) {
    return {
      ...parseXaiSearchConfig(undefined),
      warnings: [`Could not parse xAI search config at ${path}: ${errorMessage(error)}`],
    };
  }
}

async function readExistingRecord(path: string): Promise<UnknownRecord> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveXaiSearchConfig(path: string, config: XaiSearchConfig): Promise<void> {
  const model = config.model.trim();
  if (!model) throw new Error("model must not be empty");

  const value = { ...(await readExistingRecord(path)), model };
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
