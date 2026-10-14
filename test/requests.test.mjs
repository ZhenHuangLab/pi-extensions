import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionProjection, convertToLlm, estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import piPleat from "../src/index.ts";
import { createResponseObserver, createSessionStats, limitsFor } from "../src/budget.ts";
import { applyReplay, createRequests } from "../src/requests.ts";
import { canonicalJson, channelOf, sha256 } from "../src/session.ts";
import { appendTool, assertCompactionReplays, assistant, testOptions, textReply, usage } from "./harness.mjs";

const model = { provider: "anthropic", api: "anthropic-messages", id: "claude-test", baseUrl: "https://example.invalid", contextWindow: 10000, reasoning: true, maxTokens: 1000 };
const block = { type: "compaction", content: "Readable summary.", signature: "local-compaction-signature" };
function replayFixture(kind = "anthropic") {
  const selected = kind === "anthropic" ? model : { ...model, provider: "openai", api: "openai-responses" };
  const native = kind === "anthropic" ? { kind, block, systemHash: sha256(canonicalJson(["system"])), toolsHash: sha256(canonicalJson(["tools"])), keptSignatures: ["local-thinking", "local-redacted"], keptToolUseIds: ["call"] }
    : { kind: "responses-trigger", window: [{ role: "user", content: [{ type: "input_text", text: "retained" }] }, { type: "compaction", encrypted_content: "local-state", id: "compact" }] };
  const entry = { id: "compact", type: "compaction", summary: block.content, firstKeptEntryId: "kept", tokensBefore: 100,
    details: { plugin: "pi-pleat", version: 1, strategy: kind === "anthropic" ? kind : "responses-trigger", ...channelOf(selected), firstCoveredEntryId: "first", lastCoveredEntryId: "last", firstKeptEntryId: "kept", native } };
  const expected = convertToLlm([{ role: "compactionSummary", summary: entry.summary, tokensBefore: 100, timestamp: 0 }])[0].content[0].text;
  const kept = { role: "assistant", content: [{ type: "thinking", thinking: "local reasoning", signature: "local-thinking" }, { type: "redacted_thinking", data: "local-redacted" }, { type: "tool_use", id: "call", name: "noop", input: {} }] };
  const effort = { role: "system", content: [], output_config: { effort: "high" } };
  const payload = kind === "anthropic" ? { model: selected.id, system: ["system"], tools: ["tools"], messages: [{ role: "user", content: [{ type: "text", text: expected, cache_control: { type: "ephemeral" } }] }, effort, kept, { role: "user", content: "suffix" }] }
    : { model: selected.id, input: [{ role: "user", content: [{ type: "input_text", text: expected }] }, { role: "assistant", content: [{ type: "output_text", text: "kept" }] }] };
  return { model: selected, entry, payload, kept, expected };
}

test("requests bind replacement assistant objects by sequence, ignore warmer snapshots, and require the current branch and channel", testOptions, () => {
  const requests = createRequests();
  const manager = SessionManager.inMemory();
  const message = assistant();
  const id = manager.appendMessage(message);
  const payload = { model: model.id, max_tokens: 1000, messages: ["main"] };
  requests.record(payload, channelOf(model));
  requests.record({ model: model.id, max_tokens: 1, messages: ["warm"] }, channelOf(model));
  requests.onMessageEnd(message);
  requests.onMessageEnd({ role: "toolResult" });
  requests.onTurnEnd({ message: structuredClone(message), messageEntryId: id });
  assert.deepEqual(requests.boundary(manager.getBranch(), model), { snapshot: { payload, channel: channelOf(model) }, assistantEntryId: id });
  payload.messages[0] = "mutated caller";
  assert.equal(requests.boundary(manager.getBranch(), model).snapshot.payload.messages[0], "main");
  assert.equal(requests.boundary([], model), undefined);
  assert.equal(requests.boundary(manager.getBranch(), { ...model, baseUrl: "https://another.invalid" }), undefined);
  requests.record({ model: model.id, max_tokens: 1, messages: ["real clamped request"] }, channelOf(model));
  requests.onMessageEnd(message);
  requests.onTurnEnd({ message, messageEntryId: "new-clamped-reply" });
  assert.equal(requests.boundary(manager.getBranch(), model).assistantEntryId, id);
  requests.record({ messages: ["failed"] }, channelOf(model));
  requests.onMessageEnd({ ...message, stopReason: "error" });
  requests.onTurnEnd({ message, messageEntryId: "wrong" });
  assert.equal(requests.boundary(manager.getBranch(), model).assistantEntryId, id);
});

