import { isDeepStrictEqual } from "node:util";
import { buildSessionProjection, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { Limits, SessionStats } from "./budget.ts";
import { captureCompaction, completeToolBatches, createCompactor, validateCompaction } from "./compact.ts";
import type { CompactArgs, CompactionDecision, CompactionSnapshot } from "./compact.ts";
import { combineUsage } from "./fallback.ts";
import { isAnthropic } from "./providers/anthropic.ts";
import type { Requests } from "./requests.ts";
import { canonicalJson, coverage, FALLBACK_ENTRY, isPhysicalModel, sha256 } from "./session.ts";

export interface CompactionUsage {
  usage?: Usage;
  usageComplete: boolean;
  requests: number;
}
interface ObserveArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  limits: Limits;
}
interface BackgroundArgs extends ObserveArgs {
  stats: SessionStats;
}
interface Job {
  snapshot: CompactionSnapshot;
  args: ObserveArgs;
  epoch: number;
  key?: string;
  controller: AbortController;
  listeners: Map<AbortSignal, () => void>;
  accounting: CompactionUsage;
  disposition: "pending" | "adopted" | "discarded";
  promise?: Promise<CompactionDecision>;
  decision?: CompactionDecision;
}
const changed = (): CompactionDecision => ({ kind: "skip", reason: "state changed" });

