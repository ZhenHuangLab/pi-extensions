import { calculateCost } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { Limits } from "../budget.ts";
import { isRecord } from "../session.ts";
import { captureResponse } from "./http.ts";

export const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

export function isAnthropic(model: Model<Api>): boolean {
  return model.provider === "anthropic" && model.api === "anthropic-messages";
}

export function withClearing(payload: Record<string, unknown>, limits: Limits): Record<string, unknown> {
  if ("context_management" in payload || "compaction" in payload) return payload;
  const edits: Record<string, unknown>[] = [];
  if (payload.thinking !== undefined &&
      !(isRecord(payload.thinking) && payload.thinking.type === "disabled")) {
    edits.push({ type: "clear_thinking_20251015", keep: "all" });
  }
  edits.push({
    type: "clear_tool_uses_20250919",
    trigger: { type: "input_tokens", value: limits.clearTrigger },
    keep: { type: "tool_uses", value: limits.keepToolUses },
    clear_at_least: { type: "input_tokens", value: limits.clearFloor },
    clear_tool_inputs: false,
  });
  const betas = Array.isArray(payload.betas) ? payload.betas : [];
  return {
    ...payload, context_management: { edits },
    betas: [...new Set([...betas, CONTEXT_MANAGEMENT_BETA])],
  };
}

export function readAppliedEdits(data: unknown): { clearedInput: number; appliedEdits: number } | undefined {
  if (!isRecord(data) || data.type !== "message_delta" || !isRecord(data.context_management) ||
      !Array.isArray(data.context_management.applied_edits)) return undefined;
  const edits = data.context_management.applied_edits;
  return {
    clearedInput: edits.reduce((sum: number, edit: unknown) => {
      const tokens = isRecord(edit) ? edit.cleared_input_tokens : undefined;
      return sum + (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : 0);
    }, 0),
    appliedEdits: edits.length,
  };
}

export function isClearingUnsupported(errorMessage: string | undefined): boolean {
  return typeof errorMessage === "string" &&
    /context_management|context-management|clear_tool_uses|clear_thinking/i.test(errorMessage) &&
    /not supported|unsupported|does not support|Extra inputs are not permitted|unknown|invalid beta/i.test(errorMessage);
}

export const COMPACT_BETA = "compact-2026-09-04";

export function compactionPayload(snapshot: Record<string, unknown>, customInstructions?: string): Record<string, unknown> {
  const payload = structuredClone(snapshot);
  delete payload.context_management;
  delete payload.stop_sequences;
  if (isRecord(payload.tool_choice) && ["any", "tool"].includes(String(payload.tool_choice.type))) delete payload.tool_choice;
  if (isRecord(payload.output_config)) delete payload.output_config.format;
  payload.betas = [...new Set([...(Array.isArray(payload.betas) ? payload.betas : []), COMPACT_BETA])];
  payload.compaction = { type: "summarize" };
  if (customInstructions?.trim()) {
    payload.instructions = (`Summarize the conversation so far so that the work can continue from the summary alone. Keep goals, constraints, decisions, progress, open tasks, and exact file paths, identifiers, and error messages. Additional focus: ${customInstructions} Do not call tools; respond with the summary text only.`).slice(0, 16384);
  }
  return payload;
}

export type AnthropicOutcome =
  | { ok: true; block: Record<string, unknown>; usage?: Usage }
  | { ok: false; kind: "cancelled" | "transient" | "unsupported" | "invalid" | "no-summary"; message?: string; retryAfter?: number };

function errorText(text: string): string {
  try {
    const body: unknown = JSON.parse(text);
    const error = isRecord(body) && isRecord(body.error) ? body.error : body;
    if (isRecord(error)) return `${typeof error.type === "string" ? error.type : ""} ${typeof error.message === "string" ? error.message : ""}`.trim();
  } catch { /* Non-JSON errors do not expose response bodies in diagnostics. */ }
  return "Provider request failed.";
}

function sseEvents(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const frame of text.replace(/\r\n?/g, "\n").split("\n\n")) {
    let type = "";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") type = value;
      if (field === "data") data.push(value);
    }
    if (type === "ping" || !data.length) continue;
    const value: unknown = JSON.parse(data.join("\n"));
    if (!isRecord(value) || typeof value.type !== "string" || type && value.type !== type) throw new Error("integrity");
    events.push(value);
  }
  return events;
}

function compactionUsage(value: unknown, model: Model<Api>): Usage | undefined {
  if (!isRecord(value) || !Array.isArray(value.iterations)) return undefined;
  const iterations = value.iterations.filter((iteration): iteration is Record<string, unknown> =>
    isRecord(iteration) && iteration.type === "compaction");
  const validCount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!iterations.length || iterations.some((iteration) =>
    !validCount(iteration.input_tokens) || !validCount(iteration.output_tokens) ||
    iteration.cache_read_input_tokens !== undefined && !validCount(iteration.cache_read_input_tokens) ||
    iteration.cache_creation_input_tokens !== undefined && !validCount(iteration.cache_creation_input_tokens))) {
    return undefined;
  }
  const sum = (key: string) => iterations.reduce((total, iteration) => total + ((iteration[key] as number) ?? 0), 0);
  const usage: Usage = {
    input: sum("input_tokens"), output: sum("output_tokens"),
    cacheRead: sum("cache_read_input_tokens"), cacheWrite: sum("cache_creation_input_tokens"), totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  if (!Number.isFinite(usage.totalTokens)) return undefined;
  calculateCost(model, usage);
  return usage;
}

