import {
  buildSessionProjection, compact, convertToLlm, estimateTokens, generateSummaryWithUsage,
  serializeConversation, sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI, ExtensionContext, FileOperations, SessionBeforeCompactEvent, SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, hasApi } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, RetryPolicy, ThinkingBudgets, Usage } from "@earendil-works/pi-ai";
import { CONTEXT_SAFETY_TOKENS, limitsFor } from "./budget.ts";
import type { Limits } from "./budget.ts";
import { isPhysicalModel, isRecord, isThinkingLevel, readFallbackOverride } from "./session.ts";

export type CompactionPreparation = SessionBeforeCompactEvent["preparation"];
export interface Summarizer {
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  label: "session override" | "settings" | "session model";
  configured: boolean;
}
export function resolveSummarizer(
  pi: Pick<ExtensionAPI, "getSettings" | "getThinkingLevel">,
  ctx: Pick<ExtensionContext, "sessionManager" | "modelRegistry" | "model">,
): Summarizer | { error: string } {
  const override = readFallbackOverride(ctx.sessionManager.getBranch());
  const config = (pi.getSettings() as Record<string, unknown>)["pi-pleat"];
  if (config !== undefined && !isRecord(config)) return { error: "Invalid pi-pleat fallback settings." };
  const settings = isRecord(config) ? config : {};
  const fromOverride = !!override && (override.model !== null || override.thinking !== null);
  const name = override?.model ?? settings.fallbackModel;
  const thinking = override?.thinking ?? settings.fallbackThinking;
  if (thinking !== undefined && !isThinkingLevel(thinking)) return { error: "Invalid fallback thinking level." };
  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    return { error: "Invalid fallback model. Use provider/model." };
  }
  let model = ctx.model;
  if (typeof name === "string") {
    const slash = name.indexOf("/");
    if (slash <= 0 || slash === name.length - 1) return { error: "Invalid fallback model. Use provider/model." };
    model = ctx.modelRegistry.find(name.slice(0, slash), name.slice(slash + 1));
    if (!isPhysicalModel(model)) return { error: "Fallback model was not found or is not a physical model." };
  }
  if (!isPhysicalModel(model)) return { error: "No physical model selected." };
  const configured = name !== undefined || thinking !== undefined;
  return {
    model, thinkingLevel: clampThinkingLevel(model, thinking ?? (configured ? "off" : pi.getThinkingLevel())),
    label: configured ? fromOverride ? "session override" : "settings" : "session model", configured,
  };
}

export function combineUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input, output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input, output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead, cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

function retryPolicy(settings: Record<string, unknown>): RetryPolicy {
  const retry = isRecord(settings.retry) ? settings.retry : {};
  const number = (key: string, fallback: number) =>
    typeof retry[key] === "number" && Number.isSafeInteger(retry[key]) && retry[key] >= 0 ? retry[key] : fallback;
  return {
    enabled: retry.enabled !== false, maxRetries: number("maxRetries", 3),
    baseDelayMs: number("baseDelayMs", 2000), maxAgentDelayMs: number("maxAgentDelayMs", 60000),
  };
}

const SUMMARY_PROMPT_TOKENS = 2000;
const DEFAULT_THINKING_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };

function thinkingBudgetsFor(settings: Record<string, unknown>): ThinkingBudgets | undefined {
  if (!isRecord(settings.thinkingBudgets)) return undefined;
  const budgets: ThinkingBudgets = {};
  for (const level of ["minimal", "low", "medium", "high"] as const) {
    const tokens = settings.thinkingBudgets[level];
    if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0) budgets[level] = tokens;
  }
  return budgets;
}

function usesAdditionalThinkingBudget(model: Model<Api>): boolean {
  if (hasApi(model, "anthropic-messages")) return model.compat?.forceAdaptiveThinking !== true;
  if (model.api !== "bedrock-converse-stream") return false;
  // Pi 1.2.0 expands the response ceiling only for older Claude models on
  // Bedrock. Its adaptive-model check considers inference-profile names too.
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  const claude = id.includes("anthropic.claude") || id.includes("anthropic/claude") || name.includes("claude");
  const candidates = [id, name].flatMap((value) => [value, value.replace(/[\s_.:]+/g, "-")]);
  const adaptive = candidates.some((value) =>
    /opus-(4-[678]|5)|sonnet-(4-6|5)|haiku-5|fable-5/.test(value));
  return claude && !adaptive;
}

function summaryResponseTokens(model: Model<Api>, reserve: number, level: ThinkingLevel, budgets?: ThinkingBudgets): number {
  const ceiling = model.maxTokens > 0 ? model.maxTokens : Infinity;
  const output = Math.min(Math.floor(0.8 * reserve), ceiling);
  if (!model.reasoning || level === "off" || !usesAdditionalThinkingBudget(model)) return output;
  const budgetLevel = level === "xhigh" || level === "max" ? "high" : level;
  const thinking = budgets?.[budgetLevel] ?? DEFAULT_THINKING_BUDGETS[budgetLevel];
  // This is Pi's adjustMaxTokensForThinking response ceiling. The adapter
  // also clamps thinking inside it to keep 1024 tokens for the answer.
  return Math.min(output + thinking, ceiling);
}

