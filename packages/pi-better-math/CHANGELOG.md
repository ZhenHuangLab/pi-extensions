# Changelog

## 0.1.1

### Patch Changes

- Move source and package metadata into the pi-extensions monorepo while retaining independent package versions and releases. Source behavior is unchanged.

## 0.1.0

First public release of `pi-better-math` (formerly developed as `pi-math-typeset`).

- Typeset `$$...$$` and math-looking `\[...\]` display math as multi-line Unicode art
- Substitute inline `$...$` that Pi's built-in renderer cannot handle
- Isolate libtexprintf on a worker thread with a 250ms deadline so a bad formula cannot freeze the TUI
- Fall back to Pi's built-in LaTeX on any failure
- Toggle with `/better-math [status|on|off|toggle]`
