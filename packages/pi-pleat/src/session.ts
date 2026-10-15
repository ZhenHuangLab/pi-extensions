import { createHash } from "node:crypto";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";

export const CAPABILITY_ENTRY = "pi-pleat.capability";
export const FALLBACK_ENTRY = "pi-pleat.fallback";

export interface Channel {
  provider: string;
  api: string;
  endpoint: string;
  model: string;
}

export function isPhysicalModel(model: Model<Api> | undefined): model is Model<Api> {
  return !!model && model.contextWindow > 0 && !!model.baseUrl.trim();
}

export function matchesResponse(model: Model<Api> | undefined, message: AgentMessage): message is AssistantMessage {
  return isPhysicalModel(model) && message.role === "assistant" && message.provider === model.provider &&
    message.api === model.api && message.model === model.id;
}

export function channelOf(model: Model<Api>): Channel {
  const endpoint = new URL(model.baseUrl);
  endpoint.username = "";
  endpoint.password = "";
  endpoint.search = "";
  endpoint.hash = "";
  return {
    provider: model.provider, api: model.api,
    endpoint: endpoint.href.replace(/\/+$/, ""), model: model.id,
  };
}

export function channelKey(channel: Channel): string {
  return `${channel.provider}|${channel.api}|${channel.endpoint}|${channel.model}`;
}

export function sameChannel(a: Channel, b: Channel): boolean {
  return a.provider === b.provider && a.api === b.api &&
    a.endpoint === b.endpoint && a.model === b.model;
}

export type Feature = "clearing" | "anthropic-compaction" | "responses-trigger";
export interface CapabilityRecord {
  key: string;
  feature: Feature;
  status: "supported" | "unsupported";
  reason: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readCapabilities(branch: SessionEntry[]): Map<string, CapabilityRecord> {
  const records = new Map<string, CapabilityRecord>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== CAPABILITY_ENTRY) continue;
    const data = entry.data;
    if (!isRecord(data) || typeof data.key !== "string" || typeof data.reason !== "string" ||
        (data.feature !== "clearing" && data.feature !== "anthropic-compaction" && data.feature !== "responses-trigger") ||
        (data.status !== "supported" && data.status !== "unsupported")) continue;
    const record = data as unknown as CapabilityRecord;
    records.set(`${record.key}#${record.feature}`, record);
  }
  return records;
}

const thinkingLevels: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && thinkingLevels.some((level) => level === value);
}

export interface FallbackOverride {
  model: string | null;
  thinking: ThinkingLevel | null;
}

export function readFallbackOverride(branch: SessionEntry[]): FallbackOverride | undefined {
  for (const entry of [...branch].reverse()) {
    if (entry.type !== "custom" || entry.customType !== FALLBACK_ENTRY) continue;
    const data = entry.data;
    if (isRecord(data) && (data.model === null || typeof data.model === "string") &&
        (data.thinking === null || isThinkingLevel(data.thinking))) {
      return { model: data.model, thinking: data.thinking };
    }
  }
  return undefined;
}

