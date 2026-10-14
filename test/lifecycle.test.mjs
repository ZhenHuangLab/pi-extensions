import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession, createEventBus, createExtensionRuntime,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";

// These internal SDK contracts are deliberately tested against the pinned Pi version.
const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { AuthStorage } = await import(
  new URL("./core/auth-storage.js", piEntry)
);
const { loadExtensionFromFactory } = await import(
  new URL("./core/extensions/loader.js", piEntry)
);

const testOptions = { timeout: 15000 };
const textReply = (text) => [{ type: "text", text }];
const toolReply = [{
  type: "toolCall", id: "noop-call", name: "validation_noop", arguments: {},
}];

async function bounded(promise, label, milliseconds = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)), milliseconds
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function syntheticProvider(replies, requests) {
  return (model, context, options = {}) => {
    const stream = new AssistantMessageEventStream();
    const index = requests.length;
    const message = {
      role: "assistant", content: [], api: model.api,
      provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: "pending",
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    void (async () => {
      try {
        options.signal?.throwIfAborted();
        assert.ok(replies[index], `Unexpected provider request ${index + 1}`);
        const request = {
          messages: structuredClone(context.messages), signal: options.signal,
        };
        requests.push(request);
        const payload = { request: index + 1 };
        request.payload =
          (await options.onPayload?.(payload, model)) ?? payload;
        await options.onResponse?.({
          status: 200, headers: { "x-validation": "local" },
        }, model);
        await options.onProviderStreamEvent?.({
          type: "synthetic", request: index + 1,
        }, model);
        options.signal?.throwIfAborted();
        stream.push({ type: "start", partial: message });
        for (const block of replies[index]) {
          const contentIndex = message.content.length;
          if (block.type === "text") {
            message.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex, partial: message });
            message.content[contentIndex].text = block.text;
            stream.push({
              type: "text_delta", contentIndex,
              delta: block.text, partial: message,
            });
            stream.push({
              type: "text_end", contentIndex,
              content: block.text, partial: message,
            });
          } else {
            assert.equal(block.type, "toolCall");
            const toolCall = { ...block, arguments: {} };
            message.content.push(toolCall);
            stream.push({
              type: "toolcall_start", contentIndex, partial: message,
            });
            toolCall.arguments = structuredClone(block.arguments);
            stream.push({
              type: "toolcall_delta", contentIndex,
              delta: JSON.stringify(block.arguments), partial: message,
            });
            stream.push({
              type: "toolcall_end", contentIndex, toolCall, partial: message,
            });
          }
        }
        message.stopReason = message.content.some(
          (block) => block.type === "toolCall"
        ) ? "toolUse" : "stop";
        stream.push({
          type: "done", reason: message.stopReason, message,
        });
      } catch (error) {
        message.stopReason = options.signal?.aborted ? "aborted" : "error";
        message.errorMessage =
          error instanceof Error ? error.message : String(error);
        stream.push({
          type: "error", reason: message.stopReason, error: message,
        });
      } finally {
        stream.end();
      }
    })();
    return stream;
  };
}

function registerNoop(pi) {
  pi.registerTool({
    name: "validation_noop", label: "Validation noop",
    description: "Return a fixed result without changing any files.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "noop result" }], details: {},
    }),
  });
}

