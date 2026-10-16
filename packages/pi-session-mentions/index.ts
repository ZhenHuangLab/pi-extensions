import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSessionAutocomplete } from "./autocomplete.ts";
import { attachSessions, findMentions } from "./mentions.ts";
import { SessionStore } from "./src/store.mjs";

export default function sessionMentions(pi: ExtensionAPI): void {
  let store: SessionStore | undefined;

  function getStore(ctx: ExtensionContext): SessionStore {
    store ??= new SessionStore({
      agentDir: getAgentDir(),
      cacheDir: join(getAgentDir(), "session-mentions"),
      sessionDir: ctx.sessionManager.getSessionDir() || undefined,
    });
    return store;
  }

  pi.on("session_start", async (_event, ctx) => {
    const previousStore = store;
    store = undefined;
    await previousStore?.close();
    const activeStore = getStore(ctx);
    if (ctx.hasUI) {
      activeStore.start();
      ctx.ui.addAutocompleteProvider((current) =>
        createSessionAutocomplete(current, activeStore, {
          cwd: ctx.cwd,
          excludePath: ctx.sessionManager.getSessionFile(),
          notify: (message) => ctx.ui.notify(message, "info"),
        }),
      );
    }
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !findMentions(event.text).length) return { action: "continue" };
    const activeStore = getStore(ctx);
    const signal = ctx.signal;
    let result: Awaited<ReturnType<typeof attachSessions>>;
    try {
      result = await attachSessions(event.text, activeStore, signal);
    } catch (error) {
      // Pi continues with the original input after a thrown handler error.
      if (activeStore !== store || signal?.aborted) return { action: "handled" };
      throw error;
    }
    if (activeStore !== store || signal?.aborted) return { action: "handled" };
    if (result.failures && ctx.hasUI) {
      ctx.ui.notify("Some session references could not be read. Select them again to attach their context.", "warning");
    }
    return { action: "transform", text: result.text, images: event.images };
  });

  pi.on("session_shutdown", async () => {
    const activeStore = store;
    store = undefined;
    await activeStore?.close();
  });
}
