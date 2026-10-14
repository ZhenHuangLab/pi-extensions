import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { compactionPayload, COMPACT_BETA, keptIdentity, requestCompaction } from "../src/providers/anthropic.ts";
import { canonicalJson, CAPABILITY_ENTRY, channelOf, readPleatDetails, sha256 } from "../src/session.ts";
import { anthropicCompaction, anthropicMessage, bounded, createHarness, sendJson, sendSse, startAnthropicMock, testOptions, textReply } from "./harness.mjs";

const block = { type: "compaction", content: "Native summary.", signature: "local-compaction-signature", metadata: { complete: true } };
const thinking = { type: "thinking", thinking: "local reasoning", signature: "local-thinking-signature" };
const tool = { type: "tool_use", id: "native-call", name: "noop", input: {} };
const compactions = (h) => h.manager.getBranch().filter((entry) => entry.type === "compaction");
const nativeRequests = (h) => h.mock.requests.filter((request) => request.body.compaction);
async function fixture(t, { native = (_request, res) => sendSse(res, anthropicCompaction({ block })), main, enabled = true, before, configure, ...options } = {}) {
  let agents = 0;
  const mock = await startAnthropicMock((request, res, index) => {
    if (request.body.compaction) return native(request, res, index);
    if (main) return main(request, res, agents++);
    sendSse(res, anthropicMessage(agents++ === 0 ? { blocks: [thinking, tool], stop: "tool_use", input: 10000, extra: { context_management: { applied_edits: [{ cleared_input_tokens: 5000 }] } } } : { blocks: [thinking, ...textReply("continued")] }));
  });
  t.after(() => mock.close());
  const h = await createHarness(t, { mock, tools: ["recall", "noop"], modelOptions: { contextWindow: 20000 },
    settings: { compaction: { enabled, reserveTokens: 5000, keepRecentTokens: 1 } }, before,
    configure(pi) {
      pi.registerTool({ name: "noop", label: "Noop", description: "Return a fixed result.", parameters: Type.Object({}), execute: async () => ({ content: textReply("noop result"), details: {} }) });
      configure?.(pi);
    }, ...options });
  h.mock = mock;
  return h;
}
function expectedCompaction(body) {
  const expected = structuredClone(body);
  delete expected.context_management;
  expected.compaction = { type: "summarize" };
  return expected;
}

test("raw Anthropic turn_end compaction uses the exact last HTTP body and replays the block with its kept tool pair", testOptions, async (t) => {
  const h = await fixture(t, { before(pi) {
    pi.on("message_end", (event) => event.message.role === "assistant" ? { message: structuredClone(event.message) } : undefined);
    pi.on("turn_end", () => ({ entries: [{ type: "custom", customType: "preceding-boundary", data: true }] }));
  } });
  await h.prompt("Run noop and continue. Source prefix.");
  assert.equal(h.mock.requests.length, 3);
  const [agent, compact, replay] = h.mock.requests;
  assert.deepEqual(compact.body, expectedCompaction(agent.body));
  assert.deepEqual(new Set(compact.headers["anthropic-beta"].split(",")), new Set([...agent.headers["anthropic-beta"].split(","), COMPACT_BETA]));
  const [entry] = compactions(h);
  assert.equal(compactions(h).length, 1);
  const details = readPleatDetails(entry);
  assert.equal(details.strategy, "anthropic");
  assert.deepEqual({ provider: details.provider, api: details.api, endpoint: details.endpoint, model: details.model }, channelOf(h.model));
  assert.deepEqual(details.native.block, block);
  assert.equal(details.firstKeptEntryId, entry.firstKeptEntryId);
  assert.equal(details.native.systemHash, sha256(canonicalJson(agent.body.system)));
  assert.equal(details.native.toolsHash, sha256(canonicalJson(agent.body.tools)));
  const kept = h.manager.getEntry(entry.firstKeptEntryId);
  assert.deepEqual(details.native.keptSignatures, [thinking.signature]);
  assert.deepEqual(details.native.keptToolUseIds, [tool.id]);
  assert.equal(kept.message.role, "assistant");
  const branch = h.manager.getBranch();
  assert.equal(h.manager.getEntry(details.firstCoveredEntryId).message.role, "system");
  assert.equal(h.manager.getEntry(details.lastCoveredEntryId).message.role, "user");
  assert.deepEqual(entry.usage, { input: 300, output: 50, cacheRead: 30, cacheWrite: 40, totalTokens: 420,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const expectedMessages = [
    { role: "assistant", content: [block] },
    { role: "assistant", content: [thinking, tool] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "noop result", is_error: false, cache_control: { type: "ephemeral", ...(process.env.PI_CACHE_RETENTION === "long" ? { ttl: "1h" } : {}) } }] },
    { role: "system", content: [], output_config: { effort: "high" } },
  ];
  assert.deepEqual(replay.body.messages, expectedMessages);
  assert.deepEqual(replay.body.system, agent.body.system);
  assert.deepEqual(replay.body.tools, agent.body.tools);
  assert.ok((await h.status()).includes("Native replay: active (anthropic)"));
  assert.equal(branch.filter((e) => e.type === "custom" && e.customType === "preceding-boundary").length, 2);
  assert.equal(branch.filter((e) => e.type === "custom" && e.customType === CAPABILITY_ENTRY).length, 1);
  assert.deepEqual(h.statuses, [{ key: "pi-pleat", text: "compacting…" }, { key: "pi-pleat", text: undefined }]);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.mock.errors, []);
});

