import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSessionStats, limitsFor } from "../src/budget.ts";
import { canonicalJson, CAPABILITY_ENTRY, channelKey, channelOf, FALLBACK_ENTRY, readCapabilities, readFallbackOverride, readPleatDetails, sameChannel, sha256 } from "../src/session.ts";
import { resolveSummarizer } from "../src/fallback.ts";
import { formatContextStatus, formatFallback, parseContextArgs } from "../src/status.ts";
import { assistant, createHarness, testOptions, textReply, toolCall, usage } from "./harness.mjs";

const model = { provider: "anthropic", api: "anthropic-messages", baseUrl: "https://user:password@example.com/v1///?key=secret#private", id: "claude-test", contextWindow: 20000 };
const baseDetails = { plugin: "pi-pleat", version: 1, strategy: "pi-summary", ...channelOf(model), firstCoveredEntryId: "first", lastCoveredEntryId: "last", firstKeptEntryId: "kept" };

function format(manager, extra = {}) {
  return formatContextStatus({ model, limits: limitsFor(model, { compaction: { reserveTokens: 1000 } }), usage: { tokens: 1000, contextWindow: 20000, percent: 5 }, raw: { tokens: 1777, estimated: false }, branch: manager.getBranch(), stats: createSessionStats(), summarizer: { model, thinkingLevel: "high", label: "session model", configured: false }, diagnostics: [], ...extra });
}