test("Anthropic replay validates summary, effort markers, exact kept identities and hashes without mutating input", testOptions, () => {
  const f = replayFixture();
  const original = structuredClone(f.payload);
  const result = applyReplay(f.payload, f.model, [f.entry]);
  assert.equal(result.state, "applied");
  assert.deepEqual(result.payload.messages, [{ role: "assistant", content: [block] }, f.kept, { role: "user", content: "suffix" }]);
  assert.deepEqual(f.payload, original);
  result.payload.messages[0].content[0].content = "changed copy";
  assert.deepEqual(f.entry.details.native.block, block);
  const string = { ...f.payload, messages: [{ role: "user", content: f.expected }, ...f.payload.messages.slice(1)] };
  assert.equal(applyReplay(string, f.model, [f.entry]).state, "applied");
  for (const [change, reason] of [
    [(p) => { p.messages[0].content[0].text = "wrong"; }, "summary differs"],
    [(p) => { p.messages[1].content = [{ type: "text", text: "real system change" }]; }, "kept assistant missing"],
    [(p) => { p.messages[2].content[0].signature = "different"; }, "kept assistant identity differs"],
    [(p) => { p.messages[2].content[2].id = "different"; }, "kept assistant identity differs"],
    [(p) => { p.system = []; }, "system differs"],
    [(p) => { p.tools = []; }, "tools differ"],
  ]) {
    const payload = structuredClone(f.payload);
    change(payload);
    const rejected = applyReplay(payload, f.model, [f.entry]);
    assert.equal(rejected.state, "rejected");
    assert.equal(rejected.reason, reason);
    assert.equal(rejected.payload, payload);
  }
  assert.equal(applyReplay(f.payload, { ...f.model, provider: "other" }, [f.entry]).reason, "channel differs");
  assert.equal(applyReplay(f.payload, f.model, []).state, "none");
  const latest = { ...f.entry, id: "newer", details: undefined };
  assert.equal(applyReplay(f.payload, f.model, [f.entry, latest]).state, "none");
});

test("Responses replay substitutes an exact native window, preserves suffix, and rejects a summary mismatch", testOptions, () => {
  const f = replayFixture("responses-trigger");
  const original = structuredClone(f.payload);
  const result = applyReplay(f.payload, f.model, [f.entry]);
  assert.equal(result.state, "applied");
  assert.deepEqual(result.payload.input, [...f.entry.details.native.window, f.payload.input[1]]);
  assert.deepEqual(f.payload, original);
  result.payload.input[1].encrypted_content = "modified copy";
  assert.equal(f.entry.details.native.window[1].encrypted_content, "local-state");
  const wrong = structuredClone(f.payload);
  wrong.input[0].content[0].text = "wrong";
  assert.deepEqual(applyReplay(wrong, f.model, [f.entry]), { payload: wrong, state: "rejected", reason: "summary differs" });
  assert.equal(applyReplay(f.payload, { ...f.model, baseUrl: "https://other.invalid" }, [f.entry]).state, "none");
  assert.equal(applyReplay({ messages: [] }, f.model, [f.entry]).reason, "payload shape differs");
});

test("overlapping cache-warm stream edits count only toward totals while unambiguous edits bind by responseId", testOptions, () => {
  const stats = createSessionStats();
  const observer = createResponseObserver(stats);
  const start = (id) => observer.observe({ type: "message_start", message: { id } });
  const delta = (clearedInput) => observer.observe({ type: "message_delta" }, { clearedInput, appliedEdits: 1 });
  const stop = () => observer.observe({ type: "message_stop" });
  start("main"); delta(100); start("warm"); delta(900); stop(); delta(800); stop();
  const message = assistant(textReply("done"), { responseId: "main" });
  assert.equal(observer.messageEnd(message).clearedInput, undefined);
  assert.equal(observer.messageEnd({ ...message, responseId: "warm" }).clearedInput, undefined);
  assert.equal(stats.serverClearedTokens, 1800);
  assert.equal(stats.serverClears, 3);
  start("warm-only"); delta(700); stop(); start("main-next"); delta(200); stop();
  assert.equal(observer.messageEnd({ ...message, responseId: "main-next" }).clearedInput, 200);
  assert.equal(observer.messageEnd({ ...message, responseId: undefined }).clearedInput, undefined);
  assert.equal(stats.serverClearedTokens, 2700);
});

