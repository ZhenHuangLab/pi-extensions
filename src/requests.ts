import { convertToLlm, getLatestCompactionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { COMPACT_BETA } from "./providers/anthropic.ts";
import { canonicalJson, channelOf, isRecord, readPleatDetails, sameChannel, sha256 } from "./session.ts";
import type { Channel } from "./session.ts";

export interface Snapshot { payload: Record<string, unknown>; channel: Channel }
export interface BoundRequest { snapshot: Snapshot; assistantEntryId: string }
export interface ReplayState { state: "applied" | "none" | "rejected"; reason?: string }
export interface ReplayResult extends ReplayState { payload: Record<string, unknown> }

export function createRequests() {
  let last: Snapshot | undefined;
  let pending: Snapshot | undefined;
  let bound: BoundRequest | undefined;
  return {
    discard(): void { last = undefined; pending = undefined; },
    record(payload: Record<string, unknown>, channel: Channel): void {
      if (channel.api === "anthropic-messages" && payload.max_tokens === 1) return;
      last = { payload: structuredClone(payload), channel: { ...channel } };
    },
    onMessageEnd(message: AgentMessage): void {
      if (message.role !== "assistant") return;
      pending = message.stopReason === "stop" || message.stopReason === "toolUse" ? last : undefined;
      // Pi can also clamp a real request to one token. A snapshot can bind only
      // once, so ignoring that request cannot bind its reply to an older prefix.
      last = undefined;
    },
    onTurnEnd(event: Pick<TurnEndEvent, "message" | "messageEntryId">): void {
      if (pending && event.message.role === "assistant" &&
          (event.message.stopReason === "stop" || event.message.stopReason === "toolUse")) {
        bound = { snapshot: pending, assistantEntryId: event.messageEntryId };
      }
      pending = undefined;
    },
    boundary(branch: SessionEntry[], model: Model<Api>): BoundRequest | undefined {
      return bound && branch.some((entry) => entry.id === bound!.assistantEntryId) &&
        sameChannel(bound.snapshot.channel, channelOf(model)) ? bound : undefined;
    },
  };
}
export type Requests = ReturnType<typeof createRequests>;

function onlyText(message: unknown, type: string): string | undefined {
  if (!isRecord(message) || message.role !== "user") return undefined;
  if (type === "text" && typeof message.content === "string") return message.content;
  const content = message.content;
  if (!Array.isArray(content) || content.length !== 1 || !isRecord(content[0]) || content[0].type !== type) return undefined;
  if (type === "input_text" && Object.keys(content[0]).some((key) => key !== "type" && key !== "text")) return undefined;
  return typeof content[0].text === "string" ? content[0].text : undefined;
}

export function applyReplay(payload: Record<string, unknown>, model: Model<Api>, branch: SessionEntry[]): ReplayResult {
  const reject = (reason: string): ReplayResult => ({ payload, state: "rejected", reason });
  try {
    const latest = getLatestCompactionEntry(branch);
    const details = latest && readPleatDetails(latest);
    if (!details?.native) return { payload, state: "none" };
    if (!sameChannel(details, channelOf(model))) return { payload, state: "none", reason: "channel differs" };
    const summary = convertToLlm([{ role: "compactionSummary", summary: latest!.summary, tokensBefore: latest!.tokensBefore, timestamp: 0 }])[0];
    const expected = summary.role === "user" && Array.isArray(summary.content) && summary.content[0].type === "text" ? summary.content[0].text : undefined;
    if (expected === undefined) return reject("summary differs");
    if (details.native.kind === "anthropic" && Array.isArray(payload.messages)) {
      const native = details.native;
      if (onlyText(payload.messages[0], "text") !== expected) return reject("summary differs");
      let index = 1;
      while (index < payload.messages.length) {
        const message = payload.messages[index];
        if (!isRecord(message) || message.role !== "system" || !Array.isArray(message.content) || message.content.length ||
            !isRecord(message.output_config) || Object.keys(message).some((key) => !["role", "content", "output_config"].includes(key))) break;
        index++;
      }
      const kept = payload.messages[index];
      if (!isRecord(kept) || kept.role !== "assistant" || !Array.isArray(kept.content)) return reject("kept assistant missing");
      const signatures = kept.content.flatMap((part: unknown) => isRecord(part) && part.type === "thinking" ? [part.signature] : isRecord(part) && part.type === "redacted_thinking" ? [part.data] : []);
      const toolUseIds = kept.content.flatMap((part: unknown) => isRecord(part) && part.type === "tool_use" ? [part.id] : []);
      if (canonicalJson(signatures) !== canonicalJson(native.keptSignatures) || canonicalJson(toolUseIds) !== canonicalJson(native.keptToolUseIds)) return reject("kept assistant identity differs");
      if (sha256(canonicalJson(payload.system ?? null)) !== native.systemHash) return reject("system differs");
      if (sha256(canonicalJson(payload.tools ?? null)) !== native.toolsHash) return reject("tools differ");
      return { state: "applied", payload: { ...payload,
        messages: [{ role: "assistant", content: [structuredClone(native.block)] }, ...payload.messages.slice(index)],
        betas: [...new Set([...(Array.isArray(payload.betas) ? payload.betas : []), COMPACT_BETA])],
      } };
    }
    if (details.native.kind === "responses-trigger" && Array.isArray(payload.input)) {
      // Pi's OpenAI adapter puts the leading instruction in input. Codex uses
      // instructions instead. Preserve that one instruction and verify the next
      // fixed item; never search the history for matching summary text.
      const first = payload.input[0];
      const index = model.provider === "openai" && model.api === "openai-responses" && isRecord(first) &&
        (first.role === "developer" || first.role === "system") && typeof first.content === "string" &&
        Object.keys(first).every((key) => key === "role" || key === "content") ? 1 : 0;
      const message = payload.input[index];
      if (onlyText(message, "input_text") !== expected || !isRecord(message) ||
          message.type !== undefined && message.type !== "message") return reject("summary differs");
      return { state: "applied", payload: { ...payload, input: [...payload.input.slice(0, index), ...structuredClone(details.native.window), ...payload.input.slice(index + 1)] } };
    }
    return reject("payload shape differs");
  } catch { return reject("replay validation failed"); }
}
