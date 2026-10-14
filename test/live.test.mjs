import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createAgentSession, createEventBus, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import piPleat from "../src/index.ts";
import { assertCompactionReplays, bounded, loadExtensionFromFactory, testResourceLoader } from "./harness.mjs";

// Explicit opt-in. The main session runs these billable provider checks.
const live = process.env.PI_CONTEXT_LIVE === "1";
const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { ReadOnlyAuthStorage } = await import(new URL("./core/auth-storage.js", piEntry));
const { InMemoryCodingAgentModelsStore } = await import(new URL("./core/models-store.js", piEntry));
const systemPrompt = "You are helping with a synthetic context-management test. Preserve the project identifier and tool values. Follow the requested lookup order. Give concise answers.";
const values = { alpha: 17, beta: 23, gamma: 31 };
const sum = Object.values(values).reduce((a, b) => a + b, 0);
const textOf = (message) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
const signedThinking = (message) => message.role === "assistant" && message.content.some((part) => part.type === "thinking" && !!part.thinkingSignature);
const compactions = (h) => h.manager.getBranch().filter((entry) => entry.type === "compaction");
const assistants = (h) => h.manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant");

function diagnostic(t, step, data) {
  t.diagnostic(JSON.stringify({ step, ...data }));
}
function assertSuccess(message, label) {
  assert.ok(message.stopReason === "stop" || message.stopReason === "toolUse", `${label}: response must succeed`);
  assert.ok(!message.diagnostics?.some((item) => item.type === "anthropic_input_transformations"), `${label}: no input transformations are permitted`);
}
function assertAnthropicReplay(h, entry, request) {
  assert.ok(request.payload.thinking?.block_binding?.prefix_mismatch_behavior === "error", "Strict binding must remain enabled");
  const kept = h.manager.getEntry(entry.firstKeptEntryId);
  assert.ok(kept?.type === "message" && signedThinking(kept.message), "Every kept assistant must have signed thinking");
  const messages = request.payload.messages;
  assert.ok(messages?.[0]?.role === "assistant" && isDeepStrictEqual(messages[0].content, [entry.details.native.block]), "Replay must preserve the entire block");
  assert.ok(messages[1]?.role === "assistant", "The kept assistant must directly follow its block");
  const wireCalls = messages[1].content?.filter((part) => part.type === "tool_use").map((part) => part.id);
  assert.ok(isDeepStrictEqual(wireCalls, entry.details.native.keptToolUseIds), "The kept tool calls must remain unchanged");
  const wireSignatures = messages[1].content?.filter((part) => part.type === "thinking" || part.type === "redacted_thinking").map((part) => part.signature ?? part.data);
  assert.ok(isDeepStrictEqual(wireSignatures, entry.details.native.keptSignatures), "The kept thinking must directly follow its block unchanged");
}
function assertCodexReplay(h, entry, request) {
  const window = entry.details.native.window;
  const last = window.at(-1);
  assert.ok(last?.type === "compaction" && typeof last.encrypted_content === "string" && last.encrypted_content.length > 0, "The native window must end with complete encrypted compaction state");
  assert.ok(window.filter((item) => item.type === "compaction").length === 1 && window.slice(0, -1).every((item) => item.role === "user"), "Only retained users may precede the single compaction item");
  assert.ok(isDeepStrictEqual(request.payload.input?.slice(0, window.length), window), "The complete window must prefix the replay request");
  const kept = h.manager.getEntry(entry.firstKeptEntryId);
  const hasReasoningOrCall = kept?.type === "message" && kept.message.role === "assistant" && kept.message.content.some((part) => part.type === "toolCall" || part.type === "thinking" && part.thinkingSignature);
  if (hasReasoningOrCall) assert.ok(request.payload.input.slice(window.length).some((item) => item.type === "reasoning" || item.type === "function_call"), "The kept reasoning and tool suffix must follow the compaction item");
  assert.ok(entry.summary.trim().length > 0, "Native replay also requires a readable summary");
}
async function createRuntime() {
  // OAuth refresh must fail before it can alter the user's stored token.
  return ModelRuntime.create({ credentials: new ReadOnlyAuthStorage(), modelsStore: new InMemoryCodingAgentModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
}

async function fixture(t, provider, modelId, thinking, settingsFor) {
  const root = await mkdtemp(join(tmpdir(), "pi-pleat-live-"));
  const h = { root, requests: [], errors: [], notifications: [], lookups: [] };
  let session;
  t.after(async () => {
    try {
      session?.abortCompaction();
      if (session) await bounded(session.abort(), "live session cleanup", 5000);
    } finally {
      session?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  const abort = () => { void session?.abort(); };
  t.signal.addEventListener("abort", abort, { once: true });
  t.after(() => t.signal.removeEventListener("abort", abort));
  async function open(manager) {
    const modelRuntime = await createRuntime();
    const model = modelRuntime.getModel(provider, modelId);
    assert.ok(model && model.contextWindow > 0, "The configured physical model must exist");
    const runtime = createExtensionRuntime();
    const factories = [];
    if (provider === "anthropic") factories.push(["strict", (pi) => {
      pi.on("before_provider_request", (event) => event.payload.thinking ? {
        ...event.payload, thinking: { ...event.payload.thinking, block_binding: { ...event.payload.thinking.block_binding, prefix_mismatch_behavior: "error" } },
      } : undefined);
    }]);
    factories.push(["pi-pleat", piPleat], ["recorder", (pi) => {
      pi.registerTool({ name: "fixture_lookup", label: "Fixture lookup", description: "Return the deterministic value for a synthetic item.", parameters: Type.Object({ item: Type.Union([Type.Literal("alpha"), Type.Literal("beta"), Type.Literal("gamma")]) }),
        execute: async (_id, { item }) => {
          h.lookups.push(item);
          return { content: [{ type: "text", text: `item ${item} has value ${values[item]}\n` + "Synthetic fixture filler.\n".repeat(340) }], details: {} };
        } });
      pi.on("before_provider_request", (event, ctx) => {
        const latest = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
        h.requests.push({ payload: JSON.parse(JSON.stringify(event.payload)), compactionId: latest?.id, assistantIds: assistants(h).map((entry) => entry.id) });
      });
    }]);
    const extensions = [];
    for (const [name, factory] of factories) extensions.push(await loadExtensionFromFactory(factory, root, createEventBus(), runtime, `<live-${name}>`));
    const settings = SettingsManager.inMemory({ cacheWarming: "off", retry: { enabled: false, provider: { maxRetries: 0 } }, httpIdleTimeoutMs: 60000, ...settingsFor(model) });
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime, thinkingLevel: thinking,
      tools: ["recall", "fixture_lookup"], resourceLoader: testResourceLoader(extensions, runtime, systemPrompt), sessionManager: manager, settingsManager: settings }));
    Object.assign(h, { session, manager, model, modelRuntime });
    session.setCacheWarmingMode("off");
    await session.bindExtensions({ mode: "print", uiContext: { notify: (text, type) => { h.notifications.push(type); diagnostic(t, "notice", { type, message: text }); }, setStatus() {} }, onError: () => h.errors.push("extension error") });
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") diagnostic(t, "response", { stopReason: event.message.stopReason, usage: event.message.usage,
        contentTypes: event.message.content.map((part) => part.type), signedThinking: signedThinking(event.message),
        diagnostics: event.message.diagnostics?.map((item) => item.type) ?? [] });
      if (event.type === "compaction_end") diagnostic(t, "compaction", { strategy: event.result?.details?.strategy, aborted: event.aborted });
    });
  }
  await open(SessionManager.create(root, join(root, "sessions")));
  h.prompt = (text) => bounded(session.prompt(text), "live prompt", 240000);
  h.reopen = async () => {
    const file = h.manager.getSessionFile();
    assert.ok(file, "The session must persist for restart verification");
    await session.abort();
    session.dispose();
    h.requests.length = 0;
    await open(SessionManager.open(file));
  };
  return h;
}

