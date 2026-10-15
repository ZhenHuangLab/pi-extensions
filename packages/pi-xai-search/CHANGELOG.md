# Changelog

## 0.2.2

### Patch Changes

- Move source and package metadata into the pi-extensions monorepo while retaining independent package versions and releases. Source behavior is unchanged.
- Update the development Pi SDK and formatter to remove known vulnerabilities in the development dependency tree.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-07-31

### Added

- `/xai-search config` now opens a settings menu first; the fuzzy-searchable model picker appears after selecting **Search model**, and Escape in the picker returns to the settings menu instead of closing the dialog.

## [0.2.0] - 2026-07-31

### Added

- `allowed_x_handles` and `excluded_x_handles` filters with xAI's 20-handle limit and mutual-exclusion validation.
- Optional `enable_image_understanding` and `enable_video_understanding` controls.
- Floating `/xai-search config` model picker with OAuth-backed live model discovery and fuzzy search.
- Persistent `~/.pi/agent/pi-xai-search.json` model configuration that applies immediately without `/reload`.

## [0.1.0] - 2026-07-31

### Added

- Model-independent `xai_search` tool for live X search.
- Pi-managed `/login xai` OAuth and `XAI_API_KEY` resolution.
- Grok 4.5 default with per-call model overrides.
- Inclusive UTC date filters.
- Citation, usage, and server-side tool formatting.
- Cancellation, timeout, validation, and safe error handling.
- Unit tests and multi-version Node.js CI.

[0.2.1]: https://github.com/ZhenHuangLab/pi-xai-search/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ZhenHuangLab/pi-xai-search/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ZhenHuangLab/pi-xai-search/releases/tag/v0.1.0
