import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionProjection, estimateTokens, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { contentBytes, DEFAULT_CLEARING, limitsFor, rawNextTokens, readClearingSettings, readCompactionSettings } from "../src/budget.ts";
import { coverage, toolRecords } from "../src/session.ts";
import { appendTool, assistant, createHarness, testOptions, textReply, usage } from "./harness.mjs";

const model = { provider: "pleat-test", id: "deterministic", contextWindow: 20000 };
function records(sizes) {
  const manager = SessionManager.inMemory();
  const saved = sizes.map((size, index) => appendTool(manager, { id: `call-${index}`, content: textReply(String(index).repeat(size)) }));
  return { manager, saved };
}

test("budgets resolve independent per-model overrides and clamp small windows", testOptions, () => {
  const key = `${model.provider}/${model.id}`;
  const settings = { compaction: { reserveTokens: 500, keepRecentTokens: 100, modelOverrides: { [key]: { keepRecentTokens: 200 } } } };
  assert.deepEqual(limitsFor(model, settings), { window: 20000, reserve: 500, keepRecent: 200, enabled: true, threshold: 19500, asyncThreshold: 15600, clearTrigger: 9750, clearFloor: 1950, keepToolUses: 8 });
  const piSettings = SettingsManager.inMemory(settings).getCompactionSettings(model);
  assert.equal(piSettings.reserveTokens, limitsFor(model, settings).reserve);
  assert.equal(piSettings.keepRecentTokens, limitsFor(model, settings).keepRecent);
  assert.deepEqual(readCompactionSettings(settings, model), { enabled: true, reserve: 500, keepRecent: 200, problems: [] });
  assert.equal(limitsFor(model, {}).reserve, 16384);
  assert.equal(limitsFor(model, {}).keepRecent, 20000);
  assert.deepEqual(limitsFor({ ...model, contextWindow: 100 }, { compaction: { enabled: false } }), { window: 100, reserve: 16384, keepRecent: 20000, enabled: false, threshold: 0, asyncThreshold: 0, clearTrigger: 1, clearFloor: 1, keepToolUses: 8 });
  for (const [field, resolvedField, ordinary, defaultValue] of [
    ["reserveTokens", "reserve", 500, 16384], ["keepRecentTokens", "keepRecent", 100, 20000],
  ]) {
    for (const invalid of [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "10", null, false, [], {}]) {
      const ordinaryProblem = `Invalid compaction.${field}: use a non-negative safe integer. Using the default ${defaultValue}.`;
      const overrideProblem = `Invalid compaction.modelOverrides["${key}"].${field}: use a non-negative safe integer. Using `;
      for (const [compaction, expected, problems] of [
        [{ [field]: invalid, modelOverrides: { [key]: { [field]: 250 } } }, 250, [`Invalid compaction.${field}: use a non-negative safe integer. Using the compaction.modelOverrides["${key}"] value 250.`]],
        [{ [field]: ordinary, modelOverrides: { [key]: { [field]: invalid } } }, ordinary, [`${overrideProblem}the compaction value ${ordinary}.`]],
        [{ modelOverrides: { [key]: { [field]: invalid } } }, defaultValue, [`${overrideProblem}the default ${defaultValue}.`]],
        [{ [field]: invalid }, defaultValue, [ordinaryProblem]],
        [{ [field]: invalid, modelOverrides: { [key]: { [field]: invalid } } }, defaultValue, [ordinaryProblem, `${overrideProblem}the default ${defaultValue}.`]],
      ]) {
        const settings = { compaction };
        const result = readCompactionSettings(settings, model);
        assert.equal(result[resolvedField], expected);
        assert.equal(limitsFor(model, settings)[resolvedField], expected);
        assert.deepEqual(result.problems, problems);
        assert.throws(() => SettingsManager.inMemory(settings).getCompactionSettings(model), /Invalid compaction/);
      }
    }
  }
  for (const value of [null, [], false, "invalid", 1]) {
    const invalidEntry = { compaction: { reserveTokens: 500, keepRecentTokens: 100, modelOverrides: { [key]: value } } };
    assert.deepEqual(readCompactionSettings(invalidEntry, model), {
      enabled: true, reserve: 500, keepRecent: 100,
      problems: [`Invalid compaction.modelOverrides["${key}"]: use an object. Using the compaction values.`],
    });
    assert.throws(() => SettingsManager.inMemory(invalidEntry).getCompactionSettings(model), /Invalid compaction/);
    for (const settings of [
      { compaction: { reserveTokens: 500, keepRecentTokens: 100, modelOverrides: value } },
      { compaction: { reserveTokens: 500, keepRecentTokens: 100, modelOverrides: { [key.toUpperCase()]: value }, unrelated: "ignored" } },
      { compaction: value },
    ]) {
      const result = readCompactionSettings(settings, model);
      const piSettings = SettingsManager.inMemory(settings).getCompactionSettings(model);
      assert.deepEqual(result, { enabled: piSettings.enabled, reserve: piSettings.reserveTokens, keepRecent: piSettings.keepRecentTokens, problems: [] });
    }
  }
  for (const enabled of [true, false, 0, 1, "", "no", null, undefined]) {
    const settings = { compaction: { enabled } };
    assert.equal(readCompactionSettings(settings, model).enabled, !!SettingsManager.inMemory(settings).getCompactionSettings(model).enabled);
  }
  assert.equal(limitsFor(model, { compaction: { reserveTokens: 0, keepRecentTokens: 0 } }).keepRecent, 0);
  assert.deepEqual(readClearingSettings({}, model), { clearing: DEFAULT_CLEARING, problems: [] });
  const configured = { triggerRatio: 0.75, floorRatio: 0.25, keepToolUses: 3 };
  const configuredSettings = { ...settings, "pi-pleat": { clearing: configured } };
  assert.deepEqual(readClearingSettings(configuredSettings, model), { clearing: configured, problems: [] });
  assert.deepEqual(limitsFor(model, configuredSettings), { window: 20000, reserve: 500, keepRecent: 200, enabled: true, threshold: 19500, asyncThreshold: 15600, clearTrigger: 14625, clearFloor: 4875, keepToolUses: 3 });
  const boundary = { triggerRatio: 1, floorRatio: 0, keepToolUses: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(readClearingSettings({ "pi-pleat": { clearing: boundary } }, model), { clearing: boundary, problems: [] });
  const path = `pi-pleat.clearing.modelOverrides["${key}"]`;
  for (const [field, invalids, rule] of [
    ["triggerRatio", [0, -0.1, 1.1], "use a finite number greater than 0 and at most 1"],
    ["floorRatio", [-0.1, 1], "use a finite number at least 0 and less than 1"],
    ["keepToolUses", [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1], "use a safe integer at least 1"],
  ]) {
    for (const value of [...invalids, true, false, "1", null, NaN, Infinity, -Infinity]) {
      const result = readClearingSettings({ "pi-pleat": { clearing: { [field]: value } } }, model);
      assert.deepEqual(result, {
        clearing: DEFAULT_CLEARING,
        problems: [`Invalid pi-pleat.clearing.${field}: ${rule}. Using the default ${DEFAULT_CLEARING[field]}.`],
      });
      for (const [ordinary, label] of [[configured, "the pi-pleat.clearing value"], [{}, "the default"]]) {
        const expected = { ...DEFAULT_CLEARING, ...ordinary };
        assert.deepEqual(readClearingSettings({ "pi-pleat": { clearing: { ...ordinary, modelOverrides: { [key]: { [field]: value } } } } }, model), {
          clearing: expected, problems: [`Invalid ${path}.${field}: ${rule}. Using ${label} ${expected[field]}.`],
        });
      }
    }
  }
  const ratioProblem = "Invalid pi-pleat.clearing.floorRatio: use a value less than pi-pleat.clearing.triggerRatio. Using the default ratios (triggerRatio 0.5, floorRatio 0.1).";
  for (const clearing of [{ triggerRatio: 0.05 }, { triggerRatio: 0.2, floorRatio: 0.2 }, { triggerRatio: 0.2, floorRatio: 0.3 }]) {
    assert.deepEqual(readClearingSettings({ "pi-pleat": { clearing } }, model), { clearing: DEFAULT_CLEARING, problems: [ratioProblem] });
  }
  for (const value of [null, [], false, "invalid", 1]) {
    for (const [settings, path] of [[{ "pi-pleat": value }, "pi-pleat"], [{ "pi-pleat": { clearing: value } }, "pi-pleat.clearing"]]) {
      assert.deepEqual(readClearingSettings(settings, model), {
        clearing: DEFAULT_CLEARING, problems: [`Invalid ${path}: use an object. Using all clearing defaults.`],
      });
    }
  }
  assert.deepEqual(readClearingSettings({ "pi-pleat": { clearing: { keepToolUse: 2 } } }, model), {
    clearing: DEFAULT_CLEARING, problems: ["Unknown setting pi-pleat.clearing.keepToolUse ignored."],
  });
  for (const [field, value] of Object.entries({ triggerRatio: 0.8, floorRatio: 0.3, keepToolUses: 4 })) {
    for (const ordinary of [configured, {}]) {
      assert.deepEqual(readClearingSettings({ "pi-pleat": { clearing: { ...ordinary, modelOverrides: { [key]: { [field]: value } } } } }, model), {
        clearing: { ...DEFAULT_CLEARING, ...ordinary, [field]: value }, problems: [],
      });
    }
  }
  const clearingOverride = { triggerRatio: 0.3, floorRatio: 0.05, keepToolUses: 4 };
  const overrideSettings = { ...settings, "pi-pleat": { clearing: { ...configured, modelOverrides: { [key]: clearingOverride } } } };
  assert.deepEqual(readClearingSettings(overrideSettings, model), { clearing: clearingOverride, problems: [] });
  assert.deepEqual(limitsFor(model, overrideSettings), { window: 20000, reserve: 500, keepRecent: 200, enabled: true, threshold: 19500, asyncThreshold: 15600, clearTrigger: 5850, clearFloor: 975, keepToolUses: 4 });
  const slashedModel = { ...model, id: "group/deterministic" };
  const slashedSettings = { "pi-pleat": { clearing: { modelOverrides: { [key]: null, "pleat-test/group/deterministic": { keepToolUses: 2 } } } } };
  assert.deepEqual(readClearingSettings(slashedSettings, slashedModel), { clearing: { ...DEFAULT_CLEARING, keepToolUses: 2 }, problems: [] });
  for (const value of [null, [], false, "invalid", 1, { triggerRatio: -1, unknown: true }]) {
    assert.deepEqual(readClearingSettings({ "pi-pleat": { clearing: { ...configured, modelOverrides: { [key.toUpperCase()]: value } } } }, model), {
      clearing: configured, problems: [],
    });
  }
  for (const value of [null, [], false, "invalid", 1]) {
    const invalidOverrides = { "pi-pleat": { clearing: { ...configured, modelOverrides: value } } };
    for (const selected of [model, slashedModel]) {
      assert.deepEqual(readClearingSettings(invalidOverrides, selected), {
        clearing: configured, problems: ["Invalid pi-pleat.clearing.modelOverrides: use an object. Ignoring clearing model overrides."],
      });
    }
    assert.deepEqual(readClearingSettings({ "pi-pleat": { clearing: { ...configured, modelOverrides: { [key]: value } } } }, model), {
      clearing: configured, problems: [`Invalid ${path}: use an object. Using the pi-pleat.clearing values.`],
    });
  }
  assert.deepEqual(readClearingSettings({ "pi-pleat": { clearing: { modelOverrides: { [key]: { keepToolUses: 2, keepToolUse: 3, modelOverrides: {} } } } } }, model), {
    clearing: { ...DEFAULT_CLEARING, keepToolUses: 2 },
    problems: [`Unknown setting ${path}.keepToolUse ignored.`, `Unknown setting ${path}.modelOverrides ignored.`],
  });
  assert.deepEqual(readClearingSettings({ "pi-pleat": { clearing: { keepToolUses: 8, modelOverrides: { [key]: { keepToolUses: 0 } } } } }, model), {
    clearing: DEFAULT_CLEARING,
    problems: [`Invalid ${path}.keepToolUses: use a safe integer at least 1. Using the pi-pleat.clearing value 8.`],
  });
  for (const [ordinary, ratios, restored, label, problems] of [
    [configured, { triggerRatio: 0.2, floorRatio: 0.3 }, configured, "the pi-pleat.clearing ratios", []],
    [configured, { triggerRatio: 0.2 }, configured, "the pi-pleat.clearing ratios", []],
    [{}, { floorRatio: 0.5 }, DEFAULT_CLEARING, "the default ratios", []],
    [{ triggerRatio: 0.8 }, { floorRatio: 0.9 }, { ...DEFAULT_CLEARING, triggerRatio: 0.8 }, "the pi-pleat.clearing ratios", []],
    [{ triggerRatio: 0.2, floorRatio: 0.3 }, { triggerRatio: 0.05 }, DEFAULT_CLEARING, "the default ratios", [ratioProblem]],
    [{ triggerRatio: 0.5, floorRatio: 0.1 }, { floorRatio: 0.5 }, DEFAULT_CLEARING, "the pi-pleat.clearing ratios", []],
  ]) {
    const trigger = ratios.triggerRatio ?? restored.triggerRatio;
    const floor = ratios.floorRatio ?? restored.floorRatio;
    assert.deepEqual(readClearingSettings({ "pi-pleat": { clearing: { ...ordinary, modelOverrides: { [key]: { ...ratios, keepToolUses: 2 } } } } }, model), {
      clearing: { ...restored, keepToolUses: 2 },
      problems: [...problems, `Invalid ${path}: floorRatio ${floor} must be less than triggerRatio ${trigger}. Using ${label} (triggerRatio ${restored.triggerRatio}, floorRatio ${restored.floorRatio}).`],
    });
  }
  assert.deepEqual(readClearingSettings({ "pi-pleat": { clearing: { triggerRatio: 0.2, floorRatio: 0.3, modelOverrides: { [key]: { floorRatio: -1 } } } } }, model), {
    clearing: DEFAULT_CLEARING,
    problems: [ratioProblem, `Invalid ${path}.floorRatio: use a finite number at least 0 and less than 1. Using the default 0.1.`],
  });
  assert.equal(contentBytes([{ type: "text", text: "é" }, { type: "image", data: "aW1n", mimeType: "image/png" }]), 6);
});

test("coverage follows the current projection and tool records retain raw top-level results", testOptions, () => {
  const { manager, saved } = records(Array(3).fill(100));
  manager.appendContextEdit(saved[0].entryId, null);
  let branch = manager.getBranch();
  assert.deepEqual(coverage(branch, saved[2].assistantId), { firstCoveredEntryId: saved[0].assistantId, lastCoveredEntryId: saved[1].entryId });
  assert.equal(coverage(branch, "absent"), undefined);
  assert.equal(coverage(branch, saved[0].assistantId), undefined);
  const first = manager.appendCompaction("first", saved[1].assistantId, 100);
  branch = manager.getBranch();
  assert.deepEqual(coverage(branch, saved[2].assistantId), { firstCoveredEntryId: first, lastCoveredEntryId: saved[1].entryId });
  const all = toolRecords(branch);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((record) => record.entryId), saved.map((record) => record.entryId));
  assert.deepEqual(all[0].args, {});
  assert.equal(all[0].content[0].text.length, 100);
});