test("assistant completion retires unfinished warm streams and their late edits before the next response", testOptions, () => {
  for (const responseId of ["main", undefined]) {
    const stats = createSessionStats();
    const observer = createResponseObserver(stats);
    const start = (id) => observer.observe({ type: "message_start", message: { id } });
    const delta = (clearedInput) => observer.observe({ type: "message_delta" }, { clearedInput, appliedEdits: 1 });
    start("main"); delta(100);
    start("warm-without-stop"); delta(900);
    const ended = observer.messageEnd(assistant(textReply("done"), { responseId }));
    assert.equal(ended.clearedInput, undefined);
    delta(800); // Late warm delta has no active response to bind to.
    start("next"); delta(200);
    observer.observe({ type: "message_stop" });
    assert.equal(observer.messageEnd(assistant(textReply("done"), { responseId: "next" })).clearedInput, undefined);
    observer.observe({ type: "message_stop" });
    observer.observe({ type: "message_stop" }); // Both unfinished streams have now stopped.
    start("clean"); delta(300); observer.observe({ type: "message_stop" });
    assert.equal(observer.messageEnd(assistant(textReply("done"), { responseId: "clean" })).clearedInput, 300);
    assert.equal(observer.messageEnd(assistant(textReply("done"), { responseId: "warm-without-stop" })).clearedInput, undefined);
    assert.equal(stats.serverClearedTokens, 2300);
    assert.equal(stats.serverClears, 5);
  }
});

function driver(selected, manager = SessionManager.inMemory()) {
  const handlers = new Map(), commands = new Map(), notifications = [];
  const settings = { compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 } };
  const pi = { on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command), registerTool() {}, getSettings: () => settings, getThinkingLevel: () => "off" };
  const ctx = { model: selected, sessionManager: manager, modelRegistry: { find: () => undefined }, ui: { notify: (text) => notifications.push(text), setStatus() {} }, getContextUsage: () => ({ tokens: 190, contextWindow: 10000 }), signal: new AbortController().signal };
  piPleat(pi);
  return { handlers, commands, notifications, ctx };
}

test("all response handlers require a matching physical selection, and virtual /context shows an explicit status", testOptions, async () => {
  const manager = SessionManager.inMemory();
  for (let index = 0; index < 12; index++) appendTool(manager, { id: `call-${index}`, content: textReply("x".repeat(5000)) });
  const physical = { ...model, provider: "pleat-test", api: "pleat-test", id: "deterministic" };
  assert.ok(limitsFor(physical, { compaction: { reserveTokens: 1000 } }).clearTrigger < 10000);
  for (const selected of [undefined, { ...physical, baseUrl: "", contextWindow: 0 }, physical]) {
    const d = driver(selected, manager);
    d.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: 10000 });
    const message = assistant(textReply("routed answer"), { provider: "routed", api: "pleat-test", model: "other", usage: usage(10000) });
    await d.handlers.get("message_end")({ message }, d.ctx);
    const result = await d.handlers.get("turn_end")({ message, messageEntryId: "routed-id", entries: [], outcome: "completed" }, d.ctx);
    assert.equal(result, undefined);
    await d.commands.get("context").handler("", d.ctx);
    if (!selected?.baseUrl) assert.ok(d.notifications.at(-1).includes("no physical model selected"));
  }
});

