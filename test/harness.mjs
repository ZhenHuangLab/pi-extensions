import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import {
  createAgentSession, createEventBus, createExtensionRuntime,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import piPleat from "../src/index.ts";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { AuthStorage } = await import(new URL("./core/auth-storage.js", piEntry));
export const { loadExtensionFromFactory } = await import(new URL("./core/extensions/loader.js", piEntry));

export const testOptions = { timeout: 15000 };
export const textReply = (text) => [{ type: "text", text }];
export const toolCall = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
export function usage(input = 100, output = 20, cacheRead = 0, cacheWrite = 0) {
  return {
    input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
export function assistant(content = textReply("done"), extra = {}) {
  return {
    role: "assistant", content, api: "pleat-test", provider: "pleat-test", model: "deterministic",
    timestamp: 0, stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    usage: usage(), ...extra,
  };
}
export function appendTool(manager, { id, name = "output", args = {}, content = textReply("saved output"), details, isError = false }) {
  const assistantId = manager.appendMessage(assistant([toolCall(id, name, args)]));
  const entryId = manager.appendMessage({
    role: "toolResult", toolCallId: id, toolName: name, content, details, isError, timestamp: 0,
  });
  return { assistantId, entryId };
}

export async function bounded(promise, label, milliseconds = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// The final compaction can be committed after the task's final answer.
// Check earlier replays against task requests and the latest against restart,
// once per compaction even when the latest also had a task request.
export function assertCompactionReplays(entries, taskRequests, restartRequest, check) {
  assert.ok(entries.length > 0, "Replay verification requires compactions");
  for (const [index, entry] of entries.entries()) {
    const request = index === entries.length - 1 ? restartRequest : taskRequests.find((request) => request.compactionId === entry.id);
    assert.ok(request?.compactionId === entry.id, "Every compaction must have its replay checked");
    check(entry, request);
  }
}

export function syntheticProvider(replies, requests) {
  return (model, context, options = {}) => {
    const stream = new AssistantMessageEventStream();
    const message = assistant([], {
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "pending",
    });
    void (async () => {
      try {
        options.signal?.throwIfAborted();
        const index = requests.length;
        assert.ok(replies[index], `Unexpected synthetic request ${index + 1}`);
        const request = { model: model.id, messages: structuredClone(context.messages) };
        request.options = options;
        requests.push(request);
        const payload = { model: model.id, messages: structuredClone(context.messages) };
        request.payload = structuredClone((await options.onPayload?.(payload, model)) ?? payload);
        await options.onResponse?.({ status: 200, headers: {} }, model);
        await options.onProviderStreamEvent?.({ type: "synthetic" }, model);
        const reply = typeof replies[index] === "function" ? await replies[index](request) : replies[index];
        const spec = Array.isArray(reply) ? { content: reply } : reply;
        Object.assign(message, spec, { content: [] });
        stream.push({ type: "start", partial: message });
        for (const block of spec.content ?? []) {
          const contentIndex = message.content.length;
          if (block.type === "toolCall") {
            const call = { ...structuredClone(block), arguments: {} };
            message.content.push(call);
            stream.push({ type: "toolcall_start", contentIndex, partial: message });
            call.arguments = structuredClone(block.arguments);
            stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial: message });
            stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
          } else if (block.type === "text") {
            message.content.push({ ...block, text: "" });
            stream.push({ type: "text_start", contentIndex, partial: message });
            message.content[contentIndex].text = block.text;
            stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
            stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
          } else {
            assert.equal(block.type, "thinking");
            message.content.push(structuredClone(block));
            stream.push({ type: "thinking_start", contentIndex, partial: message });
            stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: message });
          }
        }
        options.signal?.throwIfAborted();
        message.stopReason = spec.stopReason ?? (message.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop");
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          stream.push({ type: "error", reason: message.stopReason, error: message });
        } else stream.push({ type: "done", reason: message.stopReason, message });
      } catch (error) {
        message.stopReason = options.signal?.aborted ? "aborted" : "error";
        message.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } finally { stream.end(); }
    })();
    return stream;
  };
}

export function sendSse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}
export function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
let anthropicSequence = 0;
export function anthropicMessage({ blocks = textReply("done"), stop = "end_turn", input = 100, output = 20, cacheRead = 0, cacheWrite = 0, extra = {}, startExtra = {} } = {}) {
  const events = [{ type: "message_start", message: {
    id: `msg-${++anthropicSequence}`, type: "message", role: "assistant", model: "claude-test", content: [],
    usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
    ...startExtra,
  } }];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    } else if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else events.push({ type: "content_block_start", index, content_block: structuredClone(block) });
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: output }, ...extra });
  events.push({ type: "message_stop" });
  return events;
}

export function anthropicCompaction({ block = { type: "compaction", content: "Native summary.", signature: "local-compaction-signature" }, stop = "compaction", iterations = [{ type: "compaction", input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }], omitStop = false } = {}) {
  const events = anthropicMessage({ blocks: block ? [block] : [], stop, input: 0, output: 0,
    extra: { usage: { input_tokens: 0, output_tokens: 0, ...(iterations === undefined ? {} : { iterations }) } } });
  return omitStop ? events.slice(0, -1) : events;
}

// Shared HTTP capture keeps provider-specific protocols in their response helpers.
export async function startMock(handler) {
  const requests = [], errors = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let bytes = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "zstd") bytes = zlib.zstdDecompressSync(bytes);
      else assert.ok(!req.headers["content-encoding"]);
      const request = { url: req.url, headers: req.headers, body: JSON.parse(bytes.toString("utf8")) };
      requests.push(request);
      await handler(request, res, requests.length - 1);
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) sendJson(res, 500, { type: "error", error: { type: "api_error", message: "Local mock handler failed" } });
      else res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests, errors, baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
