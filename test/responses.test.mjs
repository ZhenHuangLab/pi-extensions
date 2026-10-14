import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { isResponsesTrigger, requestTriggerCompaction } from "../src/providers/openai.ts";
import { CAPABILITY_ENTRY, channelOf, readPleatDetails } from "../src/session.ts";
import { bounded, createHarness, responsesMessage, sendJson, sendSse, startResponsesMock, testOptions, textReply, usage } from "./harness.mjs";

const compactions = (h) => h.manager.getBranch().filter((entry) => entry.type === "compaction");
const nativeRequests = (h) => h.mock.requests.filter((request) => request.body.input.at(-1)?.type === "compaction_trigger");
const capabilities = (h) => h.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === CAPABILITY_ENTRY);
const jsonCopy = (value) => JSON.parse(JSON.stringify(value));
const messageItem = (text, id = "msg-reply") => ({ type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const reasoningItem = (id) => ({ type: "reasoning", id, summary: [], encrypted_content: `local-reasoning-${id}` });
const compactionItem = (round = 1) => ({ type: "compaction", id: `cmp-${round}`, encrypted_content: `local-compaction-${round}`, metadata: { complete: true, extra: [1, null] } });
const instructionCount = (provider) => provider === "openai" ? 1 : 0;

async function fixture(t, provider, { enabled = true, native, main, summary, before, configure, ...options } = {}) {
  let agents = 0, round = 0;
  const originals = [];
  const mock = await startResponsesMock(provider, (request, res) => {
    if (request.body.input.at(-1)?.type === "compaction_trigger") {
      if (native) return native(request, res, ++round);
      return sendSse(res, responsesMessage({ id: `resp-compaction-${++round}`, items: [compactionItem(round)], input: 300, output: 50, cached: 30 }));
    }
    if (!request.body.tools && summary) return summary(request, res);
    if (main) return main(request, res, agents++);
    const index = agents++;
    const items = index === 0 ? [reasoningItem("rs-call"), { type: "function_call", id: "fc-noop", call_id: "call-noop", name: "noop", arguments: "{}", status: "completed" }]
      : [reasoningItem(`rs-${index}`), messageItem(`reply ${index}`, `msg-${index}`)];
    sendSse(res, responsesMessage({ id: `resp-agent-${index}`, items, input: index === 0 ? 19500 : 100 }));
  });
  t.after(() => mock.close());
  const h = await createHarness(t, { mock, responsesProvider: provider, thinking: "low", tools: ["recall", "noop"],
    settings: { compaction: { enabled, reserveTokens: 1000, keepRecentTokens: 1 }, "pi-pleat": { fallbackModel: "pleat-test/deterministic", fallbackThinking: "off" } },
    replies: Array.from({ length: 10 }, (_, index) => ({ content: textReply(`Readable summary ${index + 1}`), usage: usage(10, 2) })),
    before(pi) {
      pi.on("before_provider_request", (event) => { originals.push(jsonCopy(event.payload)); });
      before?.(pi);
    },
    configure(pi) {
      pi.registerTool({ name: "noop", label: "Noop", description: "Return a deterministic result.", parameters: Type.Object({}), execute: async () => ({ content: textReply("noop result"), details: {} }) });
      configure?.(pi);
    }, ...options });
  return Object.assign(h, { mock, originals });
}

for (const provider of ["openai-codex", "openai"]) {
  test(`${provider}: Pi threshold compacts the exact prefix with prompt and tools and replays the complete window`, testOptions, async (t) => {
    const h = await fixture(t, provider);
    await h.prompt("Run noop. Preserve the source identifier.");
    assert.equal(h.mock.requests.length, 3);
    const [agent, compact, replay] = h.mock.requests;
    assert.deepEqual(compact.body.input, [...agent.body.input, { type: "compaction_trigger" }]);
    assert.deepEqual(compact.body.tools, agent.body.tools);
    assert.ok(compact.body.tools.some((tool) => tool.name === "noop"));
    if (provider === "openai-codex") assert.equal(compact.body.instructions, agent.body.instructions);
    else assert.deepEqual(compact.body.input[0], agent.body.input[0]);
    assert.equal(compact.body.store, false);
    assert.equal(compact.body.previous_response_id, undefined);
    const [entry] = compactions(h);
    assert.equal(compactions(h).length, 1);
    const details = readPleatDetails(entry);
    assert.equal(details.strategy, "responses-trigger");
    assert.deepEqual({ provider: details.provider, api: details.api, endpoint: details.endpoint, model: details.model }, channelOf(h.model));
    const users = agent.body.input.filter((item) => item.role === "user");
    assert.deepEqual(details.native.window, [...users, compactionItem()]);
    assert.ok(entry.summary.includes("Readable summary 1"));
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].model, "deterministic");
    const source = h.requests[0].messages.find((message) => message.role === "user").content[0].text;
    assert.ok(source.includes("Preserve the source identifier."));
    assert.equal(source.includes("noop result"), false);
    const offset = instructionCount(provider);
    assert.deepEqual(replay.body.input, [...h.originals[1].input.slice(0, offset), ...details.native.window, ...h.originals[1].input.slice(offset + 1)]);
    assert.ok(replay.body.input.slice(offset + details.native.window.length).some((item) => item.type === "reasoning"));
    assert.ok(replay.body.input.some((item) => item.type === "function_call" && item.call_id === "call-noop"));
    assert.ok(replay.body.input.some((item) => item.type === "function_call_output" && item.call_id === "call-noop"));
    const kept = h.manager.getEntry(entry.firstKeptEntryId);
    assert.equal(kept.message.role, "assistant");
    assert.ok(kept.message.content.some((part) => part.type === "toolCall"));
    assert.equal(h.manager.getEntry(details.firstCoveredEntryId).message.role, "system");
    assert.equal(h.manager.getEntry(details.lastCoveredEntryId).message.role, "user");
    assert.deepEqual(entry.usage, usage(280, 52, 30));
    assert.equal(capabilities(h).length, 1);
    assert.equal(capabilities(h)[0].data.feature, "responses-trigger");
    assert.equal(capabilities(h)[0].data.status, "supported");
    assert.ok((await h.status()).includes("Native replay: active (responses-trigger)"));
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.mock.errors, []);
  });

  test(`${provider}: second compaction includes and replaces the previous window; restart and channel switches replay safely`, testOptions, async (t) => {
    const h = await fixture(t, provider, {
      main(_request, res, index) {
        const items = index < 2 ? [reasoningItem(`rs-call-${index}`), { type: "function_call", id: `fc-noop-${index}`, call_id: `call-noop-${index}`, name: "noop", arguments: "{}", status: "completed" }]
          : [reasoningItem(`rs-${index}`), messageItem(`reply ${index}`, `msg-${index}`)];
        sendSse(res, responsesMessage({ id: `resp-agent-${index}`, items, input: index < 2 ? 19500 : 100 }));
      },
    });
    await h.prompt("Run noop. Original identifier.");
    assert.equal(compactions(h).length, 2);
    const [first, second] = compactions(h);
    const natives = nativeRequests(h);
    const replay1 = h.mock.requests[2].body;
    assert.deepEqual(natives[1].body.input, [...replay1.input, { type: "compaction_trigger" }]);
    assert.deepEqual(natives[1].body.tools, replay1.tools);
    assert.equal(natives[1].body.instructions, replay1.instructions);
    assert.equal(second.details.firstCoveredEntryId, first.id);
    assert.deepEqual(second.details.native.window, [...first.details.native.window.slice(0, -1), compactionItem(2)]);
    const offset = instructionCount(provider);
    const next = h.mock.requests.at(-1).body;
    assert.deepEqual(next.input, [...h.originals[2].input.slice(0, offset), ...second.details.native.window, ...h.originals[2].input.slice(offset + 1)]);
    assert.equal(next.input.some((item) => item.encrypted_content === compactionItem(1).encrypted_content), false);
    assert.equal(capabilities(h).length, 1);
    await h.reopen();
    await h.prompt("After restart.");
    assert.deepEqual(h.mock.requests.at(-1).body.input.slice(offset, offset + second.details.native.window.length), second.details.native.window);
    assert.ok((await h.status()).includes("Native replay: active (responses-trigger)"));
    await h.session.setModel(h.modelRuntime.getModel("pleat-test", "deterministic"));
    await h.prompt("Readable handoff.");
    const handoff = h.requests.at(-1).messages;
    assert.ok(JSON.stringify(handoff).includes(second.summary));
    assert.equal(JSON.stringify(handoff).includes(compactionItem(2).encrypted_content), false);
    assert.ok((await h.status()).includes("Native replay: not active: channel differs"));
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.mock.errors, []);
  });

  test(`${provider}: retained user images select text fallback without disabling the trigger capability`, testOptions, async (t) => {
    const h = await fixture(t, provider);
    await h.prompt("Run noop with this image.", { images: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP5sAAAAASUVORK5CYII=" }] });
    assert.equal(nativeRequests(h).length, 1);
    assert.ok(nativeRequests(h)[0].body.input.some((item) => item.role === "user" && item.content.some((part) => part.type === "input_image")));
    const [entry] = compactions(h);
    assert.equal(entry.details.strategy, "pi-summary");
    assert.equal(entry.details.reason, "native compaction unsupported-content");
    assert.equal(entry.details.native, undefined);
    assert.ok(entry.summary.includes("Readable summary 1"));
    assert.equal(capabilities(h).length, 0);
    assert.equal(h.mock.requests.at(-1).body.input.some((item) => item.type === "compaction"), false);
    assert.deepEqual(h.errors, []);
  });

  test(`${provider}: a 400 unsupported trigger records capability and uses the already generated readable summary`, testOptions, async (t) => {
    const h = await fixture(t, provider, { native(_request, res) { sendJson(res, 400, { error: { type: "invalid_request_error", message: "Unknown input item type compaction_trigger" } }); } });
    await h.prompt("Run noop.");
    const [entry] = compactions(h);
    assert.equal(entry.details.strategy, "pi-summary");
    assert.equal(entry.details.reason, "native compaction unsupported");
    assert.equal(h.requests.length, 1);
    assert.equal(capabilities(h).length, 1);
    assert.equal(capabilities(h)[0].data.feature, "responses-trigger");
    assert.equal(capabilities(h)[0].data.status, "unsupported");
    assert.ok(h.notifications.some((notification) => notification.text.includes("unsupported")));
    await h.prompt("Continue.");
    await bounded(h.session.compact(), "remembered unsupported trigger");
    assert.equal(nativeRequests(h).length, 1);
    assert.equal(compactions(h).at(-1).details.reason, "native compaction unsupported");
    assert.deepEqual(h.errors, []);
  });

  test(`${provider}: custom instructions select fallback before any trigger request`, testOptions, async (t) => {
    const h = await fixture(t, provider, { enabled: false });
    await h.prompt("Run noop.");
    await bounded(h.session.compact("Preserve exact paths."), "custom instruction fallback");
    assert.equal(nativeRequests(h).length, 0);
    assert.equal(compactions(h).length, 1);
    assert.equal(compactions(h)[0].details.strategy, "pi-summary");
    assert.equal(compactions(h)[0].details.reason, "custom-instructions");
    assert.ok(compactions(h)[0].summary.includes("Readable summary 1"));
    assert.deepEqual(h.errors, []);
  });

  for (const retryFails of [false, true]) {
    test(`${provider}: configured readable failure retries the session model${retryFails ? " and keeps history when both fail" : " before committing native state"}`, testOptions, async (t) => {
      let summaryCalls = 0;
      const h = await fixture(t, provider, { enabled: false,
        replies: [{ content: [], stopReason: "error", errorMessage: "Configured summarizer failed" }],
        summary(_request, res) {
          summaryCalls++;
          if (retryFails) return sendJson(res, 401, { error: { message: "Synthetic session summarizer failed", type: "authentication_error" } });
          sendSse(res, responsesMessage({ items: [messageItem("Session readable retry")] }));
        },
      });
      await h.prompt("Run noop.");
      const branchBefore = structuredClone(h.manager.getBranch());
      if (retryFails) {
        await assert.rejects(bounded(h.session.compact(), "failed readable retry"), /cancel/i);
        assert.deepEqual(h.manager.getBranch(), branchBefore);
        assert.equal(compactions(h).length, 0);
        assert.equal(capabilities(h).length, 0);
        assert.ok(h.notifications.some((notification) => notification.text.includes("readable summary failed")));
      } else {
        await bounded(h.session.compact(), "session readable retry");
        assert.equal(compactions(h).length, 1);
        assert.equal(compactions(h)[0].details.strategy, "responses-trigger");
        assert.ok(compactions(h)[0].summary.includes("Session readable retry"));
      }
      assert.equal(nativeRequests(h).length, 1);
      assert.equal(h.requests.length, 1);
      assert.equal(summaryCalls, 1);
      assert.deepEqual(h.errors, []);
    });
  }

  test(`${provider}: native and readable requests run in parallel and state changes discard both results`, testOptions, async (t) => {
    const nativeEntered = Promise.withResolvers(), readableEntered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    const h = await fixture(t, provider, { enabled: false,
      native: async (_request, res) => { nativeEntered.resolve(); await release.promise; sendSse(res, responsesMessage({ items: [compactionItem()] })); },
      replies: [async () => { readableEntered.resolve(); await release.promise; return textReply("stale readable summary"); }],
    });
    await h.prompt("Run noop.");
    const compact = h.session.compact();
    const rejected = assert.rejects(compact, /cancel/i);
    await bounded(Promise.all([nativeEntered.promise, readableEntered.promise]), "parallel compaction start");
    h.manager.appendCustomEntry("changed-during-compaction", true);
    release.resolve();
    await rejected;
    assert.equal(compactions(h).length, 0);
    assert.equal(capabilities(h).length, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(nativeRequests(h).length, 1);
    assert.ok(h.notifications.some((notification) => notification.text.includes("state changed")));
  });

  test(`${provider}: transient requests use three retries then fallback`, testOptions, async (t) => {
    const h = await fixture(t, provider, { native(_request, res) {
      res.setHeader("retry-after-ms", "0");
      sendJson(res, 503, { error: { message: "Synthetic overloaded provider" } });
    } });
    await h.prompt("Run noop.");
    assert.equal(nativeRequests(h).length, 4);
    for (const request of nativeRequests(h)) assert.deepEqual(request.body, nativeRequests(h)[0].body);
    assert.equal(compactions(h).length, 1);
    assert.equal(compactions(h)[0].details.strategy, "pi-summary");
    assert.equal(compactions(h)[0].details.reason, "native compaction transient");
    assert.equal(h.requests.length, 1);
    assert.equal(capabilities(h).length, 0);
  });

  test(`${provider}: invalid native responses keep history and do not retry the readable summary`, testOptions, async (t) => {
    const h = await fixture(t, provider, { enabled: false,
      native(_request, res) { sendJson(res, 401, { error: { message: "Synthetic authorization failure" } }); },
      replies: [{ content: [], stopReason: "error", errorMessage: "Synthetic configured summary failure" }],
    });
    await h.prompt("Run noop.");
    const before = structuredClone(h.manager.getBranch());
    await assert.rejects(bounded(h.session.compact(), "invalid native compaction"), /cancel/i);
    assert.deepEqual(h.manager.getBranch(), before);
    assert.equal(nativeRequests(h).length, 1);
    assert.equal(h.requests.length, 1);
    assert.equal(h.mock.requests.filter((request) => !request.body.tools).length, 0);
    assert.ok(h.notifications.some((notification) => notification.text.includes("authorization")));
  });

  test(`${provider}: abort discards native and readable candidates without capability records`, testOptions, async (t) => {
    const entered = Promise.withResolvers();
    const h = await fixture(t, provider, { enabled: false, native(_request, res) { entered.resolve(res); } });
    await h.prompt("Run noop.");
    const result = h.session.compact();
    const cancelled = assert.rejects(result, /abort|cancel/i);
    const res = await bounded(entered.promise, "native compaction entered");
    h.session.abortCompaction();
    res.destroy();
    await cancelled;
    assert.equal(compactions(h).length, 0);
    assert.equal(capabilities(h).length, 0);
    assert.equal(nativeRequests(h).length, 1);
  });

  test(`${provider}: raw terminal validation rejects missing, altered, empty, or incomplete native state`, testOptions, async (t) => {
    let scripted;
    const h = await fixture(t, provider, { enabled: false, native(_request, res) { sendSse(res, scripted); } });
    const request = (prefixMessages = [{ role: "system", content: "system", timestamp: 0 }, { role: "user", content: "source", timestamp: 0 }]) => requestTriggerCompaction({ ctx: h.ctx, model: h.model, prefixMessages, thinkingLevel: "off", signal: t.signal, splice: (payload) => payload });
    scripted = responsesMessage({ items: [compactionItem()], input: 300, output: 50, cached: 30 });
    assert.deepEqual(await request(), { ok: true, window: [{ role: "user", content: [{ type: "input_text", text: "source" }] }, compactionItem()], usage: usage(270, 50, 30) });
    for (const mutate of [
      (events) => events.filter((event) => event.type !== "response.output_item.done"),
      (events) => events.map((event) => event.type === "response.completed" ? { ...event, response: { ...event.response, output: [{ ...compactionItem(), encrypted_content: "altered" }] } } : event),
      () => responsesMessage({ items: [compactionItem(), compactionItem(2)] }),
      () => responsesMessage({ items: [{ ...compactionItem(), encrypted_content: " " }] }),
      () => responsesMessage({ items: [messageItem("ordinary reply")] }),
      () => responsesMessage({ items: [compactionItem()], status: "in_progress" }),
      () => responsesMessage({ items: [compactionItem()], terminal: "response.incomplete", status: "incomplete" }),
      () => responsesMessage({ items: [compactionItem(), { type: "function_call", id: "fc-extra", call_id: "extra", name: "noop", arguments: "{}" }] }),
    ]) {
      scripted = mutate(responsesMessage({ items: [compactionItem()] }));
      assert.equal((await request()).kind, "invalid");
    }
    scripted = responsesMessage({ items: [compactionItem()] });
    delete scripted.at(-1).response.usage;
    assert.equal((await request()).usage, undefined);
    if (provider === "openai-codex") {
      scripted = responsesMessage({ items: [compactionItem()], terminal: "response.done" });
      assert.equal((await request()).ok, true);
    }
    for (const trailing of [
      (events) => structuredClone(events.at(-1)),
      () => ({ type: "response.done", response: { status: "completed", output: [compactionItem()] } }),
      () => ({ type: "error", code: "overloaded", message: "Synthetic overloaded provider" }),
      () => ({ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "Synthetic overloaded provider" } } }),
      () => ({ type: "response.incomplete", response: { status: "incomplete", output: [] } }),
      () => ({ type: "response.output_item.added", output_index: 1, item: compactionItem(2) }),
      () => ({ type: "response.output_item.done", output_index: 1, item: compactionItem(2) }),
      () => ({ type: "response.output_text.delta", output_index: 1, delta: "late output" }),
    ]) {
      scripted = responsesMessage({ items: [compactionItem()] });
      scripted.push(trailing(scripted));
      const outcome = await request();
      assert.equal(outcome.ok, false);
      assert.equal(outcome.kind, "invalid", `Trailing ${scripted.at(-1).type} must reject the complete HTTP stream`);
    }
    assert.deepEqual(h.mock.errors, []);
  });

  test(`${provider}: complete raw SSE parsing checks multiline data and trailing frames beyond Pi's completion`, testOptions, async (t) => {
    let raw;
    const h = await fixture(t, provider, { enabled: false, native(_request, res) {
      res.writeHead(200, { "content-type": "text/event-stream", "content-length": Buffer.byteLength(raw) });
      res.end(raw);
    } });
    const request = () => requestTriggerCompaction({ ctx: h.ctx, model: h.model,
      prefixMessages: [{ role: "user", content: "source", timestamp: 0 }], thinkingLevel: "off", signal: t.signal, splice: (payload) => payload });
    const frames = responsesMessage({ items: [compactionItem()] }).map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    for (const body of [frames,
      responsesMessage({ items: [compactionItem()] }).map((event) => JSON.stringify(event, null, 2).split("\n").map((line) => `data: ${line}`).join("\n") + "\n\n").join(""),
      frames + "data: [DONE]\n\n: keepalive\n\n"]) {
      raw = body;
      assert.equal((await request()).ok, true);
    }
    raw = frames.replaceAll("\n", "\r\n");
    const crlf = await request();
    // Pi 1.2.0's Codex parser recognizes only LF/LF frame separators. A
    // complete raw response cannot bypass the required normalized stop gate.
    if (provider === "openai-codex") assert.equal(crlf.kind, "invalid");
    else assert.equal(crlf.ok, true);
    for (const suffix of ["data: {invalid}\n\n", "data: [DONE]\n\ndata: {invalid}\n\n",
      `data: [DONE]\n\ndata: ${JSON.stringify({ type: "response.output_item.done", item: compactionItem(2) })}\n\n`]) {
      raw = frames + suffix;
      assert.equal((await request()).kind, "invalid");
    }
    assert.deepEqual(h.mock.errors, []);
  });

  test(`${provider}: a failure after completion preserves history and reports integrity`, testOptions, async (t) => {
    const h = await fixture(t, provider, { enabled: false,
      native(_request, res) {
        sendSse(res, [...responsesMessage({ items: [compactionItem()] }),
          { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "Synthetic overloaded provider" } } }]);
      },
    });
    await h.prompt("Run noop.");
    const before = structuredClone(h.manager.getBranch());
    await assert.rejects(bounded(h.session.compact(), "trailing failure compaction"), /cancel/i);
    assert.deepEqual(h.manager.getBranch(), before);
    assert.equal(nativeRequests(h).length, 1);
    assert.equal(h.requests.length, 1);
    assert.equal(capabilities(h).length, 0);
    assert.ok(h.notifications.some((notification) => notification.text.includes("integrity")));
    assert.deepEqual(h.errors, []);
  });

  test(`${provider}: native HTTP, network, and registry failures are classified without committing history`, testOptions, async (t) => {
    let code = 400, text = "compaction_trigger unsupported";
    const h = await fixture(t, provider, { enabled: false, native(_request, res) {
      if (code === 0) return res.destroy();
      if (code < 0) {
        res.writeHead(-code, { "content-type": "application/json", "content-length": 1000, connection: "close" });
        return res.end("{}"); // Close before the declared body length arrives.
      }
      res.setHeader("retry-after-ms", "0");
      sendJson(res, code, { error: { type: "invalid_request_error", message: text } });
    } });
    const args = { ctx: h.ctx, model: h.model, prefixMessages: [{ role: "user", content: "source", timestamp: 0 }], thinkingLevel: "off", signal: t.signal, splice: (payload) => payload };
    for (const [status, message, kind] of [[400, "compaction_trigger unsupported", "unsupported"], [404, "missing", "unsupported"], [400, "unrelated request invalid", "invalid"], [401, "auth failure", "invalid"], [403, "forbidden", "invalid"], [429, "busy", "transient"], [503, "busy", "transient"], [0, "network", "transient"], [-200, "truncated body", "transient"], [-401, "truncated auth error", "invalid"], [-404, "truncated unsupported error", "unsupported"]]) {
      code = status; text = message;
      assert.equal((await requestTriggerCompaction(args)).kind, kind);
    }
    const count = h.mock.requests.length;
    const invalid = await requestTriggerCompaction({ ...args, model: { ...h.model, provider: "missing-responses-provider" } });
    assert.equal(invalid.kind, "invalid");
    assert.equal(h.mock.requests.length, count);
    assert.equal(compactions(h).length, 0);
    if (provider === "openai-codex") {
      h.modelRuntime.registerProvider(provider, { apiKey: "invalid-jwt" });
      assert.equal((await requestTriggerCompaction(args)).kind, "invalid");
      assert.equal(h.mock.requests.length, count);
    }
  });
}