test("a second native compaction compacts the exact block-prefixed request and replaces the previous block", testOptions, async (t) => {
  let round = 0;
  const h = await fixture(t, {
    main(_request, res, index) { sendSse(res, anthropicMessage({ blocks: [thinking, ...textReply("done")], input: index < 2 ? 10000 : 100, extra: index < 2 ? { context_management: { applied_edits: [{ cleared_input_tokens: 5000 }] } } : {} })); },
    native(_request, res) { sendSse(res, anthropicCompaction({ block: { ...block, content: `Summary ${++round}`, signature: `local-signature-${round}` } })); },
  });
  await h.prompt("First.");
  await h.prompt("Second.");
  await h.prompt("Third.");
  assert.equal(compactions(h).length, 2);
  const [agent1, compact1, agent2, compact2, agent3] = h.mock.requests;
  assert.deepEqual(compact1.body, expectedCompaction(agent1.body));
  assert.deepEqual(compact2.body, expectedCompaction(agent2.body));
  assert.equal(compact2.body.messages[0].content[0].content, "Summary 1");
  assert.deepEqual(agent3.body.messages[0], { role: "assistant", content: [{ ...block, content: "Summary 2", signature: "local-signature-2" }] });
  assert.equal(JSON.stringify(agent3.body.messages).includes("Summary 1"), false);
  const second = compactions(h)[1];
  assert.equal(second.details.firstCoveredEntryId, compactions(h)[0].id);
  assert.equal(h.manager.getBranch().filter((e) => e.type === "custom" && e.customType === CAPABILITY_ENTRY).length, 1);
  assert.deepEqual(h.errors, []);
});

test("live-shaped reserve and default keepRecentTokens allow two consecutive native tool-turn compactions", testOptions, async (t) => {
  let round = 0;
  const h = await fixture(t, {
    settings: { compaction: { enabled: true, modelOverrides: { "anthropic/claude-test": { reserveTokens: 20000 - 3000 } } } },
    main(_request, res, index) {
      sendSse(res, anthropicMessage(index < 2 ? { blocks: [thinking, { ...tool, id: `live-call-${index}` }], stop: "tool_use", input: 3500 + index * 1000 }
        : { blocks: [thinking, ...textReply("done")], input: 100 }));
    },
    native(_request, res) { sendSse(res, anthropicCompaction({ block: { ...block, content: `Summary ${++round}` } })); },
    configure(pi) {
      pi.registerTool({ name: "noop", label: "Noop", description: "Return deterministic fixture output.", parameters: Type.Object({}),
        execute: async () => ({ content: textReply("Synthetic fixture filler.\n".repeat(340)), details: {} }) });
    },
  });
  await h.prompt("Perform two lookups one at a time.");
  assert.equal(h.settingsManager.getCompactionSettings().keepRecentTokens, 20000);
  const entries = compactions(h);
  const kept = h.manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant");
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.details.strategy), ["anthropic", "anthropic"]);
  assert.deepEqual(entries.map((entry) => entry.firstKeptEntryId), kept.slice(0, 2).map((entry) => entry.id));
  assert.equal(nativeRequests(h).length, 2);
  for (const [index, request] of nativeRequests(h).entries()) {
    assert.ok(request.body.max_tokens >= 4096);
    assert.deepEqual(request.body, expectedCompaction(h.mock.requests[index * 2].body));
  }
  assert.deepEqual(nativeRequests(h)[1].body.messages[0].content[0], entries[0].details.native.block);
  assert.equal(h.mock.requests.length, 5);
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.mock.errors, []);
});

