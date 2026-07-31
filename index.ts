import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveXaiRuntime } from "./src/auth.ts";
import { callXaiSearch } from "./src/client.ts";
import { formatXaiSearchResponse, type XaiSearchDetails } from "./src/format.ts";
import { normalizeXaiSearchParams, xaiSearchSchema } from "./src/schema.ts";
import { XaiSearchSettings, type XaiSearchSettingsOptions } from "./src/settings.ts";

export default function registerXaiSearch(
  pi: ExtensionAPI,
  dependencies: XaiSearchSettingsOptions = {},
): void {
  const settings = new XaiSearchSettings(dependencies);

  pi.registerCommand("xai-search", {
    description: "Configure the independent xAI X search tool",
    getArgumentCompletions(prefix) {
      const value = prefix.trim();
      return "config".startsWith(value)
        ? [{ value: "config", label: "config", description: "Choose the xAI search model" }]
        : null;
    },
    async handler(args, ctx) {
      if (args.trim() !== "config") {
        ctx.ui.notify("Usage: /xai-search config", "warning");
        return;
      }
      await settings.open(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await settings.refresh(ctx);
  });

  pi.registerTool<typeof xaiSearchSchema, XaiSearchDetails>({
    name: "xai_search",
    label: "xAI X Search",
    description:
      "Search live X (Twitter) posts using xAI's server-side x_search. Uses separate `/login xai` credentials and is independent of the active chat model. Supports model/date overrides, handle allow/exclude filters, and image/video understanding. The default request model is configured with `/xai-search config` (initially grok-4.5).",
    promptSnippet: "Search live X posts through xAI independently of the active chat model",
    promptGuidelines: [
      "Use xai_search when the user needs current posts, discussions, reactions, profiles, or threads from X (Twitter).",
    ],
    parameters: xaiSearchSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const request = normalizeXaiSearchParams(params, settings.model);
      const runtime = await resolveXaiRuntime(ctx, request.model);
      const response = await callXaiSearch(runtime, request, signal ? { signal } : {});
      const formatted = formatXaiSearchResponse(response, request.model, runtime.authSource);

      return {
        content: [{ type: "text", text: formatted.text }],
        details: formatted.details,
      };
    },
  });
}