function parseCompaction(text: string, model: Model<Api>): AnthropicOutcome {
  const invalid: AnthropicOutcome = { ok: false, kind: "invalid", message: "integrity" };
  try {
    const events = sseEvents(text);
    const error = events.find((event) => event.type === "error");
    if (error) return { ok: false, kind: isRecord(error.error) && ["overloaded_error", "api_error"].includes(String(error.error.type)) ? "transient" : "invalid", message: "Provider stream error." };
    if (events[0]?.type !== "message_start" || events.at(-1)?.type !== "message_stop" ||
        events.filter((event) => event.type === "message_start").length !== 1 ||
        events.filter((event) => event.type === "message_stop").length !== 1) return invalid;
    const start = events[0];
    if (!isRecord(start.message) || !Array.isArray(start.message.content) || start.message.content.length) return invalid;
    const blocks: Record<string, unknown>[] = [];
    const indices = new Set<number>();
    let active: number | undefined;
    let delta: Record<string, unknown> | undefined;
    for (const event of events.slice(1, -1)) {
      if (event.type === "content_block_start") {
        if (delta || active !== undefined || !Number.isSafeInteger(event.index) || indices.has(event.index as number) || !isRecord(event.content_block)) return invalid;
        active = event.index as number;
        indices.add(active);
        blocks.push(event.content_block);
      } else if (event.type === "content_block_stop") {
        if (active === undefined || event.index !== active) return invalid;
        active = undefined;
      } else if (event.type === "content_block_delta") {
        if (event.index !== active || active === undefined || blocks.at(-1)?.type === "compaction") return invalid;
      } else if (event.type === "message_delta") {
        if (active !== undefined || delta || !isRecord(event.delta) || typeof event.delta.stop_reason !== "string") return invalid;
        delta = event;
      } else return invalid;
    }
    if (!delta || active !== undefined || !isRecord(delta.delta)) return invalid;
    const stop = delta.delta.stop_reason;
    if (["max_tokens", "model_context_window_exceeded", "tool_use", "refusal", "end_turn"].includes(String(stop)) && !blocks.some((block) => block.type === "compaction")) return { ok: false, kind: "no-summary", message: `Compaction returned ${stop}.` };
    const block = blocks[0];
    if (stop !== "compaction" || blocks.length !== 1 || block.type !== "compaction" ||
        typeof block.content !== "string" || !block.content.trim() || typeof block.signature !== "string" || !block.signature.trim()) return invalid;
    return { ok: true, block, usage: compactionUsage(delta.usage ?? start.message.usage, model) };
  } catch { return invalid; }
}

export async function requestCompaction({ ctx, model, payload, signal }: {
  ctx: ExtensionContext; model: Model<Api>; payload: Record<string, unknown>; signal: AbortSignal;
}): Promise<AnthropicOutcome> {
  const { captured, fetch } = captureResponse();
  let result: AssistantMessage | undefined;
  try {
    result = await ctx.modelRegistry.streamSimple(model, {
      messages: [{ role: "user", content: "pi-pleat compaction", timestamp: 0 }],
    }, { maxRetries: 0, signal, onPayload: () => payload, fetch }).result();
  } catch { /* The captured response, rather than Pi normalization, is authoritative. */ }
  if (signal.aborted) return { ok: false, kind: "cancelled" };
  if (!captured.started) {
    // Setup errors must not enable a retry or fallback that conceals an auth failure.
    return {
      ok: false, kind: "invalid",
      message: result?.stopReason === "error" ? "Provider authorization or setup failed." : "Provider request was not sent.",
    };
  }
  const { status, retryAfter, text } = captured;
  if (status === 429 || status !== undefined && status >= 500) {
    return { ok: false, kind: "transient", retryAfter };
  }
  const fullMessage = errorText(text ?? "");
  const message = fullMessage.slice(0, 300);
  if (status === 404 || status === 400 && /compact|compaction/i.test(fullMessage) &&
      /not supported|unsupported|does not support|Extra inputs are not permitted|unknown|invalid beta/i.test(fullMessage)) {
    return { ok: false, kind: "unsupported", message };
  }
  if (status !== undefined && status >= 400 && status < 500) return { ok: false, kind: "invalid", message };
  if (captured.failed) return { ok: false, kind: "transient", retryAfter, message: "No complete provider response." };
  if (status !== 200 || text === undefined) return { ok: false, kind: "invalid", message };
  return parseCompaction(text, model);
}

export function keptIdentity(assistant: AssistantMessage): { signatures: string[]; toolUseIds: string[] } {
  return {
    signatures: assistant.content.flatMap((block) => block.type === "thinking" && block.thinkingSignature ? [block.thinkingSignature] : []),
    toolUseIds: assistant.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []),
  };
}
