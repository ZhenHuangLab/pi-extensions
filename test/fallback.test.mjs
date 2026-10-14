import assert from "node:assert/strict";
import test from "node:test";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import { createCompactor } from "../src/compact.ts";
import { createRequests } from "../src/requests.ts";
import { createSessionStats, limitsFor } from "../src/budget.ts";
import { prepareFromBranch, resolveSummarizer, summarize } from "../src/fallback.ts";
import { FALLBACK_ENTRY } from "../src/session.ts";
import { anthropicMessage, appendTool, assistant, bounded, createHarness, sendSse, startAnthropicMock, testOptions, textReply, toolCall, usage } from "./harness.mjs";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { prepareCompaction } = await import(new URL("./core/compaction/compaction.js", piEntry));
const files = { read: new Set(["z.txt", "a.txt", "written.txt", "edited.txt"]), written: new Set(["written.txt"]), edited: new Set(["edited.txt"]) };
function preparation(messages, extra = {}) {
  return { firstKeptEntryId: "kept", messagesToSummarize: messages, turnPrefixMessages: [], isSplitTurn: false,
    tokensBefore: 10000, fileOps: files, settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 }, ...extra };
}
const summaryModel = { id: "small-summary", name: "Small summary", contextWindow: 7100, maxTokens: 500, reasoning: true };

function resolve(h, settings = {}) {
  return resolveSummarizer({ getSettings: () => settings, getThinkingLevel: () => "high" }, h.ctx);
}

test("chunked fallback chains each previous summary, uses summarizer limits, sums usage, and appends exact Pi file lists", testOptions, async (t) => {
  const messages = Array.from({ length: 5 }, (_, index) => ({ role: "user", content: `Message ${index} ` + "x".repeat(2000), timestamp: 0 }));
  const h = await createHarness(t, { summarizerModels: [summaryModel], replies: Array.from({ length: 5 }, (_, index) => ({ content: textReply(`Summary ${index + 1}`), usage: usage(10, 2, 3, 4) })) });
  const settings = { "pi-pleat": { fallbackModel: "pleat-test/small-summary", fallbackThinking: "high" }, compaction: { reserveTokens: 500 } };
  const summarizer = resolve(h, settings);
  const result = await summarize({ ctx: h.ctx, preparation: preparation(messages.slice(0, 3), { turnPrefixMessages: messages.slice(3), previousSummary: "Initial summary" }),
    summarizer, signal: t.signal, settings });
  assert.equal(h.requests.length, 5);
  for (const [index, request] of h.requests.entries()) {
    assert.equal(request.model, summaryModel.id);
    const text = request.messages.find((message) => message.role === "user").content[0].text;
    assert.ok(text.includes(`Message ${index} `));
    for (let other = 0; other < 5; other++) if (other !== index) assert.equal(text.includes(`Message ${other} `), false);
    assert.ok(text.includes(`<previous-summary>\n${index === 0 ? "Initial summary" : `Summary ${index}`}\n</previous-summary>`));
    assert.equal(request.options.maxTokens, 400);
    assert.equal(request.options.cacheRetention, "none");
    assert.equal(request.options.reasoning, "high");
    assert.equal(typeof request.options.apiKey, "string");
  }
  assert.equal(result.summary, "Summary 5\n\n<read-files>\na.txt\nz.txt\n</read-files>\n\n<modified-files>\nedited.txt\nwritten.txt\n</modified-files>");
  assert.deepEqual(result.readFiles, ["a.txt", "z.txt"]);
  assert.deepEqual(result.modifiedFiles, ["edited.txt", "written.txt"]);
  assert.deepEqual(result.usage, usage(50, 10, 15, 20));
  assert.deepEqual(h.errors, []);
});

