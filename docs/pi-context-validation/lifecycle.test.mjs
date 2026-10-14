import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const packageDir = process.env.PI_PACKAGE_DIR ??
  "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const packageUrl = pathToFileURL(join(packageDir, "package.json"));
const {
  createAgentSession, createEventBus, createExtensionRuntime,
  ModelRuntime, SessionManager, SettingsManager,
} = await import(new URL("dist/index.js", packageUrl));
const { AuthStorage } = await import(
  new URL("dist/core/auth-storage.js", packageUrl)
);
const { loadExtensionFromFactory } = await import(
  new URL("dist/core/extensions/loader.js", packageUrl)
);
const { AssistantMessageEventStream } = await import(new URL(
  "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js", packageUrl
));
const { Type } = await import(
  new URL("node_modules/typebox/build/index.mjs", packageUrl)
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
