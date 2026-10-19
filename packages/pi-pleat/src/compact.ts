import { setTimeout as sleep } from "node:timers/promises";
import { buildSessionProjection, convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { CustomEntryDraft, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { CONTEXT_SAFETY_TOKENS } from "./budget.ts";
import type { Limits, SessionStats } from "./budget.ts";
import { combineUsage, prepareFromBranch, resolveSummarizer, summarize } from "./fallback.ts";
import type { CompactionPreparation, Summarizer } from "./fallback.ts";
import { compactionPayload, isAnthropic, keptIdentity, requestCompaction } from "./providers/anthropic.ts";
import { isResponsesTrigger, readResponsesTriggerChannels, requestTriggerCompaction } from "./providers/openai.ts";
import type { ResponsesOutcome } from "./providers/openai.ts";
import { applyReplay } from "./requests.ts";
import type { Requests } from "./requests.ts";
import {
  CAPABILITY_ENTRY, canonicalJson, channelKey, channelOf, coverage, isPhysicalModel,
  readCapabilities, sameChannel, sha256,
} from "./session.ts";
import type { CapabilityRecord, Feature, PleatDetails } from "./session.ts";

export type Trigger = "background" | "turn_end" | "manual" | "threshold" | "overflow";
export type CompactionDecision =
  | {
    kind: "result";
    summary: string;
    firstKeptEntryId: string;
    details: PleatDetails;
    usage?: Usage;
    customEntries: CustomEntryDraft[];
  }
  | { kind: "pi-default"; reason: string; customEntries?: CustomEntryDraft[] }
  | { kind: "skip"; reason: string; customEntries?: CustomEntryDraft[] };
export interface CompactArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  trigger: Trigger;
  signal: AbortSignal;
  preparation?: CompactionPreparation;
  customInstructions?: string;
  stats: SessionStats;
  limits: Limits;
  snapshot?: CompactionSnapshot;
  isCurrent?: () => boolean;
  onUsage?: (usage: Usage | undefined) => void;
}

export interface CompactionSnapshot {
  sessionId: string;
  leafId: string | null;
  branch: SessionEntry[];
  model: Model<Api>;
  settings: Record<string, unknown>;
  thinkingLevel: ThinkingLevel;
  summarizer: Summarizer | { error: string };
  preparation?: CompactionPreparation;
}

export function captureCompaction(args: Pick<CompactArgs, "pi" | "ctx" | "limits" | "preparation">): CompactionSnapshot | undefined {
  const { pi, ctx, limits } = args;
  const model = ctx.model;
  if (!isPhysicalModel(model)) return undefined;
  const branch = structuredClone(ctx.sessionManager.getBranch());
  const settings = structuredClone({ ...pi.getSettings() });
  const thinkingLevel = pi.getThinkingLevel();
  const summarizer = resolveSummarizer({
    getSettings: () => settings as ReturnType<ExtensionAPI["getSettings"]>,
    getThinkingLevel: () => thinkingLevel,
  }, ctx);
  return {
    sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId(),
    branch, model: structuredClone(model), settings, thinkingLevel, summarizer: structuredClone(summarizer),
    preparation: structuredClone(args.preparation ?? prepareFromBranch(branch, limits)),
  };
}

/** A cut must keep each assistant's complete tool batch on one side. */
export function completeToolBatches(messages: AgentMessage[]): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      if (!pending.delete(message.toolCallId)) return false;
    } else if (message.role !== "system") {
      if (pending.size) return false;
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type !== "toolCall") continue;
          if (pending.has(block.id)) return false;
          pending.add(block.id);
        }
      }
    }
  }
  return pending.size === 0;
}

