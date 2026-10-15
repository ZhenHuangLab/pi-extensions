import { buildSessionProjection, calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { isRecord } from "./session.ts";

export interface ClearingSettings {
  triggerRatio: number;
  floorRatio: number;
  keepToolUses: number;
  minBytes: number;
}
export const DEFAULT_CLEARING: Readonly<ClearingSettings> = Object.freeze({
  triggerRatio: 0.5, floorRatio: 0.1, keepToolUses: 8, minBytes: 1024,
});
export const CONTEXT_SAFETY_TOKENS = 4096;

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readCompactionSettings(settings: Record<string, unknown>, model: Pick<Model<Api>, "provider" | "id">): {
  enabled: boolean; reserve: number; keepRecent: number; problems: string[];
} {
  const compaction = isRecord(settings.compaction) ? settings.compaction : {};
  const overrides = isRecord(compaction.modelOverrides) ? compaction.modelOverrides : {};
  const key = `${model.provider}/${model.id}`;
  const entry = overrides[key];
  const override = isRecord(entry) ? entry : {};
  const problems: string[] = [];
  if (entry !== undefined && !isRecord(entry)) {
    problems.push(`Invalid compaction.modelOverrides["${key}"]: use an object. Using the compaction values.`);
  }
  function tokens(field: string, defaultValue: number): number {
    const value = compaction[field];
    const ordinary = isTokenCount(value) ? value : undefined;
    const valueOverride = override[field];
    const modelValue = isTokenCount(valueOverride) ? valueOverride : undefined;
    if (value !== undefined && ordinary === undefined) {
      const label = modelValue === undefined ? `the default ${defaultValue}` : `the compaction.modelOverrides["${key}"] value ${modelValue}`;
      problems.push(`Invalid compaction.${field}: use a non-negative safe integer. Using ${label}.`);
    }
    if (valueOverride !== undefined && modelValue === undefined) {
      const label = ordinary === undefined ? `the default ${defaultValue}` : `the compaction value ${ordinary}`;
      problems.push(`Invalid compaction.modelOverrides["${key}"].${field}: use a non-negative safe integer. Using ${label}.`);
    }
    return modelValue ?? ordinary ?? defaultValue;
  }
  // Pi reads `enabled` with a nullish default and tests it for truthiness.
  return { enabled: Boolean(compaction.enabled ?? true), reserve: tokens("reserveTokens", 16384),
    keepRecent: tokens("keepRecentTokens", 20000), problems };
}

const clearingFields: [keyof ClearingSettings, (value: number) => boolean, string][] = [
  ["triggerRatio", (value) => value > 0 && value <= 1, "use a finite number greater than 0 and at most 1"],
  ["floorRatio", (value) => value >= 0 && value < 1, "use a finite number at least 0 and less than 1"],
  ["keepToolUses", (value) => Number.isSafeInteger(value) && value >= 1, "use a safe integer at least 1"],
  ["minBytes", (value) => Number.isSafeInteger(value) && value >= 0, "use a safe integer at least 0"],
];

export function readClearingSettings(settings: Record<string, unknown>, model: Pick<Model<Api>, "provider" | "id">): {
  clearing: ClearingSettings; problems: string[];
} {
  const clearing = { ...DEFAULT_CLEARING };
  const sources: Record<keyof ClearingSettings, "default" | "settings"> = {
    triggerRatio: "default", floorRatio: "default", keepToolUses: "default", minBytes: "default",
  };
  const problems: string[] = [];
  const result = { clearing, problems };
  if (!Object.hasOwn(settings, "pi-pleat")) return result;
  const config = settings["pi-pleat"];
  if (!isRecord(config)) {
    problems.push("Invalid pi-pleat: use an object. Using all clearing defaults.");
    return result;
  }
  if (!Object.hasOwn(config, "clearing")) return result;
  const values = config.clearing;
  if (!isRecord(values)) {
    problems.push("Invalid pi-pleat.clearing: use an object. Using all clearing defaults.");
    return result;
  }
  for (const key of Object.keys(values)) {
    if (key !== "modelOverrides" && !Object.hasOwn(DEFAULT_CLEARING, key)) problems.push(`Unknown setting pi-pleat.clearing.${key} ignored.`);
  }
  for (const [key, valid, rule] of clearingFields) {
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key];
    if (typeof value === "number" && Number.isFinite(value) && valid(value)) {
      clearing[key] = value;
      sources[key] = "settings";
    } else problems.push(`Invalid pi-pleat.clearing.${key}: ${rule}. Using the default ${DEFAULT_CLEARING[key]}.`);
  }
  if (clearing.floorRatio >= clearing.triggerRatio) {
    clearing.triggerRatio = DEFAULT_CLEARING.triggerRatio;
    clearing.floorRatio = DEFAULT_CLEARING.floorRatio;
    sources.triggerRatio = sources.floorRatio = "default";
    problems.push(`Invalid pi-pleat.clearing.floorRatio: use a value less than pi-pleat.clearing.triggerRatio. Using the default ratios (triggerRatio ${DEFAULT_CLEARING.triggerRatio}, floorRatio ${DEFAULT_CLEARING.floorRatio}).`);
  }
  if (!Object.hasOwn(values, "modelOverrides")) return result;
  const overrides = values.modelOverrides;
  if (!isRecord(overrides)) {
    problems.push("Invalid pi-pleat.clearing.modelOverrides: use an object. Ignoring clearing model overrides.");
    return result;
  }
  const key = `${model.provider}/${model.id}`;
  const entry = overrides[key];
  if (entry === undefined) return result;
  const path = `pi-pleat.clearing.modelOverrides["${key}"]`;
  if (!isRecord(entry)) {
    problems.push(`Invalid ${path}: use an object. Using the pi-pleat.clearing values.`);
    return result;
  }
  for (const field of Object.keys(entry)) {
    if (!Object.hasOwn(DEFAULT_CLEARING, field)) problems.push(`Unknown setting ${path}.${field} ignored.`);
  }
  const ordinary = { ...clearing };
  for (const [field, valid, rule] of clearingFields) {
    if (!Object.hasOwn(entry, field)) continue;
    const value = entry[field];
    if (typeof value === "number" && Number.isFinite(value) && valid(value)) clearing[field] = value;
    else {
      const label = sources[field] === "settings" ? `the pi-pleat.clearing value ${ordinary[field]}` : `the default ${ordinary[field]}`;
      problems.push(`Invalid ${path}.${field}: ${rule}. Using ${label}.`);
    }
  }
  if (clearing.floorRatio >= clearing.triggerRatio) {
    const label = sources.triggerRatio === "default" && sources.floorRatio === "default" ? "the default ratios" : "the pi-pleat.clearing ratios";
    problems.push(`Invalid ${path}: floorRatio ${clearing.floorRatio} must be less than triggerRatio ${clearing.triggerRatio}. Using ${label} (triggerRatio ${ordinary.triggerRatio}, floorRatio ${ordinary.floorRatio}).`);
    clearing.triggerRatio = ordinary.triggerRatio;
    clearing.floorRatio = ordinary.floorRatio;
  }
  return result;
}

