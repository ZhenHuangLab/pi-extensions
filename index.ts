/**
 * strip-pi-docs
 *
 * Removes Pi's built-in "Pi documentation (read only when…)" pointer from the
 * system prompt so it does not consume context on every turn.
 *
 * Preference is stored in ~/.pi/agent/strip-pi-docs.json and is only applied
 * when a session starts. Slash-command changes take effect in the next session.
 *
 * Commands:
 *   /strip-pi-docs          show session + pending config status
 *   /strip-pi-docs on       enable stripping for new sessions
 *   /strip-pi-docs off      disable stripping for new sessions
 *   /strip-pi-docs status   same as bare command
 *   /strip-pi-docs toggle   flip the pending preference
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfigPath, loadConfig, saveConfig, type StripPiDocsConfig } from "./src/config.ts";

export default function stripPiDocsExtension(pi: ExtensionAPI) {
  /** Active for this session only — snapshotted at session_start. */
  let sessionEnabled = loadConfig().enabled;
  let lastStripped = false;

  function readPending(): StripPiDocsConfig {
    return loadConfig();
  }

  function statusLines(): string {
    const pending = readPending();
    const sessionLabel = sessionEnabled ? "on" : "off";
    const pendingLabel = pending.enabled ? "on" : "off";
    const lines = [
      `strip-pi-docs`,
      `  this session:  ${sessionLabel}`,
      `  next session:  ${pendingLabel}`,
      `  config:        ${getConfigPath()}`,
    ];
    if (sessionEnabled !== pending.enabled) {
      lines.push(`  note: preference change takes effect in a new session (/new or restart)`);
    }
    if (sessionEnabled) {
      lines.push(`  last turn:     ${lastStripped ? "stripped docs block" : "no docs block found"}`);
    }
    return lines.join("\n");
  }

  function setPending(enabled: boolean, ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } }) {
    saveConfig({ enabled });
    const label = enabled ? "on" : "off";
    if (sessionEnabled === enabled) {
      ctx.ui.notify(`strip-pi-docs ${label} (already active this session)`, "info");
    } else {
      ctx.ui.notify(
        `strip-pi-docs ${label} for new sessions (this session stays ${sessionEnabled ? "on" : "off"})`,
        "info",
      );
    }
  }

  pi.on("session_start", () => {
    sessionEnabled = loadConfig().enabled;
    lastStripped = false;
  });

  pi.registerCommand("strip-pi-docs", {
    description: "Toggle stripping the Pi documentation pointer from the system prompt (next session)",
    getArgumentCompletions(prefix) {
      const options = [
        { value: "on", label: "on", description: "Enable stripping for new sessions" },
        { value: "off", label: "off", description: "Disable stripping for new sessions" },
        { value: "status", label: "status", description: "Show session + pending status" },
        { value: "toggle", label: "toggle", description: "Flip the pending preference" },
      ];
      const value = prefix.trim().toLowerCase();
      if (!value) return options;
      const matched = options.filter((o) => o.value.startsWith(value));
      return matched.length > 0 ? matched : null;
    },
    async handler(args, ctx) {
      const cmd = args.trim().toLowerCase();

      if (!cmd || cmd === "status") {
        ctx.ui.notify(statusLines(), "info");
        return;
      }

      if (cmd === "on") {
        setPending(true, ctx);
        return;
      }

      if (cmd === "off") {
        setPending(false, ctx);
        return;
      }

      if (cmd === "toggle") {
        const pending = readPending();
        setPending(!pending.enabled, ctx);
        return;
      }

      ctx.ui.notify("Usage: /strip-pi-docs [on|off|status|toggle]", "warning");
    },
  });

  pi.on("before_agent_start", (event) => {
    lastStripped = false;
    if (!sessionEnabled) return;

    const options = event.systemPromptOptions;
    if (options.forceSystemPrompt !== undefined) return;
    if (options.customPrompt && !options.sections.docs) return;

    const previousPrompt = event.systemPrompt;
    // Pi 1.2.0 ignores empty section overrides; a newline leaves only the docs wrapper.
    options.sections.docs = "\n";
    lastStripped = event.systemPrompt !== previousPrompt;
  });
}