async function fixture(t, replies, configure, tools = []) {
  const root = await mkdtemp(join(tmpdir(), "pi-context-validation-"));
  const requests = [], events = [], errors = [], pending = [];
  let session;
  t.after(async () => {
    try {
      if (session) {
        session.abortCompaction();
        await bounded(session.abort(), "session cleanup", 2000);
        await bounded(
          Promise.allSettled(pending), "compaction callback cleanup", 2000
        );
      }
    } finally {
      session?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory(), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false,
  });
  modelRuntime.registerProvider("context-validation", {
    api: "context-validation", apiKey: "local-validation-key",
    baseUrl: "https://context-validation.invalid",
    streamSimple: syntheticProvider(replies, requests),
    models: [{
      id: "deterministic", name: "Deterministic validation",
      reasoning: false, input: ["text"], contextWindow: 32768,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  });
  const model = modelRuntime.getModel("context-validation", "deterministic");
  assert.ok(model);
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(
    configure, root, createEventBus(), runtime, "<context-validation>"
  );
  const resourceLoader = {
    getExtensions: () => ({ extensions: [extension], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "You are a deterministic validation assistant.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const manager = SessionManager.create(root, join(root, "sessions"));
  ({ session } = await createAgentSession({
    cwd: root, agentDir: root, model, modelRuntime, thinkingLevel: "off",
    tools, resourceLoader, sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false, reserveTokens: 128, keepRecentTokens: 1 },
      retry: { enabled: false, maxRetries: 0 },
    }),
  }));
  session.setCacheWarmingMode("off");
  session.subscribe((event) => events.push(event));
  await bounded(session.bindExtensions({
    mode: "print", onError: (error) => errors.push(error),
  }), "extension binding");
  assert.deepEqual(errors, []);
  return { session, manager, requests, events, errors, pending };
}

test("ctx.compact at turn_end aborts without automatic model continuation",
  testOptions, async (t) => {
    const completed = Promise.withResolvers();
    let signal, firstKeptEntryId, compactReason;
    const h = await fixture(t, [
      toolReply, textReply("explicit next turn"),
    ], (pi) => {
      registerNoop(pi);
      pi.on("turn_end", (event, ctx) => {
        if (signal || event.message.stopReason !== "toolUse") return;
        signal = ctx.signal;
        // The callback is awaited by the test, after this handler returns.
        ctx.compact({
          onComplete: (result) => completed.resolve({ result }),
          onError: (error) => completed.resolve({ error }),
        });
      });
      pi.on("session_before_compact", (event) => {
        compactReason = { reason: event.reason, willRetry: event.willRetry };
        firstKeptEntryId = event.preparation.firstKeptEntryId;
        return { compaction: {
          summary: "The user requested a noop and a report.",
          firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
        } };
      });
    }, ["validation_noop"]);
    h.pending.push(completed.promise);
    await bounded(
      h.session.prompt("Run the noop and report its result."), "initial prompt"
    );
    const completion = await bounded(completed.promise, "manual compaction");
    assert.ifError(completion.error);
    assert.ok(completion.result);
    await bounded(h.session.waitForIdle(), "manual compaction idle");
    assert.ok(signal);
    assert.equal(signal.aborted, true);
    assert.deepEqual(compactReason, { reason: "manual", willRetry: false });
    assert.equal(h.requests.length, 1);
    const compactions = h.manager.getEntries().filter(
      (entry) => entry.type === "compaction"
    );
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0].firstKeptEntryId, firstKeptEntryId);
    assert.ok(h.events.some(
      (event) => event.type === "compaction_start" && event.reason === "manual"
    ));
    const end = h.events.find((event) => event.type === "compaction_end");
    assert.ok(end);
    assert.equal(end.reason, "manual");
    assert.equal(end.aborted, false);
    assert.equal(end.willRetry, false);
    assert.equal(h.events.find(
      (event) => event.type === "agent_settled"
    )?.aborted, true);
    assert.equal(h.session.isCompacting, false);
    assert.equal(h.session.isIdle, true);
    await bounded(h.session.prompt("Respond to this new prompt."), "next prompt");
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.session.messages.at(-1).content, textReply("explicit next turn"));
    assert.deepEqual(h.errors, []);
  });