export function validateCompaction(
  decision: CompactionDecision, branch: SessionEntry[], model: Model<Api>, threshold?: number,
): CompactionDecision {
  if (decision.kind !== "result") return decision;
  const projection = buildSessionProjection(branch);
  const cut = projection.entries.findIndex((entry) => entry.sourceEntry.id === decision.firstKeptEntryId);
  const covered = coverage(branch, decision.firstKeptEntryId);
  if (cut < 0 || !covered || covered.firstCoveredEntryId !== decision.details.firstCoveredEntryId ||
      covered.lastCoveredEntryId !== decision.details.lastCoveredEntryId) {
    return { kind: "skip", reason: "compaction coverage unavailable" };
  }
  const prefix = projection.entries.slice(0, cut).flatMap((entry) => entry.messages);
  const suffix = projection.entries.slice(cut).flatMap((entry) => entry.messages);
  if (!completeToolBatches(prefix) || !completeToolBatches(suffix)) {
    return { kind: "skip", reason: "tool results incomplete" };
  }
  const system = getCurrentSystemMessage(projection.messages);
  const native = decision.details.native;
  const replacement = native?.kind === "responses-trigger" ? JSON.stringify(native.window).length / 4
    : (native?.kind === "anthropic" ? native.block.content as string : decision.summary).length / 4;
  const kept = suffix.filter((message) => message.role !== "system")
    .reduce((sum, message) => sum + estimateTokens(message), 0);
  const estimate = (system ? estimateTokens(system) : 0) + Math.ceil(replacement) + kept;
  if (estimate + CONTEXT_SAFETY_TOKENS > model.contextWindow) {
    return { kind: "skip", reason: "compacted context does not fit the window" };
  }
  if (threshold !== undefined && estimate >= threshold) {
    return { kind: "skip", reason: "compacted context still exceeds the hard threshold" };
  }
  return decision;
}