export interface Limits {
  window: number;
  reserve: number;
  keepRecent: number;
  enabled: boolean;
  threshold: number;
  clearTrigger: number;
  clearFloor: number;
  keepToolUses: number;
  minClearBytes: number;
}

export function limitsFor(model: Model<Api>, settings: Record<string, unknown>): Limits {
  const compaction = readCompactionSettings(settings, model);
  const clearing = readClearingSettings(settings, model).clearing;
  const threshold = Math.max(0, model.contextWindow - compaction.reserve);
  return {
    window: model.contextWindow, reserve: compaction.reserve, keepRecent: compaction.keepRecent,
    enabled: compaction.enabled, threshold,
    clearTrigger: Math.max(1, Math.round(clearing.triggerRatio * threshold)),
    clearFloor: Math.max(1, Math.round(clearing.floorRatio * threshold)),
    keepToolUses: clearing.keepToolUses, minClearBytes: clearing.minBytes,
  };
}

export function contentBytes(content: (TextContent | ImageContent)[]): number {
  return content.reduce((bytes, block) => bytes +
    (block.type === "text" ? Buffer.byteLength(block.text, "utf8") : block.data.length), 0);
}

export interface ResponseStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  clearedInput?: number;
  appliedEdits?: number;
}
export interface SessionStats {
  serverClears: number;
  serverClearedTokens: number;
  localBatches: number;
  localClearedEntries: number;
  nativeFailures: number;
  fallbacks: number;
}