function knownUsage(usage: Usage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens];
  const costs = usage.cost && [usage.cost.input, usage.cost.output, usage.cost.cacheRead, usage.cost.cacheWrite, usage.cost.total];
  // Pi initializes usage to zero even when the provider reports none.
  if (!counts.every((value) => Number.isFinite(value) && value >= 0) || !counts.some((value) => value > 0) ||
      !costs?.every((value) => Number.isFinite(value) && value >= 0)) return undefined;
  return usage;
}

export interface Summary {
  summary: string;
  usage?: Usage;
  usageComplete?: boolean;
  readFiles: string[];
  modifiedFiles: string[];
}
export async function summarize({ ctx, preparation, summarizer, customInstructions, signal, settings, checkState, onUsage }: {
  ctx: ExtensionContext;
  preparation: CompactionPreparation;
  summarizer: Summarizer;
  customInstructions?: string;
  signal: AbortSignal;
  settings: Record<string, unknown>;
  checkState?: () => void;
  onUsage?: (usage: Usage | undefined) => void;
}): Promise<Summary> {
  const { model, thinkingLevel } = summarizer;
  const reserve = limitsFor(model, settings).reserve;
  const thinkingBudgets = thinkingBudgetsFor(settings);
  const budget = model.contextWindow - summaryResponseTokens(model, reserve, thinkingLevel, thinkingBudgets) -
    CONTEXT_SAFETY_TOKENS - SUMMARY_PROMPT_TOKENS;
  const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  const size = (messages: AgentMessage[], previous?: string) =>
    (serializeConversation(convertToLlm(messages)).length + (previous?.length ?? 0) +
      (customInstructions?.length ?? 0)) / 4;
  let usage: Usage | undefined;
  let usageComplete = true;
  const streamFn: StreamFn = async (model, context, options) => {
    signal.throwIfAborted();
    checkState?.();
    let stream: AssistantMessageEventStream;
    let response: AssistantMessage;
    try {
      stream = ctx.modelRegistry.streamSimple(model, context, { ...options, thinkingBudgets });
      response = await stream.result();
    } catch (error) {
      usageComplete = false;
      onUsage?.(undefined);
      throw error;
    }
    // A completed request is billable even when its candidate is now obsolete.
    const reported = knownUsage(response.usage);
    usage = combineUsage(usage, reported);
    if (!reported) usageComplete = false;
    onUsage?.(reported);
    signal.throwIfAborted();
    checkState?.();
    // Pi adds file lists and split-turn headings after it reads the raw reply.
    // Validate here so those additions cannot make an empty reply look valid.
    // Return provider errors to Pi so its configured retry policy still runs.
    if (response.stopReason === "error") return stream;
    if (response.stopReason !== "stop" || response.content.some((block) => block.type === "toolCall")) {
      throw new Error("Fallback summarization did not complete with text only.");
    }
    if (!response.content.some((block) => block.type === "text" && block.text.trim())) {
      throw new Error("Fallback summary was empty.");
    }
    return stream;
  };
  const retry = retryPolicy(settings);
  signal.throwIfAborted();
  if (size(messages, preparation.previousSummary) <= budget) {
    const result = await compact(
      { ...preparation, settings: { ...preparation.settings, reserveTokens: reserve } },
      model, undefined, undefined, customInstructions, signal, thinkingLevel, streamFn, undefined, retry,
    );
    signal.throwIfAborted();
    if (!result.summary.trim()) throw new Error("Fallback summary was empty.");
    const details = result.details as { readFiles: string[]; modifiedFiles: string[] };
    return { summary: result.summary, usage, ...(usageComplete ? {} : { usageComplete: false }), ...details };
  }
  let previous = preparation.previousSummary;
  let offset = 0;
  while (offset < messages.length) {
    let end = offset;
    while (end < messages.length && size(messages.slice(offset, end + 1), previous) <= budget) end++;
    if (end === offset) throw new Error("A single message does not fit the fallback model window.");
    const result = await generateSummaryWithUsage(
      messages.slice(offset, end), model, reserve, undefined, undefined, signal,
      customInstructions, previous, thinkingLevel, streamFn, undefined, retry,
    );
    signal.throwIfAborted();
    if (!result.text.trim()) throw new Error("Fallback summary was empty.");
    previous = result.text;
    offset = end;
  }
  if (!previous?.trim()) throw new Error("Fallback summary was empty.");
  const modifiedFiles = [...new Set([...preparation.fileOps.written, ...preparation.fileOps.edited])].sort();
  const modified = new Set(modifiedFiles);
  const readFiles = [...preparation.fileOps.read].filter((file) => !modified.has(file)).sort();
  const sections = [
    readFiles.length ? `<read-files>\n${readFiles.join("\n")}\n</read-files>` : "",
    modifiedFiles.length ? `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>` : "",
  ].filter(Boolean);
  return {
    summary: previous + (sections.length ? `\n\n${sections.join("\n\n")}` : ""),
    usage, ...(usageComplete ? {} : { usageComplete: false }), readFiles, modifiedFiles,
  };
}