export function createCompactor(requests: Requests, diagnostic: (message: string) => void) {
  let inFlight: Promise<CompactionDecision> | undefined;
  let state: "idle" | "preparing" | "requesting" | "validating" = "idle";
  async function run(args: CompactArgs, snapshot: CompactionSnapshot): Promise<CompactionDecision> {
    const { ctx, trigger, signal, stats, limits } = args;
    const { model, branch, settings, thinkingLevel } = snapshot;
    const key = channelKey(channelOf(model));
    const unchanged = () => {
      try {
        return !signal.aborted && (args.isCurrent ? args.isCurrent() :
          ctx.sessionManager.getSessionId() === snapshot.sessionId &&
          ctx.sessionManager.getLeafId() === snapshot.leafId && isPhysicalModel(ctx.model) &&
          canonicalJson(ctx.model) === canonicalJson(model) &&
          canonicalJson(args.pi.getSettings()) === canonicalJson(settings));
      } catch { return false; }
    };
    const changed = (): CompactionDecision => ({ kind: "skip", reason: "state changed" });
    if (!unchanged()) return changed();
    for (const problem of readResponsesTriggerChannels(settings).problems) diagnostic(problem);
    let usage: Usage | undefined;
    let usageComplete = true;
    function recordUsage(reported: Usage | undefined): void {
      usage = combineUsage(usage, reported);
      if (!reported) usageComplete = false;
      args.onUsage?.(reported);
    }
    const customEntries: (CustomEntryDraft & { data: CapabilityRecord })[] = [];
    const capabilities = readCapabilities(branch);
    const feature: Feature = isAnthropic(model) ? "anthropic-compaction" : "responses-trigger";
    const featureKey = `${key}#${feature}`;
    function capability(status: CapabilityRecord["status"], reason: string): void {
      if (status === "supported" && capabilities.has(featureKey)) return;
      customEntries.push({
        type: "custom", customType: CAPABILITY_ENTRY,
        data: { key, feature, status, reason } satisfies CapabilityRecord,
      });
    }
    function finish(decision: CompactionDecision): CompactionDecision {
      state = "validating";
      if (!unchanged()) return changed();
      if (decision.kind === "result") {
        decision = validateCompaction({ ...decision, usage, details: {
          ...decision.details, ...(!usageComplete || !usage ? { usageComplete: false } : {}),
        } }, trigger === "background" ? branch : ctx.sessionManager.getBranch(), model);
      }
      return { ...decision, customEntries: decision.kind === "result" ? customEntries
        : customEntries.filter((entry) => entry.data.status !== "supported") };
    }
    let reason = isAnthropic(model)
      ? "native compaction unavailable" : "native compaction is not available on this channel";
    if (isAnthropic(model) && capabilities.get(featureKey)?.status !== "unsupported") {
      const bound = requests.boundary(branch, model);
      const projection = buildSessionProjection(branch);
      const boundaryIndex = bound
        ? projection.entries.findIndex((entry) => entry.sourceEntry.id === bound.assistantEntryId) : -1;
      const assistant = boundaryIndex < 0 ? undefined
        : projection.entries[boundaryIndex].messages.find((message) => message.role === "assistant");
      const covered = bound && coverage(branch, bound.assistantEntryId);
      const calls = assistant?.role === "assistant"
        ? assistant.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []) : [];
      const results = new Set(projection.entries.slice(boundaryIndex + 1).flatMap((entry) =>
        entry.messages.flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : [])));
      const keptTokens = projection.entries.slice(boundaryIndex).flatMap((entry) => entry.messages)
        .reduce((sum, message) => sum + estimateTokens(message), 0);
      const maxTokens = bound?.snapshot.payload.max_tokens;
      if (!bound || assistant?.role !== "assistant" || !covered) reason = "request boundary unavailable";
      else if (!calls.every((id) => results.has(id))) reason = "tool results incomplete";
      else if (projection.messages.filter((message) => message.role === "system").length !== 1) {
        reason = "system-changed";
      } else if (keptTokens > limits.threshold) {
        return finish({ kind: "skip", reason: "kept suffix exceeds threshold" });
      }
      // Pi clamps the real request's max_tokens to its remaining window. The
      // native request reuses that allowance, independently of the trigger reserve.
      else if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 4096) {
        reason = "native compaction requires max_tokens >= 4096";
      } else {
        const payload = compactionPayload(bound.snapshot.payload, args.customInstructions);
        state = "requesting";
        for (let attempt = 0; ; attempt++) {
          if (!unchanged()) return changed();
          const outcome = await requestCompaction({ ctx, model, payload, signal });
          recordUsage(outcome.ok ? outcome.usage : undefined);
          state = "validating";
          if (!unchanged()) return changed();
          if (outcome.ok) {
            const identity = keptIdentity(assistant);
            capability("supported", "A complete native compaction response was verified.");
            return finish({
              kind: "result", summary: outcome.block.content as string, firstKeptEntryId: bound.assistantEntryId,
              details: {
                plugin: "pi-pleat", version: 1, strategy: "anthropic", ...channelOf(model), ...covered,
                firstKeptEntryId: bound.assistantEntryId, ...(outcome.usage ? {} : { usageComplete: false }),
                native: {
                  kind: "anthropic", block: outcome.block,
                  systemHash: sha256(canonicalJson(bound.snapshot.payload.system ?? null)),
                  toolsHash: sha256(canonicalJson(bound.snapshot.payload.tools ?? null)),
                  keptSignatures: identity.signatures, keptToolUseIds: identity.toolUseIds,
                },
              },
              usage: outcome.usage, customEntries,
            });
          }
          stats.nativeFailures++;
          if (outcome.kind === "cancelled") return changed();
          if (outcome.kind === "invalid") {
            return finish({
              kind: "skip", reason: "native compaction failed: invalid response or request (integrity or authorization)",
            });
          }
          if (outcome.kind === "transient" && attempt < 3) {
            diagnostic("Native compaction request failed temporarily; retrying.");
            try {
              await sleep(Math.min(30000, outcome.retryAfter ?? 1000 * 2 ** attempt), undefined, { signal });
            } catch { return changed(); }
            state = "requesting";
            continue;
          }
          reason = `native compaction ${outcome.kind}`;
          if (outcome.kind === "unsupported") capability("unsupported", "The provider does not support native compaction.");
          break;
        }
      }
    } else if (isAnthropic(model)) reason = "native compaction unsupported";
    if (!unchanged()) return changed();
    let resolved = snapshot.summarizer;
    const session = sessionSummarizer(snapshot);
    if ("error" in resolved) {
      diagnostic(resolved.error);
      resolved = session;
    }
    let summarizer = resolved;
    const proactive = trigger === "turn_end" || trigger === "background";
    if (isResponsesTrigger(model, settings)) {
      if (capabilities.get(featureKey)?.status === "unsupported") reason = "native compaction unsupported";
      else if (args.customInstructions?.trim()) reason = "custom-instructions";
      else if (snapshot.preparation) {
        const preparation = snapshot.preparation;
        const projection = buildSessionProjection(branch);
        const cut = projection.entries.findIndex((entry) => entry.sourceEntry.id === preparation.firstKeptEntryId);
        const covered = coverage(branch, preparation.firstKeptEntryId);
        if (cut < 0 || !covered) return finish({ kind: "skip", reason: "native compaction coverage unavailable" });
        const prefix = projection.entries.slice(0, cut).flatMap((entry) => entry.messages);
        if (!completeToolBatches(prefix)) return finish({ kind: "skip", reason: "tool results incomplete" });
        const prefixMessages = convertToLlm(prefix);
        const native = async (): Promise<ResponsesOutcome> => {
          for (let attempt = 0; ; attempt++) {
            if (!unchanged()) return { ok: false, kind: "cancelled" };
            const outcome = await requestTriggerCompaction({
              ctx, model, prefixMessages, thinkingLevel, signal,
              splice(payload) {
                if (!unchanged()) throw new Error("state changed");
                const replay = applyReplay(payload, model, branch, settings);
                if (replay.state === "rejected") throw new Error("Native replay rejected.");
                return replay.payload;
              },
            });
            recordUsage(outcome.ok ? outcome.usage : undefined);
            if (!unchanged()) return { ok: false, kind: "cancelled" };
            if (outcome.ok) return outcome;
            stats.nativeFailures++;
            if (outcome.kind !== "transient" || attempt >= 3) return outcome;
            diagnostic("Native compaction request failed temporarily; retrying.");
            try {
              await sleep(Math.min(30000, outcome.retryAfter ?? 1000 * 2 ** attempt), undefined, { signal });
            } catch { return { ok: false, kind: "cancelled" }; }
          }
        };
        const readable = (selected: Summarizer) => summarize({
          ctx, preparation, summarizer: selected, signal, settings, onUsage: recordUsage,
          checkState: () => { if (!unchanged()) throw new Error("state changed"); },
        });
        state = "requesting";
        const [outcome, initial] = await Promise.all([
          native(), readable(summarizer).then((summary) => ({ summary }), () => ({ summary: undefined })),
        ]);
        if (!unchanged() || !outcome.ok && outcome.kind === "cancelled") return changed();
        if (!outcome.ok && outcome.kind === "invalid") {
          return finish({
            kind: "skip", reason: "native compaction failed: invalid response or request (integrity or authorization)",
          });
        }
        if (!outcome.ok && outcome.kind === "unsupported") {
          capability("unsupported", "The provider does not support Responses trigger compaction.");
        } else if (outcome.ok) {
          capability("supported", "A complete Responses trigger compaction response was verified.");
        }
        let summary = initial.summary;
        if (!summary && summarizer.configured && !sameChannel(channelOf(summarizer.model), channelOf(model))) {
          diagnostic("Configured readable summary failed; retrying with the session model.");
          summarizer = session;
          try { summary = await readable(summarizer); } catch { /* Both failures preserve the history. */ }
        }
        if (!unchanged()) return changed();
        if (!summary) return finish({ kind: "skip", reason: "readable summary failed" });
        if (outcome.ok) {
          const usageComplete = !!outcome.usage && !!summary.usage && summary.usageComplete !== false;
          return finish({
            kind: "result", summary: summary.summary, firstKeptEntryId: preparation.firstKeptEntryId,
            details: {
              plugin: "pi-pleat", version: 1, strategy: "responses-trigger", ...channelOf(model), ...covered,
              firstKeptEntryId: preparation.firstKeptEntryId, ...(usageComplete ? {} : { usageComplete: false }),
              native: { kind: "responses-trigger", window: outcome.window },
            },
            usage: combineUsage(outcome.usage, summary.usage), customEntries,
          });
        }
        stats.fallbacks++;
        reason = `native compaction ${outcome.kind}`;
        return finish({
          kind: "result", summary: summary.summary, firstKeptEntryId: preparation.firstKeptEntryId,
          details: {
            plugin: "pi-pleat", version: 1, strategy: "pi-summary", ...channelOf(summarizer.model), ...covered,
            firstKeptEntryId: preparation.firstKeptEntryId, reason, usageComplete: summary.usageComplete,
            readFiles: summary.readFiles, modifiedFiles: summary.modifiedFiles,
          },
          usage: summary.usage, customEntries,
        });
      }
    }
    if (!proactive && !summarizer.configured) return finish({ kind: "pi-default", reason });
    const preparation = snapshot.preparation;
    if (!preparation) return finish({ kind: "skip", reason: `${reason}; nothing to summarize` });
    async function readable(selected: Summarizer) {
      return summarize({
        ctx, preparation: preparation!, summarizer: selected, customInstructions: args.customInstructions,
        signal, settings, onUsage: recordUsage,
        checkState: () => { if (!unchanged()) throw new Error("state changed"); },
      });
    }
    state = "requesting";
    try {
      let summary;
      try { summary = await readable(summarizer); }
      catch {
        if (!unchanged()) return changed();
        if (sameChannel(channelOf(summarizer.model), channelOf(model))) {
          return finish({ kind: "skip", reason: `${reason}; fallback summary failed` });
        }
        if (!proactive) {
          return finish({ kind: "pi-default", reason: `${reason}; configured fallback summary failed` });
        }
        summarizer = session;
        summary = await readable(summarizer);
      }
      if (!unchanged()) return changed();
      const covered = coverage(branch, preparation.firstKeptEntryId);
      if (!covered) return finish({ kind: "skip", reason: "fallback coverage unavailable" });
      stats.fallbacks++;
      return finish({
        kind: "result", summary: summary.summary, firstKeptEntryId: preparation.firstKeptEntryId,
        details: {
          plugin: "pi-pleat", version: 1, strategy: "pi-summary", ...channelOf(summarizer.model), ...covered,
          firstKeptEntryId: preparation.firstKeptEntryId, reason, usageComplete: summary.usageComplete,
          readFiles: summary.readFiles, modifiedFiles: summary.modifiedFiles,
        },
        usage: summary.usage, customEntries,
      });
    } catch {
      return unchanged() ? finish({ kind: "skip", reason: `${reason}; fallback summary failed` }) : changed();
    }
  }
  return {
    get state() { return state; },
    async compactNow(args: CompactArgs): Promise<CompactionDecision> {
      let snapshot: CompactionSnapshot | undefined;
      try { snapshot = args.snapshot ?? captureCompaction(args); }
      catch { return { kind: "skip", reason: "compaction preparation failed" }; }
      if (!snapshot) return { kind: "skip", reason: "no physical model selected" };
      const previous = inFlight;
      let resolve!: (decision: CompactionDecision) => void;
      const current = new Promise<CompactionDecision>((done) => { resolve = done; });
      inFlight = current;
      await previous;
      state = "preparing";
      let decision: CompactionDecision;
      try { decision = await run(args, snapshot); }
      catch {
        decision = { kind: "skip", reason: args.signal.aborted ? "state changed" : "compaction preparation failed" };
      } finally {
        state = "idle";
      }
      resolve(decision);
      if (inFlight === current) inFlight = undefined;
      return decision;
    },
  };
}

function sessionSummarizer(snapshot: CompactionSnapshot): Summarizer {
  return {
    model: snapshot.model, thinkingLevel: clampThinkingLevel(snapshot.model, snapshot.thinkingLevel),
    label: "session model", configured: false,
  };
}
