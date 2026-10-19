import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendTool, createHarness, testOptions, textReply, toolCall } from "./harness.mjs";

const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };

test("recall selects entry IDs, full call IDs, and the prefix before a pipe", testOptions, async (t) => {
  const h = await createHarness(t);
  const content = [{ type: "text", text: "écho output", textSignature: "local-text-metadata" }, image];
  const saved = appendTool(h.manager, { id: "call-1|item-1", name: "bash", args: { command: "npm test", path: "ignored" }, content, isError: true });
  for (const id of [saved.entryId, "call-1|item-1", "call-1", ` ${saved.entryId} `]) {
    const result = await h.recall({ id });
    assert.equal(result.content[0].text, `[${saved.entryId} · bash "npm test" · ${formatSize(Buffer.byteLength("écho output"))} · error]`);
    assert.deepEqual(result.content.slice(1), content);
    assert.deepEqual(result.details, { entryId: saved.entryId, toolName: "bash", mode: "id", others: 0, truncated: false });
  }
  // Entry IDs take precedence when a different tool happens to use that ID.
  appendTool(h.manager, { id: saved.entryId, content: textReply("different result") });
  assert.equal((await h.recall({ id: saved.entryId })).content[1].text, "écho output");
  assert.equal(h.requests.length, 0);
});

test("recall queries return the newest match and up to five other IDs, excluding recall", testOptions, async (t) => {
  const h = await createHarness(t);
  const ids = [];
  for (let index = 0; index < 7; index++) {
    ids.push(appendTool(h.manager, {
      id: `search-${index}`, name: "read", args: { path: "src/example.ts" },
      content: textReply(`build output ${index}`),
    }).entryId);
  }
  appendTool(h.manager, { id: "recall-previous", name: "recall", args: { query: "build example" }, content: textReply("build src/example.ts") });
  const result = await h.recall({ query: "  BUILD   example.ts  " });
  assert.equal(result.details.entryId, ids.at(-1));
  assert.equal(result.details.others, 6);
  assert.equal(result.details.mode, "query");
  assert.equal(result.content[1].text, "build output 6");
  assert.equal(result.content.at(-1).text, `Other matches: ${ids.slice(1, 6).reverse().join(", ")}`);
  for (const query of ["READ", "src/example.ts", "output 6"]) {
    assert.equal((await h.recall({ query })).details.entryId, ids.at(-1));
  }
  const self = h.manager.getBranch().at(-1);
  assert.equal((await h.recall({ id: self.id })).details.toolName, "recall");
});

test("recall is branch-local and keeps compressed and cleared originals after reopen", testOptions, async (t) => {
  const h = await createHarness(t);
  const early = appendTool(h.manager, { id: "early", content: textReply("original before compaction") });
  const fork = h.manager.getLeafId();
  const sibling = appendTool(h.manager, { id: "sibling", content: textReply("sibling-only-value") });
  h.manager.branch(fork);
  const current = appendTool(h.manager, { id: "current", content: textReply("current-only-value") });
  h.manager.appendContextEdit(early.entryId, { content: textReply("cleared") });
  h.manager.appendCompaction("A fixed summary.", current.assistantId, 100);
  assert.equal(h.manager.buildSessionContext().messages.some((message) => JSON.stringify(message).includes("original before compaction")), false);
  assert.equal((await h.recall({ id: early.entryId })).content[1].text, "original before compaction");
  await assert.rejects(h.recall({ id: sibling.entryId }), { message: `No original tool result or compacted message with id ${sibling.entryId} on the current branch. Use query with a command, path, or message text.` });
  await assert.rejects(h.recall({ query: "sibling-only-value" }), { message: 'No original tool result or compacted message matches "sibling-only-value". Try a shorter query or text from the message or call.' });
  await h.reopen();
  assert.equal((await h.recall({ id: early.entryId })).content[1].text, "original before compaction");
  assert.equal((await h.recall({ query: "current-only-value" })).details.entryId, current.entryId);
  await assert.rejects(h.recall({ id: sibling.entryId }), /on the current branch/);
  assert.deepEqual(h.errors, []);
});

