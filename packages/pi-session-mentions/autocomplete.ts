import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { Provider, SessionStore } from "./src/store.mjs";
import { oneLine, PROVIDER_LABELS, sessionMention } from "./mentions.ts";

const SESSION_ENTRY: AutocompleteItem = {
  value: "@@",
  label: "@@  Sessions",
  description: "All sessions · @@cc: Claude Code · @@cx: Codex · @@pi: Pi",
};

const SOURCES: { code: string; label: string; description: string; provider?: Provider }[] = [
  { code: "all", label: "All sessions", description: "Pi · Claude Code · Codex" },
  { code: "cc", label: "CC sessions", description: "Claude Code", provider: "claude" },
  { code: "cx", label: "CX sessions", description: "Codex", provider: "codex" },
  { code: "pi", label: "Pi sessions", description: "Pi", provider: "pi" },
];

function sessionQuery(text: string) {
  const match = /(?:^|[\s([{"'=，。！？；：（【、])(@@(?:(all|cc|cx|pi|):)?(?:"([^"\r\n]*)"?|([^\s@"`]*)))$/iu.exec(text);
  if (!match) return undefined;
  const source = match[2]?.toLowerCase();
  return {
    prefix: match[1],
    query: match[3] ?? match[4],
    rawQuery: match[1].slice(2 + (source === undefined ? 0 : source.length + 1)),
    source,
    provider: SOURCES.find(({ code }) => code === source)?.provider,
  };
}

function replacePrefix(
  lines: string[], line: number, col: number, prefix: string, value: string, removeClosingQuote = false,
) {
  const next = [...lines];
  let suffix = lines[line].slice(col);
  const quote = prefix.indexOf('"');
  if (removeClosingQuote && quote >= 0 && (prefix.length === quote + 1 || !prefix.endsWith('"')) && suffix.startsWith('"')) {
    suffix = suffix.slice(1);
  }
  next[line] = lines[line].slice(0, col - prefix.length) + value + suffix;
  return { lines: next, cursorLine: line, cursorCol: col - prefix.length + value.length };
}

export function createSessionAutocomplete(
  current: AutocompleteProvider,
  store: SessionStore,
  context: {
    cwd: string;
    excludePath?: string;
    notify: (message: string) => void;
    setIndexing: (indexed: number | undefined) => void;
  },
): AutocompleteProvider {
  const sessionItems = new WeakSet<AutocompleteItem>();
  const sourceItems = new WeakSet<AutocompleteItem>();
  const notices = new WeakMap<AutocompleteItem, string>();
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],

    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const query = sessionQuery(beforeCursor);
      if (!query) {
        const original = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        if (options.signal.aborted || !/(?:^|[\s([{"'=，。！？；：（【、])@$/u.test(beforeCursor)) return original;
        if (original && original.prefix !== "@") return original;
        const items = [...(original?.items ?? [])];
        items.splice(Math.min(2, items.length), 0, SESSION_ENTRY);
        return { prefix: "@", items };
      }

      const sources = SOURCES.filter(({ code }) => query.source === "" || (
        query.source === undefined && query.query && !query.rawQuery.startsWith('"') &&
        code.startsWith(query.query.toLowerCase())
      )).map(({ code, label, description }): AutocompleteItem => {
        const item = {
          value: `@@${code}:${query.source === "" ? query.rawQuery : ""}`,
          label,
          description,
        };
        sourceItems.add(item);
        return item;
      });
      if (query.source === "") return { prefix: query.prefix, items: sources };

      let indexing = false;
      try {
        const searchOptions = {
          cwd: context.cwd, excludePath: context.excludePath, provider: query.provider, signal: options.signal,
        };
        let result = await store.search(query.query, searchOptions);
        // Pi takes one suggestion snapshot per request. Wait for the initial scan
        // so a partial list and its loading notice cannot remain on screen.
        while (result.loading) {
          indexing = true;
          context.setIndexing(result.indexed);
          await delay(100, undefined, { signal: options.signal });
          result = await store.search(query.query, searchOptions);
        }
        if (options.signal.aborted) return null;
        const items = result.sessions.map((session): AutocompleteItem => {
          const modified = new Date(session.modified);
          const date = Number.isFinite(modified.getTime()) ? modified.toISOString().slice(0, 10) : "";
          const project = oneLine(basename(session.cwd) || session.cwd, 32);
          const item = {
            value: sessionMention(session),
            label: oneLine(session.title, 72) || PROVIDER_LABELS[session.provider],
            description: [PROVIDER_LABELS[session.provider], project, date].filter(Boolean).join(" · "),
          };
          sessionItems.add(item);
          return item;
        });
        items.unshift(...sources);
        if (!items.length) {
          const notice = {
            value: "",
            label: "No matching sessions",
            description: "Sources: @@all: · @@cc: · @@cx: · @@pi:",
          };
          notices.set(notice, notice.label);
          items.push(notice);
        }
        return { prefix: query.prefix, items };
      } catch (error) {
        if (options.signal.aborted) return null;
        const notice = { value: "", label: "Session search unavailable" };
        const reason = oneLine(error instanceof Error ? error.message : String(error), 160);
        notices.set(notice, `${notice.label}: ${reason}`);
        return { prefix: query.prefix, items: [notice] };
      } finally {
        if (indexing) context.setIndexing(undefined);
      }
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (item === SESSION_ENTRY) return replacePrefix(lines, cursorLine, cursorCol, prefix, "@@");
      if (sourceItems.has(item)) return replacePrefix(lines, cursorLine, cursorCol, prefix, item.value);
      const notice = notices.get(item);
      if (notice) {
        context.notify(notice);
        return { lines, cursorLine, cursorCol };
      }
      if (sessionItems.has(item)) {
        return replacePrefix(lines, cursorLine, cursorCol, prefix, `${item.value} `, true);
      }
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      if (sessionQuery((lines[cursorLine] ?? "").slice(0, cursorCol))) return true;
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
