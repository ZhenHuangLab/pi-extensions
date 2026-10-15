import { getLatestCompactionEntry } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createResponseObserver, createSessionStats, limitsFor, rawNextTokens, readClearingSettings } from "./budget.ts";
import type { Limits, ResponseStats } from "./budget.ts";
import { createCompactor } from "./compact.ts";
import type { CompactionDecision } from "./compact.ts";
import { planClearing } from "./edits.ts";
import { resolveSummarizer } from "./fallback.ts";
import { isAnthropic, isClearingUnsupported, readAppliedEdits, withClearing } from "./providers/anthropic.ts";
import { isResponsesTrigger } from "./providers/openai.ts";
import { recallTool } from "./recall.ts";
import { applyReplay, createRequests } from "./requests.ts";
import type { ReplayState } from "./requests.ts";
import { CAPABILITY_ENTRY, channelKey, channelOf, isPhysicalModel, isRecord, matchesResponse, readCapabilities } from "./session.ts";
import type { CapabilityRecord } from "./session.ts";
import { contextCommand, formatContextStatus } from "./status.ts";

export default function piPleat(pi: ExtensionAPI): void {
  let stats = createSessionStats();
  const responses = new Map<string, ResponseStats>();
  const diagnostics: string[] = [];
  const reported = new Set<string>();
  const observed = new Set<string>();
  let observer = createResponseObserver(stats);
  let requests = createRequests();
  let coordinator = createCompactor(requests, diagnostic);
  let pending: ResponseStats | undefined;
  let failure: { capability: CapabilityRecord; entryId?: string } | undefined;
  let clearingRequestKey: string | undefined;
  let replay: { entryId: string | undefined; channel: string; result: ReplayState } | undefined;

  function diagnostic(message: string): void {
    if (observed.has(message)) return;
    observed.add(message);
    diagnostics.push(message);
    if (diagnostics.length > 5) diagnostics.shift();
  }
  function notify(ctx: ExtensionContext, message: string): void {
    diagnostic(message);
    if (reported.has(message)) return;
    reported.add(message);
    ctx.ui.notify(message, "warning");
  }
  function currentLimits(ctx: ExtensionContext, model: Model<Api>): Limits {
    const settings = { ...pi.getSettings() };
    for (const problem of readClearingSettings(settings).problems) notify(ctx, problem);
    return limitsFor(model, settings);
  }
  function report(ctx: ExtensionContext, decision: CompactionDecision): void {
    if (decision.kind === "skip") notify(ctx, `Compaction skipped: ${decision.reason}.`);
    else if (decision.kind === "pi-default") notify(ctx, `Using Pi compaction: ${decision.reason}.`);
    else if (decision.details.strategy === "pi-summary") notify(ctx, `Using a text summary: ${decision.details.reason}.`);
  }
  function reset(): void {
    stats = createSessionStats();
    responses.clear();
    diagnostics.length = 0;
    reported.clear();
    observed.clear();
    observer = createResponseObserver(stats);
    requests = createRequests();
    coordinator = createCompactor(requests, diagnostic);
    pending = undefined;
    failure = undefined;
    clearingRequestKey = undefined;
    replay = undefined;
  }

  pi.registerTool(recallTool);
  pi.registerCommand("context", {
    description: "Show context management status; /context fallback <provider/model> [level] switches the fallback summary model",
    getArgumentCompletions: (prefix) => ["fallback", "fallback default"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: (args, ctx) => contextCommand(args, pi, ctx, () => {
      const model = isPhysicalModel(ctx.model) ? ctx.model : undefined;
      const branch = ctx.sessionManager.getBranch();
      const currentReplay = model && replay?.entryId === getLatestCompactionEntry(branch)?.id && replay?.channel === channelKey(channelOf(model)) ? replay.result : undefined;
      return formatContextStatus({ model, limits: model ? currentLimits(ctx, model) : undefined,
        usage: ctx.getContextUsage(), raw: rawNextTokens(ctx, responses), branch, stats,
        summarizer: resolveSummarizer(pi, ctx), replay: currentReplay, diagnostics });
    }),
  });
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);

  pi.on("before_provider_request", (event, ctx) => {
    try {
      const model = ctx.model;
      const payload = event.payload;
      if (!isPhysicalModel(model) || !isRecord(payload) || payload.model !== model.id) return;
      const warm = isAnthropic(model) && payload.max_tokens === 1;
      const branch = ctx.sessionManager.getBranch();
      const key = channelKey(channelOf(model));
      let result = payload;
      if (Array.isArray(payload.messages) && isAnthropic(model) || Array.isArray(payload.input) && isResponsesTrigger(model)) {
        const applied = applyReplay(payload, model, branch);
        result = applied.payload;
        if (!warm) replay = { entryId: getLatestCompactionEntry(branch)?.id, channel: key, result: applied };
        if (applied.state === "rejected") diagnostic(`Native replay rejected: ${applied.reason}.`);
      }
      if (isAnthropic(model) && Array.isArray(result.messages) && !("compaction" in result) &&
          readCapabilities(branch).get(`${key}#clearing`)?.status !== "unsupported") {
        if ("context_management" in result) diagnostic("Existing context_management configuration kept.");
        result = withClearing(result, currentLimits(ctx, model));
        if (!warm) clearingRequestKey = key;
      } else if (!warm) clearingRequestKey = undefined;
      requests.record(result, channelOf(model));
      return result;
    } catch {
      diagnostic("Could not prepare the provider request.");
      return;
    }
  });

  pi.on("provider_stream_event", (event, ctx) => {
    const model = ctx.model;
    if (!isPhysicalModel(model) || !isAnthropic(model) || event.provider !== model.provider || event.api !== model.api || event.model !== model.id) return;
    observer.observe(event.data, readAppliedEdits(event.data));
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    pending = undefined;
    failure = undefined;
    const responseStats = observer.messageEnd(event.message);
    if (!matchesResponse(ctx.model, event.message)) { requests.discard(); clearingRequestKey = undefined; return; }
    const message = event.message;
    requests.onMessageEnd(message);
    pending = responseStats;
    if (isAnthropic(ctx.model!) && clearingRequestKey && message.stopReason === "error" && isClearingUnsupported(message.errorMessage)) {
      failure = { capability: { key: clearingRequestKey, feature: "clearing", status: "unsupported",
        reason: "The provider does not support context management clearing." } };
      diagnostic("Anthropic clearing is unsupported; retrying without clearing.");
    }
    clearingRequestKey = undefined;
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!matchesResponse(ctx.model, event.message)) { requests.discard(); pending = undefined; failure = undefined; return; }
    requests.onTurnEnd(event);
    if (pending) responses.set(event.messageEntryId, pending);
    pending = undefined;
    if (failure) failure.entryId = event.messageEntryId;
    if (event.outcome !== "completed") return;
    const model = ctx.model!;
    const limits = currentLimits(ctx, model);
    if (isAnthropic(model)) {
      const raw = rawNextTokens(ctx, responses);
      if (!limits.enabled || !raw || raw.tokens <= limits.threshold || !ctx.signal) return;
      const decision = await coordinator.compactNow({ pi, ctx, trigger: "turn_end", signal: ctx.signal, stats, limits });
      report(ctx, decision);
      if (decision.kind === "result") return { entries: [...event.entries, ...decision.customEntries,
        { type: "compaction", summary: decision.summary, firstKeptEntryId: decision.firstKeptEntryId, details: decision.details, usage: decision.usage }] };
      if (decision.kind === "skip" && decision.customEntries?.length) return { entries: [...event.entries, ...decision.customEntries] };
      return;
    }
    const tokens = ctx.getContextUsage()?.tokens;
    if (tokens === null || tokens === undefined) return;
    const drafts = planClearing({ branch: ctx.sessionManager.getBranch(), effectiveTokens: tokens, limits });
    if (!drafts.length) return;
    stats.localBatches++;
    stats.localClearedEntries += drafts.length;
    return { entries: [...event.entries, ...drafts] };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!isPhysicalModel(ctx.model)) return;
    const decision = await coordinator.compactNow({ pi, ctx, trigger: event.reason, preparation: event.preparation,
      signal: event.signal, customInstructions: event.customInstructions, stats, limits: currentLimits(ctx, ctx.model) });
    report(ctx, decision);
    if (decision.kind === "result") return { compaction: { summary: decision.summary, firstKeptEntryId: decision.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore, details: decision.details, usage: decision.usage } };
    if (decision.kind === "skip") return { cancel: true };
    return;
  });

  pi.on("agent_before_settle", (event, ctx) => {
    const failed = failure;
    failure = undefined;
    if (!failed?.entryId || event.outcome !== "error" || !isPhysicalModel(ctx.model) || !isAnthropic(ctx.model) ||
        channelKey(channelOf(ctx.model)) !== failed.capability.key) return;
    const branch = ctx.sessionManager.getBranch();
    const latest = branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (latest?.id !== failed.entryId || latest.type !== "message" || !matchesResponse(ctx.model, latest.message) ||
        readCapabilities(branch).get(`${failed.capability.key}#clearing`)?.status === "unsupported") return;
    return { entries: [...event.entries,
      { type: "context_edit", targetId: failed.entryId, replacement: null },
      { type: "custom", customType: CAPABILITY_ENTRY, data: failed.capability },
    ], continue: true };
  });
}