test("channel identities remove credentials and canonical JSON sorts nested keys without mutation", testOptions, () => {
  assert.deepEqual(channelOf(model), { provider: "anthropic", api: "anthropic-messages", endpoint: "https://example.com/v1", model: "claude-test" });
  assert.equal(channelKey(channelOf(model)), "anthropic|anthropic-messages|https://example.com/v1|claude-test");
  assert.equal(sameChannel(channelOf(model), channelOf({ ...model, baseUrl: "https://example.com/v1" })), true);
  for (const changed of [{ provider: "proxy" }, { api: "other" }, { baseUrl: "https://other.example.com/v1" }, { id: "other" }]) assert.equal(sameChannel(channelOf(model), channelOf({ ...model, ...changed })), false);
  const json = { z: undefined, b: [{ z: 1, a: 2 }, undefined], a: { y: true, x: null }, "__proto__": 1 };
  const copy = structuredClone(json);
  assert.equal(canonicalJson(json), '{"a":{"x":null,"y":true},"b":[{"a":2,"z":1},null]}');
  assert.deepEqual(json, copy);
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("plugin records use the latest valid entry on the active branch", testOptions, () => {
  const manager = SessionManager.inMemory();
  const supported = { key: channelKey(channelOf(model)), feature: "clearing", status: "supported", reason: "local fixture" };
  manager.appendCustomEntry(CAPABILITY_ENTRY, supported);
  const fork = manager.getLeafId();
  manager.appendCustomEntry(CAPABILITY_ENTRY, { ...supported, status: "unsupported" });
  manager.appendCustomEntry(FALLBACK_ENTRY, { model: "provider/model", thinking: "high" });
  assert.equal(readCapabilities(manager.getBranch()).get(`${supported.key}#clearing`).status, "unsupported");
  assert.deepEqual(readFallbackOverride(manager.getBranch()), { model: "provider/model", thinking: "high" });
  manager.appendCustomEntry(CAPABILITY_ENTRY, { ...supported, feature: "invalid" });
  manager.appendCustomEntry(FALLBACK_ENTRY, { model: 3, thinking: "invalid" });
  assert.equal(readCapabilities(manager.getBranch()).size, 1);
  assert.deepEqual(readFallbackOverride(manager.getBranch()), { model: "provider/model", thinking: "high" });
  manager.appendCustomEntry(FALLBACK_ENTRY, { model: null, thinking: null });
  assert.deepEqual(readFallbackOverride(manager.getBranch()), { model: null, thinking: null });
  manager.branch(fork);
  assert.equal(readCapabilities(manager.getBranch()).get(`${supported.key}#clearing`).status, "supported");
  assert.equal(readFallbackOverride(manager.getBranch()), undefined);
});

test("compaction details reject invalid shapes and mismatched native strategies", testOptions, () => {
  const entry = { type: "compaction", firstKeptEntryId: "kept", details: baseDetails };
  assert.deepEqual(readPleatDetails(entry), baseDetails);
  const native = { kind: "anthropic", block: { type: "compaction", content: "fixed summary", signature: "local-signature", extra: { exact: true } }, systemHash: sha256("system"), toolsHash: sha256("tools"), keptSignatures: ["local-thinking"], keptToolUseIds: ["call"] };
  const details = { ...baseDetails, strategy: "anthropic", native };
  assert.equal(readPleatDetails({ ...entry, details }), details);
  const responses = { ...baseDetails, strategy: "responses-trigger", native: { kind: "responses-trigger", window: [{ type: "compaction", encrypted_content: "local-opaque" }] } };
  assert.equal(readPleatDetails({ ...entry, details: responses }), responses);
  for (const invalid of [null, {}, { ...baseDetails, version: 2 }, { ...baseDetails, model: 5 }, { ...baseDetails, firstKeptEntryId: "different" }, { ...baseDetails, readFiles: [5] }, { ...baseDetails, usageComplete: "false" }, { ...baseDetails, native }, { ...details, native: { ...native, systemHash: "invalid" } }, { ...details, native: { ...native, block: { ...native.block, signature: "" } } }, { ...details, native: responses.native }]) {
    assert.equal(readPleatDetails({ ...entry, details: invalid }), undefined);
  }
});

test("context status formats branch counts, compaction usage, capabilities, recall and thinking drops", testOptions, () => {
  const manager = SessionManager.inMemory();
  const id = manager.appendMessage(assistant([toolCall("recall-call", "recall", { id: "original" })], { diagnostics: [{ type: "anthropic_input_transformations", timestamp: 0, details: { transformations: [{ type: "thinking_dropped", path: "messages.1.content.0" }, { type: "thinking_dropped", path: "messages.2.content.0" }, { type: "other" }] } }] }));
  const costUsage = { ...usage(100, 20, 30, 40), cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 } };
  for (const strategy of ["anthropic", "responses-trigger", "pi-summary"]) manager.appendCompaction("summary", id, 1000, { ...baseDetails, firstKeptEntryId: id, strategy }, true, costUsage);
  manager.appendCompaction("Pi summary", id, 1000, undefined, false);
  manager.appendCustomEntry(CAPABILITY_ENTRY, { key: channelKey(channelOf(model)), feature: "clearing", status: "supported", reason: "local fixture" });
  manager.appendCustomEntry(CAPABILITY_ENTRY, { key: channelKey(channelOf({ ...model, id: "other" })), feature: "responses-trigger", status: "unsupported", reason: "other channel" });
  const stats = { ...createSessionStats(), serverClears: 2, serverClearedTokens: 777 };
  const result = format(manager, { stats, diagnostics: ["one", "two", "three", "four", "five", "six"] });
  assert.equal(result, [
    "pi-pleat · anthropic/claude-test (anthropic-messages)",
    "Context: 1000 of 20000 tokens (5.0%) · raw 1777 (Anthropic) · compaction at 19000 · clearing from 9500 (frees at least 1900, keeps 8 tool uses)",
    "Clearing: server-side, 2 applied, 777 tokens this session",
    "Compaction on this branch: 4 (anthropic 1, responses-trigger 1, pi-summary 1, pi 1) · usage 510 in / 60 out · $1.1100 (partial)",
    "Native replay: none", "Capabilities: clearing supported", "Recall on this branch: 1 calls",
    "Thinking drops reported on this branch: 2 (first: messages.1.content.0)",
    "Fallback summary: anthropic/claude-test (high) · session model", "Recent: two · three · four · five · six",
  ].join("\n"));
  assert.equal(result.includes("secret"), false);
  assert.equal(result.includes("password"), false);
});

test("status reports unknown usage and unavailable replay without claiming a successful check", testOptions, () => {
  const manager = SessionManager.inMemory();
  assert.ok(format(manager, { usage: { tokens: null, contextWindow: 20000, percent: null }, raw: undefined }).includes("Context: unknown of 20000 tokens · raw unknown (Anthropic)"));
  assert.ok(format(manager, { raw: { tokens: 1000, estimated: true } }).includes("(5.0%), estimated"));
  assert.ok(format(manager, { model: undefined, limits: undefined, usage: undefined, raw: undefined }).startsWith("pi-pleat · no physical model selected\nContext: unknown of unknown tokens\nClearing: off"));
  manager.appendCustomEntry(CAPABILITY_ENTRY, { key: channelKey(channelOf(model)), feature: "clearing", status: "unsupported", reason: "unsupported" });
  assert.ok(format(manager).includes("Clearing: off"));
});

test("fallback parsing accepts only valid syntax and preserves slashes in model IDs", testOptions, () => {
  assert.deepEqual(parseContextArgs(""), { kind: "status" });
  assert.deepEqual(parseContextArgs("  fallback  "), { kind: "fallback-show" });
  assert.deepEqual(parseContextArgs("fallback default"), { kind: "fallback-set", model: null, thinking: null });
  assert.deepEqual(parseContextArgs("fallback provider/model/path"), { kind: "fallback-set", model: "provider/model/path", thinking: null });
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.deepEqual(parseContextArgs(`fallback provider/model ${level}`), { kind: "fallback-set", model: "provider/model", thinking: level });
  }
  for (const input of ["other", "fallback model", "fallback /model", "fallback provider/", "fallback default high", "fallback p/m invalid", "fallback p/m high extra"]) assert.equal(parseContextArgs(input).kind, "error");
});