export interface AnthropicNative {
  kind: "anthropic";
  block: Record<string, unknown>;
  systemHash: string;
  toolsHash: string;
  keptSignatures: string[];
  keptToolUseIds: string[];
}
export interface ResponsesNative {
  kind: "responses-trigger";
  window: unknown[];
}
export interface PleatDetails extends Channel {
  plugin: "pi-pleat";
  version: 1;
  strategy: "anthropic" | "responses-trigger" | "pi-summary";
  firstCoveredEntryId: string;
  lastCoveredEntryId: string;
  firstKeptEntryId: string;
  native?: AnthropicNative | ResponsesNative;
  reason?: string;
  usageComplete?: boolean;
  readFiles?: string[];
  modifiedFiles?: string[];
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function readPleatDetails(entry: CompactionEntry): PleatDetails | undefined {
  const data = entry.details;
  if (!isRecord(data) || data.plugin !== "pi-pleat" || data.version !== 1 ||
      (data.strategy !== "anthropic" && data.strategy !== "responses-trigger" && data.strategy !== "pi-summary") ||
      !["provider", "api", "endpoint", "model", "firstCoveredEntryId", "lastCoveredEntryId", "firstKeptEntryId"]
        .every((key) => typeof data[key] === "string" && data[key].length > 0) ||
      data.firstKeptEntryId !== entry.firstKeptEntryId ||
      (data.reason !== undefined && typeof data.reason !== "string") ||
      (data.usageComplete !== undefined && typeof data.usageComplete !== "boolean") ||
      (data.readFiles !== undefined && !stringArray(data.readFiles)) ||
      (data.modifiedFiles !== undefined && !stringArray(data.modifiedFiles))) return undefined;
  const native = data.native;
  if (native !== undefined) {
    if (!isRecord(native)) return undefined;
    if (data.strategy === "anthropic") {
      if (native.kind !== "anthropic" || !isRecord(native.block) ||
          native.block.type !== "compaction" ||
          typeof native.block.content !== "string" || !native.block.content.trim() ||
          typeof native.block.signature !== "string" || !native.block.signature ||
          typeof native.systemHash !== "string" || !/^[a-f0-9]{64}$/.test(native.systemHash) ||
          typeof native.toolsHash !== "string" || !/^[a-f0-9]{64}$/.test(native.toolsHash) ||
          !stringArray(native.keptSignatures) || !stringArray(native.keptToolUseIds)) return undefined;
    } else if (data.strategy === "responses-trigger") {
      if (native.kind !== "responses-trigger" || !Array.isArray(native.window) || !native.window.length) return undefined;
      const item: unknown = native.window.at(-1);
      if (!isRecord(item) || item.type !== "compaction" || typeof item.encrypted_content !== "string" || !item.encrypted_content.trim() ||
          !native.window.slice(0, -1).every((message: unknown) => isRecord(message) && message.role === "user" &&
            (message.type === undefined || message.type === "message") && Array.isArray(message.content) &&
            message.content.every((part: unknown) => isRecord(part) && part.type === "input_text" && typeof part.text === "string"))) return undefined;
    } else return undefined;
  }
  return data as unknown as PleatDetails;
}

export function canonicalJson(value: unknown): string {
  // Convert to JSON values first so arrays and optional properties follow JSON rules.
  const json: unknown = JSON.parse(JSON.stringify(value) ?? "null");
  function encode(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    if (isRecord(item)) {
      return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode(item[key])}`).join(",")}}`;
    }
    return JSON.stringify(item);
  }
  return encode(json);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function coverage(branch: SessionEntry[], firstKeptEntryId: string): {
  firstCoveredEntryId: string;
  lastCoveredEntryId: string;
} | undefined {
  const entries = buildSessionProjection(branch).entries;
  const kept = entries.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
  if (kept < 0) return undefined;
  const covered = entries.slice(0, kept).filter((entry) => entry.messages.length > 0);
  if (!covered.length) return undefined;
  return {
    firstCoveredEntryId: covered[0].sourceEntry.id,
    lastCoveredEntryId: covered[covered.length - 1].sourceEntry.id,
  };
}

export interface ToolRecord {
  entryId: string;
  index: number;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown> | undefined;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  details: unknown;
}

export function toolRecords(branch: SessionEntry[]): ToolRecord[] {
  const records: ToolRecord[] = [];
  const calls = new Map<string, Record<string, unknown>>();
  branch.forEach((entry, index) => {
    if (entry.type !== "message") return;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") calls.set(block.id, block.arguments);
      }
    } else if (message.role === "toolResult") {
      records.push({
        entryId: entry.id, index, toolCallId: message.toolCallId, toolName: message.toolName,
        args: calls.get(message.toolCallId), content: message.content,
        isError: message.isError, details: message.details,
      });
    }
  });
  return records;
}

export function isClaudeThinking(message: AgentMessage): boolean {
  return message.role === "assistant" && message.api === "anthropic-messages" &&
    message.content.some((block) => block.type === "thinking" &&
      (block.redacted === true || !!block.thinkingSignature));
}