const task = (identifier) => `Project identifier: ${identifier}. Use fixture_lookup for items alpha, beta and gamma one at a time, think about each value, then report their sum and the project identifier.`;

test("live integrated Anthropic: automatic signed compactions, strict kept-thinking replay, and restart", { skip: !live, timeout: 300000 }, async (t) => {
  const modelId = process.env.PI_CONTEXT_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
  const h = await fixture(t, "anthropic", modelId, "high", (model) => ({ compaction: { enabled: true,
    modelOverrides: { [`anthropic/${model.id}`]: { reserveTokens: model.contextWindow - 3000 } } } }));
  const identifier = `project-${randomUUID()}`;
  await h.prompt(task(identifier));
  const entries = compactions(h);
  diagnostic(t, "anthropic-task", { requests: h.requests.length, compactions: entries.length, strategies: entries.map((entry) => entry.details?.strategy), lookups: h.lookups.length });
  assert.ok(assistants(h).some((entry) => signedThinking(entry.message)), "Signed thinking is a required precondition");
  assert.ok(entries.filter((entry) => entry.details?.strategy === "anthropic").length >= 2, "At least two integrated native Anthropic compactions are required");
  assert.ok(isDeepStrictEqual(h.lookups, ["alpha", "beta", "gamma"]), "The task must perform the three lookups in order");
  const natives = entries.filter((entry) => entry.details?.strategy === "anthropic");
  const firstRequest = h.requests.findIndex((request) => request.compactionId === natives[0].id);
  for (const request of firstRequest < 0 ? [] : h.requests.slice(firstRequest)) {
    const first = request.payload.messages?.[0];
    assert.ok(first?.role === "assistant" && first.content?.[0]?.type === "compaction", "Every later request must start with a native compaction block");
    assert.ok(request.payload.thinking?.block_binding?.prefix_mismatch_behavior === "error", "Strict binding must remain enabled");
  }
  if (firstRequest >= 0) {
    const earlierAssistants = new Set(h.requests[firstRequest].assistantIds);
    for (const entry of assistants(h).filter((entry) => !earlierAssistants.has(entry.id))) assertSuccess(entry.message, "post-compaction assistant");
  }
  const answer = h.session.messages.findLast((message) => message.role === "assistant");
  assertSuccess(answer, "final answer");
  assert.ok(textOf(answer).includes(String(sum)) && textOf(answer).includes(identifier), "The final answer must contain the correct sum and identifier");
  assert.ok(h.errors.length === 0, "Extensions must not report errors");
  const latest = entries.at(-1);
  assert.ok(latest.details?.strategy === "anthropic", "Restart requires the latest compaction to be native");
  const taskRequests = h.requests.slice();
  await h.reopen();
  await h.prompt("Reply with the project identifier only.");
  const request = h.requests[0];
  assertCompactionReplays(natives, taskRequests, request, (entry, replay) => assertAnthropicReplay(h, entry, replay));
  const reply = h.session.messages.findLast((message) => message.role === "assistant");
  assertSuccess(reply, "restart reply");
  assert.ok(textOf(reply).includes(identifier), "Restart must recover the project identifier");
  diagnostic(t, "anthropic-restart", { requests: h.requests.length, stopReason: reply.stopReason, usage: reply.usage, strictBinding: request.payload.thinking?.block_binding?.prefix_mismatch_behavior, replayChecks: natives.length });
});

