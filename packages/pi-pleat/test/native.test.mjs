import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { zstdDecompressSync } from "node:zlib";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// Explicit opt-in: these checks make real, billable model requests.
const live = process.env.PI_CONTEXT_LIVE === "1";
const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { ReadOnlyAuthStorage } = await import(new URL("./core/auth-storage.js", piEntry));
const { InMemoryCodingAgentModelsStore } = await import(new URL("./core/models-store.js", piEntry));
const systemPrompt = "You are helping with a synthetic context-management test. Preserve the project identifier and constraints. Give concise answers.";
const user = (text) => ({ role: "user", content: text, timestamp: Date.now() });
const textOf = (message) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

async function createRuntime() {
  // Refuse credential mutations, including OAuth refresh, before they run.
  // A refresh in a copied store could invalidate the user's original token.
  return ModelRuntime.create({
    credentials: new ReadOnlyAuthStorage(),
    modelsStore: new InMemoryCodingAgentModelsStore(),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
}

function diagnostic(t, name, data) {
  t.diagnostic(JSON.stringify({ step: name, ...data }));
}

function assertResponse(result, label) {
  assert.equal(result.stopReason, "stop", `${label}: ${result.errorMessage ?? result.stopReason}`);
}

async function captureRequest(input, init, observe) {
  const request = new Request(input, init);
  const bytes = Buffer.from(await request.clone().arrayBuffer());
  const encoding = request.headers.get("content-encoding");
  assert.ok(!encoding || encoding === "zstd", "Unexpected request content encoding");
  const body = JSON.parse((encoding === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8"));
  observe(request, body);
  return fetch(request, { redirect: "error" });
}

function strictAnthropic(payload, compaction = false) {
  const next = structuredClone(payload);
  next.betas = [...new Set([
    ...(next.betas ?? []),
    "compact-2026-09-04",
    "context-management-2025-06-27",
  ])];
  assert.ok(next.thinking, "The request must enable thinking");
  next.thinking.block_binding = {
    ...next.thinking.block_binding,
    prefix_mismatch_behavior: "error",
  };
  if (compaction) {
    next.compaction = { type: "summarize" };
    delete next.context_management;
    delete next.stop_sequences;
    delete next.tool_choice;
    if (next.output_config) delete next.output_config.format;
  } else {
    // Validates acceptance of the plan's configuration. This small fixture does
    // NOT reach the clearing threshold and does not prove tools were cleared.
    next.context_management = {
      edits: [
        { type: "clear_thinking_20251015", keep: "all" },
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: 40_000 },
          keep: { type: "tool_uses", value: 8 },
          clear_at_least: { type: "input_tokens", value: 20_000 },
          clear_tool_inputs: false,
        },
      ],
    };
  }
  return next;
}

test("live Anthropic: two signed compactions and strict preserved-thinking replay", {
  skip: !live,
  timeout: 240_000,
}, async (t) => {
  const runtime = await createRuntime();
  const model = runtime.getModel("anthropic", process.env.PI_CONTEXT_ANTHROPIC_MODEL ?? "claude-sonnet-5-5");
  assert.ok(model, "Configured Anthropic model must exist");
  const marker = `project-${randomUUID()}`;
  const first = user(`Project identifier: ${marker}. Seven indivisible jobs have durations 17, 23, 31, 43, 59, 71, and 89 seconds. Two workers run in parallel, each processing its jobs sequentially. Worker A must receive exactly three jobs and worker B receives the rest. Find an assignment minimizing the time when both workers are finished, and explain why a smaller time is impossible. Include the project identifier. Preserve the job durations and constraints for subsequent questions.`);

  async function request(messages, transform) {
    let sent;
    let wire;
    let wireBetas;
    let status;
    let rawStop;
    let rawUsage;
    const blocks = [];
    const rawBlockTypes = [];
    const transformations = [];
    const result = await runtime.streamSimple(model, { systemPrompt, messages }, {
      reasoning: "high",
      maxTokens: 4096,
      maxRetries: 0,
      cacheRetention: "none",
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(60_000)]),
      fetch: (input, init) => captureRequest(input, init, (request, body) => {
        wire = body;
        wireBetas = (request.headers.get("anthropic-beta") ?? "").split(",").map((value) => value.trim());
      }),
      onPayload(payload) {
        sent = transform(payload);
        return sent;
      },
      onResponse(response) { status = response.status; },
      onProviderStreamEvent(event) {
        if (event.type === "content_block_start") rawBlockTypes.push(event.content_block?.type);
        if (event.type === "content_block_start" && event.content_block?.type === "compaction") {
          blocks.push(structuredClone(event.content_block));
        }
        const changes = event.input_transformations ?? event.message?.input_transformations;
        if (Array.isArray(changes)) transformations.push(...changes);
        if (event.type === "message_delta") {
          rawStop = event.delta?.stop_reason;
          rawUsage = event.usage;
        }
      },
    }).result();
    if (wire) {
      for (const field of ["messages", "system", "tools", "thinking", "context_management", "compaction", "output_config"]) {
        assert.ok(isDeepStrictEqual(wire[field], sent[field]), `Transport must preserve ${field}`);
      }
      assert.equal(wire.thinking?.block_binding?.prefix_mismatch_behavior, "error",
        "Strict prefix binding must be present in the actual HTTP request");
      assert.ok(sent.betas.every((beta) => wireBetas.includes(beta)), "Transport must include every requested beta");
    }
    return { result, sent: wire, status, rawStop, rawUsage, blocks, transformations, rawBlockTypes };
  }

  let previous = await request([first], (payload) => strictAnthropic(payload));
  assertResponse(previous.result, "baseline");
  diagnostic(t, "anthropic-baseline-observation", {
    model: model.id, responseModel: previous.result.responseModel,
    status: previous.status, rawBlockTypes: previous.rawBlockTypes,
    contentTypes: previous.result.content.map((part) => part.type),
    thinking: previous.sent.thinking, usage: previous.result.usage,
  });
  assert.ok(previous.result.content.some((part) => part.type === "thinking" && part.thinkingSignature),
    "A successful request without signed thinking cannot validate preserved thinking");
  assert.ok(textOf(previous.result).includes(marker), "Baseline must retain the synthetic identifier");
  diagnostic(t, "anthropic-baseline", {
    model: model.id, status: previous.status,
    signedThinking: true, usage: previous.result.usage,
  });

  for (let round = 1; round <= 2; round++) {
    const prefix = previous.sent;
    const compacted = await request([first], (payload) => {
      const next = strictAnthropic(payload, true);
      next.messages = structuredClone(prefix.messages);
      next.system = structuredClone(prefix.system);
      if (prefix.tools === undefined) delete next.tools;
      else next.tools = structuredClone(prefix.tools);
      return next;
    });
    diagnostic(t, `anthropic-compact-${round}`, {
      status: compacted.status, rawStop: compacted.rawStop,
      blockCount: compacted.blocks.length,
      normalizedStop: compacted.result.stopReason,
      adapterError: compacted.result.errorMessage,
      rawUsage: compacted.rawUsage,
    });
    assert.equal(compacted.status, 200, "Compaction must receive HTTP 200");
    assert.equal(compacted.rawStop, "compaction", "Require the provider's terminal compaction reason");
    assert.equal(compacted.blocks.length, 1, "Require exactly one signed compaction block");
    const block = compacted.blocks[0];
    assert.ok(typeof block.content === "string" && block.content.length > 0);
    assert.ok(typeof block.signature === "string" && block.signature.length > 0);
    // Pi 1.2.0 does not normalize the compaction stop reason. Record that
    // limitation explicitly; no production session is committed by this test.
    if (compacted.result.stopReason === "error") {
      assert.equal(compacted.result.errorMessage, "Unhandled stop reason: compaction");
    } else {
      assert.equal(compacted.result.stopReason, "stop");
    }
    const kept = previous.result;
    const signatures = kept.content.filter((part) => part.type === "thinking").map((part) => part.thinkingSignature);
    assert.ok(signatures.length > 0 && signatures.every(Boolean), "Each kept reply must contain signed thinking");
    let keptWire;
    const followup = user(`Add one more indivisible job of ${round === 1 ? 97 : 101} seconds to the existing jobs. Keep the same two workers and the exactly-three-jobs constraint for worker A. Recompute the optimal assignment and justify its minimality. Include the project identifier.`);
    const replay = await request([first, kept, followup], (payload) => {
      const next = strictAnthropic(payload);
      assert.ok(isDeepStrictEqual(next.system, prefix.system), "System prompt must remain unchanged");
      assert.ok(isDeepStrictEqual(next.tools, prefix.tools), "Tool definitions must remain unchanged");
      const assistantIndex = next.messages.findIndex((message) => message.role === "assistant");
      assert.ok(assistantIndex >= 0, "Locate the kept assistant reply after Pi's effort messages");
      keptWire = structuredClone(next.messages[assistantIndex]);
      const wireSignatures = keptWire.content.filter((part) => part.type === "thinking").map((part) => part.signature);
      assert.ok(isDeepStrictEqual(wireSignatures, signatures), "Pi must retain every kept thinking signature");
      // Pi can insert a historical effort system message before this reply.
      // That state is already inside the compacted prefix; retain from the
      // assistant boundary, rather than assuming the first message is a user.
      next.messages = [
        { role: "assistant", content: [structuredClone(block)] },
        ...next.messages.slice(assistantIndex),
      ];
      return next;
    });
    assertResponse(replay.result, `replay ${round}`);
    assert.ok(isDeepStrictEqual(replay.sent.messages[0].content, [block]), "Transport must preserve the signed block");
    assert.ok(isDeepStrictEqual(replay.sent.messages[1], keptWire), "The exact kept reply must directly follow the block");
    assert.deepEqual(replay.transformations, [], "Strict replay must not report input transformations");
    assert.ok(textOf(replay.result).includes(marker), "The replayed window must retain the identifier");
    diagnostic(t, `anthropic-replay-${round}`, {
      status: replay.status, identifierRecoveredFromWindow: true, reportedTransformations: 0,
      strictBindingOnWire: replay.sent.thinking.block_binding.prefix_mismatch_behavior,
      signedThinkingReplayed: signatures.length,
      usage: replay.result.usage,
    });
    previous = replay;
  }
});