test("cache-warm payloads do not replace agent stats or request boundaries in event wiring", testOptions, async () => {
  const manager = SessionManager.inMemory();
  const d = driver(model, manager);
  const request = (max_tokens) => d.handlers.get("before_provider_request")({ payload: { model: model.id, messages: [], max_tokens } }, d.ctx);
  const event = (data) => d.handlers.get("provider_stream_event")({ provider: model.provider, api: model.api, model: model.id, data }, d.ctx);
  request(1000);
  event({ type: "message_start", message: { id: "main" } });
  request(1);
  event({ type: "message_start", message: { id: "warm" } });
  event({ type: "message_delta", context_management: { applied_edits: [{ cleared_input_tokens: 700 }] } });
  event({ type: "message_stop" }); event({ type: "message_stop" });
  const message = assistant(textReply("done"), { provider: model.provider, api: model.api, model: model.id, responseId: "main", usage: usage(100, 20, 30, 40) });
  const id = manager.appendMessage(message);
  d.handlers.get("message_end")({ message }, d.ctx);
  await d.handlers.get("turn_end")({ message: structuredClone(message), messageEntryId: id, entries: [], outcome: "completed" }, d.ctx);
  await d.commands.get("context").handler("", d.ctx);
  const status = d.notifications.at(-1);
  const raw = buildSessionProjection(manager.getBranch()).messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  assert.ok(status.includes(`estimated · raw ${raw} (Anthropic)`), status);
  assert.ok(status.includes("1 applied, 700 tokens this session"));
});


test("a routed assistant message_end also retires unfinished streams in event wiring", testOptions, async () => {
  const manager = SessionManager.inMemory();
  const d = driver(model, manager);
  const event = (data) => d.handlers.get("provider_stream_event")({ provider: model.provider, api: model.api, model: model.id, data }, d.ctx);
  event({ type: "message_start", message: { id: "unfinished-warm" } });
  d.handlers.get("message_end")({ message: assistant(textReply("routed response")) }, d.ctx);
  event({ type: "message_start", message: { id: "next-main" } });
  event({ type: "message_delta", context_management: { applied_edits: [{ cleared_input_tokens: 200 }] } });
  const message = assistant(textReply("done"), { provider: model.provider, api: model.api, model: model.id,
    responseId: "next-main", usage: usage(100, 20, 30, 40) });
  const id = manager.appendMessage(message);
  d.handlers.get("message_end")({ message }, d.ctx);
  await d.handlers.get("turn_end")({ message, messageEntryId: id, entries: [], outcome: "completed" }, d.ctx);
  await d.commands.get("context").handler("", d.ctx);
  const raw = buildSessionProjection(manager.getBranch()).messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  assert.ok(d.notifications.at(-1).includes(`estimated · raw ${raw} (Anthropic)`));
});

test("assistant completion retires aborted and failed stream IDs even without message_stop", testOptions, () => {
  for (const stopReason of ["aborted", "error", "length", "stop", "toolUse"]) {
    const totals = createSessionStats();
    const observer = createResponseObserver(totals);
    observer.observe({ type: "message_start", message: { id: "unfinished" } });
    const unknown = observer.messageEnd(assistant([], { responseId: "unfinished", stopReason }));
    assert.equal(unknown.clearedInput, undefined);
    assert.equal(unknown.appliedEdits, undefined);
    observer.observe({ type: "message_start", message: { id: "next" } });
    observer.observe({ type: "message_delta" }, { clearedInput: 500, appliedEdits: 1 });
    observer.observe({ type: "message_stop" });
    assert.equal(observer.messageEnd(assistant(textReply("done"), { responseId: "next" })).clearedInput, undefined);
    observer.observe({ type: "message_stop" });
    observer.observe({ type: "message_start", message: { id: "clean" } });
    observer.observe({ type: "message_delta" }, { clearedInput: 500, appliedEdits: 1 });
    observer.observe({ type: "message_stop" });
    assert.equal(observer.messageEnd(assistant(textReply("done"), { responseId: "clean" })).clearedInput, 500);
    assert.equal(totals.serverClearedTokens, 1000);
  }
});