test("a turn_end compaction boundary preserves the tool pair and continues",
  testOptions, async (t) => {
    let retainedId, signal;
    const summary = "The user requested a noop and a report.";
    const h = await fixture(t, [
      toolReply, textReply("continued"), textReply("next prompt"),
    ], (pi) => {
      registerNoop(pi);
      pi.on("turn_end", (event, ctx) => {
        if (retainedId || event.message.stopReason !== "toolUse") return;
        retainedId = event.messageEntryId;
        signal = ctx.signal;
        return { entries: [{
          type: "compaction", summary, firstKeptEntryId: retainedId,
        }] };
      });
    }, ["validation_noop"]);
    await bounded(
      h.session.prompt("Run the noop and report its result."), "boundary prompt"
    );
    assert.equal(h.requests.length, 2);
    assert.ok(signal);
    assert.equal(signal.aborted, false);
    const compactions = h.manager.getEntries().filter(
      (entry) => entry.type === "compaction"
    );
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0].firstKeptEntryId, retainedId);
    assert.equal(compactions[0].fromHook, true);
    assert.equal(compactions[0].systemMessage?.role, "system");
    assert.equal(h.manager.getEntry(retainedId).message.role, "assistant");
    const messages = h.requests[1].messages;
    assert.equal(messages[0].role, "system");
    assert.ok(messages.some(
      (message) => message.role === "user" &&
        JSON.stringify(message.content).includes(summary)
    ));
    assert.deepEqual(
      messages.slice(-2).map((message) => message.role),
      ["assistant", "toolResult"]
    );
    assert.equal(messages.at(-2).content[0].id, messages.at(-1).toolCallId);
    assert.equal(h.events.some(
      (event) => event.type === "compaction_start"
    ), false);
    assert.equal(h.events.find(
      (event) => event.type === "agent_settled"
    )?.aborted, false);
    assert.equal(h.session.isIdle, true);
    await bounded(h.session.prompt("Start another turn."), "next boundary prompt");
    assert.equal(h.requests.length, 3);
    assert.equal(h.requests[2].signal.aborted, false);
    assert.deepEqual(h.session.messages.at(-1).content, textReply("next prompt"));
    assert.deepEqual(h.errors, []);
  });

test("direct registry calls require explicit provider callbacks",
  testOptions, async (t) => {
    let ctx;
    const hooks = { payload: 0, response: 0, stream: 0 };
    const h = await fixture(t, [
      textReply("agent"), textReply("direct"), textReply("callbacks"),
    ], (pi) => {
      pi.on("session_start", (_event, context) => { ctx = context; });
      pi.on("before_provider_request", (event) => {
        hooks.payload++;
        return { ...event.payload, fromExtension: true };
      });
      pi.on("after_provider_response", () => { hooks.response++; });
      pi.on("provider_stream_event", () => { hooks.stream++; });
    });
    await bounded(h.session.prompt("Make a normal agent request."), "agent request");
    assert.deepEqual(hooks, { payload: 1, response: 1, stream: 1 });
    assert.equal(h.requests[0].payload.fromExtension, true);
    const context = { messages: [{
      role: "user", content: "Make a direct request.", timestamp: Date.now(),
    }] };
    const direct = await bounded(ctx.modelRegistry.streamSimple(
      ctx.model, context, { signal: t.signal }
    ).result(), "direct request");
    assert.equal(direct.stopReason, "stop");
    assert.deepEqual(direct.content, textReply("direct"));
    assert.deepEqual(hooks, { payload: 1, response: 1, stream: 1 });
    assert.equal(h.requests[1].payload.fromExtension, undefined);
    const callbacks = { payload: 0, response: 0, stream: 0 };
    const explicit = await bounded(ctx.modelRegistry.streamSimple(
      ctx.model, context, {
        signal: t.signal,
        onPayload: (payload, model) => {
          callbacks.payload++;
          assert.equal(model.id, ctx.model.id);
          return { ...payload, fromCallback: true };
        },
        onResponse: (response) => {
          callbacks.response++;
          assert.equal(response.status, 200);
        },
        onProviderStreamEvent: (data, model) => {
          callbacks.stream++;
          assert.equal(data.type, "synthetic");
          assert.equal(model.provider, ctx.model.provider);
        },
      }
    ).result(), "explicit callbacks");
    assert.equal(explicit.stopReason, "stop");
    assert.deepEqual(explicit.content, textReply("callbacks"));
    assert.deepEqual(callbacks, { payload: 1, response: 1, stream: 1 });
    assert.deepEqual(hooks, { payload: 1, response: 1, stream: 1 });
    assert.equal(h.requests[2].payload.fromCallback, true);
    assert.equal(h.manager.getEntries().filter(
      (entry) => entry.type === "message" && entry.message.role === "assistant"
    ).length, 1);
    assert.deepEqual(h.errors, []);
  });