test("fallback uses Pi compact when input fits and rejects an indivisible oversized message", testOptions, async (t) => {
  const h = await createHarness(t, { summarizerModels: [summaryModel], replies: [textReply("Pi summary.")] });
  const settings = { "pi-pleat": { fallbackModel: "pleat-test/small-summary" }, compaction: { reserveTokens: 500 } };
  const summarizer = resolve(h, settings);
  const result = await summarize({ ctx: h.ctx, preparation: preparation([{ role: "user", content: "Small conversation.", timestamp: 0 }]), summarizer, signal: t.signal, settings });
  assert.equal(h.requests.length, 1);
  assert.equal(result.summary, "Pi summary.\n\n<read-files>\na.txt\nz.txt\n</read-files>\n\n<modified-files>\nedited.txt\nwritten.txt\n</modified-files>");
  assert.equal(h.requests[0].options.maxTokens, 400);
  await assert.rejects(summarize({ ctx: h.ctx, preparation: preparation([{ role: "user", content: "x".repeat(5000), timestamp: 0 }]), summarizer, signal: t.signal, settings }), /single message does not fit/);
  assert.equal(h.requests.length, 1);
});

test("summarizer selection resolves overrides before settings, clears to settings, preserves model slashes, and clamps thinking", testOptions, async (t) => {
  const h = await createHarness(t, { summarizerModels: [{ ...summaryModel, id: "small/summary" }] });
  let result = resolve(h);
  assert.equal(result.model.id, "deterministic");
  assert.equal(result.thinkingLevel, "off");
  assert.equal(result.configured, false);
  const settings = { "pi-pleat": { fallbackModel: "pleat-test/small/summary", fallbackThinking: "max" } };
  result = resolve(h, settings);
  assert.equal(result.model.id, "small/summary");
  assert.equal(result.thinkingLevel, clampThinkingLevel(result.model, "max"));
  assert.equal(result.label, "settings");
  h.manager.appendCustomEntry(FALLBACK_ENTRY, { model: "pleat-test/deterministic", thinking: "high" });
  result = resolve(h, settings);
  assert.equal(result.model.id, "deterministic");
  assert.equal(result.thinkingLevel, "off");
  assert.equal(result.label, "session override");
  h.manager.appendCustomEntry(FALLBACK_ENTRY, { model: null, thinking: null });
  assert.equal(resolve(h, settings).model.id, "small/summary");
  for (const config of [{ fallbackModel: "missing/model" }, { fallbackModel: "invalid" }, { fallbackModel: "" }, { fallbackThinking: "invalid" }, []]) {
    assert.equal(typeof resolve(h, { "pi-pleat": config }).error, "string");
  }
});

test("configured summarizer failure returns control to Pi default compaction with the session model", testOptions, async (t) => {
  const h = await createHarness(t, { summarizerModels: [summaryModel], settings: {
    "pi-pleat": { fallbackModel: "pleat-test/small-summary" }, compaction: { enabled: false, reserveTokens: 500, keepRecentTokens: 1 },
  }, replies: [textReply("first answer"), textReply("second answer"), { content: [], stopReason: "error", errorMessage: "Configured model unavailable" }, textReply("Pi history"), textReply("Pi turn prefix")] });
  await h.prompt("First task.");
  await h.prompt("Second task.");
  await bounded(h.session.compact(), "fallback to Pi default");
  assert.deepEqual(h.requests.map((request) => request.model), ["deterministic", "deterministic", "small-summary", "deterministic", "deterministic"]);
  const entries = h.manager.getBranch().filter((entry) => entry.type === "compaction");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].fromHook, false);
  assert.equal(entries[0].details.plugin, undefined);
  assert.ok(entries[0].summary.includes("Pi history"));
  assert.ok(entries[0].summary.includes("Pi turn prefix"));
  assert.ok(h.notifications.some((notification) => notification.text.includes("configured fallback summary failed")));
  assert.deepEqual(h.errors, []);
});

