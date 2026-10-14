import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Type } from "typebox";
import { buildSessionProjection, estimateTokens } from "@earendil-works/pi-coding-agent";
import { limitsFor } from "../src/budget.ts";
import { isAnthropic, isClearingUnsupported, readAppliedEdits, withClearing, CONTEXT_MANAGEMENT_BETA } from "../src/providers/anthropic.ts";
import { CAPABILITY_ENTRY, channelKey, channelOf, readCapabilities } from "../src/session.ts";
import { anthropicMessage, createHarness, sendJson, sendSse, startAnthropicMock, testOptions, textReply } from "./harness.mjs";

const clearing = (thinking = true) => ({ edits: [
  ...(thinking ? [{ type: "clear_thinking_20251015", keep: "all" }] : []),
  { type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 9500 }, keep: { type: "tool_uses", value: 8 }, clear_at_least: { type: "input_tokens", value: 1900 }, clear_tool_inputs: false },
] });

async function mockHarness(t, handler, options = {}) {
  const mock = await startAnthropicMock(handler);
  t.after(() => mock.close());
  const h = await createHarness(t, { mock, ...options });
  h.mock = mock;
  return h;
}

test("Anthropic clearing reaches the real adapter's HTTP body without changing prompt, tools, or thinking", testOptions, async (t) => {
  let original;
  const h = await mockHarness(t, (_request, res) => sendSse(res, anthropicMessage()), {
    configure(pi) {
      pi.on("before_provider_request", (event) => {
        original = event.payload;
        assert.deepEqual(event.payload.context_management, clearing());
      });
    },
  });
  await h.prompt("Reply.");
  assert.equal(h.mock.requests.length, 1);
  const request = h.mock.requests[0];
  assert.deepEqual(request.body.context_management, clearing());
  assert.ok(request.headers["anthropic-beta"].split(",").includes(CONTEXT_MANAGEMENT_BETA));
  for (const field of ["messages", "system", "tools", "thinking", "output_config"]) {
    assert.deepEqual(request.body[field], original[field] === undefined ? undefined : JSON.parse(JSON.stringify(original[field])), `HTTP preserves ${field}`);
  }
  assert.equal(request.body.compaction, undefined);
  assert.ok(request.body.tools.some((tool) => tool.name === "recall"));
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.mock.errors, []);
});

test("Anthropic clearing is immutable, deduplicates betas, and omits thinking edits when thinking is disabled", testOptions, () => {
  const limits = limitsFor({ contextWindow: 20000, provider: "anthropic", id: "claude-test" }, { compaction: { reserveTokens: 1000 } });
  const original = { model: "claude-test", messages: [], thinking: { type: "adaptive" }, betas: ["existing", CONTEXT_MANAGEMENT_BETA, "existing"] };
  const copy = structuredClone(original);
  Object.freeze(original.betas);
  Object.freeze(original.thinking);
  Object.freeze(original);
  assert.deepEqual(withClearing(original, limits).context_management, clearing());
  assert.deepEqual(withClearing(original, limits).betas, ["existing", CONTEXT_MANAGEMENT_BETA]);
  assert.deepEqual(original, copy);
  for (const payload of [{ messages: [] }, { messages: [], thinking: { type: "disabled" } }]) {
    assert.deepEqual(withClearing(payload, limits).context_management, clearing(false));
  }
  const external = { ...copy, context_management: { edits: [] } };
  assert.equal(withClearing(external, limits), external);
  const compaction = { ...copy, compaction: { type: "summarize" } };
  assert.equal(withClearing(compaction, limits), compaction);
  assert.equal(isAnthropic({ provider: "anthropic", api: "anthropic-messages" }), true);
  assert.equal(isAnthropic({ provider: "proxy", api: "anthropic-messages" }), false);
  assert.equal(isAnthropic({ provider: "anthropic", api: "openai-responses" }), false);
});

test("an existing Anthropic clearing configuration stays unchanged and is reported once", testOptions, async (t) => {
  const external = { edits: [{ type: "clear_tool_uses_20250919", keep: { type: "tool_uses", value: 20 } }] };
  const h = await mockHarness(t, (_request, res) => sendSse(res, anthropicMessage()), {
    before(pi) { pi.on("before_provider_request", (event) => ({ ...event.payload, context_management: external })); },
  });
  await h.prompt("First.");
  await h.prompt("Second.");
  for (const request of h.mock.requests) {
    assert.deepEqual(request.body.context_management, external);
    assert.equal(request.headers["anthropic-beta"].includes(CONTEXT_MANAGEMENT_BETA), false);
  }
  const status = await h.status();
  assert.equal(status.split("Existing context_management configuration kept.").length - 1, 1);
  assert.deepEqual(h.errors, []);
});

