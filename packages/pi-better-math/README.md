<h1 align="center"><code>pi-better-math</code></h1>

<p align="center"><strong>Multi-line Unicode math for Pi's TUI</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-better-math"><img alt="npm version" src="https://img.shields.io/npm/v/pi-better-math?color=cb3837&amp;logo=npm"></a>
  <a href="https://www.npmjs.com/package/pi-better-math"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/pi-better-math"></a>
  <a href="https://github.com/ZhenHuangLab/pi-extensions/tags"><img alt="GitHub tag" src="https://img.shields.io/github/v/tag/ZhenHuangLab/pi-extensions?filter=pi-better-math%40*"></a>
  <a href="https://github.com/earendil-works/pi-mono"><img alt="Pi 0.84.0 or newer" src="https://img.shields.io/badge/Pi-%E2%89%A50.84.0-7c3aed"></a>
  <a href="LICENSE"><img alt="GPL-3.0-or-later" src="https://img.shields.io/badge/License-GPL%20v3-blue.svg"></a>
</p>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#license">License</a>
</p>

---

Pi's built-in renderer flattens LaTeX to a single line. `pi-better-math` intercepts Markdown and typesets display math as real 2D Unicode art — stacked fractions, extended brackets, centered sum/integral limits, matrices — using [libtexprintf](https://www.npmjs.com/package/libtexprintf) (utftex, WASM).

Rendering is **display-only**. Session and model context stay unchanged. Any failure falls back to Pi's built-in LaTeX handling.

```
        ⎡             |xᵢ|² - 2ρ Re(xᵢ x̅ⱼ) ⎤
ℒ =  ∑  ⎢ log(1-ρ²) + ──────────────────── ⎥
    i<j ⎣                     1-ρ²         ⎦
```

## Installation

Requires [Pi](https://github.com/earendil-works/pi-mono) 0.84.0 or newer (`pi.registerMarkdownTransformer`).

### npm

```bash
pi install npm:pi-better-math
```

### Local checkout

```bash
git clone https://github.com/ZhenHuangLab/pi-extensions.git
pi install ./pi-extensions/packages/pi-better-math
```

Restart Pi or run `/reload` after installing.

## Usage

The extension is on by default once the render worker is ready.

| Command | Effect |
| --- | --- |
| `/better-math` | Show status |
| `/better-math on` | Enable typesetting |
| `/better-math off` | Disable typesetting |
| `/better-math toggle` | Flip the current state |

Status looks like `better-math ON calls=12 hits=4`. `calls` is how many Markdown transforms ran; `hits` is how many actually changed. `stalls=N` appears if a render blew the 250ms deadline and the worker was replaced.

### What gets typeset

- **Display math:** `$$...$$` and math-looking `\[...\]` become a fenced code block of multi-line Unicode art.
- **Inline math:** `$...$` that Pi cannot handle well (`\frac`, `\sin`, `\left`/`\right`, `\rm`, `\!`, …) is replaced with a **single-line** Unicode substitution so table cells stay intact.
- **Left alone:** fenced code blocks, inline code, escaped prose `\[optional\]`, and anything that fails to render.

## How it works

1. A Markdown transformer walks non-code segments and hands TeX to libtexprintf.
2. Rendering happens on a **worker thread**, on a **fresh WebAssembly instance** every call. libtexprintf keeps global state in WASM memory; reusing an instance eventually returns garbage, and some inputs never terminate.
3. The TUI thread drives the worker through `SharedArrayBuffer` + `Atomics.wait` with a **250ms deadline**. A missed deadline kills and respawns the worker, then falls back to Pi's built-in LaTeX — so a bad formula cannot freeze the session.
4. Output wider than the terminal, unknown TeX, or a worker error also falls back.

## Development

Use Node.js 22.19.0 or later for development. Run these commands from the repository root:

```bash
npm ci
npm run check --workspace=pi-better-math
```

The check validates syntax in `index.ts`, `transform.ts`, and `render-worker.mjs`.

## Maintainer releases

See [RELEASING.md](https://github.com/ZhenHuangLab/pi-extensions/blob/main/RELEASING.md)
for versioning, package tags, and npm trusted publishing.

## License

[GPL-3.0-or-later](LICENSE). The runtime renderer is [libtexprintf](https://www.npmjs.com/package/libtexprintf), which is GPL-3.0-or-later.
