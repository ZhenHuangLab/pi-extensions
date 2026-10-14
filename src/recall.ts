import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, formatSize, truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isRecord, toolRecords } from "./session.ts";
import type { ToolRecord } from "./session.ts";

function argSummary(args: ToolRecord["args"]): string {
  if (!args || !Object.keys(args).length) return "";
  for (const key of ["command", "path", "pattern", "query", "url"]) {
    if (typeof args[key] === "string") return ` ${JSON.stringify(args[key])}`;
  }
  const text = JSON.stringify(args);
  return ` ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`;
}

interface RecallDetails {
  entryId: string;
  toolName: string;
  mode: "id" | "query";
  others: number;
  truncated: boolean;
  file?: string;
}

export const recallTool = defineTool({
  name: "recall",
  label: "Recall",
  description: "Get the full output of an earlier tool call that was cleared to save context.\nPass `id` from a cleared-output note, or `query` (command, path, tool name, or text) to get the newest match.",
  parameters: Type.Object({ id: Type.Optional(Type.String()), query: Type.Optional(Type.String()) }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const id = params.id?.trim();
    const query = params.query?.trim();
    if (Boolean(id) === Boolean(query)) {
      throw new Error("Pass either id or query.");
    }
    const records = toolRecords(ctx.sessionManager.getBranch());
    let record: ToolRecord | undefined;
    let others: ToolRecord[] = [];
    if (id) {
      record = records.find((candidate) => candidate.entryId === id) ??
        records.find((candidate) => candidate.toolCallId === id) ??
        records.find((candidate) => candidate.toolCallId.split("|")[0] === id);
      if (!record) {
        if (ctx.sessionManager.getEntry(id)) {
          throw new Error(`${id} is not on the current branch. Use query to search this branch.`);
        }
        throw new Error(`No tool result with id ${id} on the current branch. Use query with a command, path, or text.`);
      }
    } else {
      const normalized = query!.toLowerCase().replace(/\s+/g, " ");
      const terms = normalized.split(" ");
      const matches = records.filter((candidate) => {
        if (candidate.toolName === "recall") return false;
        const text = candidate.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
        const haystack = `${candidate.toolName}\n${JSON.stringify(candidate.args ?? {})}\n${text}`.toLowerCase();
        return haystack.includes(normalized) || terms.every((term) => haystack.includes(term));
      }).reverse();
      record = matches[0];
      others = matches.slice(1);
      if (!record) {
        throw new Error(`No earlier tool result matches "${query}". Try a shorter query or a path from the call.`);
      }
    }
    const texts = record.content.filter((block) => block.type === "text").map((block) => block.text);
    const bytes = texts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
    let source = `[${record.entryId} · ${record.toolName}${argSummary(record.args)} · ${formatSize(bytes)}${record.isError ? " · error" : ""}]`;
    const saved = isRecord(record.details) ? record.details : {};
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
      entryId: record.entryId, toolName: record.toolName, mode: id ? "id" : "query",
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
