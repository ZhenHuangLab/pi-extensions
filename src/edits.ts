import { buildSessionProjection, estimateTokens, formatSize } from "@earendil-works/pi-coding-agent";
import type { ContextEditEntryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";
import { contentBytes, KEEP_TOOL_USES, MIN_CLEAR_BYTES } from "./budget.ts";
import type { Limits } from "./budget.ts";
import { isClaudeThinking } from "./session.ts";

export function placeholder(entryId: string, bytes: number): string {
  return `[Output cleared to save context (${formatSize(bytes)}). recall id="${entryId}"]`;
}

export function planClearing({ branch, effectiveTokens, limits }: {
  branch: SessionEntry[];
  effectiveTokens: number;
  limits: Limits;
}): ContextEditEntryDraft[] {
  if (effectiveTokens <= limits.clearTrigger) return [];
  const projection = buildSessionProjection(branch);
  const editedTargets = new Set(branch.flatMap((entry) => entry.type === "context_edit" ? [entry.targetId] : []));
  const callIds = projection.messages.flatMap((message) => message.role === "assistant"
    ? message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []) : []);
  const protectedIds = new Set(callIds.slice(-KEEP_TOOL_USES));
  const lastThinkingIndex = branch.findLastIndex((entry) => entry.type === "message" && isClaudeThinking(entry.message));
  const indices = new Map(branch.map((entry, index) => [entry.id, index]));
  const drafts: ContextEditEntryDraft[] = [];
  let freed = 0;
  for (const projected of projection.entries) {
    const entry = projected.sourceEntry;
    if (!projected.messages.length || entry.type !== "message" || entry.message.role !== "toolResult" ||
        editedTargets.has(entry.id) || protectedIds.has(entry.message.toolCallId) ||
        (indices.get(entry.id) ?? -1) < lastThinkingIndex) continue;
    const bytes = contentBytes(entry.message.content);
    if (bytes < MIN_CLEAR_BYTES) continue;
    const content = [{ type: "text" as const, text: placeholder(entry.id, bytes) }];
    const saving = estimateTokens(entry.message) - estimateTokens({ ...entry.message, content });
    if (saving <= 0) continue;
    drafts.push({ type: "context_edit", targetId: entry.id, replacement: { content } });
    freed += saving;
    if (freed >= limits.clearFloor) return drafts;
  }
  return [];
}