test("raw usage is bound to the projected assistant entry and remains unknown after compaction", testOptions, async (t) => {
  const h = await createHarness(t);
  const id = h.manager.appendMessage(assistant(textReply("done"), { usage: usage(100, 20, 30, 40) }));
  const ctx = { ...h.ctx, model: { ...h.model, provider: "anthropic", api: "anthropic-messages" }, getContextUsage: () => ({ tokens: 190, contextWindow: 20000 }) };
  const stats = new Map([[id, { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, clearedInput: 777, appliedEdits: 1 }]]);
  assert.deepEqual(rawNextTokens(ctx, stats), { tokens: 967, estimated: false });
  const full = buildSessionProjection(h.manager.getBranch()).messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  assert.deepEqual(rawNextTokens(ctx, new Map()), { tokens: full, estimated: true });
  assert.deepEqual(rawNextTokens({ ...ctx, model: h.model }, stats), { tokens: 190, estimated: false });
  h.manager.appendMessage({ role: "user", content: "next", timestamp: 0 });
  assert.deepEqual(rawNextTokens(ctx, stats), { tokens: 967, estimated: true });
  assert.equal(rawNextTokens({ ...ctx, getContextUsage: () => ({ tokens: null }) }, stats), undefined);
  assert.equal(rawNextTokens({ ...ctx, getContextUsage: () => undefined }, stats), undefined);
  const sibling = h.manager.appendMessage(assistant());
  h.manager.branch(id);
  stats.set(sibling, { clearedInput: 999 });
  assert.equal(rawNextTokens(ctx, stats).tokens, 967);
});

