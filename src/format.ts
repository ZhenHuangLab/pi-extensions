import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

export interface XaiSearchDetails {
  model: string;
  provider: "xai";
  authSource?: string;
  citations: string[];
  searchCount: number;
  serverSideToolUsage: Record<string, number>;
  truncated: boolean;
}

export interface FormattedXaiSearchResponse {
  text: string;
  details: XaiSearchDetails;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function getRecord(value: unknown): UnknownRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function collectCitations(response: UnknownRecord, output: unknown[]): string[] {
  const citations = new Set<string>();
  const topLevel = response.citations;
  if (Array.isArray(topLevel)) {
    for (const citation of topLevel) {
      if (typeof citation === "string" && citation) citations.add(citation);
    }
  }

  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content) || !Array.isArray(content.annotations)) continue;
      for (const annotation of content.annotations) {
        if (!isRecord(annotation)) continue;
        const url = getString(annotation, "url");
        if (url) citations.add(url);
      }
    }
  }

  return [...citations];
}

function collectServerToolUsage(response: UnknownRecord): Record<string, number> {
  const usage = getRecord(response.server_side_tool_usage);
  if (!usage) return {};

  return Object.fromEntries(
    Object.entries(usage).filter((entry): entry is [string, number] => {
      return typeof entry[1] === "number" && Number.isFinite(entry[1]);
    }),
  );
}

function formatUsage(response: UnknownRecord): string | undefined {
  const usage = getRecord(response.usage);
  if (!usage) return undefined;

  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;

  const details = getRecord(usage.output_tokens_details);
  const reasoning =
    details && typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : undefined;
  const base = `Tokens: ${input ?? "?"} in / ${output ?? "?"} out`;
  return reasoning && reasoning > 0 ? `${base} (${reasoning} reasoning)` : base;
}

function glueCitationSpacing(text: string): string {
  return text.replace(/((?:https?:\/\/|www\.)[^\s<>\]]+)(\[\[\d+\]\]\([^)]+\))/g, "$1 $2");
}

export function formatXaiSearchResponse(
  value: unknown,
  requestedModel: string,
  authSource?: string,
): FormattedXaiSearchResponse {
  if (!isRecord(value)) throw new Error("Cannot format an invalid xAI response");

  const output = Array.isArray(value.output) ? value.output : [];
  const textParts: string[] = [];
  const searches: string[] = [];

  for (const item of output) {
    if (!isRecord(item)) continue;

    if (item.type === "message" && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (!isRecord(content) || content.type !== "output_text") continue;
        const text = getString(content, "text");
        if (text) textParts.push(text);
      }
      continue;
    }

    if (item.type === "x_search_call") {
      const action = getRecord(item.action);
      const query = action ? getString(action, "query") : undefined;
      const status = getString(item, "status");
      searches.push(`- X search${query ? `: “${query}”` : ""}${status ? ` [${status}]` : ""}`);
    }
  }

  const model = getString(value, "model") ?? requestedModel;
  const citations = collectCitations(value, output);
  const serverSideToolUsage = collectServerToolUsage(value);
  const usage = formatUsage(value);
  const body = glueCitationSpacing(textParts.join("\n").trim()) || "(no text output)";

  const sections = [`**xAI X Search** (${model})`, body];
  if (searches.length > 0) sections.push(`**Searches performed**\n${searches.join("\n")}`);
  if (usage) sections.push(usage);
  if (Object.keys(serverSideToolUsage).length > 0) {
    const tools = Object.entries(serverSideToolUsage)
      .map(([name, count]) => `${name.replace(/^SERVER_SIDE_TOOL_/, "").toLowerCase()}×${count}`)
      .join(", ");
    sections.push(`Server-side tools: ${tools}`);
  }
  if (citations.length > 0) {
    sections.push(
      `**Sources**\n${citations.map((url, index) => `${index + 1}. ${url}`).join("\n")}`,
    );
  }

  const fullText = sections.join("\n\n");
  const truncated = truncateHead(fullText);
  const suffix = truncated.truncated
    ? `\n\n[Output truncated to ${truncated.outputLines} lines / ${formatSize(truncated.outputBytes)}]`
    : "";

  return {
    text: `${truncated.content}${suffix}`,
    details: {
      model,
      provider: "xai",
      ...(authSource ? { authSource } : {}),
      citations,
      searchCount: searches.length,
      serverSideToolUsage,
      truncated: truncated.truncated,
    },
  };
}