test("live OpenAI Codex: Responses compaction_trigger supports two compact-replay cycles", {
  skip: !live,
  timeout: 240_000,
}, async (t) => {
  const runtime = await createRuntime();
  const model = runtime.getModel("openai-codex", process.env.PI_CONTEXT_OPENAI_MODEL ?? "gpt-6-astra");
  assert.ok(model, "Configured OpenAI Codex model must exist");
  const marker = `project-${randomUUID()}`;
  // The marker exists only in an assistant message that will be removed.
  // Retained user messages cannot answer the later lookup on their own.
  const seed = [
    user("Keep the project identifier assigned in the following assistant message. Only reveal it when requested."),
    {
      role: "assistant",
      content: [{ type: "text", text: `The assigned project identifier is ${marker}.` }],
      api: model.api, provider: model.provider, model: model.id,
      stopReason: "stop", timestamp: Date.now(),
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    user("Acknowledge readiness with READY only."),
  ];

  async function request(input) {
    let sent;
    let wire;
    let completed;
    let status;
    let endpoint;
    let completedCount = 0;
    const output = [];
    const failedEvents = [];
    const result = await runtime.streamSimple(model, { systemPrompt, messages: seed }, {
      reasoning: "low",
      maxTokens: 1024,
      maxRetries: 0,
      transport: "sse",
      cacheRetention: "none",
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(60_000)]),
      fetch: (url, init) => captureRequest(url, init, (request, body) => {
        endpoint = new URL(request.url);
        wire = body;
      }),
      onPayload(payload) {
        // Pi can emit optional fields such as phase: undefined for assistant
        // text. Snapshot JSON values, which are what the transport can send.
        sent = JSON.parse(JSON.stringify(payload));
        if (input) sent.input = structuredClone(input);
        return sent;
      },
      onResponse(response) { status = response.status; },
      onProviderStreamEvent(event) {
        if (["error", "response.failed", "response.incomplete"].includes(event.type)) failedEvents.push(event.type);
        if (event.type === "response.output_item.done") output.push(structuredClone(event.item));
        if (event.type === "response.completed") {
          completed = structuredClone(event.response);
          completedCount++;
        }
      },
    }).result();
    assertResponse(result, "OpenAI Responses");
    assert.deepEqual(failedEvents, [], "Failed or incomplete streams cannot supply replayable state");
    assert.equal(status, 200, "Require a successful Responses request");
    assert.equal(completedCount, 1, "Require exactly one terminal response.completed event");
    assert.equal(completed?.status, "completed", "An incomplete response cannot supply compaction state");
    assert.ok(Array.isArray(completed.output), "Require a completed output window");
    assert.ok(isDeepStrictEqual(output, completed.output), "Completed output must match the finalized stream items");
    assert.ok(isDeepStrictEqual(wire?.input, sent.input), "Transport must send the intended complete input");
    assert.equal(wire.store, false, "Use stateless input-array replay");
    assert.equal(wire.previous_response_id, undefined, "Replay must not depend on server-side history");
    return { result, sent: wire, output, completed, status, endpoint };
  }

  let previous = await request();
  const endpoint = previous.endpoint;
  assert.ok(endpoint?.pathname.endsWith("/responses"), "Use the actual configured Responses endpoint");
  assert.ok(JSON.stringify(previous.sent.input).includes(marker),
    "The original assistant-only fact must reach the provider");
  diagnostic(t, "codex-baseline", {
    model: model.id, status: previous.status,
    endpoint: endpoint.origin + endpoint.pathname,
    usage: previous.result.usage,
  });
  for (let round = 1; round <= 2; round++) {
    const history = [...previous.sent.input, ...previous.output];
    assert.equal(history.some((item) => item.type === "compaction_trigger"), false,
      "A compaction trigger is request control, not persistent history");
    const compacted = await request([...history, { type: "compaction_trigger" }]);
    assert.equal(compacted.endpoint.href, endpoint.href, "Use the same authenticated Responses endpoint");
    assert.deepEqual(compacted.sent.input.at(-1), { type: "compaction_trigger" });
    const compactionItems = compacted.output.filter((item) => item.type === "compaction");
    diagnostic(t, `codex-compact-${round}`, {
      status: compacted.status, endpoint: endpoint.origin + endpoint.pathname,
      outputTypes: compacted.output.map((item) => item.type),
      completed: true, usage: compacted.completed.usage,
    });
    assert.equal(compactionItems.length, 1, "Require exactly one finalized compaction item");
    const block = compactionItems[0];
    assert.ok(typeof block.encrypted_content === "string" && block.encrypted_content.length > 0,
      "Require nonempty encrypted compaction state");
    // This fixture has only ordinary user/assistant/compaction items.
    // Follow Codex's streamed-compaction policy: retained user messages, then
    // the complete new compaction item. Standalone /compact has a different
    // contract: its entire returned window must be used without pruning.
    const retained = history.filter((item) => item.role === "user");
    assert.equal(JSON.stringify(retained).includes(marker), false,
      "The retained plaintext must not contain the answer");
    const input = [
      ...structuredClone(retained),
      structuredClone(block),
      { role: "user", content: "What is the recorded project identifier? Reply with the exact identifier only." },
    ];
    const replay = await request(input);
    assert.equal(replay.endpoint.href, endpoint.href);
    assert.equal(replay.sent.input.length, retained.length + 2, "No covered assistant history may be reinserted");
    assert.ok(isDeepStrictEqual(replay.sent.input[retained.length], block),
      "Replay the complete compaction item without altering encrypted state or metadata");
    const plaintext = replay.sent.input.map(({ encrypted_content: _encrypted, ...item }) => item);
    assert.equal(JSON.stringify({ ...replay.sent, input: plaintext }).includes(marker), false,
      "The actual replay body must not contain the removed plaintext answer");
    assert.equal(textOf(replay.result).trim(), marker, "Recover the identifier from the compacted state");
    diagnostic(t, `codex-replay-${round}`, {
      status: replay.status, compactionItems: 1,
      exactCompactionItemReplayed: true, answerAbsentFromPlaintext: true,
      identifierRecovered: true, usage: replay.completed.usage,
    });
    previous = replay;
  }
});