test("nested tool calls preserve programmatic values without transcript results",
  testOptions, async (t) => {
    const parentId = "validation-parent-call";
    const childText = "nested child content ".repeat(512);
    const structured = {
      items: [{ id: 7, payload: "complete structured value ".repeat(512) }],
      metadata: { complete: true, optional: null },
    };
    const parentContent = textReply(
      `Consumed ${structured.items[0].payload.length} characters from item 7.`
    );
    const results = [];
    let outcome, consumed;
    const h = await fixture(t, [
      [{
        type: "toolCall", id: parentId,
        name: "validation_parent", arguments: {},
      }],
      textReply("parent finished"),
    ], (pi) => {
      pi.on("tool_result", (event) => {
        results.push(structuredClone(event));
      });
      pi.registerTool({
        name: "validation_child", label: "Validation child",
        description: "Return text and a complete structured value.",
        exposure: "codemode",
        parameters: Type.Object({}),
        outputSchema: Type.Object({
          items: Type.Array(Type.Object({
            id: Type.Number(), payload: Type.String(),
          })),
          metadata: Type.Object({
            complete: Type.Boolean(), optional: Type.Null(),
          }),
        }),
        execute: async () => ({
          content: textReply(childText),
          structuredContent: structuredClone(structured),
          details: {},
        }),
      });
      pi.registerTool({
        name: "validation_parent", label: "Validation parent",
        description: "Consume a registered child's structured result.",
        parameters: Type.Object({}),
        execute: async (_id, _params, _signal, _onUpdate, ctx) => {
          outcome = await ctx.executeTool("validation_child", {});
          assert.equal(outcome.isError, false);
          consumed = structuredClone(outcome.result.structuredContent);
          const item = consumed.items[0];
          return {
            content: textReply(
              `Consumed ${item.payload.length} characters from item ${item.id}.`
            ),
            details: {},
          };
        },
      });
    }, ["validation_parent", "validation_child"]);
    await bounded(h.session.prompt("Run the parent tool."), "nested tool prompt");

    assert.ok(outcome);
    assert.equal(outcome.isError, false, JSON.stringify(outcome.result.content));
    assert.deepEqual(consumed, structured);
    assert.deepEqual(outcome.result.structuredContent, structured);
    assert.deepEqual(outcome.result.content, textReply(childText));
    assert.equal(results.length, 2);
    const child = results.find(
      (event) => event.toolName === "validation_child"
    );
    const parent = results.find(
      (event) => event.toolName === "validation_parent"
    );
    assert.ok(child);
    assert.ok(parent);
    assert.equal(child.parentToolCallId, parentId);
    assert.equal(child.toolCallId, outcome.toolCall.id);
    assert.ok(child.toolCallId.startsWith(`${parentId}/`));
    assert.deepEqual(child.structuredContent, structured);
    assert.deepEqual(child.content, textReply(childText));
    assert.equal(parent.toolCallId, parentId);
    assert.equal(parent.parentToolCallId, undefined);
    assert.deepEqual(parent.content, parentContent);

    const rawResults = h.manager.getEntries().filter(
      (entry) => entry.type === "message" &&
        entry.message.role === "toolResult"
    ).map((entry) => entry.message);
    assert.equal(rawResults.length, 1);
    const raw = rawResults[0];
    assert.equal(raw.toolCallId, parentId);
    assert.deepEqual(raw.content, parentContent);
    assert.ok(Array.isArray(raw.nestedCalls?.calls));
    assert.equal(raw.nestedCalls.complete, true);
    assert.equal(raw.nestedCalls.calls.length, 1);
    for (const call of raw.nestedCalls.calls) {
      assert.equal(Object.hasOwn(call, "result"), false);
      assert.equal(Object.hasOwn(call, "content"), false);
      assert.equal(Object.hasOwn(call, "structuredContent"), false);
    }
    const nestedRecord = JSON.stringify(raw.nestedCalls);
    assert.ok(nestedRecord.includes(child.toolCallId));
    assert.ok(nestedRecord.includes("validation_child"));
    assert.equal(nestedRecord.includes(childText), false);
    assert.equal(nestedRecord.includes(structured.items[0].payload), false);
    assert.deepEqual(h.session.messages.filter(
      (message) => message.role === "toolResult"
    ).map((message) => message.toolCallId), [parentId]);
    assert.equal(h.requests.length, 2);
    const visibleResults = h.requests[1].messages.filter(
      (message) => message.role === "toolResult"
    );
    assert.equal(visibleResults.length, 1);
    assert.equal(visibleResults[0].toolCallId, parentId);
    assert.deepEqual(visibleResults[0].content, parentContent);
    assert.deepEqual(h.errors, []);
  });