export function createSessionStats(): SessionStats {
  return {
    serverClears: 0, serverClearedTokens: 0, localBatches: 0,
    localClearedEntries: 0, nativeFailures: 0, fallbacks: 0,
  };
}

export function rawNextTokens(ctx: ExtensionContext, stats: ReadonlyMap<string, ResponseStats>): {
  tokens: number;
  estimated: boolean;
} | undefined {
  const tokens = ctx.getContextUsage()?.tokens;
  if (tokens === null || tokens === undefined) return undefined;
  const branch = ctx.sessionManager.getBranch();
  const projection = buildSessionProjection(branch);
  const entries = projection.entries;
  const index = entries.findLastIndex((entry) => entry.messages.some((message) =>
    message.role === "assistant" && message.stopReason !== "error" &&
    message.stopReason !== "aborted" && calculateContextTokens(message.usage) > 0));
  const sourceId = index < 0 ? undefined : entries[index].sourceEntry.id;
  const response = sourceId === undefined ? undefined : stats.get(sourceId);
  const anthropic = ctx.model?.provider === "anthropic" && ctx.model.api === "anthropic-messages";
  if (anthropic && response?.clearedInput === undefined) {
    return { tokens: projection.messages.reduce((sum, message) => sum + estimateTokens(message), 0), estimated: true };
  }
  const branchIndex = branch.findIndex((entry) => entry.id === sourceId);
  const invalidated = branch.slice(branchIndex + 1).some((entry) =>
    entry.type === "context_edit" || entry.type === "compaction");
  const estimated = !response || invalidated || entries.slice(index + 1).some((entry) => entry.messages.length > 0);
  return { tokens: tokens + (anthropic && !invalidated ? response?.clearedInput ?? 0 : 0), estimated };
}

export function createResponseObserver(stats: SessionStats) {
  const open = new Set<string>();
  const streams = new Map<string, {
    known: boolean;
    stopped: boolean;
    clearedInput: number;
    appliedEdits: number;
  }>();
  let stops = 0;
  let retired = 0;
  const markUnknown = () => {
    for (const stream of streams.values()) stream.known = false;
  };
  return {
    observe(data: unknown, edits: { clearedInput: number; appliedEdits: number } | undefined): void {
      if (!isRecord(data)) return;
      if (data.type === "message_start") {
        const id = isRecord(data.message) ? data.message.id : undefined;
        const ambiguous = open.size > 0 || retired > 0 || typeof id !== "string" || streams.has(id);
        // A new stream also invalidates a stopped response awaiting message_end.
        markUnknown();
        if (typeof id === "string") {
          open.add(id);
          streams.set(id, { known: !ambiguous, stopped: false, clearedInput: 0, appliedEdits: 0 });
        }
      }
      if (retired > 0) markUnknown();
      if (edits) {
        stats.serverClears += edits.appliedEdits;
        stats.serverClearedTokens += edits.clearedInput;
        if (open.size === 1 && stops === 0 && retired === 0) {
          const stream = streams.get(open.values().next().value!)!;
          stream.clearedInput += edits.clearedInput;
          stream.appliedEdits += edits.appliedEdits;
        } else markUnknown();
      }
      if (data.type === "message_stop") {
        // Stop frames have no id. Count them without guessing which overlapping
        // stream closed. An unmatched stop drains one unfinished retired stream.
        if (!open.size) {
          markUnknown();
          if (retired > 0) retired--;
        } else {
          if (open.size > 1 || stops > 0) markUnknown();
          if (++stops >= open.size) {
            for (const id of open) streams.get(id)!.stopped = true;
            open.clear();
            stops = 0;
          }
        }
      }
    },
    messageEnd(message: AssistantMessage): ResponseStats {
      const stream = message.responseId ? streams.get(message.responseId) : undefined;
      const known = stream?.known && stream.stopped && retired === 0;
      // Warm requests do not emit agent message_end and can lose message_stop.
      // Retain their outstanding count so late events cannot bind to a new reply.
      retired += open.size - stops;
      open.clear();
      streams.clear();
      stops = 0;
      return { input: message.usage.input, output: message.usage.output,
        cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite,
        clearedInput: known ? stream.clearedInput : undefined,
        appliedEdits: known ? stream.appliedEdits : undefined };
    },
  };
}