test("live integrated OpenAI Codex: threshold trigger, readable summary, retained suffix, and restart", { skip: !live, timeout: 300000 }, async (t) => {
  const modelId = process.env.PI_CONTEXT_OPENAI_MODEL ?? "gpt-6-luna";
  const h = await fixture(t, "openai-codex", modelId, "low", (model) => ({ compaction: { enabled: true, keepRecentTokens: 800,
    modelOverrides: { [`openai-codex/${model.id}`]: { reserveTokens: model.contextWindow - 3500 } } },
    "pi-pleat": { fallbackModel: "anthropic/claude-haiku-5-5", fallbackThinking: "off" } }));
  const identifier = `project-${randomUUID()}`;
  await h.prompt(task(identifier));
  const entries = compactions(h);
  const natives = entries.filter((entry) => entry.details?.strategy === "responses-trigger");
  diagnostic(t, "codex-task", { requests: h.requests.length, compactions: entries.length, strategies: entries.map((entry) => entry.details?.strategy), windowTypes: natives.map((entry) => entry.details.native.window.map((item) => item.type ?? "message")) });
  assert.ok(natives.length >= 1, "At least one integrated Responses trigger compaction is required");
  assert.ok(isDeepStrictEqual(h.lookups, ["alpha", "beta", "gamma"]), "The task must perform three lookups in order");
  const firstRequest = h.requests.find((request) => request.compactionId === natives[0].id);
  if (firstRequest) {
    const earlierAssistants = new Set(firstRequest.assistantIds);
    for (const entry of assistants(h).filter((entry) => !earlierAssistants.has(entry.id))) assertSuccess(entry.message, "post-compaction assistant");
  }
  const answer = h.session.messages.findLast((message) => message.role === "assistant");
  assertSuccess(answer, "final answer");
  assert.ok(textOf(answer).includes(String(sum)) && textOf(answer).includes(identifier), "The final answer must contain the correct sum and identifier");
  assert.ok(h.errors.length === 0, "Extensions must not report errors");
  const latest = entries.at(-1);
  assert.ok(latest.details?.strategy === "responses-trigger", "Restart requires the latest compaction to be native");
  const taskRequests = h.requests.slice();
  await h.reopen();
  await h.prompt("Reply with the project identifier only.");
  const window = latest.details.native.window;
  assertCompactionReplays(natives, taskRequests, h.requests[0], (entry, replay) => assertCodexReplay(h, entry, replay));
  const reply = h.session.messages.findLast((message) => message.role === "assistant");
  assertSuccess(reply, "restart reply");
  assert.ok(textOf(reply).includes(identifier), "Restart must recover the project identifier");
  diagnostic(t, "codex-restart", { requests: h.requests.length, stopReason: reply.stopReason, usage: reply.usage, windowTypes: window.map((item) => item.type ?? "message"), replayChecks: natives.length });
});
