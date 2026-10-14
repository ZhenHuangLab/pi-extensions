import { isDeepStrictEqual } from "node:util";
import { calculateCost, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, Usage } from "@earendil-works/pi-ai";
import { isRecord } from "../session.ts";
import { captureResponse } from "./http.ts";

export function isResponsesTrigger(model: Model<Api>): boolean {
  return model.provider === "openai-codex" && model.api === "openai-codex-responses" ||
    model.provider === "openai" && model.api === "openai-responses";
}

export type ResponsesOutcome =
  | { ok: true; window: unknown[]; usage?: Usage }
  | { ok: false; kind: "cancelled" | "transient" | "unsupported" | "invalid" | "unsupported-content"; retryAfter?: number };

function responseUsage(value: unknown, model: Model<Api>): Usage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("integrity");
  const cached = isRecord(value.input_tokens_details) ? value.input_tokens_details.cached_tokens ?? 0 : 0;
  const counts = [value.input_tokens, value.output_tokens, cached];
  if (!counts.every((count) => typeof count === "number" && Number.isFinite(count) && count >= 0) ||
      (cached as number) > (value.input_tokens as number)) throw new Error("integrity");
  const usage: Usage = {
    input: (value.input_tokens as number) - (cached as number), output: value.output_tokens as number,
    cacheRead: cached as number, cacheWrite: 0,
    totalTokens: (value.input_tokens as number) + (value.output_tokens as number),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

function compactedWindow(input: unknown[], item: Record<string, unknown>): unknown[] | undefined {
  const retained = input.filter((value): value is Record<string, unknown> =>
    isRecord(value) && value.role === "user" && (value.type === undefined || value.type === "message"));
  // Validate every retained user item before budgeting, including items too old
  // to fit. Multimodal retained history has not been verified for this protocol.
  if (retained.some((message) => !Array.isArray(message.content) || message.content.some((part) =>
      !isRecord(part) || part.type !== "input_text" || typeof part.text !== "string"))) return undefined;
  let tokens = 0;
  let start = retained.length;
  while (start > 0) {
    const content = retained[start - 1].content as { text: string }[];
    const size = content.reduce((sum, part) => sum + part.text.length / 4, 0);
    if (tokens + size > 64000) break;
    tokens += size;
    start--;
  }
  return JSON.parse(JSON.stringify([...retained.slice(start), item])) as unknown[];
}

function readResponse(text: string): {
  response?: Record<string, unknown>;
  items: Record<string, unknown>[];
  failed: boolean;
} {
  const items: Record<string, unknown>[] = [];
  let response: Record<string, unknown> | undefined;
  let done = false;
  let failed = false;
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
    if (!data.length) continue;
    if (done) throw new Error("integrity");
    const json = data.join("\n");
    if (json.trim() === "[DONE]") {
      if (!response) throw new Error("integrity");
      done = true;
      continue;
    }
    const event: unknown = JSON.parse(json);
    if (!isRecord(event) || typeof event.type !== "string" || type && type !== event.type || response) {
      throw new Error("integrity");
    }
    if (["error", "response.failed", "response.incomplete"].includes(event.type)) failed = true;
    if (event.type === "response.output_item.done") {
      if (!isRecord(event.item)) throw new Error("integrity");
      items.push(event.item);
    }
    if (event.type === "response.completed" || event.type === "response.done") {
      if (!isRecord(event.response) || event.response.status !== "completed") throw new Error("integrity");
      response = event.response;
    }
  }
  if (response && (!Array.isArray(response.output) || !isDeepStrictEqual(response.output, items))) {
    throw new Error("integrity");
  }
  return { response, items, failed };
}

export async function requestTriggerCompaction({ ctx, model, prefixMessages, thinkingLevel, signal, splice }: {
  ctx: ExtensionContext;
  model: Model<Api>;
  prefixMessages: Message[];
  thinkingLevel: ThinkingLevel;
  signal: AbortSignal;
  splice: (payload: Record<string, unknown>) => Record<string, unknown>;
}): Promise<ResponsesOutcome> {
  let result: AssistantMessage | undefined;
  let sentInput: unknown[] | undefined;
  const { captured, fetch } = captureResponse();
  try {
    result = await ctx.modelRegistry.streamSimple(model, { messages: prefixMessages }, {
      reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
      transport: "sse", maxRetries: 0, signal, sessionId: ctx.sessionManager.getSessionId(),
      onPayload(body) {
        if (!isRecord(body) || !Array.isArray(body.input)) throw new Error("Responses input missing.");
        const payload = splice(body);
        if (!Array.isArray(payload.input)) throw new Error("Responses input missing.");
        sentInput = JSON.parse(JSON.stringify(payload.input)) as unknown[];
        return { ...payload, input: [...payload.input, { type: "compaction_trigger" }] };
      },
      fetch,
    }).result();
  } catch { /* Outcomes expose classifications only, never provider state or credentials. */ }
  if (signal.aborted) return { ok: false, kind: "cancelled" };
  if (!captured.started) return { ok: false, kind: "invalid" };
  const { status, retryAfter, text } = captured;
  if (status === 404 || status === 400 &&
      /compaction|compaction_trigger|unknown.*(type|item)|invalid.*input/i.test(text || result?.errorMessage || "")) {
    return { ok: false, kind: "unsupported" };
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return { ok: false, kind: "invalid" };
  }
  if (status === 429 || status !== undefined && status >= 500) {
    return { ok: false, kind: "transient", retryAfter };
  }
  if (captured.failed) return { ok: false, kind: "transient", retryAfter };
  if (status !== 200 || text === undefined || !sentInput) return { ok: false, kind: "invalid" };
  try {
    const { response, items, failed } = readResponse(text);
    if (!response && result && isRetryableAssistantError(result)) {
      return { ok: false, kind: "transient", retryAfter };
    }
    if (!response || failed || result?.stopReason !== "stop") return { ok: false, kind: "invalid" };
    const compactions = items.filter((item) => item.type === "compaction");
    if (compactions.length !== 1 || typeof compactions[0].encrypted_content !== "string" ||
        !compactions[0].encrypted_content.trim()) return { ok: false, kind: "invalid" };
    const window = compactedWindow(sentInput, compactions[0]);
    if (!window) return { ok: false, kind: "unsupported-content" };
    return { ok: true, window, usage: responseUsage(response.usage, model) };
  } catch { return { ok: false, kind: "invalid" }; }
}