export function prepareFromBranch(branch: SessionEntry[], limits: Limits): CompactionPreparation | undefined {
  if (branch.at(-1)?.type === "compaction") return undefined;
  const projection = buildSessionProjection(branch);
  const entries = projection.entries;
  const previous = entries[0]?.sourceEntry.type === "compaction" && entries[0].messages.length
    ? entries[0].sourceEntry : undefined;
  const start = previous ? 1 : 0;
  const isTurnStart = (message: AgentMessage) =>
    ["user", "custom", "bashExecution", "branchSummary", "compactionSummary"].includes(message.role);
  const cuts = entries.flatMap((entry, index) =>
    index >= start && entry.sourceEntry.type !== "compaction" &&
    entry.messages.some((message) => message.role === "assistant" || isTurnStart(message)) ? [index] : []);
  if (!cuts.length) return undefined;
  let cut = cuts[0];
  let tokens = 0;
  let exceeded = false;
  for (let index = entries.length - 1; index >= start; index--) {
    const count = entries[index].messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    if (!count) continue;
    tokens += count;
    if (tokens >= limits.keepRecent) {
      exceeded = true;
      cut = cuts.find((candidate) => candidate >= index) ?? cuts.at(-1)!;
      break;
    }
  }
  const suffix = entries.slice(cut + 1);
  const intrinsic = (entry: typeof entries[number]) =>
    entry.sourceEntry.type !== "context_edit" && sessionEntryToContextMessages(entry.sourceEntry).length > 0;
  const omitted = (entry: typeof entries[number]) => intrinsic(entry) && !entry.messages.length;
  const omittedIds = new Set(suffix.filter(omitted).map((entry) => entry.sourceEntry.id));
  const externalReplacement = suffix.some((entry) => entry.sourceEntry.type === "context_edit" &&
    entry.sourceEntry.replacement !== null && !omittedIds.has(entry.sourceEntry.targetId));
  if (exceeded && !externalReplacement && suffix.some((entry) => entry.sourceEntry.type === "message" &&
      entry.sourceEntry.message.role === "assistant" && omitted(entry)) &&
      suffix.every((entry) => entry.sourceEntry.type !== "compaction" && (!intrinsic(entry) || omitted(entry)))) cut++;
  while (cut > start && entries[cut - 1].sourceEntry.type !== "compaction" && !entries[cut - 1].messages.length) cut--;
  let turnStart = -1;
  if (!entries[cut].messages.some(isTurnStart)) {
    for (let index = cut; index >= start; index--) {
      if (entries[index].sourceEntry.type !== "compaction" && entries[index].messages.some(isTurnStart)) {
        turnStart = index;
        break;
      }
    }
  }
  const collect = (start: number, end: number) => entries.slice(start, end).flatMap((entry) =>
    entry.sourceEntry.type === "compaction" ? [] : entry.messages.filter((message) => message.role !== "system"));
  const messagesToSummarize = collect(start, turnStart < 0 ? cut : turnStart);
  const turnPrefixMessages = turnStart < 0 ? [] : collect(turnStart, cut);
  if (!messagesToSummarize.length && !turnPrefixMessages.length) return undefined;
  const fileOps: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
  if (previous && !previous.fromHook && isRecord(previous.details)) {
    for (const file of Array.isArray(previous.details.readFiles) ? previous.details.readFiles : []) {
      if (typeof file === "string") fileOps.read.add(file);
    }
    for (const file of Array.isArray(previous.details.modifiedFiles) ? previous.details.modifiedFiles : []) {
      if (typeof file === "string") fileOps.edited.add(file);
    }
  }
  const add = (name: string, args: unknown) => {
    if (!isRecord(args) || typeof args.path !== "string" || !args.path) return;
    if (name === "read") fileOps.read.add(args.path);
    if (name === "write") fileOps.written.add(args.path);
    if (name === "edit") fileOps.edited.add(args.path);
  };
  for (const message of [...messagesToSummarize, ...turnPrefixMessages]) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") add(block.name, block.arguments);
    }
    if (message.role === "toolResult") {
      for (const call of message.nestedCalls?.calls ?? []) add(call.name, call.arguments);
    }
  }
  return {
    firstKeptEntryId: entries[cut].sourceEntry.id, messagesToSummarize, turnPrefixMessages, isSplitTurn: turnStart >= 0,
    tokensBefore: projection.messages.reduce((sum, message) => sum + estimateTokens(message), 0),
    previousSummary: previous?.summary, fileOps,
    settings: { enabled: limits.enabled, reserveTokens: limits.reserve, keepRecentTokens: limits.keepRecent },
  };
}
