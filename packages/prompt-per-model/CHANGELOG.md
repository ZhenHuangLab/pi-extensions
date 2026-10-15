# Changelog

Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.1

### Patch Changes

- Move source and package metadata into the pi-extensions monorepo while retaining independent package versions and releases. Source behavior is unchanged.

## 0.1.0 (2026-10-14)

The first version, for Pi 1.2.0.

- Markdown files in `~/.pi/agent/prompt-per-model/` and, in trusted projects, `.pi/prompt-per-model/`
  are added to the system prompt as a `model_prompt` section when they match the current model.
  The global directory is created at the first start.
- A file matches the model id named by its file name, or the patterns in its `match` frontmatter.
  Patterns use `*` and `?` and ignore case.
- Files with invalid frontmatter or no text are reported at session start, in the footer, and by
  `/prompt-per-model`.
