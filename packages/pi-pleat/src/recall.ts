import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, formatSize, truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { isRecord, toolRecords } from "./session.ts";
import type { ToolRecord } from "./session.ts";

type RecallRecord = ({ kind: "tool" } & ToolRecord) | {
  kind: "chat";
  entryId: string;
  index: number;
  role: "user" | "assistant";
  content: TextContent[];
};

function recallRecords(branch: SessionEntry[]): RecallRecord[] {
  const records: RecallRecord[] = toolRecords(branch).map((record) => ({ kind: "tool", ...record }));
  const compactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
  const compaction = branch[compactionIndex];
  const kept = compaction?.type === "compaction"
    ? branch.findIndex((entry, index) => index <= compactionIndex && entry.id === compaction.firstKeptEntryId)
    : -1;
  for (let index = 0; index < kept; index++) {
    const entry = branch[index];
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content: TextContent[] = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content.filter((block) => block.type === "text").map((block) => ({ type: "text", text: block.text }));
    if (!content.length) continue;
    records.push({ kind: "chat", entryId: entry.id, index, role: message.role, content });
  }
  return records.sort((a, b) => a.index - b.index);
}

function argSummary(args: ToolRecord["args"]): string {
  if (!args || !Object.keys(args).length) return "";
  for (const key of ["command", "path", "pattern", "query", "url"]) {
    if (typeof args[key] === "string") return ` ${JSON.stringify(args[key])}`;
  }
  const text = JSON.stringify(args);
  return ` ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`;
}

type RecallDetails = {
  entryId: string;
  mode: "id" | "query";
  others: number;
  truncated: boolean;
  file?: string;
} & ({ toolName: string } | { role: "user" | "assistant" });

export const recallTool = defineTool({
  name: "recall",
  label: "Recall",
  description: "Get original tool results or text from compacted user/assistant messages on this branch.\nPass `id` (entry or tool call ID), or `query` (command, path, tool name, or text) for the newest match.",
  parameters: Type.Object({ id: Type.Optional(Type.String()), query: Type.Optional(Type.String()) }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const id = params.id?.trim();
    const query = params.query?.trim();
    if (Boolean(id) === Boolean(query)) {
      throw new Error("Pass either id or query.");
    }
    const records = recallRecords(ctx.sessionManager.getBranch());
    let record: RecallRecord | undefined;
    let others: RecallRecord[] = [];
    if (id) {
      record = records.find((candidate) => candidate.entryId === id) ??
        records.find((candidate) => candidate.kind === "tool" && candidate.toolCallId === id) ??
        records.find((candidate) => candidate.kind === "tool" && candidate.toolCallId.split("|")[0] === id);
      if (!record) {
        throw new Error(`No original tool result or compacted message with id ${id} on the current branch. Use query with a command, path, or message text.`);
      }
    } else {
      const normalized = query!.toLowerCase().replace(/\s+/g, " ");
      const terms = normalized.split(" ");
      const matches = records.filter((candidate) => {
        if (candidate.kind === "tool" && candidate.toolName === "recall") return false;
        const text = candidate.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
        const label = candidate.kind === "tool" ? `${candidate.toolName}\n${JSON.stringify(candidate.args ?? {})}` : candidate.role;
        const haystack = `${label}\n${text}`.toLowerCase();
        return haystack.includes(normalized) || terms.every((term) => haystack.includes(term));
      }).reverse();
      record = matches[0];
      others = matches.slice(1);
      if (!record) {
        throw new Error(`No original tool result or compacted message matches "${query}". Try a shorter query or text from the message or call.`);
      }
    }
    const texts = record.content.flatMap((block) => block.type === "text" ? [block.text] : []);
    const bytes = texts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
    const label = record.kind === "tool" ? `${record.toolName}${argSummary(record.args)}` : record.role;
    let source = `[${record.entryId} · ${label} · ${formatSize(bytes)}${record.kind === "tool" && record.isError ? " · error" : ""}]`;
    const saved = record.kind === "tool" && isRecord(record.details) ? record.details : {};
    const fullOutputPath = typeof saved.fullOutputPath === "string" ? saved.fullOutputPath : undefined;
    if ((isRecord(saved.truncation) && saved.truncation.truncated === true) || fullOutputPath !== undefined) {
      source += "\nPi kept only this part of the output.";
      if (fullOutputPath !== undefined) {
        let exists = true;
        try { await access(fullOutputPath); } catch { exists = false; }
        source += ` Full output file: ${fullOutputPath} (${exists ? "exists" : "missing"}).`;
      }
    }
    const text = texts.join("\n");
    const head = truncateHead(text);
    const content = [{ type: "text" as const, text: source }];
    const details: RecallDetails = {
      entryId: record.entryId,
      ...(record.kind === "tool" ? { toolName: record.toolName } : { role: record.role }),
      mode: id ? "id" : "query",
      others: others.length, truncated: head.truncated,
    };
    if (head.truncated) {
      const sessionId = ctx.sessionManager.getSessionId().replace(/[^a-zA-Z0-9_-]/g, "_");
      const directory = join(tmpdir(), "pi-pleat", sessionId);
      const file = join(directory, `${record.entryId.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`);
      await mkdir(directory, { recursive: true });
      await withFileMutationQueue(file, () => writeFile(file, text, "utf8"));
      details.file = file;
      content.push({ type: "text", text: `${head.content}\n\n[Showing lines 1-${head.outputLines} of ${head.totalLines} (${formatSize(head.outputBytes)} of ${formatSize(head.totalBytes)}). Full output: ${file}. Use read with offset to continue.]` });
    }
    return {
      content: [
        ...content,
        ...(head.truncated ? record.content.filter((block) => block.type === "image") : record.content),
        ...(others.length ? [{ type: "text" as const, text: `Other matches: ${others.slice(0, 5).map((other) => other.entryId).join(", ")}` }] : []),
      ],
      details,
    };
  },
});
