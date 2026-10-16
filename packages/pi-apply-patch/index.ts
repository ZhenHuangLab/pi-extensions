/** Stable Pi registration for the Codex patch format. Licensed under Apache-2.0. */
import {
  generateDiffString,
  generateUnifiedPatch,
  renderDiff,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { applyPatch, PatchApplyError, type FileChange } from "./src/files.ts";
import {
  PATCH_GRAMMAR,
  patchParameters,
  PROMPT_GUIDELINES,
  TOOL_DESCRIPTION,
} from "./src/tool-spec.ts";

type PatchParams = Static<typeof patchParameters>;

interface PatchDetails {
  files: Array<{
    path: string;
    kind: FileChange["kind"];
    diff: string;
    patch: string;
    firstChangedLine?: number;
  }>;
  failure?: {
    failed: PatchApplyError["failed"];
    pending: PatchApplyError["pending"];
  };
}

/**
 * Maps raw freeform input to the schema that Pi also uses for function calls.
 *
 * Args:
 *   args: Raw tool input.
 * Returns:
 *   Input for Pi's schema validator. Object input is retained for strict validation.
 */
function prepareArguments(args: unknown): PatchParams {
  return (typeof args === "string" ? { patch: args } : args) as PatchParams;
}

/**
 * Builds persisted diffs from confirmed changes without storing whole source files.
 *
 * Args:
 *   files: Confirmed filesystem mutations.
 * Returns:
 *   Rendering details for this call and future transcript views.
 */
function describeChanges(files: readonly FileChange[]): PatchDetails {
  return {
    files: files.map(({ path, kind, before, after }) => ({
      path,
      kind,
      ...generateDiffString(before, after),
      patch: generateUnifiedPatch(path, before, after),
    })),
  };
}

/**
 * Registers the patch tool in each runtime, independently of model and session events.
 *
 * Args:
 *   pi: Pi's extension API. The host applies tool allowlists to this registration.
 */
export default function applyPatchExtension(pi: ExtensionAPI): void {
  pi.registerTool<typeof patchParameters, PatchDetails>({
    name: "apply_patch",
    label: "apply_patch",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Edit files with a Codex-format patch.",
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: patchParameters,
    exposure: "direct",
    defaultActive: true,
    executionMode: "sequential",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    constrainedSampling: {
      type: "grammar",
      variants: { openai_lark: PATCH_GRAMMAR },
    },
    prepareArguments,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await applyPatch(params.patch, ctx.cwd, signal);
        return {
          content: [{ type: "text", text: result.summary }],
          details: describeChanges(result.files),
        };
      } catch (error) {
        if (!(error instanceof PatchApplyError)) throw error;
        const details = describeChanges(error.files);
        details.failure = { failed: error.failed, pending: error.pending };
        return {
          content: [{ type: "text", text: error.message }],
          details,
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      const patch = prepareArguments(args)?.patch;
      const count =
        typeof patch === "string"
          ? [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: /gm)].length
          : 0;
      const suffix = count ? ` ${count} file operation${count === 1 ? "" : "s"}` : "";
      return new Text(theme.fg("toolTitle", theme.bold("apply_patch")) + suffix, 0, 0);
    },

    renderResult(result, options, theme, context) {
      const summary = result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      let text = context.isError ? theme.fg("error", summary) : summary;
      if (options.expanded) {
        for (const file of result.details?.files ?? []) {
          text += `\n\n${theme.fg("accent", file.path)}\n${renderDiff(file.diff)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("apply-patch-status", {
    description: "Show whether apply_patch is registered and active in this session.",
    async handler(_args, ctx) {
      const registered = pi.getAllTools().some((tool) => tool.name === "apply_patch");
      const active = pi.getActiveTools().includes("apply_patch");
      ctx.ui.notify(
        `apply_patch: registered=${registered}, active=${active}.` +
          (registered
            ? active
              ? " Pi selects the model's supported input format."
              : " Check this session's active tool selection."
            : " Check the SDK or agent tools allowlist and excludeTools."),
        active ? "info" : "warning",
      );
    },
  });
}