test("native eligibility includes a bound max_tokens allowance of exactly 4096", testOptions, async (t) => {
  const h = await fixture(t, { modelOptions: { contextWindow: 20000, maxTokens: 4096 } });
  await h.prompt("Run noop.");
  assert.equal(compactions(h).length, 1);
  assert.equal(compactions(h)[0].details.strategy, "anthropic");
  assert.equal(nativeRequests(h)[0].body.max_tokens, 4096);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.mock.errors, []);
});

test("a kept suffix over the trigger threshold skips native and fallback and keeps history", testOptions, async (t) => {
  const h = await fixture(t, {
    settings: { compaction: { enabled: true, modelOverrides: { "anthropic/claude-test": { reserveTokens: 20000 - 3000 } } },
      "pi-pleat": { fallbackModel: "pleat-test/deterministic" } },
    configure(pi) {
      pi.registerTool({ name: "noop", label: "Noop", description: "Return an oversized kept result.", parameters: Type.Object({}),
        execute: async () => ({ content: textReply("x".repeat(12000)), details: {} }) });
    },
  });
  await h.prompt("Run noop.");
  assert.equal(nativeRequests(h).length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(compactions(h).length, 0);
  assert.equal(h.manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === CAPABILITY_ENTRY), false);
  const result = h.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult");
  assert.equal(result.message.content[0].text.length, 12000);
  assert.ok(h.notifications.some((notification) => notification.text === "Compaction skipped: kept suffix exceeds threshold."));
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.mock.errors, []);
});

test("native replay survives restart and disappears when navigating before its compaction", testOptions, async (t) => {
  const h = await fixture(t);
  await h.prompt("Run noop.");
  const entry = compactions(h)[0];
  const parent = entry.parentId;
  await h.reopen();
  await h.prompt("After restart.");
  assert.deepEqual(h.mock.requests.at(-1).body.messages[0], { role: "assistant", content: [block] });
  assert.ok((await h.status()).includes("Native replay: active (anthropic)"));
  h.manager.branch(parent);
  h.session.refreshContext();
  await h.prompt("Before compaction.");
  assert.equal(h.mock.requests.at(-1).body.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "compaction")), false);
  assert.ok((await h.status()).includes("Native replay: none"));
  assert.deepEqual(h.errors, []);
});

test("switching channels uses the readable summary and sends no native block", testOptions, async (t) => {
  const h = await fixture(t, { replies: [textReply("other channel")] });
  await h.prompt("Run noop.");
  await h.session.setModel(h.modelRuntime.getModel("pleat-test", "deterministic"));
  await h.prompt("Continue elsewhere.");
  const body = h.requests[0];
  assert.ok(JSON.stringify(body.messages).includes("Native summary."));
  assert.equal(JSON.stringify(body.messages).includes(block.signature), false);
  assert.ok((await h.status()).includes("Native replay: not active: channel differs"));
  assert.deepEqual(h.errors, []);
});