test("turn_end Anthropic fallback prepares the projected branch when the bound output allowance is below 4096", testOptions, async (t) => {
  const mock = await startAnthropicMock((request, res) => {
    assert.equal(request.body.compaction, undefined);
    sendSse(res, anthropicMessage({ blocks: textReply("kept answer"), input: 9500 }));
  });
  t.after(() => mock.close());
  const h = await createHarness(t, { mock, modelOptions: { contextWindow: 10000, maxTokens: 4095 }, replies: [textReply("Readable fallback summary")],
    settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 }, "pi-pleat": { fallbackModel: "pleat-test/deterministic" } } });
  await h.prompt("Original source to summarize.");
  assert.equal(mock.requests.length, 1);
  assert.equal(h.requests.length, 1);
  const text = h.requests[0].messages.find((message) => message.role === "user").content[0].text;
  assert.ok(text.includes("Original source to summarize."));
  assert.equal(text.includes("kept answer"), false);
  const [entry] = h.manager.getBranch().filter((entry) => entry.type === "compaction");
  assert.equal(entry.details.strategy, "pi-summary");
  assert.equal(entry.details.reason, "native compaction requires max_tokens >= 4096");
  assert.equal(entry.details.provider, "pleat-test");
  assert.equal(h.manager.getEntry(entry.firstKeptEntryId).message.content[0].text, "kept answer");
  assert.ok(entry.summary.includes("Readable fallback summary"));
  assert.ok(h.notifications.some((notification) => notification.text.includes("max_tokens >= 4096")));
  assert.deepEqual(h.errors, []);
  assert.deepEqual(mock.errors, []);
});

test("turn_end fallback retries a failing configured summarizer with the session model", testOptions, async (t) => {
  const mock = await startAnthropicMock((_request, res, index) => sendSse(res, anthropicMessage({ blocks: textReply(index ? "Session summary" : "kept answer"), input: index ? 100 : 9500 })));
  t.after(() => mock.close());
  const h = await createHarness(t, { mock, modelOptions: { contextWindow: 10000, maxTokens: 4095 }, replies: [{ content: [], stopReason: "error", errorMessage: "Configured summarizer failed" }],
    settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 }, "pi-pleat": { fallbackModel: "pleat-test/deterministic" } } });
  await h.prompt("Original source.");
  assert.equal(h.requests.length, 1);
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[1].body.compaction, undefined);
  const [entry] = h.manager.getBranch().filter((entry) => entry.type === "compaction");
  assert.equal(entry.details.strategy, "pi-summary");
  assert.equal(entry.details.provider, "anthropic");
  assert.ok(entry.summary.includes("Session summary"));
  assert.deepEqual(h.errors, []);
});

test("fallback candidates are discarded when the session changes during summarization", testOptions, async (t) => {
  let h;
  h = await createHarness(t, { summarizerModels: [summaryModel], settings: { "pi-pleat": { fallbackModel: "pleat-test/small-summary" }, compaction: { enabled: false, reserveTokens: 500, keepRecentTokens: 1 } },
    replies: [textReply("answer"), () => { h.manager.appendCustomEntry("changed-during-summary", true); return textReply("discard this summary"); }] });
  await h.prompt("Task.");
  await assert.rejects(bounded(h.session.compact(), "discard stale fallback"), /cancel/i);
  assert.equal(h.manager.getBranch().some((entry) => entry.type === "compaction"), false);
  assert.equal(h.requests.length, 2);
  assert.ok(h.notifications.some((notification) => notification.text.includes("state changed")));
  assert.deepEqual(h.errors, []);
});