test("Responses replay keeps Pi's OpenAI instruction item and requires a summary at the fixed boundary", testOptions, () => {
  const f = replayFixture("responses-trigger");
  const instruction = { role: "developer", content: "Current system instructions." };
  const payload = { ...f.payload, input: [instruction, ...f.payload.input] };
  assert.deepEqual(applyReplay(payload, f.model, [f.entry]).payload.input,
    [instruction, ...f.entry.details.native.window, f.payload.input[1]]);
  for (const input of [
    [instruction, { role: "user", content: [{ type: "input_text", text: "wrong" }] }, ...f.payload.input],
    [instruction, instruction, ...f.payload.input],
    [{ ...f.payload.input[0], content: [{ type: "input_text", text: f.expected }, { type: "input_image" }] }],
    [{ role: "user", content: f.expected }],
    [{ ...f.payload.input[0], content: [{ type: "input_text", text: f.expected, extra: "unverified" }] }],
    [{ ...f.payload.input[0], type: "function_call_output" }],
  ]) {
    const changed = { ...payload, input };
    const rejected = applyReplay(changed, f.model, [f.entry]);
    assert.equal(rejected.state, "rejected");
    assert.equal(rejected.payload, changed);
  }
  const codex = { ...f.model, provider: "openai-codex", api: "openai-codex-responses" };
  const entry = { ...f.entry, details: { ...f.entry.details, ...channelOf(codex) } };
  assert.equal(applyReplay(payload, codex, [entry]).state, "rejected");
  const requests = createRequests();
  const id = "assistant-response";
  requests.record(payload, channelOf(f.model));
  requests.onMessageEnd(assistant());
  requests.onTurnEnd({ message: assistant(), messageEntryId: id });
  assert.deepEqual(requests.boundary([{ id }], f.model).snapshot.payload, payload);
});


test("live replay verification checks a final-answer compaction once against restart", testOptions, () => {
  const entries = [{ id: "first" }, { id: "last" }];
  const taskRequests = [{ compactionId: "first", step: "task" }];
  const restart = { compactionId: "last", step: "restart" };
  for (const requests of [taskRequests, [...taskRequests, { compactionId: "last", step: "task" }]]) {
    const checked = [];
    assertCompactionReplays(entries, requests, restart, (entry, request) => checked.push([entry.id, request.step]));
    assert.deepEqual(checked, [["first", "task"], ["last", "restart"]]);
  }
  const checked = [];
  assertCompactionReplays([entries[1]], [], restart, (entry, request) => checked.push([entry.id, request.step]));
  assert.deepEqual(checked, [["last", "restart"]]);
  assert.throws(() => assertCompactionReplays(entries, [], restart, () => {}), /Every compaction/);
  assert.throws(() => assertCompactionReplays(entries, taskRequests, { compactionId: "wrong" }, () => {}), /Every compaction/);
});

for (const late of ["delta", "stop"]) {
  test(`a retired warm stream's late ${late} after the next start makes response attribution unknown`, testOptions, () => {
    const stats = createSessionStats();
    const observer = createResponseObserver(stats);
    const start = (id) => observer.observe({ type: "message_start", message: { id } });
    const delta = (clearedInput) => observer.observe({ type: "message_delta" }, { clearedInput, appliedEdits: 1 });
    const stop = () => observer.observe({ type: "message_stop" });
    const end = (id) => observer.messageEnd(assistant(textReply("done"), { responseId: id }));
    start("main"); delta(100); stop(); start("warm");
    assert.equal(end("main").clearedInput, undefined);
    start("next"); delta(200);
    if (late === "delta") delta(900);
    else stop();
    stop();
    const unknown = end("next");
    assert.equal(unknown.clearedInput, undefined);
    assert.equal(unknown.appliedEdits, undefined);
    if (late === "delta") stop(); // The remaining retired stream finally stops.
    start("clean"); delta(75); stop();
    assert.equal(end("clean").clearedInput, 75);
    assert.equal(stats.serverClearedTokens, late === "delta" ? 1275 : 375);
    assert.equal(stats.serverClears, late === "delta" ? 4 : 3);
  });
}

test("a response with one complete stream and no applied edits has known zero clearing", testOptions, () => {
  const observer = createResponseObserver(createSessionStats());
  observer.observe({ type: "message_start", message: { id: "main" } });
  observer.observe({ type: "message_delta", delta: { stop_reason: "end_turn" } });
  observer.observe({ type: "message_stop" });
  const result = observer.messageEnd(assistant(textReply("done"), { responseId: "main" }));
  assert.equal(result.clearedInput, 0);
  assert.equal(result.appliedEdits, 0);
});