test("applied edits are counted per response, raw tokens add cleared input, and session stats reset on reopen", testOptions, async (t) => {
  const h = await mockHarness(t, (_request, res, index) => sendSse(res, anthropicMessage({
    input: 100, output: 20, cacheRead: 30, cacheWrite: 40,
    extra: index === 0 ? { context_management: { applied_edits: [
      { type: "clear_thinking_20251015", cleared_input_tokens: 10 },
      { type: "clear_tool_uses_20250919", cleared_tool_uses: 2, cleared_input_tokens: 777 },
    ] } } : {},
  })), { before(pi) { pi.on("message_end", (event) => event.message.role === "assistant" ? { message: structuredClone(event.message) } : undefined); } });
  await h.prompt("First response.");
  let status = await h.status();
  assert.ok(status.includes("Context: 190 of 20000 tokens (0.9%) · raw 977 (Anthropic)"), status);
  assert.ok(status.includes("Clearing: server-side, 2 applied, 787 tokens this session"));
  await h.prompt("Second response.");
  status = await h.status();
  assert.ok(status.includes("raw 190 (Anthropic)"));
  assert.ok(status.includes("2 applied, 787 tokens this session"));
  await h.reopen();
  status = await h.status();
  const raw = buildSessionProjection(h.manager.getBranch()).messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  assert.ok(status.includes(`estimated · raw ${raw} (Anthropic)`), status);
  assert.ok(status.includes("0 applied, 0 tokens this session"));
  assert.deepEqual(h.errors, []);
});

test("applied-edit parsing ignores unrelated events and does not invent missing token counts", testOptions, () => {
  assert.equal(readAppliedEdits({ type: "message_start", message: { context_management: { applied_edits: [] } } }), undefined);
  assert.equal(readAppliedEdits({ type: "message_delta" }), undefined);
  assert.equal(readAppliedEdits(null), undefined);
  assert.deepEqual(readAppliedEdits({ type: "message_delta", context_management: { applied_edits: [] } }), { clearedInput: 0, appliedEdits: 0 });
  assert.deepEqual(readAppliedEdits({ type: "message_delta", context_management: { applied_edits: [
    { cleared_input_tokens: 50 }, { cleared_input_tokens: 25 }, { type: "clear_thinking_20251015" },
  ] } }), { clearedInput: 75, appliedEdits: 3 });
  assert.deepEqual(readAppliedEdits({ type: "message_delta", context_management: { applied_edits: [{ cleared_input_tokens: -5 }, { cleared_input_tokens: "5" }] } }), { clearedInput: 0, appliedEdits: 2 });
});

test("unsupported Anthropic clearing gets one persisted recovery request and stays disabled after reopen", testOptions, async (t) => {
  const h = await mockHarness(t, (request, res, index) => {
    if (index === 0) {
      assert.deepEqual(request.body.context_management, clearing());
      sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "context_management not supported" } });
    } else {
      assert.equal(request.body.context_management, undefined);
      sendSse(res, anthropicMessage());
    }
  }, {
    before(pi) { pi.on("message_end", (event) => event.message.role === "assistant" ? { message: structuredClone(event.message) } : undefined); pi.on("agent_before_settle", (event) => ({ entries: [...event.entries, { type: "custom", customType: "preceding-settle", data: "kept" }] })); },
  });
  await h.prompt("Normal request.");
  assert.equal(h.mock.requests.length, 2);
  const [initial, recovery] = h.mock.requests;
  assert.deepEqual(recovery.body.messages, initial.body.messages);
  assert.deepEqual(recovery.body.system, initial.body.system);
  assert.deepEqual(recovery.body.tools, initial.body.tools);
  assert.deepEqual(recovery.body.thinking, initial.body.thinking);
  assert.equal(recovery.headers["anthropic-beta"].includes(CONTEXT_MANAGEMENT_BETA), false);
  const branch = h.manager.getBranch();
  const capability = branch.filter((entry) => entry.type === "custom" && entry.customType === CAPABILITY_ENTRY);
  assert.equal(capability.length, 1);
  const key = channelKey(channelOf(h.model));
  assert.equal(readCapabilities(branch).get(`${key}#clearing`).status, "unsupported");
  const edits = branch.filter((entry) => entry.type === "context_edit");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].replacement, null);
  const failed = h.manager.getEntry(edits[0].targetId);
  assert.equal(failed.message.stopReason, "error");
  assert.equal(h.manager.buildSessionContext().messages.some((message) => message.role === "assistant" && message.stopReason === "error"), false);
  assert.equal(branch.some((entry) => entry.type === "compaction"), false);
  assert.equal(branch.filter((entry) => entry.type === "custom" && entry.customType === "preceding-settle").length, 2);
  assert.ok((await h.status()).includes("Capabilities: clearing unsupported"));
  const file = await readFile(h.manager.getSessionFile(), "utf8");
  assert.equal(file.includes("local-test-key"), false);
  await h.reopen();
  await h.prompt("Another request.");
  assert.equal(h.mock.requests.length, 3);
  assert.equal(h.mock.requests[2].body.context_management, undefined);
  assert.equal(h.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === CAPABILITY_ENTRY).length, 1);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.mock.errors, []);
});

