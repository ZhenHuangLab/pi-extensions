# Changelog

Versions follow [Semantic Versioning](https://semver.org/).

## 0.2.0

### Minor Changes

- 30375d8: Allow custom provider/API pairs to use Codex Responses-trigger compaction through `pi-pleat.responsesTriggerChannels`. Use the configured channels for compaction and native replay, preserve their leading Responses instructions, and show the selected compaction method in `/context`. Document the stable-endpoint requirement for native compaction and replay on Pi 1.2.

  Replace non-Anthropic local clearing with background compaction. Start at `pi-pleat.asyncCompaction.triggerRatio` of the hard compaction threshold (default 0.8, with per-model overrides), use native Responses compaction on configured channels and text summaries elsewhere, preserve messages appended while the request runs, and adopt results at safe boundaries. Handle cancellation, obsolete results, and foreground compaction through one coordinator. Show the background threshold and state in `/context`; clearing settings and status apply only to Anthropic.

  Extend `recall` to retrieve original user and assistant text covered by native compaction or text summaries, including compaction that retains no earlier messages, while preserving branch isolation and the existing tool-output recall behavior.

## 0.1.4

### Patch Changes

- Move source and package metadata into the pi-extensions monorepo while retaining independent package versions and releases. Source behavior is unchanged.

## 0.1.3 (2026-10-15)

- Publish to npm with installation instructions and version, download, and Git tag badges.
- Include the Chinese README and changelog in the package.

## 0.1.2 (2026-10-14)

- Set per-model clearing values through `pi-pleat.clearing.modelOverrides["provider/modelId"]`, with
  each field falling back to `pi-pleat.clearing` and then its default.
- Invalid `compaction.reserveTokens` and `keepRecentTokens` values, including in
  `compaction.modelOverrides`, warn and name the value pi-pleat uses.
- `compaction.enabled` is read as Pi reads it: an omitted or `null` value keeps automatic compaction on,
  and `false`, `0` or `""` turns it off.

## 0.1.1 (2026-10-14)

- Configure clearing trigger and floor ratios, kept tool uses, and the minimum local result size
  through `pi-pleat.clearing` in Pi settings. Invalid values warn and use defaults.
- `/context` also shows the clearing floor and the number of tool uses kept.

## 0.1.0 (2026-10-14)

The first version, for Pi 1.2.0.

- Old tool results are cleared by Anthropic's server-side context editing on Anthropic, and replaced
  by placeholders with a recall id through Pi context edits on other providers.
- Anthropic models compact natively at the end of a turn. Later requests, also after a restart,
  replay the signed compaction block once the summary, the kept reply, the system prompt and the
  tools are checked.
- OpenAI Codex and OpenAI Responses models compact with the Responses `compaction_trigger` item when
  Pi's threshold is reached or on `/compact`, and keep a readable summary for other models.
- When native compaction is unavailable or fails, a text summary in Pi's format is written by the
  session model or by a fallback model set with the `pi-pleat` settings key or `/context fallback`.
  A compaction result whose next request would not fit the model window is discarded, and the
  history is kept.
- The `recall` tool returns the saved output of an earlier tool call on the current branch, by id or
  by query.
- `/context` shows context usage, clearing, compaction, native replay and fallback status.
