import type { ResolvedXaiRuntime } from "./auth.ts";
import { type FetchLike, XaiApiError } from "./client.ts";

const DEFAULT_XAI_MODELS_TIMEOUT_MS = 30_000;

export interface XaiModelInfo {
  id: string;
  aliases: string[];
  ownedBy?: string;
  contextLength?: number;
}

export interface ListXaiModelsOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactErrorBody(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function parseAliases(value: unknown, modelId: string): string[] {
  if (!Array.isArray(value)) return [];

  const aliases = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const alias = candidate.trim();
    if (alias && alias !== modelId) aliases.add(alias);
  }
  return [...aliases];
}

function parseModelInfo(value: unknown): XaiModelInfo | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const id = value.id.trim();
  if (!id) return undefined;

  const ownedBy = typeof value.owned_by === "string" && value.owned_by ? value.owned_by : undefined;
  const contextLength =
    typeof value.context_length === "number" &&
    Number.isFinite(value.context_length) &&
    value.context_length > 0
      ? value.context_length
      : undefined;

  return {
    id,
    aliases: parseAliases(value.aliases, id),
    ...(ownedBy ? { ownedBy } : {}),
    ...(contextLength ? { contextLength } : {}),
  };
}

export function parseXaiModelList(value: unknown): XaiModelInfo[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error("xAI models API returned an invalid response");
  }

  const models = new Map<string, XaiModelInfo>();
  for (const item of value.data) {
    const model = parseModelInfo(item);
    if (model && !models.has(model.id)) models.set(model.id, model);
  }

  if (models.size === 0) throw new Error("xAI models API returned no available models");
  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export async function listXaiModels(
  runtime: ResolvedXaiRuntime,
  options: ListXaiModelsOptions = {},
): Promise<XaiModelInfo[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_XAI_MODELS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("xAI model listing timed out", "TimeoutError"));
  }, timeoutMs);
  const abortFromParent = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });

  const headers = new Headers(runtime.headers);
  headers.set("Authorization", `Bearer ${runtime.apiKey}`);
  headers.set("Accept", "application/json");

  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${runtime.baseUrl}/models`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = compactErrorBody(await response.text().catch(() => ""));
      throw new XaiApiError(response.status, detail);
    }

    return parseXaiModelList(await response.json());
  } catch (error) {
    if (options.signal?.aborted) {
      throw new Error("xAI model listing was cancelled", { cause: error });
    }
    if (timedOut) {
      throw new Error(`xAI model listing timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}