test("manual compaction uses native Anthropic and preserves custom instructions in the exact request", testOptions, async (t) => {
  const h = await fixture(t, { enabled: false });
  await h.prompt("Run noop.");
  const last = structuredClone(h.mock.requests.at(-1).body);
  await bounded(h.session.compact("Preserve paths."), "manual native compaction");
  assert.equal(compactions(h).length, 1);
  const expected = expectedCompaction(last);
  expected.instructions = compactionPayload({}, "Preserve paths.").instructions;
  assert.deepEqual(nativeRequests(h)[0].body, expected);
  assert.equal(compactions(h)[0].details.strategy, "anthropic");
  assert.ok(h.events.some((event) => event.type === "compaction_end" && event.result?.details?.strategy === "anthropic"));
  assert.deepEqual(h.errors, []);
});

for (const [name, configured] of [["pi-default", false], ["pi-summary", true]]) {
  test(`unsupported native manual compaction persists capability and uses ${name}`, testOptions, async (t) => {
    const h = await fixture(t, { enabled: false,
      native(_request, res) { sendJson(res, 400, { error: { type: "invalid_request_error", message: "compaction is not supported" } }); },
      replies: [textReply("Configured fallback summary."), textReply("Configured fallback update.")],
      settings: { compaction: { enabled: false, reserveTokens: 5000, keepRecentTokens: 1 }, ...(configured ? { "pi-pleat": { fallbackModel: "pleat-test/deterministic" } } : {}) },
    });
    await h.prompt("Run noop.");
    await bounded(h.session.compact(), "manual unsupported compaction");
    assert.equal(nativeRequests(h).length, 1);
    assert.equal(compactions(h).length, 1);
    assert.equal(compactions(h)[0].details?.strategy, configured ? "pi-summary" : undefined);
    const capability = h.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === CAPABILITY_ENTRY);
    assert.equal(capability.length, 1);
    assert.equal(capability[0].data.status, "unsupported");
    assert.equal(capability[0].data.feature, "anthropic-compaction");
    assert.ok(h.notifications.some((notification) => notification.type === "warning" && notification.text.includes("unsupported")));
    await h.prompt("Continue.");
    await bounded(h.session.compact(), "remembered unsupported compaction");
    assert.equal(nativeRequests(h).length, 1);
    assert.deepEqual(h.errors, []);
  });
}

test("native 529 responses retry twice before a verified result", testOptions, async (t) => {
  let attempts = 0;
  const h = await fixture(t, { native(_request, res) {
    if (++attempts < 3) { res.setHeader("retry-after-ms", "0"); sendJson(res, 529, { error: { type: "overloaded_error", message: "busy" } }); }
    else sendSse(res, anthropicCompaction({ block }));
  } });
  await h.prompt("Run noop.");
  assert.equal(nativeRequests(h).length, 3);
  for (const request of nativeRequests(h)) assert.deepEqual(request.body, nativeRequests(h)[0].body);
  assert.equal(compactions(h).length, 1);
  assert.equal(compactions(h)[0].details.strategy, "anthropic");
  assert.deepEqual(h.errors, []);
});

test("aborting a native request discards its candidate without a fallback or capability record", testOptions, async (t) => {
  const entered = Promise.withResolvers();
  const h = await fixture(t, { native(_request, res) { entered.resolve(res); } });
  const prompt = h.prompt("Run noop.");
  const res = await bounded(entered.promise, "native request start");
  await bounded(h.session.abort(), "abort native");
  res.destroy();
  await prompt;
  assert.equal(compactions(h).length, 0);
  assert.equal(h.manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === CAPABILITY_ENTRY), false);
  assert.equal(h.mock.requests.length, 2);
  assert.deepEqual(h.errors, []);
});

test("state changes after the native request discard candidates and do not start fallback requests", testOptions, async (t) => {
  let h;
  h = await fixture(t, { native(_request, res) {
    h.manager.appendCustomEntry("changed-during-request", true);
    sendSse(res, anthropicCompaction({ block }));
  } });
  await h.prompt("Run noop.");
  assert.equal(compactions(h).length, 0);
  assert.equal(h.manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === CAPABILITY_ENTRY), false);
  assert.equal(nativeRequests(h).length, 1);
  assert.ok(h.notifications.some((notification) => notification.text.includes("state changed")));
  assert.deepEqual(h.errors, []);
});

