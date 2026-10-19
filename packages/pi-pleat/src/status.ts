import { getLatestCompactionEntry } from "@earendil-works/pi-coding-agent";
import type { ContextUsage, ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Limits, SessionStats } from "./budget.ts";
import { contentBytes } from "./budget.ts";
import { placeholder } from "./edits.ts";
import { resolveSummarizer } from "./fallback.ts";
import type { Summarizer } from "./fallback.ts";
import type { ReplayState } from "./requests.ts";
import { isAnthropic } from "./providers/anthropic.ts";
import { isResponsesTrigger } from "./providers/openai.ts";
import { channelKey, channelOf, FALLBACK_ENTRY, isPhysicalModel, isRecord, isThinkingLevel, readCapabilities, readPleatDetails, sameChannel } from "./session.ts";

export type ContextArgs =
  | { kind: "status" }
  | { kind: "fallback-show" }
  | { kind: "fallback-set"; model: string | null; thinking: ThinkingLevel | null }
  | { kind: "error"; message: string };

export function parseContextArgs(args: string): ContextArgs {
  const parts = args.trim().split(/\s+/);
  if (!args.trim()) return { kind: "status" };
  if (parts[0] !== "fallback" || parts.length > 3) {
    return { kind: "error", message: "Use /context fallback <provider/model> [level], or /context fallback default." };
  }
  if (parts.length === 1) return { kind: "fallback-show" };
  if (parts[1] === "default") {
    return parts.length === 2 ? { kind: "fallback-set", model: null, thinking: null } :
      { kind: "error", message: "Use /context fallback default without a thinking level." };
  }
  const slash = parts[1].indexOf("/");
  if (slash <= 0 || slash === parts[1].length - 1) {
    return { kind: "error", message: "Use a fallback model in provider/model format." };
  }
  if (parts[2] !== undefined && !isThinkingLevel(parts[2])) {
    return { kind: "error", message: "Thinking level must be off, minimal, low, medium, high, xhigh, or max." };
  }
  return { kind: "fallback-set", model: parts[1], thinking: parts[2] ?? null };
}

export function formatFallback(summarizer: Summarizer | { error: string }): string {
  if ("error" in summarizer) return `Fallback summary: unavailable: ${summarizer.error}`;
  return `Fallback summary: ${summarizer.model.provider}/${summarizer.model.id} (${summarizer.thinkingLevel}) · ${summarizer.label}`;
}

