import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveXaiRuntime } from "./src/auth.ts";
import { callXaiSearch } from "./src/client.ts";
import { formatXaiSearchResponse, type XaiSearchDetails } from "./src/format.ts";
import { normalizeXaiSearchParams, xaiSearchSchema } from "./src/schema.ts";

export default function registerXaiSearch(pi: ExtensionAPI): void {
  pi.registerTool<typeof xaiSearchSchema, XaiSearchDetails>({
    name: "xai_search",
    label: "xAI X Search",
    description:
      "Search live X (Twitter) posts using xAI's server-side x_search. This tool uses separate `/login xai` credentials and is independent of the active chat model. Defaults to grok-4.5; optionally accepts another xAI model and an inclusive UTC date range.",
    promptSnippet: "Search live X posts through xAI independently of the active chat model",
    promptGuidelines: [
      "Use xai_search when the user needs current posts, discussions, reactions, profiles, or threads from X (Twitter).",
    ],
    parameters: xaiSearchSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const request = normalizeXaiSearchParams(params);
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
