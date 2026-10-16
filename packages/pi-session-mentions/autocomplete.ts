import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { SessionStore } from "./src/store.mjs";
import { oneLine, PROVIDER_LABELS, sessionMention } from "./mentions.ts";

const SESSION_ENTRY: AutocompleteItem = {
  value: "@@",
  label: "@@  Sessions",
  description: "Search local conversations",
};

function sessionQuery(text: string): { prefix: string; query: string } | undefined {
  const match = /(?:^|[\s([{"'=，。！？；：（【、])(@@(?:"([^"\r\n]*)"?|([^\s@"`]*)))$/u.exec(text);
  return match ? { prefix: match[1], query: match[2] ?? match[3] } : undefined;
}

function replacePrefix(lines: string[], line: number, col: number, prefix: string, value: string) {
  const next = [...lines];
  let suffix = lines[line].slice(col);
  if (prefix.startsWith('@@"') && (prefix.length === 3 || !prefix.endsWith('"')) && suffix.startsWith('"')) {
    suffix = suffix.slice(1);
  }
  next[line] = lines[line].slice(0, col - prefix.length) + value + suffix;
  return { lines: next, cursorLine: line, cursorCol: col - prefix.length + value.length };
}

export function createSessionAutocomplete(
  current: AutocompleteProvider,
  store: SessionStore,
  context: { cwd: string; excludePath?: string; notify: (message: string) => void },
): AutocompleteProvider {
  const sessionItems = new WeakSet<AutocompleteItem>();
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

      try {
        const searchOptions = { cwd: context.cwd, excludePath: context.excludePath, signal: options.signal };
        let result = await store.search(query.query, searchOptions);
        // Cold scans publish recent sessions first. Await initial matches without blocking typing.
        while (result.loading && result.sessions.length === 0) {
          await delay(100, undefined, { signal: options.signal });
          result = await store.search(query.query, searchOptions);
        }
        if (options.signal.aborted) return null;
        const items = result.sessions.slice(0, result.loading ? 7 : 8).map((session): AutocompleteItem => {
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
        if (result.loading) {
          const notice = { value: "", label: "Indexing sessions…" };
          notices.set(notice, "Sessions are still being indexed.");
          items.push(notice);
        } else if (!items.length) {
          const notice = { value: "", label: "No matching sessions" };
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
      }
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (item === SESSION_ENTRY) return replacePrefix(lines, cursorLine, cursorCol, prefix, "@@");
      const notice = notices.get(item);
      if (notice) {
        context.notify(notice);
        return { lines, cursorLine, cursorCol };
      }
      if (sessionItems.has(item)) {
        return replacePrefix(lines, cursorLine, cursorCol, prefix, `${item.value} `);
      }
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      if (sessionQuery((lines[cursorLine] ?? "").slice(0, cursorCol))) return true;
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