for (const [label, text] of [
  ["bytes", Array.from({ length: 800 }, () => "é".repeat(50)).join("\n")],
  ["lines", Array.from({ length: 2100 }, (_, index) => `line ${index}`).join("\n")],
  ["one long line", "a".repeat(60000)],
]) {
  test(`recall truncates by ${label}, saves full text, and preserves images`, testOptions, async (t) => {
    const h = await createHarness(t);
    const saved = appendTool(h.manager, { id: "large", content: [...textReply(text), image] });
    const result = await h.recall({ id: saved.entryId });
    t.after(() => rm(dirname(result.details.file), { recursive: true, force: true }));
    const head = truncateHead(text);
    assert.equal(result.details.truncated, true);
    assert.equal(await readFile(result.details.file, "utf8"), text);
    assert.equal(result.details.file.endsWith(`${saved.entryId}.txt`), true);
    assert.equal(result.content[1].text, `${head.content}\n\n[Showing lines 1-${head.outputLines} of ${head.totalLines} (${formatSize(head.outputBytes)} of ${formatSize(head.totalBytes)}). Full output: ${result.details.file}. Use read with offset to continue.]`);
    assert.deepEqual(result.content[2], image);
    assert.deepEqual(Object.keys(result.details).sort(), ["entryId", "file", "mode", "others", "toolName", "truncated"]);
    await writeFile(result.details.file, "changed file");
    await h.recall({ id: saved.entryId });
    assert.equal(await readFile(result.details.file, "utf8"), text);
  });
}

test("recall reports saved fragments and checks fullOutputPath at recall time", testOptions, async (t) => {
  const h = await createHarness(t);
  const file = join(h.root, "full-output.txt");
  await writeFile(file, "full output");
  const saved = appendTool(h.manager, { id: "fragment", content: textReply("saved fragment"), details: { fullOutputPath: file } });
  let result = await h.recall({ id: saved.entryId });
  assert.equal(result.content[0].text.endsWith(`\nPi kept only this part of the output. Full output file: ${file} (exists).`), true);
  assert.equal(result.content[1].text, "saved fragment");
  await rm(file);
  result = await h.recall({ id: saved.entryId });
  assert.equal(result.content[0].text.endsWith(`Full output file: ${file} (missing).`), true);
  const partial = appendTool(h.manager, { id: "truncation", details: { truncation: { truncated: true } } });
  assert.equal((await h.recall({ id: partial.entryId })).content[0].text.endsWith("\nPi kept only this part of the output."), true);
});

test("recall validates arguments and returns fixed, actionable errors", testOptions, async (t) => {
  const h = await createHarness(t);
  for (const params of [{}, { id: " " }, { query: "\t" }, { id: "one", query: "two" }, { id: "", query: "" }]) {
    await assert.rejects(h.recall(params), { message: "Pass either id or query." });
  }
  await assert.rejects(h.recall({ id: "missing" }), { message: "No original tool result or compacted message with id missing on the current branch. Use query with a command, path, or message text." });
  await assert.rejects(h.recall({ query: "absent" }), { message: 'No original tool result or compacted message matches "absent". Try a shorter query or text from the message or call.' });
  const args = { other: "a".repeat(100) };
  const saved = appendTool(h.manager, { id: "args", args });
  assert.ok((await h.recall({ id: saved.entryId })).content[0].text.includes(`${JSON.stringify(args).slice(0, 80)}…`));
  const noArgs = appendTool(h.manager, { id: "empty" });
  assert.equal((await h.recall({ id: noArgs.entryId })).content[0].text, `[${noArgs.entryId} · output · 12B]`);
});

test("the registered recall tool runs through Pi and returns the saved model-visible version", testOptions, async (t) => {
  let original;
  const h = await createHarness(t, {
    tools: ["recall", "saved"],
    replies: [[toolCall("save", "saved")], textReply("saved"),
      () => [toolCall("retrieve", "recall", { id: original.id })], textReply("recalled")],
    configure(pi) {
      pi.registerTool({ name: "saved", label: "Saved", description: "Return a fixed value.", parameters: Type.Object({}), execute: async () => ({ content: textReply("value to redact"), details: {} }) });
      pi.on("message_end", (event) => event.message.role === "toolResult" && event.message.toolName === "saved"
        ? { message: { ...event.message, content: textReply("[redacted]") } } : undefined);
    },
  });
  await h.prompt("Save output.");
  original = h.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult");
  await h.prompt("Recall output.");
  const recalled = h.requests.at(-1).messages.find((message) => message.role === "toolResult" && message.toolName === "recall");
  assert.equal(recalled.isError, false);
  assert.equal(recalled.content[1].text, "[redacted]");
  assert.equal(JSON.stringify(recalled).includes("value to redact"), false);
  const tool = h.session.getToolDefinition("recall");
  assert.equal(tool.promptSnippet, undefined);
  assert.equal(tool.promptGuidelines, undefined);
  assert.deepEqual(h.errors, []);
});