export function formatContextStatus({ model, limits, usage, raw, branch, stats, summarizer, replay, diagnostics, settings }: {
  model: Model<Api> | undefined;
  limits: Limits | undefined;
  usage: ContextUsage | undefined;
  raw: { tokens: number; estimated: boolean } | undefined;
  branch: SessionEntry[];
  stats: SessionStats;
  summarizer: Summarizer | { error: string };
  replay?: ReplayState;
  diagnostics: readonly string[];
  settings?: Record<string, unknown>;
}): string {
  model = isPhysicalModel(model) ? model : undefined;
  const anthropic = !!model && isAnthropic(model);
  const localClearingEnabled = limits?.localClearingEnabled === true;
  const lines = [`pi-pleat · ${model ? `${model.provider}/${model.id} (${model.api})` : "no physical model selected"}`];
  const tokens = usage?.tokens;
  const window = limits?.window ?? usage?.contextWindow;
  let context = `Context: ${tokens ?? "unknown"} of ${window ?? "unknown"} tokens`;
  if (tokens !== null && tokens !== undefined && window !== undefined && window > 0) {
    context += ` (${(100 * tokens / window).toFixed(1)}%)${raw?.estimated ? ", estimated" : ""}`;
  }
  if (anthropic) context += ` · raw ${raw?.tokens ?? "unknown"} (Anthropic)`;
  if (limits) {
    context += ` · compaction at ${limits.threshold}`;
    if (anthropic || model && localClearingEnabled) {
      context += ` · clearing from ${limits.clearTrigger} (frees at least ${limits.clearFloor}, keeps ${limits.keepToolUses} tool uses)`;
    }
  }
  lines.push(context);
  const key = model ? channelKey(channelOf(model)) : undefined;
  const capabilities = [...readCapabilities(branch).values()].filter((record) => record.key === key);
  const unsupportedClearing = capabilities.some((record) => record.feature === "clearing" && record.status === "unsupported");
  const targets = new Map(branch.filter((entry) => entry.type === "context_edit").map((entry) => [entry.targetId, entry]));
  const cleared = branch.filter((entry) => {
    if (entry.type !== "message" || entry.message.role !== "toolResult") return false;
    const content = targets.get(entry.id)?.replacement?.content;
    return Array.isArray(content) && content.length === 1 && content[0].type === "text" &&
      content[0].text === placeholder(entry.id, contentBytes(entry.message.content));
  }).length;
  lines.push(!model || (anthropic ? unsupportedClearing : !localClearingEnabled) ? "Clearing: off" : anthropic
    ? `Clearing: server-side, ${stats.serverClears} applied, ${stats.serverClearedTokens} tokens this session`
    : `Clearing: local, ${stats.localBatches} batches, ${cleared} results on this branch`);
  const nativeFeature = !model ? undefined : anthropic ? "anthropic-compaction"
    : isResponsesTrigger(model, settings) ? "responses-trigger" : undefined;
  const unsupportedNative = capabilities.find((record) => record.feature === nativeFeature && record.status === "unsupported");
  lines.push(!model ? "Compaction route: unavailable"
    : unsupportedNative ? `Compaction route: text/Pi summary (native unsupported: ${unsupportedNative.reason})`
    : nativeFeature === "anthropic-compaction" ? "Compaction route: Anthropic native"
    : nativeFeature === "responses-trigger" ? "Compaction route: Responses-trigger native"
    : "Compaction route: text/Pi summary");
  const compactions = branch.filter((entry) => entry.type === "compaction");
  const counts = { anthropic: 0, "responses-trigger": 0, "pi-summary": 0, pi: 0 };
  let input = 0, output = 0, cost = 0;
  let known = 0;
  let complete = true;
  for (const entry of compactions) {
    const strategy = isRecord(entry.details) ? entry.details.strategy : undefined;
    if (strategy === "anthropic" || strategy === "responses-trigger" || strategy === "pi-summary") counts[strategy]++;
    else counts.pi++;
    if (readPleatDetails(entry)?.usageComplete === false) complete = false;
    if (entry.usage) {
      known++;
      input += entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
      output += entry.usage.output;
      cost += entry.usage.cost.total;
    } else complete = false;
  }
  const totals = (known
    ? `${input} in / ${output} out · $${cost.toFixed(4)}`
    : "unknown in / unknown out · $unknown") + (complete ? "" : " (partial)");
  lines.push(`Compaction on this branch: ${compactions.length} (anthropic ${counts.anthropic}, responses-trigger ${counts["responses-trigger"]}, pi-summary ${counts["pi-summary"]}, pi ${counts.pi}) · usage ${totals}`);
  const latest = getLatestCompactionEntry(branch);
  const details = latest ? readPleatDetails(latest) : undefined;
  lines.push(details?.native ? model && sameChannel(channelOf(model), details)
    ? !nativeFeature ? "Native replay: not active: channel is not configured"
      : replay?.state === "applied" ? `Native replay: active (${details.strategy})` : `Native replay: not active: ${replay?.reason ?? "no request since compaction"}`
    : "Native replay: not active: channel differs" : "Native replay: none");
  lines.push(`Capabilities: ${capabilities.length ? capabilities.map((record) => `${record.feature} ${record.status}`).join(" · ") : "unknown"}`);
  let recalls = 0, drops = 0;
  let firstPath: string | undefined;
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    recalls += message.content.filter((block) => block.type === "toolCall" && block.name === "recall").length;
    for (const diagnostic of message.diagnostics ?? []) {
      if (diagnostic.type !== "anthropic_input_transformations") continue;
      const transformations = diagnostic.details?.transformations;
      if (!Array.isArray(transformations)) continue;
      for (const transformation of transformations) {
        if (!isRecord(transformation) || transformation.type !== "thinking_dropped") continue;
        drops++;
        if (firstPath === undefined && typeof transformation.path === "string") firstPath = transformation.path;
      }
    }
  }
  lines.push(`Recall on this branch: ${recalls} calls`);
  lines.push(`Thinking drops reported on this branch: ${drops}${firstPath ? ` (first: ${firstPath})` : ""}`);
  lines.push(formatFallback(summarizer));
  lines.push(`Recent: ${diagnostics.length ? diagnostics.slice(-5).join(" · ") : "none"}`);
  return lines.join("\n");
}

export async function contextCommand(args: string, pi: ExtensionAPI, ctx: ExtensionCommandContext, status: () => string): Promise<void> {
  const parsed = parseContextArgs(args);
  if (parsed.kind === "error") {
    ctx.ui.notify(parsed.message, "warning");
  } else if (parsed.kind === "status") {
    ctx.ui.notify(status(), "info");
  } else if (parsed.kind === "fallback-show") {
    ctx.ui.notify(formatFallback(resolveSummarizer(pi, ctx)), "info");
  } else {
    if (parsed.model !== null) {
      const slash = parsed.model.indexOf("/");
      if (!isPhysicalModel(ctx.modelRegistry.find(parsed.model.slice(0, slash), parsed.model.slice(slash + 1)))) {
        ctx.ui.notify("Fallback model was not found. Use a model from /model.", "warning");
        return;
      }
    }
    pi.appendEntry(FALLBACK_ENTRY, { model: parsed.model, thinking: parsed.thinking });
    ctx.ui.notify(formatFallback(resolveSummarizer(pi, ctx)), "info");
  }
}