export function startAnthropicMock(handler) {
  return startMock((request, res, index) => {
    assert.equal(request.url, "/v1/messages?beta=true");
    return handler(request, res, index);
  });
}

export async function createHarness(t, { replies = [], mock, responsesProvider, modelOptions = {}, settings = {}, tools = ["recall"], thinking = mock ? "high" : "off", before = () => {}, configure = () => {}, summarizerModels = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-pleat-test-"));
  const requests = [], events = [], errors = [], notifications = [], statuses = [];
  const modelRuntime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  });
  const common = {
    reasoning: false, input: ["text", "image"], contextWindow: 20000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  modelRuntime.registerProvider("pleat-test", {
    api: "pleat-test", apiKey: "local-test-key", baseUrl: "https://pleat-test.invalid",
    streamSimple: syntheticProvider(replies, requests),
    models: [{ ...common, id: "deterministic", name: "Deterministic", ...(!mock ? modelOptions : {}) }, ...summarizerModels.map((model) => ({ ...common, ...model }))],
  });
  if (mock && !responsesProvider) modelRuntime.registerProvider("anthropic", {
    api: "anthropic-messages", apiKey: "local-test-key", baseUrl: mock.baseUrl,
    models: [{
      ...common, id: "claude-test", name: "Local Claude", reasoning: true, maxTokens: 8000,
      compat: { supportsMidConvoEffort: true, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true, forceAdaptiveThinking: true, supportsTemperature: false },
      ...modelOptions,
    }],
  });
  if (mock && responsesProvider) {
    const codex = responsesProvider === "openai-codex";
    modelRuntime.registerProvider(responsesProvider, {
      api: codex ? "openai-codex-responses" : "openai-responses", apiKey: codex ? fakeCodexJwt() : "sk-test",
      baseUrl: mock.baseUrl + (codex ? "" : "/v1"),
      models: [{ ...common, id: "responses-test", name: "Local Responses", reasoning: true, maxTokens: 8000,
        compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsToolSearch: true }, ...modelOptions }],
    });
  }
  const model = modelRuntime.getModel(responsesProvider ?? (mock ? "anthropic" : "pleat-test"), mock ? responsesProvider ? "responses-test" : "claude-test" : "deterministic");
  assert.ok(model);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    cacheWarming: "off", transport: "sse", images: { autoResize: false }, ...settings,
  });
  const h = { root, requests, events, errors, notifications, statuses, model, modelRuntime, settingsManager };
  let session;
  t.after(async () => {
    try {
      session?.abortCompaction();
      if (session) await bounded(session.abort(), "session cleanup", 2000);
    } finally {
      session?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  async function open(manager) {
    const runtime = createExtensionRuntime();
    const extension = await loadExtensionFromFactory((pi) => {
      before(pi);
      piPleat(pi);
      pi.on("session_start", (_event, ctx) => { h.ctx = ctx; });
      configure(pi);
    }, root, createEventBus(), runtime, "<pi-pleat-test>");
    const resourceLoader = testResourceLoader([extension], runtime);
    ({ session } = await createAgentSession({
      cwd: root, agentDir: root, model, modelRuntime, thinkingLevel: thinking, tools,
      resourceLoader, sessionManager: manager, settingsManager,
    }));
    h.session = session;
    h.manager = manager;
    session.setCacheWarmingMode("off");
    session.subscribe((event) => events.push(event));
    await bounded(session.bindExtensions({
      mode: "print", uiContext: { notify: (text, type) => notifications.push({ text, type }), setStatus: (key, text) => statuses.push({ key, text }) },
      onError: (error) => errors.push(error),
    }), "extension binding");
    assert.deepEqual(errors, []);
  }
  await open(SessionManager.create(root, join(root, "sessions")));
  h.reopen = async () => {
    const file = h.manager.getSessionFile();
    assert.ok(file);
    await session.abort();
    session.dispose();
    await open(SessionManager.open(file));
    return h;
  };
  h.prompt = (text, options) => bounded(session.prompt(text, options), "prompt");
  h.recall = (params) => session.getToolDefinition("recall").execute("recall-test", params, t.signal, undefined, h.ctx);
  h.status = async () => {
    await h.prompt("/context");
    return notifications.at(-1).text;
  };
  return h;
}

export function fakeCodexJwt() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })}.sig`;
}

export function startResponsesMock(provider, handler) {
  return startMock((request, res, index) => {
    assert.equal(request.url, provider === "openai-codex" ? "/codex/responses" : "/v1/responses");
    if (provider === "openai-codex") assert.equal(request.headers["content-encoding"], "zstd");
    return handler(request, res, index);
  });
}

export function responsesMessage({ id = "resp-test", items = [{ type: "message", id: "msg-test", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }], input = 100, output = 20, cached = 0, terminal = "response.completed", status = "completed" } = {}) {
  const events = [{ type: "response.created", response: { id, status: "in_progress", output: [] } }];
  for (const [output_index, item] of items.entries()) {
    events.push({ type: "response.output_item.added", output_index, item: { ...structuredClone(item), ...(item.type === "message" ? { content: [] } : {}) } });
    events.push({ type: "response.output_item.done", output_index, item: structuredClone(item) });
  }
  events.push({ type: terminal, response: { id, status, output: structuredClone(items), usage: { input_tokens: input, output_tokens: output, input_tokens_details: { cached_tokens: cached }, total_tokens: input + output } } });
  return events.map((event, sequence_number) => ({ ...event, sequence_number }));
}

export function testResourceLoader(extensions, runtime, systemPrompt = "You are a deterministic test assistant.") {
  return {
    getExtensions: () => ({ extensions, errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
}