test("a second projected system message uses fallback with the system-changed reason", testOptions, async (t) => {
  const h = await fixture(t, { enabled: false });
  await h.prompt("Run noop.");
  h.manager.appendMessage({ role: "system", content: "Additional instruction.", timestamp: 0 });
  h.manager.appendMessage({ role: "user", content: "New work.", timestamp: 0 });
  h.session.refreshContext();
  assert.equal(buildSessionProjection(h.manager.getBranch()).messages.filter((message) => message.role === "system").length, 2);
  await bounded(h.session.compact(), "system changed compaction");
  assert.equal(nativeRequests(h).length, 0);
  assert.equal(compactions(h).length, 1);
  assert.ok(h.notifications.some((notification) => notification.text.includes("system-changed")));
  assert.deepEqual(h.errors, []);
});

test("native integrity failure never commits a compaction and reports the rejection", testOptions, async (t) => {
  const h = await fixture(t, { native(_request, res) { sendSse(res, anthropicCompaction({ block, omitStop: true })); } });
  await h.prompt("Run noop.");
  assert.equal(compactions(h).length, 0);
  assert.equal(nativeRequests(h).length, 1);
  assert.ok(h.notifications.some((notification) => notification.type === "warning" && notification.text.includes("integrity")));
  assert.equal(h.manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === CAPABILITY_ENTRY), false);
  assert.deepEqual(h.errors, []);
});

test("native refusal uses a text fallback without disabling native capability", testOptions, async (t) => {
  const h = await fixture(t, { native(_request, res) { sendSse(res, anthropicCompaction({ block: null, stop: "refusal" })); } });
  await h.prompt("Run noop.");
  assert.equal(compactions(h).length, 1);
  assert.equal(compactions(h)[0].details.strategy, "pi-summary");
  assert.equal(compactions(h)[0].details.reason, "native compaction no-summary");
  assert.equal(h.manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === CAPABILITY_ENTRY), false);
  assert.ok(h.notifications.some((notification) => notification.text.includes("no-summary")));
  assert.deepEqual(h.errors, []);
});

test("replay rejects a changed kept assistant and reports its reason for the current branch", testOptions, async (t) => {
  const h = await fixture(t);
  await h.prompt("Run noop.");
  const entry = compactions(h)[0];
  const kept = h.manager.getEntry(entry.firstKeptEntryId).message;
  h.manager.appendContextEdit(entry.firstKeptEntryId, { content: kept.content.map((part) => part.type === "thinking" ? { ...part, thinkingSignature: "different-local-signature" } : part) });
  h.session.refreshContext();
  await h.prompt("Continue.");
  assert.ok(JSON.stringify(h.mock.requests.at(-1).body.messages[0]).includes(entry.summary));
  assert.equal(h.mock.requests.at(-1).body.messages[0].content[0].type, "text");
  assert.ok((await h.status()).includes("Native replay: not active: kept assistant identity differs"));
  await h.prompt("Continue again.");
  const status = await h.status();
  assert.equal(status.split("Native replay rejected: kept assistant identity differs.").length - 1, 1);
  assert.equal(status.includes("different-local-signature"), false);
  assert.deepEqual(h.errors, []);
});

test("compaction payload removes only incompatible fields and preserves kept identities", testOptions, () => {
  const original = { model: "claude-test", messages: [{ role: "user", content: "text" }], context_management: {}, stop_sequences: ["stop"], tool_choice: { type: "tool", name: "noop" }, output_config: { format: { type: "json_schema" }, effort: "high" }, system: ["system"], tools: ["tool"], thinking: { type: "adaptive" }, max_tokens: 8000, betas: [COMPACT_BETA, "existing"] };
  const copy = structuredClone(original);
  const expected = { ...copy, output_config: { effort: "high" }, compaction: { type: "summarize" } };
  for (const field of ["context_management", "stop_sequences", "tool_choice"]) delete expected[field];
  assert.deepEqual(compactionPayload(original), expected);
  assert.deepEqual(original, copy);
  assert.equal(compactionPayload(original, " ").instructions, undefined);
  assert.equal(compactionPayload(original, "x".repeat(17000)).instructions.length, 16384);
  for (const type of ["auto", "none"]) assert.deepEqual(compactionPayload({ tool_choice: { type } }).tool_choice, { type });
  assert.deepEqual(keptIdentity({ content: [{ type: "thinking", thinking: "", thinkingSignature: "signed" }, { type: "thinking", thinking: "", redacted: true, thinkingSignature: "redacted" }, { type: "toolCall", id: "call" }] }), { signatures: ["signed", "redacted"], toolUseIds: ["call"] });
});