test("prepareFromBranch mirrors Pi projected cuts, complete tool pairs, split turns, previous summaries and nested file lists", testOptions, () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "system", content: "system", timestamp: 0 });
  const firstUser = manager.appendMessage({ role: "user", content: "First task.", timestamp: 0 });
  const saved = appendTool(manager, { id: "first", name: "read", args: { path: "read.txt" } });
  manager.appendMessage(assistant([toolCall("write", "write", { path: "write.txt" })]));
  manager.appendMessage({ role: "toolResult", toolCallId: "write", toolName: "write", content: textReply("done"), isError: false, timestamp: 0,
    nestedCalls: { complete: true, calls: [{ id: "nested-edit", name: "edit", arguments: { path: "edit.txt" }, status: "ok" }] } });
  const kept = manager.appendMessage(assistant(textReply("Final answer.")));
  const limits = limitsFor({ contextWindow: 10000 }, { compaction: { reserveTokens: 1000, keepRecentTokens: 1 } });
  const compare = () => {
    const branch = manager.getBranch();
    const actual = prepareFromBranch(branch, limits);
    const expected = prepareCompaction(branch, { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 });
    assert.deepEqual(actual && { ...actual, tokensBefore: 0 }, expected && { ...expected, tokensBefore: 0 });
    if (actual) assert.equal(actual.tokensBefore, manager.buildSessionContext().messages.reduce((sum, message) => sum + estimateTokens(message), 0));
    return actual;
  };
  let prepared = compare();
  assert.equal(prepared.firstKeptEntryId, kept);
  assert.equal(prepared.isSplitTurn, true);
  assert.deepEqual([...prepared.fileOps.read], ["read.txt"]);
  assert.deepEqual([...prepared.fileOps.written], ["write.txt"]);
  assert.deepEqual([...prepared.fileOps.edited], ["edit.txt"]);
  manager.appendContextEdit(saved.entryId, { content: textReply("edited output") });
  compare();
  manager.appendCompaction("Previous summary.", saved.assistantId, 100, { readFiles: ["previous.txt"], modifiedFiles: ["previous-edit.txt"] }, false);
  assert.equal(prepareFromBranch(manager.getBranch(), limits), undefined);
  manager.appendMessage({ role: "user", content: "Second task.", timestamp: 0 });
  manager.appendMessage(assistant(textReply("Second answer.")));
  prepared = compare();
  assert.equal(prepared.previousSummary, "Previous summary.");
  assert.ok(prepared.fileOps.read.has("previous.txt"));
  assert.ok(prepared.fileOps.edited.has("previous-edit.txt"));
  manager.branch(firstUser);
  assert.equal(prepareFromBranch(manager.getBranch(), limits), undefined);
  const omitted = manager.appendMessage(assistant([], { stopReason: "error" }));
  manager.appendContextEdit(omitted, null);
  compare();
});

test("chunked fallback checks session state after every provider request before sending another chunk", testOptions, async (t) => {
  let h;
  h = await createHarness(t, { summarizerModels: [summaryModel], settings: { "pi-pleat": { fallbackModel: "pleat-test/small-summary" }, compaction: { enabled: false, reserveTokens: 500, keepRecentTokens: 1 } },
    replies: [() => { h.manager.appendCustomEntry("changed-after-first-chunk", true); return textReply("stale first chunk"); }] });
  for (let index = 0; index < 5; index++) h.manager.appendMessage({ role: "user", content: "x".repeat(2000), timestamp: 0 });
  h.manager.appendMessage(assistant(textReply("kept answer")));
  h.session.refreshContext();
  await assert.rejects(bounded(h.session.compact(), "discard stale chunks"), /cancel/i);
  assert.equal(h.requests.length, 1);
  assert.equal(h.manager.getBranch().some((entry) => entry.type === "compaction"), false);
  assert.deepEqual(h.errors, []);
});


for (const [name, replies, extra] of [
  ["file-list formatting", [textReply(" ")], {}],
  ["split-turn formatting", [textReply("valid history"), textReply("")], { isSplitTurn: true, turnPrefixMessages: [{ role: "user", content: "turn prefix", timestamp: 0 }] }],
  ["tool calls", [[toolCall("summary-tool", "read")]], {}],
  ["aborted result", [{ content: textReply("partial"), stopReason: "aborted" }], {}],
  ["length result", [{ content: textReply("partial"), stopReason: "length" }], {}],
]) {
  test(`raw fallback validation rejects invalid replies before ${name}`, testOptions, async (t) => {
    const h = await createHarness(t, { replies });
    await assert.rejects(summarize({ ctx: h.ctx,
      preparation: preparation([{ role: "user", content: "history", timestamp: 0 }], extra),
      summarizer: resolve(h), settings: {}, signal: t.signal }), /empty|did not complete/);
    assert.equal(h.requests.length, replies.length);
  });
}