test("raw cleared-input adjustment stops after a context edit or compaction invalidates Pi usage", testOptions, async (t) => {
  const h = await createHarness(t);
  const id = h.manager.appendMessage(assistant(textReply("done"), { usage: usage(100, 20) }));
  const stats = new Map([[id, { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, clearedInput: 777, appliedEdits: 1 }]]);
  const ctx = { ...h.ctx, model: { ...h.model, provider: "anthropic", api: "anthropic-messages" }, getContextUsage: () => ({ tokens: 120 }) };
  assert.deepEqual(rawNextTokens(ctx, stats), { tokens: 897, estimated: false });
  h.manager.appendContextEdit(id, { content: textReply("edited") });
  assert.deepEqual(rawNextTokens(ctx, stats), { tokens: 120, estimated: true });
  h.manager.branch(id);
  h.manager.appendCompaction("summary", id, 120);
  assert.deepEqual(rawNextTokens(ctx, stats), { tokens: 120, estimated: true });
});


test("unknown applied-edit attribution keeps the raw token count marked as estimated", testOptions, async (t) => {
  const h = await createHarness(t);
  const id = h.manager.appendMessage(assistant(textReply("done"), { usage: usage(100, 20) }));
  const ctx = { ...h.ctx, model: { ...h.model, provider: "anthropic", api: "anthropic-messages" }, getContextUsage: () => ({ tokens: 120 }) };
  const stats = new Map([[id, { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }]]);
  const full = buildSessionProjection(h.manager.getBranch()).messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  assert.deepEqual(rawNextTokens(ctx, stats), { tokens: full, estimated: true });
});

test("unknown Anthropic clearing uses the complete projected raw context even when Pi reports reduced input", testOptions, async (t) => {
  const h = await createHarness(t);
  h.manager.appendMessage({ role: "system", content: "Current system", timestamp: 0 });
  const original = h.manager.appendMessage({ role: "user", content: "x".repeat(40000), timestamp: 0 });
  const id = h.manager.appendMessage(assistant(textReply("done"), { usage: usage(100, 20) }));
  h.manager.appendMessage({ role: "user", content: "Trailing task", timestamp: 0 });
  const ctx = { ...h.ctx, model: { ...h.model, provider: "anthropic", api: "anthropic-messages" }, getContextUsage: () => ({ tokens: 120 }) };
  const stats = new Map([[id, { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }]]);
  let full = buildSessionProjection(h.manager.getBranch()).messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  assert.ok(full > 10000);
  assert.deepEqual(rawNextTokens(ctx, stats), { tokens: full, estimated: true });
  h.manager.appendContextEdit(original, { content: textReply("replacement") });
  full = buildSessionProjection(h.manager.getBranch()).messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  assert.deepEqual(rawNextTokens(ctx, stats), { tokens: full, estimated: true });
});