test("a second clearing-related failure cannot start a recovery loop", testOptions, async (t) => {
  const h = await mockHarness(t, (_request, res) => sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "context_management unsupported" } }));
  await h.prompt("Request.");
  assert.equal(h.mock.requests.length, 2);
  assert.equal(h.mock.requests[1].body.context_management, undefined);
  assert.equal(h.manager.getBranch().filter((entry) => entry.type === "context_edit").length, 1);
  assert.equal(h.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === CAPABILITY_ENTRY).length, 1);
  assert.equal(h.manager.getBranch().some((entry) => entry.type === "compaction"), false);
  assert.deepEqual(h.errors, []);
});

test("non-clearing errors do not disable clearing or force a retry", testOptions, async (t) => {
  const h = await mockHarness(t, (_request, res) => sendJson(res, 401, { type: "error", error: { type: "authentication_error", message: "Invalid local credentials" } }));
  await h.prompt("Request.");
  assert.equal(h.mock.requests.length, 1);
  assert.equal(h.manager.getBranch().some((entry) => entry.type === "context_edit" || entry.type === "custom" && entry.customType === CAPABILITY_ENTRY), false);
  for (const message of ["context_management rate limit", "unsupported model", "network failure", undefined]) assert.equal(isClearingUnsupported(message), false);
  for (const message of ["context-management invalid beta", "clear_tool_uses unknown", "clear_thinking does not support", "CONTEXT_MANAGEMENT Extra inputs are not permitted"]) assert.equal(isClearingUnsupported(message), true);
  assert.deepEqual(h.errors, []);
});

test("Anthropic tool results stay intact even when reported usage exceeds the local clearing trigger", testOptions, async (t) => {
  const h = await mockHarness(t, (_request, res, index) => sendSse(res, anthropicMessage({
    input: 10000,
    blocks: index === 0 ? Array.from({ length: 12 }, (_, number) => ({ type: "tool_use", id: `anthropic-call-${number}`, name: "output", input: {} })) : textReply("done"),
    stop: index === 0 ? "tool_use" : "end_turn",
  })), {
    tools: ["recall", "output"],
    configure(pi) { pi.registerTool({ name: "output", label: "Output", description: "Return fixed output.", parameters: Type.Object({}), execute: async () => ({ content: textReply("x".repeat(5000)), details: {} }) }); },
  });
  await h.prompt("Run tools.");
  assert.equal(h.mock.requests.length, 2);
  assert.equal(h.manager.getBranch().some((entry) => entry.type === "context_edit"), false);
  const results = h.mock.requests[1].body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((part) => part.type === "tool_result");
  assert.equal(results.length, 12);
  assert.ok(results.every((part) => part.content === "x".repeat(5000)));
  assert.deepEqual(h.errors, []);
});

test("request routing and compaction payloads do not receive clearing", testOptions, async (t) => {
  for (const change of [(payload) => ({ ...payload, model: "routed-model" }), (payload) => ({ ...payload, compaction: { type: "summarize" } })]) {
    const h = await mockHarness(t, (_request, res) => sendSse(res, anthropicMessage()), {
      before(pi) { pi.on("before_provider_request", (event) => change(event.payload)); },
    });
    await h.prompt("Request.");
    assert.equal(h.mock.requests[0].body.context_management, undefined);
    assert.equal(h.mock.requests[0].headers["anthropic-beta"].includes(CONTEXT_MANAGEMENT_BETA), false);
    assert.deepEqual(h.errors, []);
  }
});