test("a thinking-only setting or override selects our summarizer and reports its source", testOptions, async (t) => {
  const h = await createHarness(t, { thinking: "high", modelOptions: { reasoning: true },
    settings: { "pi-pleat": { fallbackThinking: "low" }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 } },
    replies: [textReply("answer"), textReply("Thinking-only summary")] });
  const selected = resolve(h, { "pi-pleat": { fallbackThinking: "low" } });
  assert.equal(selected.configured, true);
  assert.equal(selected.model.id, h.model.id);
  assert.equal(selected.thinkingLevel, "low");
  assert.equal(selected.label, "settings");
  await h.prompt("Original task.");
  await bounded(h.session.compact(), "thinking-only compaction");
  assert.equal(h.requests[1].options.reasoning, "low");
  const entry = h.manager.getBranch().find((entry) => entry.type === "compaction");
  assert.equal(entry.details.strategy, "pi-summary");
  assert.ok(entry.summary.includes("Thinking-only summary"));
  h.manager.appendCustomEntry(FALLBACK_ENTRY, { model: null, thinking: "medium" });
  const overridden = resolve(h, { "pi-pleat": { fallbackThinking: "low" } });
  assert.equal(overridden.configured, true);
  assert.equal(overridden.model.id, h.model.id);
  assert.equal(overridden.label, "session override");
  assert.equal(overridden.thinkingLevel, "medium");
  assert.ok((await h.status()).includes("(medium) · session override"));
});

test("an empty same-model configured summary cannot commit file lists or split-turn text", testOptions, async (t) => {
  const h = await createHarness(t, { settings: { "pi-pleat": { fallbackThinking: "off" }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 } },
    replies: [textReply("answer"), textReply("")] });
  await h.prompt("Original task.");
  await assert.rejects(bounded(h.session.compact(), "empty configured summary"), /cancel/i);
  assert.equal(h.manager.getBranch().some((entry) => entry.type === "compaction"), false);
  assert.equal(h.requests.length, 2);
  assert.ok(h.notifications.some((notification) => notification.text.includes("fallback summary failed")));
});

for (const change of ["leaf", "session", "channel"]) {
  test(`queued compaction rejects a changed ${change} before using its preparation`, testOptions, async (t) => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const settings = { "pi-pleat": { fallbackThinking: "off" }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 } };
    const h = await createHarness(t, { settings, replies: [async () => { entered.resolve(); await release.promise; return textReply("stale summary"); }] });
    h.manager.appendMessage({ role: "user", content: "Original history", timestamp: 0 });
    h.manager.appendMessage(assistant(textReply("kept")));
    let sessionId = h.manager.getSessionId();
    const ctx = { ...h.ctx, model: h.model, sessionManager: {
      getBranch: () => h.manager.getBranch(), getLeafId: () => h.manager.getLeafId(), getSessionId: () => sessionId,
    } };
    const pi = { getSettings: () => settings, getThinkingLevel: () => "off", appendEntry: (name, data) => h.manager.appendCustomEntry(name, data) };
    const compactor = createCompactor(createRequests(), () => {});
    const limits = limitsFor(h.model, settings);
    const args = { pi, ctx, trigger: "manual", signal: t.signal, stats: createSessionStats(), limits,
      preparation: prepareFromBranch(h.manager.getBranch(), limits) };
    const first = compactor.compactNow(args);
    await bounded(entered.promise, "first summary start");
    const queued = compactor.compactNow(args);
    if (change === "leaf") h.manager.appendCustomEntry("changed", true);
    if (change === "session") sessionId = "different-session";
    if (change === "channel") ctx.model = { ...h.model, id: "different-model" };
    release.resolve();
    assert.deepEqual(await first, { kind: "skip", reason: "state changed" });
    assert.deepEqual(await queued, { kind: "skip", reason: "state changed" });
    assert.equal(h.requests.length, 1);
  });
}