test("context edits remain branch-local and persist with opaque compaction details",
  testOptions, async (t) => {
    const h = await fixture(t, [
      toolReply, textReply("completed"),
    ], registerNoop, ["validation_noop"]);
    await bounded(h.session.prompt("Run the noop."), "context edit prompt");
    const manager = h.manager;
    const originalEntries = structuredClone(manager.getEntries());
    const target = originalEntries.find(
      (entry) => entry.type === "message" &&
        entry.message.role === "toolResult"
    );
    const assistant = originalEntries.find(
      (entry) => entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.content.some((block) => block.type === "toolCall")
    );
    assert.ok(target);
    assert.ok(assistant);
    const beforeEdit = manager.getLeafId();
    const replacement = textReply("Short model-visible replacement.");
    const projectedResult = (sm) => sm.buildSessionContext().messages.find(
      (message) => message.role === "toolResult" &&
        message.toolCallId === target.message.toolCallId
    );
    const editId = manager.appendContextEdit(target.id, {
      content: replacement,
    });
    assert.deepEqual(manager.getEntries().slice(0, originalEntries.length),
      originalEntries);
    assert.deepEqual(projectedResult(manager), {
      ...target.message, content: replacement,
    });

    manager.branch(beforeEdit);
    assert.deepEqual(projectedResult(manager), target.message);
    const siblingId = manager.appendContextEdit(target.id, {
      content: textReply("Replacement on another branch."),
    });
    manager.branch(editId);
    assert.deepEqual(projectedResult(manager).content, replacement);
    const details = {
      opaque: {
        records: [{ key: "artifact", values: [1, null, { ready: true }] }],
        properties: { arbitrary: "extension data", empty: {} },
      },
    };
    const compactionId = manager.appendCompaction(
      "The user requested the noop.", assistant.id, 32, details, true
    );
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    const reopened = SessionManager.open(sessionFile);
    // JSONL retains JSON values; optional undefined properties are not JSON data.
    const persistedTarget = JSON.parse(JSON.stringify(target));
    assert.equal(reopened.getLeafId(), compactionId);
    assert.deepEqual(reopened.getEntry(compactionId).details, details);
    assert.deepEqual(reopened.getEntry(target.id), persistedTarget);
    assert.ok(reopened.getEntry(siblingId));
    assert.equal(reopened.getBranch().some(
      (entry) => entry.id === siblingId
    ), false);
    assert.deepEqual(projectedResult(reopened), {
      ...persistedTarget.message, content: replacement,
    });
    reopened.branch(beforeEdit);
    assert.deepEqual(projectedResult(reopened), persistedTarget.message);
    reopened.branch(compactionId);
    assert.deepEqual(projectedResult(reopened).content, replacement);
    assert.deepEqual(h.errors, []);
  });
