import { buildSessionProjection, calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { isRecord } from "./session.ts";

export const CLEAR_TRIGGER_RATIO = 0.5;
export const CLEAR_FLOOR_RATIO = 0.1;
export const KEEP_TOOL_USES = 8;
export const MIN_CLEAR_BYTES = 1024;
export const CONTEXT_SAFETY_TOKENS = 4096;

export interface Limits {
  window: number;
  reserve: number;
  keepRecent: number;
  enabled: boolean;
  threshold: number;
  clearTrigger: number;
  clearFloor: number;
}

export function limitsFor(model: Model<Api>, settings: Record<string, unknown>): Limits {
  const compaction = isRecord(settings.compaction) ? settings.compaction : {};
  const overrides = isRecord(compaction.modelOverrides) ? compaction.modelOverrides : {};
  const value = overrides[`${model.provider}/${model.id}`];
  const override = isRecord(value) ? value : {};
  function tokens(field: string, defaultValue: number): number {
    for (const candidate of [override[field], compaction[field]]) {
      if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) return candidate;
    }
    return defaultValue;
  }
  const reserve = tokens("reserveTokens", 16384);
  const threshold = Math.max(0, model.contextWindow - reserve);
  return {
    window: model.contextWindow, reserve, keepRecent: tokens("keepRecentTokens", 20000),
    enabled: compaction.enabled !== false, threshold,
    clearTrigger: Math.max(1, Math.round(CLEAR_TRIGGER_RATIO * threshold)),
    clearFloor: Math.max(1, Math.round(CLEAR_FLOOR_RATIO * threshold)),
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