test("native parser rejects incomplete or altered blocks and reads complete raw SSE despite Pi normalization", testOptions, async (t) => {
  let scripted;
  const h = await fixture(t, { enabled: false, native(_request, res) { sendSse(res, scripted); } });
  const request = () => requestCompaction({ ctx: h.ctx, model: h.model, payload: { model: h.model.id, messages: [{ role: "user", content: "compact" }], max_tokens: 1000, stream: true, compaction: { type: "summarize" }, betas: [COMPACT_BETA] }, signal: t.signal });
  scripted = anthropicCompaction({ block });
  assert.deepEqual(await request(), { ok: true, block, usage: { input: 300, output: 50, cacheRead: 30, cacheWrite: 40, totalTokens: 420, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  for (const mutate of [
    (events) => events.slice(0, -1),
    (events) => events.filter((event) => event.type !== "content_block_stop"),
    (events) => events.map((event) => event.type === "content_block_start" ? { ...event, content_block: { ...block, signature: "" } } : event),
    (events) => [events[0], ...events],
    (events) => [events[0], events[1], { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "altered" } }, ...events.slice(2)],
    (events) => [...events.slice(0, 3), { type: "content_block_start", index: 1, content_block: block }, { type: "content_block_stop", index: 1 }, ...events.slice(3)],
    (events) => events.map((event) => event.type === "message_delta" ? { ...event, delta: { stop_reason: "unknown" } } : event),
  ]) {
    scripted = mutate(anthropicCompaction({ block }));
    assert.equal((await request()).kind, "invalid");
  }
  for (const stop of ["max_tokens", "model_context_window_exceeded", "tool_use", "refusal", "end_turn"]) {
    scripted = anthropicCompaction({ block: null, stop });
    assert.equal((await request()).kind, "no-summary");
  }
  scripted = anthropicCompaction({ block, iterations: [
    { type: "compaction", input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 },
    { type: "message", input_tokens: 10000, output_tokens: 10000 },
    { type: "compaction", input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 10 },
  ] });
  assert.equal((await request()).usage.totalTokens, 420);
  scripted = anthropicCompaction({ block });
  delete scripted.at(-2).usage.iterations;
  assert.equal((await request()).usage, undefined);
  assert.deepEqual(h.mock.errors, []);
});

test("unsupported native turn_end compaction commits its capability with a text fallback", testOptions, async (t) => {
  const h = await fixture(t, { native(_request, res) { sendJson(res, 400, { error: { type: "invalid_request_error", message: "compaction unsupported" } }); } });
  await h.prompt("Run noop.");
  const [entry] = compactions(h);
  assert.equal(compactions(h).length, 1);
  assert.equal(entry.details.strategy, "pi-summary");
  assert.equal(entry.details.reason, "native compaction unsupported");
  const capability = h.manager.getBranch().find((candidate) => candidate.type === "custom" && candidate.customType === CAPABILITY_ENTRY);
  assert.equal(capability.data.feature, "anthropic-compaction");
  assert.equal(capability.data.status, "unsupported");
  assert.ok(h.manager.getBranch().indexOf(capability) < h.manager.getBranch().indexOf(entry));
  assert.deepEqual(h.errors, []);
});

test("transient native failures stop after three retries and use fallback", testOptions, async (t) => {
  const h = await fixture(t, { native(_request, res) { res.setHeader("retry-after-ms", "0"); sendJson(res, 529, { error: { type: "overloaded_error", message: "busy" } }); } });
  await h.prompt("Run noop.");
  assert.equal(nativeRequests(h).length, 4);
  assert.equal(compactions(h).length, 1);
  assert.equal(compactions(h)[0].details.strategy, "pi-summary");
  assert.equal(compactions(h)[0].details.reason, "native compaction transient");
  assert.deepEqual(h.errors, []);
});

test("native backoff is abortable and cannot start a retry after cancellation", testOptions, async (t) => {
  const failed = Promise.withResolvers();
  const h = await fixture(t, { native(_request, res) {
    res.setHeader("retry-after-ms", "30000");
    sendJson(res, 529, { error: { type: "overloaded_error", message: "busy" } });
    failed.resolve();
  } });
  const prompt = h.prompt("Run noop.");
  await bounded(failed.promise, "first native failure");
  await bounded(h.session.abort(), "abort native backoff");
  await prompt;
  assert.equal(nativeRequests(h).length, 1);
  assert.equal(compactions(h).length, 0);
  assert.equal(h.mock.requests.length, 2);
  assert.deepEqual(h.errors, []);
});

test("a real one-token agent request cannot bind its reply to a stale native prefix", testOptions, async (t) => {
  const h = await fixture(t, { enabled: false, modelOptions: { contextWindow: 10000 },
    settings: { compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 } },
    main(_request, res, index) { sendSse(res, anthropicMessage(index === 0 ? { blocks: [thinking, tool], stop: "tool_use", input: 9000 } : { blocks: [thinking, ...textReply("completed")] })); },
  });
  await h.prompt("Run noop.");
  assert.equal(h.mock.requests[1].body.max_tokens, 1);
  const firstAssistant = h.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant");
  await bounded(h.session.compact(), "clamped agent compaction");
  assert.equal(compactions(h)[0].firstKeptEntryId, firstAssistant.id);
  assert.deepEqual(nativeRequests(h)[0].body, expectedCompaction(h.mock.requests[0].body));
  assert.deepEqual(h.errors, []);
});

test("native HTTP and stream failures distinguish unsupported, transient, and invalid outcomes", testOptions, async (t) => {
  let status = 404, message = "unavailable", events;
  const h = await fixture(t, { enabled: false, native(_request, res) {
    if (status === 200) sendSse(res, events);
    else { res.setHeader("retry-after", "2"); sendJson(res, status, { error: { type: "invalid_request_error", message } }); }
  } });
  const request = () => requestCompaction({ ctx: h.ctx, model: h.model, signal: t.signal,
    payload: { model: h.model.id, messages: [{ role: "user", content: "compact" }], compaction: { type: "summarize" }, max_tokens: 1000, betas: [COMPACT_BETA] } });
  for (const [code, text, kind] of [[404, "missing", "unsupported"], [400, "compaction unsupported", "unsupported"], [400, "unrelated invalid request", "invalid"], [401, "unauthorized", "invalid"], [403, "forbidden", "invalid"], [429, "busy", "transient"], [500, "busy", "transient"], [502, "busy", "transient"], [503, "busy", "transient"], [504, "busy", "transient"], [529, "busy", "transient"]]) {
    status = code; message = text;
    const result = await request();
    assert.equal(result.kind, kind);
    if (kind === "transient") assert.equal(result.retryAfter, 2000);
  }
  status = 200;
  for (const [type, kind] of [["overloaded_error", "transient"], ["api_error", "transient"], ["authentication_error", "invalid"]]) {
    events = [{ type: "error", error: { type, message: "stream failure" } }];
    assert.equal((await request()).kind, kind);
  }
  assert.deepEqual(h.mock.errors, []);
});


test("registry setup failure before fetch is invalid and preserves history", testOptions, async (t) => {
  const h = await fixture(t, { enabled: false });
  const result = await requestCompaction({ ctx: h.ctx, model: { ...h.model, provider: "missing-native-provider" }, payload: {}, signal: t.signal });
  assert.equal(result.kind, "invalid");
  assert.equal(h.mock.requests.length, 0);
  assert.equal(compactions(h).length, 0);
});

test("a real fetch failure is transient", testOptions, async (t) => {
  const h = await fixture(t, { enabled: false, native(_request, res) { res.destroy(); } });
  const result = await requestCompaction({ ctx: h.ctx, model: h.model, payload: { model: h.model.id, messages: [{ role: "user", content: "compact" }], compaction: { type: "summarize" }, max_tokens: 1000 }, signal: t.signal });
  assert.equal(result.kind, "transient");
  assert.equal(nativeRequests(h).length, 1);
});

test("native Anthropic compaction checks the replacement and kept context before committing", testOptions, async (t) => {
  const h = await fixture(t, { enabled: false, native(_request, res) {
    sendSse(res, anthropicCompaction({ block: { ...block, content: "x".repeat(80000) } }));
  } });
  await h.prompt("Run noop.");
  const before = structuredClone(h.manager.getBranch());
  await assert.rejects(bounded(h.session.compact(), "reject oversized native context"), /cancel/i);
  assert.deepEqual(h.manager.getBranch(), before);
  assert.equal(nativeRequests(h).length, 1);
  assert.equal(compactions(h).length, 0);
  assert.ok(h.notifications.some((notice) => notice.text === "Compaction skipped: compacted context does not fit the window."));
  assert.deepEqual(h.errors, []);
});

test("native Anthropic HTTP errors retain their classification and retry headers when the body is truncated", testOptions, async (t) => {
  let status = 401;
  const h = await fixture(t, { enabled: false, native(_request, res) {
    res.writeHead(status, { "content-type": "application/json", "content-length": 1000, connection: "close",
      "retry-after-ms": "invalid", "retry-after": "2" });
    res.end("{}");
  } });
  const args = { ctx: h.ctx, model: h.model, signal: t.signal,
    payload: { model: h.model.id, messages: [{ role: "user", content: "compact" }], compaction: { type: "summarize" }, max_tokens: 1000 } };
  for (const [code, kind] of [[401, "invalid"], [403, "invalid"], [404, "unsupported"], [400, "invalid"], [429, "transient"], [503, "transient"], [200, "transient"]]) {
    status = code;
    const result = await requestCompaction(args);
    assert.equal(result.kind, kind);
    if (kind === "transient") assert.equal(result.retryAfter, 2000);
  }
  assert.equal(compactions(h).length, 0);
  assert.deepEqual(h.mock.errors, []);
});

test("native Anthropic usage requires valid input and output counts in every compaction iteration", testOptions, async (t) => {
  let iterations;
  const h = await fixture(t, { enabled: false, native(_request, res) { sendSse(res, anthropicCompaction({ block, iterations })); } });
  const request = () => requestCompaction({ ctx: h.ctx, model: h.model, signal: t.signal,
    payload: { model: h.model.id, messages: [{ role: "user", content: "compact" }], compaction: { type: "summarize" }, max_tokens: 1000 } });
  for (const key of ["input_tokens", "output_tokens"]) {
    for (const invalid of [undefined, null, "10", -1, Infinity]) {
      iterations = [{ type: "compaction", input_tokens: 10, output_tokens: 2 }, { type: "compaction", input_tokens: 20, output_tokens: 3, [key]: invalid }];
      const result = await request();
      assert.equal(result.ok, true);
      assert.equal(result.usage, undefined);
    }
  }
  iterations = [{ type: "compaction", input_tokens: 0, output_tokens: 0 }];
  const zero = await request();
  assert.equal(zero.ok, true);
  assert.equal(zero.usage.totalTokens, 0, "Explicit valid zeros remain known usage");
  assert.deepEqual(h.mock.errors, []);
});

test("a native compaction with missing usage reports unknown totals after restart", testOptions, async (t) => {
  const h = await fixture(t, { native(_request, res) {
    sendSse(res, anthropicCompaction({ block, iterations: [{ type: "compaction", output_tokens: 50 }] }));
  } });
  await h.prompt("Run noop.");
  assert.equal(compactions(h).length, 1);
  assert.equal(compactions(h)[0].usage, undefined);
  assert.equal(readPleatDetails(compactions(h)[0]).usageComplete, false);
  assert.ok((await h.status()).includes("usage unknown in / unknown out · $unknown"));
  await h.reopen();
  assert.equal(compactions(h)[0].usage, undefined);
  assert.equal(readPleatDetails(compactions(h)[0]).usageComplete, false);
  assert.ok((await h.status()).includes("usage unknown in / unknown out · $unknown"));
});
