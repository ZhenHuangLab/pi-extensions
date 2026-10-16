/**
 * Codex patch grammar and Pi tool guidance.
 *
 * Grammar copied from OpenAI Codex, Apache-2.0, revision
 * 4eb4a65407d98cebc4c83bf13be440b9fbc78a7c. Guidance added for Pi's
 * freeform and function interfaces. See ../NOTICE.
 */
import { Type } from "typebox";

export const PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

export const patchParameters = Type.Object(
  {
    patch: Type.String({
      description: "The complete patch, from *** Begin Patch through *** End Patch.",
      minLength: 1,
    }),
  },
  { additionalProperties: false },
);

export const TOOL_DESCRIPTION = `Apply text-file changes with the Codex patch format.
If this tool is declared FREEFORM, send raw patch text without JSON or a code fence. For a function call, pass {"patch":"..."}; in codemode use tools.apply_patch({patch:"..."}).

Read the target files first. Use enough unchanged context (normally three lines) to identify each edit. Paths resolve from the session working directory; absolute paths are accepted. Apply related edits in one patch.

*** Begin Patch
*** Update File: path/to/file
@@
 unchanged context
-old line
+new line
 unchanged context
*** End Patch

Use *** Add File: path with every content line prefixed by +, or *** Delete File: path. To rename, put *** Move to: destination immediately after an Update File header and include an update hunk. @@ may name a function or other context line to search forward; it does not take unified-diff line numbers. Use *** End of File after a hunk that must match the file's end.

Add and Move destinations must be absent. Matching and path errors stop before writing. An I/O failure during commit reports confirmed changes and unfinished paths; read those paths before retrying.`;

export const PROMPT_GUIDELINES = [
  "Use apply_patch for focused file edits. Read the current contents and preserve unrelated changes.",
  "After an apply_patch error, use the reported path and context to correct the patch; inspect partial changes before retrying.",
];