test("Responses predicates select only the two specified physical provider/API pairs", testOptions, () => {
  for (const [provider, api, expected] of [["openai", "openai-responses", true], ["openai-codex", "openai-codex-responses", true], ["proxy", "openai-responses", false], ["openai", "openai-completions", false], ["openai", "openai-codex-responses", false], ["openai-codex", "openai-responses", false]]) assert.equal(isResponsesTrigger({ provider, api }), expected);
});

test("Responses retained-user budget keeps whole newest items and stops at the first item that does not fit", testOptions, async (t) => {
  const h = await fixture(t, "openai-codex", { enabled: false });
  const users = ["older-small", "x".repeat(256001), "a".repeat(128000), "b".repeat(128000)];
  const result = await requestTriggerCompaction({ ctx: h.ctx, model: h.model, thinkingLevel: "off", signal: t.signal,
    prefixMessages: users.map((content) => ({ role: "user", content, timestamp: 0 })),
    splice(payload) { return { ...payload, input: payload.input.map((item, index) => ({ ...item, type: "message", id: `retained-${index}`, metadata: { exact: true } })) }; } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.window, [...nativeRequests(h)[0].body.input.slice(2, -1), compactionItem()]);
  assert.equal(result.window.length, 3);
});

for (const provider of ["openai-codex", "openai"]) {
  test(`${provider}: a native window that cannot fit the next session request preserves history`, testOptions, async (t) => {
    const h = await fixture(t, provider, { enabled: false, native(_request, res) {
      sendSse(res, responsesMessage({ items: [{ ...compactionItem(), encrypted_content: "x".repeat(80000) }] }));
    } });
    await h.prompt("Run noop.");
    const before = structuredClone(h.manager.getBranch());
    await assert.rejects(bounded(h.session.compact(), "reject oversized native window"), /cancel/i);
    assert.deepEqual(h.manager.getBranch(), before);
    assert.equal(nativeRequests(h).length, 1);
    assert.equal(h.requests.length, 1);
    assert.ok(h.notifications.some((notice) => notice.text === "Compaction skipped: compacted context does not fit the window."));
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.mock.errors, []);
  });

  for (const [nativeKnown, readableKnown] of [[false, true], [true, false], [false, false]]) {
    test(`${provider}: compaction usage tracks known native=${nativeKnown} and readable=${readableKnown} counts`, testOptions, async (t) => {
      const h = await fixture(t, provider, { enabled: false,
        native(_request, res) {
          const events = responsesMessage({ items: [compactionItem()], input: 300, output: 50, cached: 30 });
          if (!nativeKnown) delete events.at(-1).response.usage;
          sendSse(res, events);
        },
        replies: [{ content: textReply("Readable summary"), usage: readableKnown ? usage(10, 2) : usage(0, 0) }],
      });
      await h.prompt("Run noop.");
      await bounded(h.session.compact(), "partial usage compaction");
      const [entry] = compactions(h);
      assert.equal(entry.details.strategy, "responses-trigger");
      assert.equal(readPleatDetails(entry).usageComplete, false);
      assert.deepEqual(entry.usage, nativeKnown ? usage(270, 50, 30) : readableKnown ? usage(10, 2) : undefined);
      const expected = nativeKnown ? "usage 300 in / 50 out · $0.0000 (partial)"
        : readableKnown ? "usage 10 in / 2 out · $0.0000 (partial)" : "usage unknown in / unknown out · $unknown";
      assert.ok((await h.status()).includes(expected));
      await h.reopen();
      assert.equal(readPleatDetails(compactions(h)[0]).usageComplete, false);
      assert.ok((await h.status()).includes(expected));
    });
  }

  test(`${provider}: truncated transient errors preserve a valid retry-after when retry-after-ms is invalid`, testOptions, async (t) => {
    const h = await fixture(t, provider, { enabled: false, native(_request, res) {
      res.writeHead(503, { "content-type": "application/json", "content-length": 1000, connection: "close",
        "retry-after-ms": "invalid", "retry-after": "2" });
      res.end("{}");
    } });
    const result = await requestTriggerCompaction({ ctx: h.ctx, model: h.model,
      prefixMessages: [{ role: "user", content: "source", timestamp: 0 }], thinkingLevel: "off", signal: t.signal, splice: (payload) => payload });
    assert.equal(result.kind, "transient");
    assert.equal(result.retryAfter, 2000);
    assert.deepEqual(h.mock.errors, []);
  });
}