test("fallback budgets the capped summary output independently of a large trigger reserve", testOptions, async (t) => {
  const h = await createHarness(t, { summarizerModels: [{ ...summaryModel, contextWindow: 20000 }], replies: [textReply("Capped summary")] });
  const settings = { "pi-pleat": { fallbackModel: "pleat-test/small-summary" }, compaction: { reserveTokens: 18000 } };
  const result = await summarize({ ctx: h.ctx, preparation: preparation([{ role: "user", content: "x".repeat(8000), timestamp: 0 }]),
    summarizer: resolve(h, settings), signal: t.signal, settings });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.maxTokens, 500);
  assert.ok(result.summary.startsWith("Capped summary"));
});

for (const [label, thinking, thinkingBudgets, expectedCalls, expectedMax, expectedThinking] of [
  ["default high budget capped by the model", "high", undefined, 2, 12000, 10976],
  ["custom high budget", "high", { high: 2500 }, 1, 3300, 2276],
  ["default low budget", "low", undefined, 1, 2848, 1824],
]) {
  test(`fallback accounts for ${label} and preserves the adapter safety margin`, testOptions, async (t) => {
    const mock = await startAnthropicMock((_request, res) => sendSse(res, anthropicMessage({ blocks: textReply("Budgeted summary") })));
    t.after(() => mock.close());
    const h = await createHarness(t, { mock, modelOptions: { contextWindow: 20000, maxTokens: 12000,
      compat: { forceAdaptiveThinking: false, supportsMidConvoEffort: false } } });
    const settings = { compaction: { reserveTokens: 1000 }, thinkingBudgets };
    const summarizer = { model: h.model, thinkingLevel: thinking, configured: false, label: "session model" };
    const messages = Array.from({ length: 2 }, () => ({ role: "user", content: "x".repeat(6000), timestamp: 0 }));
    await summarize({ ctx: h.ctx, preparation: preparation(messages), summarizer, signal: t.signal, settings });
    assert.equal(mock.requests.length, expectedCalls);
    for (const request of mock.requests) {
      assert.equal(request.body.max_tokens, expectedMax, "Input sizing must not force Pi to reduce the response ceiling");
      assert.equal(request.body.thinking.type, "enabled");
      assert.equal(request.body.thinking.budget_tokens, expectedThinking);
    }
    assert.deepEqual(h.errors, []);
    assert.deepEqual(mock.errors, []);
  });
}

for (const extra of [{ previousSummary: "x".repeat(500) }, { customInstructions: "x".repeat(500) }]) {
  test(`fallback includes ${extra.previousSummary ? "the previous summary" : "custom instructions"} in its input budget`, testOptions, async (t) => {
    const h = await createHarness(t, { summarizerModels: [summaryModel] });
    const settings = { "pi-pleat": { fallbackModel: "pleat-test/small-summary" }, compaction: { reserveTokens: 500 } };
    await assert.rejects(summarize({ ctx: h.ctx,
      preparation: preparation([{ role: "user", content: "x".repeat(2000), timestamp: 0 }], extra),
      customInstructions: extra.customInstructions, summarizer: resolve(h, settings), signal: t.signal, settings }), /single message does not fit/);
    assert.equal(h.requests.length, 0);
  });
}

test("fallback keeps only known chunk usage and marks missing provider usage as partial", testOptions, async (t) => {
  const h = await createHarness(t, { summarizerModels: [summaryModel], replies: [
    { content: textReply("first"), usage: usage(5, 2) },
    { content: textReply("second"), usage: usage(0, 0) },
    { content: textReply("third"), usage: usage(7, 3) },
  ] });
  const settings = { "pi-pleat": { fallbackModel: "pleat-test/small-summary" }, compaction: { reserveTokens: 500 } };
  const messages = Array.from({ length: 3 }, () => ({ role: "user", content: "x".repeat(2000), timestamp: 0 }));
  const result = await summarize({ ctx: h.ctx, preparation: preparation(messages), summarizer: resolve(h, settings), signal: t.signal, settings });
  assert.equal(h.requests.length, 3);
  assert.deepEqual(result.usage, usage(12, 5));
  assert.equal(result.usageComplete, false);
});