test("fallback display shows resolved thinking and configuration errors", testOptions, async (t) => {
  const h = await createHarness(t);
  const pi = { getSettings: () => ({ "pi-pleat": { fallbackModel: "pleat-test/deterministic", fallbackThinking: "high" } }), getThinkingLevel: () => "high" };
  assert.equal(formatFallback(resolveSummarizer(pi, h.ctx)), "Fallback summary: pleat-test/deterministic (off) · settings");
  h.manager.appendCustomEntry(FALLBACK_ENTRY, { model: "pleat-test/deterministic", thinking: "max" });
  assert.equal(formatFallback(resolveSummarizer(pi, h.ctx)), "Fallback summary: pleat-test/deterministic (off) · session override");
  h.manager.appendCustomEntry(FALLBACK_ENTRY, { model: null, thinking: null });
  assert.equal(formatFallback(resolveSummarizer(pi, h.ctx)), "Fallback summary: pleat-test/deterministic (off) · settings");
  assert.equal(formatFallback({ error: "Missing model." }), "Fallback summary: unavailable: Missing model.");
});

test("context fallback validates models, writes branch-local entries, and survives reopen", testOptions, async (t) => {
  const h = await createHarness(t, { settings: { "pi-pleat": { fallbackModel: "missing/model", fallbackThinking: "max" } } });
  await h.prompt("/context fallback");
  assert.equal(h.notifications.at(-1).text, "Fallback summary: unavailable: Fallback model was not found or is not a physical model.");
  const fork = h.manager.appendMessage({ role: "user", content: "persist session", timestamp: 0 });
  await h.prompt("/context fallback pleat-test/deterministic high");
  assert.deepEqual(readFallbackOverride(h.manager.getBranch()), { model: "pleat-test/deterministic", thinking: "high" });
  assert.equal(h.notifications.at(-1).text, "Fallback summary: pleat-test/deterministic (off) · session override");
  const overrideLeaf = h.manager.getLeafId();
  for (const args of ["missing/model", "pleat-test/deterministic invalid", "default high"]) {
    await h.prompt(`/context fallback ${args}`);
    assert.equal(h.manager.getLeafId(), overrideLeaf);
    assert.equal(h.notifications.at(-1).type, "warning");
  }
  await h.reopen();
  assert.equal((await h.status()).includes("Fallback summary: pleat-test/deterministic (off) · session override"), true);
  h.manager.branch(fork);
  assert.ok((await h.status()).includes("Fallback summary: unavailable: Fallback model was not found or is not a physical model."));
  h.manager.branch(overrideLeaf);
  await h.prompt("/context fallback default");
  assert.deepEqual(readFallbackOverride(h.manager.getBranch()), { model: null, thinking: null });
  assert.ok(h.notifications.at(-1).text.includes("unavailable: Fallback model was not found or is not a physical model."));
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.errors, []);
});


test("stored Responses windows require text users followed by exactly one complete compaction item", testOptions, () => {
  const entry = { type: "compaction", firstKeptEntryId: "kept", details: { ...baseDetails, strategy: "responses-trigger", native: { kind: "responses-trigger", window: [] } } };
  const block = { type: "compaction", encrypted_content: "local-state", metadata: { exact: true } };
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: "retained" }] };
  for (const window of [[], [user], [{ ...block, encrypted_content: " " }], [block, block], [block, user], [{ ...user, role: "assistant" }, block], [{ ...user, content: [{ type: "input_image" }] }, block]]) {
    assert.equal(readPleatDetails({ ...entry, details: { ...entry.details, native: { kind: "responses-trigger", window } } }), undefined);
  }
  const valid = { ...entry, details: { ...entry.details, native: { kind: "responses-trigger", window: [user, block] } } };
  assert.equal(readPleatDetails(valid), valid.details);
});

test("compaction status distinguishes unknown, partial, and complete usage", testOptions, () => {
  const manager = SessionManager.inMemory();
  const kept = manager.appendMessage(assistant());
  assert.ok(format(manager).includes("usage unknown in / unknown out · $unknown"));
  const details = { ...baseDetails, firstKeptEntryId: kept };
  const unknown = manager.appendCompaction("unknown", kept, 1000, details, true);
  assert.ok(format(manager).includes("usage unknown in / unknown out · $unknown"));
  manager.appendCompaction("known", kept, 1000, details, true, usage(100, 20));
  assert.ok(format(manager).includes("usage 100 in / 20 out · $0.0000 (partial)"));
  manager.branch(unknown);
  const partial = { ...details, usageComplete: false };
  assert.equal(readPleatDetails({ type: "compaction", firstKeptEntryId: kept, details: partial }), partial);
  manager.branch(kept);
  manager.appendCompaction("partial", kept, 1000, partial, true, usage(50, 10));
  assert.ok(format(manager).includes("usage 50 in / 10 out · $0.0000 (partial)"));
  manager.branch(kept);
  manager.appendCompaction("complete", kept, 1000, { ...details, usageComplete: true }, true, usage(10, 2));
  const complete = format(manager);
  assert.ok(complete.includes("usage 10 in / 2 out · $0.0000"));
  assert.equal(complete.includes("(partial)"), false);
});