/** Owns cancellation and adoption. Provider requests never write session entries. */
export function createAsyncCompactor(requests: Requests, diagnostic: (message: string) => void) {
  const engine = createCompactor(requests, diagnostic);
  const attempted = new Set<string>();
  const tasks = new Set<Promise<CompactionDecision>>();
  const foregroundJobs = new Set<Job>();
  const unapplied: CompactionUsage = { usageComplete: true, requests: 0 };
  let background: Job | undefined;
  let epoch = 0;
  let closed = false;
  let foregroundCount = 0;
  let serial: Promise<void> = Promise.resolve();

  function addUsage(target: CompactionUsage, usage: Usage | undefined): void {
    target.usage = combineUsage(target.usage, usage);
    target.usageComplete &&= usage !== undefined;
    target.requests++;
  }
  function observeUsage(job: Job, usage: Usage | undefined): void {
    addUsage(job.accounting, usage);
    if (job.disposition === "discarded") addUsage(unapplied, usage);
  }
  function detach(job: Job): void {
    for (const [signal, listener] of job.listeners) signal.removeEventListener("abort", listener);
    job.listeners.clear();
  }
  function discard(job: Job): void {
    if (job.disposition !== "pending") return;
    job.disposition = "discarded";
    unapplied.usage = combineUsage(unapplied.usage, job.accounting.usage);
    unapplied.usageComplete &&= job.accounting.usageComplete;
    unapplied.requests += job.accounting.requests;
    if (background === job) background = undefined;
    detach(job);
    job.controller.abort();
  }
  function adopt(job: Job): void {
    job.disposition = "adopted";
    if (background === job) background = undefined;
    detach(job);
  }
  function attach(job: Job, signal: AbortSignal | undefined): void {
    if (!signal || job.listeners.has(signal) || job.disposition !== "pending") return;
    if (signal.aborted) { discard(job); return; }
    const listener = () => discard(job);
    job.listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }
  function current(job: Job, appendOnly: boolean): boolean {
    if (closed || job.epoch !== epoch || job.disposition !== "pending" || job.controller.signal.aborted) return false;
    try {
      const { ctx, pi } = job.args;
      const snapshot = job.snapshot;
      if (ctx.sessionManager.getSessionId() !== snapshot.sessionId || !isPhysicalModel(ctx.model) ||
          !isDeepStrictEqual(ctx.model, snapshot.model) || pi.getThinkingLevel() !== snapshot.thinkingLevel ||
          !isDeepStrictEqual(pi.getSettings(), snapshot.settings)) return false;
      const branch = ctx.sessionManager.getBranch();
      const count = snapshot.branch.length;
      if (branch.length < count || !isDeepStrictEqual(branch.slice(0, count), snapshot.branch)) return false;
      if (!appendOnly) return branch.length === count && ctx.sessionManager.getLeafId() === snapshot.leafId;
      // These entries can change a captured prefix or its interpretation. Ordinary
      // messages and metadata extend the suffix without changing what was covered.
      return branch.slice(count).every((entry) => entry.type !== "context_edit" && entry.type !== "compaction" &&
        entry.type !== "model_change" && entry.type !== "thinking_level_change" && entry.type !== "branch_summary" &&
        !(entry.type === "message" && entry.message.role === "system") &&
        !(entry.type === "custom" && entry.customType === FALLBACK_ENTRY));
    } catch { return false; }
  }
  function keyFor(snapshot: CompactionSnapshot): string | undefined {
    const preparation = snapshot.preparation;
    if (!preparation) return undefined;
    const projection = buildSessionProjection(snapshot.branch);
    const cut = projection.entries.findIndex((entry) => entry.sourceEntry.id === preparation.firstKeptEntryId);
    if (cut < 0 || !coverage(snapshot.branch, preparation.firstKeptEntryId)) return undefined;
    const prefix = projection.entries.slice(0, cut);
    const suffix = projection.entries.slice(cut);
    if (!completeToolBatches(prefix.flatMap((entry) => entry.messages)) ||
        !completeToolBatches(suffix.flatMap((entry) => entry.messages))) return undefined;
    // Leaf IDs are excluded: appending a suffix must not retry the same failed work.
    return sha256(canonicalJson({
      epoch, session: snapshot.sessionId, model: snapshot.model, settings: snapshot.settings,
      thinking: snapshot.thinkingLevel, prefix: prefix.filter((entry) => entry.messages.length),
      firstKeptEntryId: preparation.firstKeptEntryId,
    }));
  }
  function launch(args: CompactArgs, snapshot: CompactionSnapshot, appendOnly: boolean, key?: string): Job {
    const job: Job = {
      snapshot, args, epoch, key, controller: new AbortController(), listeners: new Map(),
      accounting: { usageComplete: true, requests: 0 }, disposition: "pending",
    };
    attach(job, args.signal);
    job.promise = engine.compactNow({
      ...args, snapshot, signal: job.controller.signal,
      isCurrent: () => current(job, appendOnly), onUsage: (usage) => observeUsage(job, usage),
    }).then((decision) => {
      job.decision = decision;
      return decision;
    }, () => {
      const decision = changed();
      job.decision = decision;
      return decision;
    });
    tasks.add(job.promise);
    void job.promise.then(() => { tasks.delete(job.promise!); });
    return job;
  }
  function observe(args: ObserveArgs): boolean {
    if (!args.limits.enabled || !isPhysicalModel(args.ctx.model) || isAnthropic(args.ctx.model)) {
      if (background) discard(background);
      return false;
    }
    if (background) {
      attach(background, args.ctx.signal);
      if (background && !current(background, true)) discard(background);
    }
    return !closed;
  }
  function invalidate(): void {
    epoch++;
    attempted.clear();
    if (background) discard(background);
    for (const job of foregroundJobs) discard(job);
  }

  return {
    get state(): "idle" | "running" | "ready" {
      return !background ? "idle" : !background.decision ? "running"
        : background.decision.kind === "result" ? "ready" : "idle";
    },
    /** Known usage of requests whose results were not adopted. Applied entries
     * carry their own usage; adding this ledger does not count them twice. */
    get unappliedUsage(): CompactionUsage { return structuredClone(unapplied); },
    observe,
    invalidate,
    start(args: BackgroundArgs): void {
      try {
        if (!observe(args) || background || foregroundCount || args.ctx.signal?.aborted) return;
        const knownTokens = args.ctx.getContextUsage()?.tokens;
        if (knownTokens != null && knownTokens < args.limits.asyncThreshold) return;
        const snapshot = captureCompaction(args);
        if (!snapshot) return;
        const tokens = knownTokens ?? buildSessionProjection(snapshot.branch).messages
          .reduce((sum, message) => sum + estimateTokens(message), 0);
        if (tokens < args.limits.asyncThreshold) return;
        const key = keyFor(snapshot);
        if (!key || attempted.has(key)) return;
        attempted.add(key);
        const job = launch({ ...args, trigger: "background", signal: args.ctx.signal ?? new AbortController().signal },
          snapshot, true, key);
        background = job;
      } catch { diagnostic("Could not prepare background compaction."); }
    },
    takeReady(args: ObserveArgs, entries: SessionBoundaryDraft[] = []): CompactionDecision | undefined {
      if (!observe(args) || !background?.decision) return undefined;
      const job = background;
      if (entries.some((entry) => entry.type !== "custom")) { discard(job); return undefined; }
      if (!current(job, true)) { discard(job); return undefined; }
      const decision = validateCompaction(job.decision!, args.ctx.sessionManager.getBranch(), args.ctx.model!, args.limits.threshold);
      if (decision.kind === "result") adopt(job);
      else discard(job);
      return decision;
    },
    async compactNow(args: CompactArgs): Promise<CompactionDecision> {
      const entryEpoch = epoch;
      let snapshot: CompactionSnapshot | undefined;
      try { snapshot = args.snapshot ?? captureCompaction(args); }
      catch { return { kind: "skip", reason: "compaction preparation failed" }; }
      if (!snapshot) return { kind: "skip", reason: "no physical model selected" };
      const previous = serial;
      let release!: () => void;
      serial = new Promise<void>((resolve) => { release = resolve; });
      foregroundCount++;
      if (args.trigger === "manual" && background) discard(background);
      try {
        await previous;
        if (closed || entryEpoch !== epoch || args.signal.aborted) return changed();
        const automatic = args.trigger === "threshold" || args.trigger === "overflow";
        if (automatic && !args.limits.enabled) { if (background) discard(background); return changed(); }
        const key = isAnthropic(snapshot.model) ? undefined : keyFor(snapshot);
        if (automatic && background) {
          const job = background;
          attach(job, args.signal);
          if (!current(job, true)) discard(job);
          else {
            const decision = await job.promise!;
            if (!current(job, true) || args.signal.aborted) { discard(job); return changed(); }
            const checked = validateCompaction(decision, args.ctx.sessionManager.getBranch(), snapshot.model, args.limits.threshold);
            if (checked.kind === "result") { adopt(job); return checked; }
            discard(job);
            // A fresh cut can cover the suffix that grew while this request ran.
            // Repeating the same cut cannot fix a failed or oversized candidate.
            if (key === job.key) return checked;
          }
        } else if (background) discard(background);
        if (automatic && key && attempted.has(key)) {
          return { kind: "skip", reason: "this compaction prefix was already attempted" };
        }
        if (key && args.trigger !== "manual") attempted.add(key);
        const job = launch(args, snapshot, false, key);
        foregroundJobs.add(job);
        try {
          const decision = await job.promise!;
          if (!current(job, false) || args.signal.aborted) { discard(job); return changed(); }
          const checked = automatic && !isAnthropic(snapshot.model)
            ? validateCompaction(decision, args.ctx.sessionManager.getBranch(), snapshot.model, args.limits.threshold)
            : decision;
          if (checked.kind === "result") adopt(job);
          else discard(job);
          return checked;
        } finally { foregroundJobs.delete(job); }
      } catch {
        return args.signal.aborted || entryEpoch !== epoch ? changed()
          : { kind: "skip", reason: "compaction preparation failed" };
      } finally {
        foregroundCount--;
        release();
      }
    },
    async shutdown(): Promise<void> {
      closed = true;
      invalidate();
      await serial;
      await Promise.all(tasks);
    },
  };
}