test("Pi split-turn fallback preserves known usage when one summary has no provider counts", testOptions, async (t) => {
  const h = await createHarness(t, { replies: [
    { content: textReply("history"), usage: usage(5, 2) },
    { content: textReply("turn prefix"), usage: usage(0, 0) },
  ] });
  const result = await summarize({ ctx: h.ctx, preparation: preparation([{ role: "user", content: "history", timestamp: 0 }], {
    isSplitTurn: true, turnPrefixMessages: [{ role: "user", content: "prefix", timestamp: 0 }],
  }), summarizer: resolve(h), signal: t.signal, settings: {} });
  assert.equal(h.requests.length, 2);
  assert.deepEqual(result.usage, usage(5, 2));
  assert.equal(result.usageComplete, false);
});

for (const excess of ["summary", "suffix", "system and tools"]) {
  test(`text compaction rejects an oversized ${excess} before committing and keeps the branch`, testOptions, async (t) => {
    const h = await createHarness(t, { modelOptions: { contextWindow: 8000 },
      settings: { "pi-pleat": { fallbackThinking: "off" }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 } },
      replies: [textReply(excess === "summary" ? "x".repeat(16000) : "Readable summary")] });
    h.manager.appendMessage({ role: "system", content: "Initial system", timestamp: 0 });
    if (excess === "system and tools") h.manager.appendMessage({ role: "system", content: "", timestamp: 0,
      sections: { focus: "x".repeat(12000) }, toolsAdded: [{ name: "large_tool", description: "x".repeat(5000), parameters: { type: "object" } }] });
    h.manager.appendMessage({ role: "user", content: "Original history", timestamp: 0 });
    h.manager.appendMessage(assistant(textReply(excess === "suffix" ? "x".repeat(20000) : "Kept answer")));
    h.session.refreshContext();
    const before = structuredClone(h.manager.getBranch());
    await assert.rejects(bounded(h.session.compact(), "reject oversized text context"), /cancel/i);
    assert.deepEqual(h.manager.getBranch(), before);
    assert.equal(h.requests.length, 1);
    assert.ok(h.notifications.some((notice) => notice.text === "Compaction skipped: compacted context does not fit the window."));
    assert.deepEqual(h.errors, []);
  });
}

for (const overflow of [false, true]) {
  test(`text compaction ${overflow ? "rejects one token above" : "accepts exactly"} the session window safety boundary`, testOptions, async (t) => {
    const system = { role: "system", content: "Current system", timestamp: 0 };
    const kept = { role: "user", content: "Next task", timestamp: 0 };
    const tokens = 8000 - 4096 - estimateTokens(system) - estimateTokens(kept);
    const h = await createHarness(t, { modelOptions: { contextWindow: 8000 },
      settings: { "pi-pleat": { fallbackThinking: "off" }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 } },
      replies: [textReply("x".repeat(tokens * 4 + (overflow ? 1 : 0)))] });
    h.manager.appendMessage(system);
    h.manager.appendMessage({ role: "user", content: "Earlier history", timestamp: 0 });
    const keptId = h.manager.appendMessage(kept);
    h.session.refreshContext();
    const before = structuredClone(h.manager.getBranch());
    if (overflow) {
      await assert.rejects(bounded(h.session.compact(), "over-boundary text context"), /cancel/i);
      assert.deepEqual(h.manager.getBranch(), before);
    } else {
      await bounded(h.session.compact(), "exact-boundary text context");
      const entry = h.manager.getBranch().find((entry) => entry.type === "compaction");
      assert.equal(entry.details.strategy, "pi-summary");
      assert.equal(entry.firstKeptEntryId, keptId);
      assert.equal(estimateTokens(system) + Math.ceil(entry.summary.length / 4) + estimateTokens(kept) + 4096, 8000);
    }
  });
}
