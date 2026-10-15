/**
 * Pure markdown-transform logic for pi-better-math.
 *
 * Two passes run over each non-code segment:
 *   1. Display math: $$...$$ and math-looking \[...\] become fenced code
 *      blocks containing multi-line Unicode art (utftex).
 *   2. Inline math: $...$ that pi's built-in LaTeX renderer cannot handle
 *      (\frac, \sin, \left/\right, \rm, \!) is replaced with a single-line
 *      Unicode substitution. \frac stacks vertically so a fraction-flatten
 *      retry ((a)/(b)) keeps table cells intact. The substitution re-escapes
 *      markdown-significant chars (notably `|`) so it survives inside a
 *      markdown table cell.
 *
 * Fenced code blocks and inline code spans are never touched. Every failure
 * path falls back to the original text, which pi's built-in LaTeX renderer
 * then handles.
 */

export type TypesetFn = (tex: string) => string | null;

/** Resolve a self-contained TeX fragment to inline Unicode text, or null. */
export type SymbolResolver = (fragment: string) => string | null;

export interface TransformOptions {
	/** Exact terminal columns available for the rendered content. */
	availableWidth: number;
	/** Measure the display width of a single line of text. */
	measureWidth: (line: string) => number;
	/** Render TeX to multi-line Unicode art, or null when not renderable. */
	typeset: TypesetFn;
}

const DISPLAY_MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
/**
 * Inline math: single $ delimiters, no cross-newline, non-space adjacent to
 * both delimiters, closing $ not followed by a word character (protects $VAR,
 * $5 in prose from being read as math). Anything wrapped in $$ is skipped by
 * the negative $-lookbehind/lookahead on the delimiters.
 */
const INLINE_MATH_RE = /(?<![\\$])\$(?!\$)(\S(?:[^\n$]*\S)?)\$(?![$\w])/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})/;
const MAX_TEX_LENGTH = 4000;
/** Columns reserved for the code-block indent pi applies to fenced blocks. */
const FENCE_INDENT_RESERVE = 4;
/** Minimum width at which typesetting is attempted at all. */
const MIN_USEFUL_WIDTH = 24;
const MASK_SENTINEL = "\u0000";
const SUM_TOP = "\u23B2"; // ⎲ SUMMATION TOP
const SUM_BOTTOM = "\u23B3"; // ⎳ SUMMATION BOTTOM
const SUM_SINGLE = "\u2211"; // ∑ N-ARY SUMMATION
/** Private-use stand-in for ASCII _ so utftex will not re-parse it as a subscript. */
const SUBSCRIPT_SENTINEL = "\uE000";

/**
 * Decide whether the body of a \[...\] span plausibly is display math.
 *
 * Escaped literal brackets in prose (e.g. "\[optional\]") must not be fed to
 * the typesetter; genuine display math essentially always contains a TeX
 * command, grouping, sub/superscript, or an operator between operands.
 */
function looksLikeMath(body: string): boolean {
	return /[\\^_{}=]|[0-9)\]]\s*[+\-*/]\s*[0-9(\\[]/.test(body);
}

const SUBSCRIPT_CHARS: Record<string, string> = {
	"0": "\u2080",
	"1": "\u2081",
	"2": "\u2082",
	"3": "\u2083",
	"4": "\u2084",
	"5": "\u2085",
	"6": "\u2086",
	"7": "\u2087",
	"8": "\u2088",
	"9": "\u2089",
	"+": "\u208A",
	"-": "\u208B",
	"=": "\u208C",
	"(": "\u208D",
	")": "\u208E",
	a: "\u2090",
	e: "\u2091",
	h: "\u2095",
	i: "\u1D62",
	j: "\u2C7C",
	k: "\u2096",
	l: "\u2097",
	m: "\u2098",
	n: "\u2099",
	o: "\u2092",
	p: "\u209A",
	r: "\u1D63",
	s: "\u209B",
	t: "\u209C",
	u: "\u1D64",
	v: "\u1D65",
	x: "\u2093",
	y: "\u1D67",
	β: "\u1D66",
	γ: "\u1D67",
	ρ: "\u1D68",
	φ: "\u1D69",
	ϕ: "\u1D69",
	χ: "\u1D6A",
};

const BIG_OPERATOR_BEFORE_RE =
	/\\(?:sum|prod|coprod|int|iint|iiint|oint|bigcup|bigcap|bigvee|bigwedge|max|min|lim|sup|inf)\s*$/;

const SIMPLE_SUBSCRIPT_RE = /(?<!\\)_(\\[A-Za-z]+|\{[^{}]+\}|[A-Za-z0-9])/g;
const HALF_POWER_RE =
	/(\{[^{}]+\}|[A-Za-z][A-Za-z0-9\u1D62-\u1D6A\u2070-\u209C\u03B1-\u03C9\u03D1-\u03D6]*)[ \t]*\^\{1\/2\}/g;
const INLINE_SUPER_RE =
	/(\S)[ \t]*\^(?:\{T\}|T(?![A-Za-z])|\{\\top\}|\\top(?![A-Za-z])|\{\\dagger\}|\\dagger(?![A-Za-z])|\{\\dag\}|\\dag(?![A-Za-z])|\{\\ast\}|\\ast(?![A-Za-z])|\*)/g;

/**
 * Map text to Unicode subscript characters, or null when any char lacks one.
 *
 * utftex renders many symbols in the Mathematical Alphanumeric block (\varphi
 * becomes U+1D711, not U+03C6). Those have NFKC decompositions to the plain
 * letter, which is what the subscript table is keyed by.
 */
function toSubscriptRun(text: string): string | null {
	let out = "";
	for (const char of text) {
		const mapped = SUBSCRIPT_CHARS[char] ?? SUBSCRIPT_CHARS[char.normalize("NFKC")];
		if (!mapped) return null;
		out += mapped;
	}
	return out;
}

/**
 * Resolve a subscript body to inline text.
 *
 * The body goes to the resolver whole (\widehat\Sigma, never \widehat followed
 * by \Sigma): a bare accent or font command is an incomplete TeX fragment, and
 * libtexprintf answers those with out-of-bounds garbage or an endless parse.
 */
function flattenSubscript(raw: string, resolveSymbol: SymbolResolver): string | null {
	const body = raw.startsWith("{") && raw.endsWith("}") ? raw.slice(1, -1) : raw;
	if (body.length === 0) return null;
	const text = body.includes("\\") ? resolveSymbol(body) : body;
	if (text === null) return null;
	return toSubscriptRun(text) ?? `${SUBSCRIPT_SENTINEL}${text}`;
}

/**
 * Rewrite scripts that utftex would otherwise spread across extra rows.
 *
 * utftex inlines only Latin/digit subscripts (Rᵢ, S₀). Greek subscripts and
 * \dagger/\top superscripts always take a whole extra row, so D_\phi, B_\theta
 * and X^\dagger look like leftover pieces. Flatten those to in-line Unicode
 * (or \\sqrt for ^{1/2}). Leave big-operator limits and multi-character
 * exponents such as e^{-i\\phi} alone.
 */
export function compactScripts(tex: string, resolveSymbol: SymbolResolver): string {
	// TeX treats a newline as a space. utftex drops bare newlines, which glues
	// tokens that were only separated by line breaks in the source.
	let out = tex.replace(/(?<!\\)\n+/g, " ");
	out = out.replace(SIMPLE_SUBSCRIPT_RE, (full, raw: string, offset: number) => {
		if (BIG_OPERATOR_BEFORE_RE.test(out.slice(0, offset))) return full;
		const flat = flattenSubscript(raw, resolveSymbol);
		return flat ?? full;
	});
	out = out.replace(HALF_POWER_RE, (_full, nucleus: string) => `\\sqrt{${nucleus}}`);
	out = out.replace(INLINE_SUPER_RE, (full, nucleus: string) => {
		const mark = full.slice(nucleus.length);
		if (/\\dagger|\\dag/.test(mark)) return `${nucleus}{}^\u005Cdagger{}`;
		if (/\\ast|\*/.test(mark)) return `${nucleus}{}^\u005Cast{}`;
		return `${nucleus}{}^{T}{}`;
	});
	return out;
}

/**
 * Replace utftex's 2-row SUMMATION TOP/BOTTOM pair with a single ∑.
 *
 * U+23B2/U+23B3 only look like one tall Σ in fonts that draw the two halves
 * as seamless tiles. Most coding fonts render them as disconnected hooks, so
 * the formula no longer reads as a sum. The single ∑ sits on the lower
 * (nucleus) row, which is where adjacent fraction bars and bracket centers
 * already align.
 */
export function replaceStackedSums(art: string): string {
	if (!art.includes(SUM_TOP) || !art.includes(SUM_BOTTOM)) return art;
	const lines = art.split("\n");
	for (let i = 0; i < lines.length - 1; i++) {
		const top = lines[i];
		const bot = lines[i + 1];
		const limit = Math.min(top.length, bot.length);
		let changed = false;
		let nextTop = top;
		let nextBot = bot;
		for (let col = 0; col < limit; col++) {
			if (top[col] === SUM_TOP && bot[col] === SUM_BOTTOM) {
				nextTop = `${nextTop.slice(0, col)} ${nextTop.slice(col + 1)}`;
				nextBot = `${nextBot.slice(0, col)}${SUM_SINGLE}${nextBot.slice(col + 1)}`;
				changed = true;
			}
		}
		if (changed) {
			lines[i] = nextTop;
			lines[i + 1] = nextBot;
		}
	}
	// Drop rows that only existed to hold SUMMATION TOP.
	return lines
		.filter((line, index) => !(line.trim() === "" && lines[index + 1]?.includes(SUM_SINGLE)))
		.join("\n");
}

/**
 * Horizontal-spacing macros, collapsed to the one width unit a terminal has.
 *
 * utftex has no notion of sub-character spacing: it silently prints \! as "!",
 * \/ as "/", \> as ">", and leaks the argument of \hspace{1em} as the text
 * "1em" — all without reporting an error, so nothing downstream can detect the
 * corruption. Even the ones it accepts do not survive intent: \, is rendered as
 * zero columns, and a literal space after a word command is swallowed as the
 * command terminator.
 *
 * A terminal has exactly one sub-word width, so every sub-em spacing macro is
 * rewritten to \; (utftex's one-column gap) and every zero/negative one is
 * dropped. \quad and \qquad are deliberately multi-em and utftex renders them
 * correctly, so they are left alone.
 */
const SPACING_MACRO_RE = new RegExp(
	[
		"\\\\\\\\", // row separator inside matrices/arrays — matched first, kept as is
		"\\\\(?:hspace\\*?|mspace|hskip|mskip|kern|mkern)\\s*\\{[^{}]*\\}",
		"\\\\(?:hskip|mskip|kern|mkern)(?![A-Za-z])\\s*-?[0-9.]*\\s*[A-Za-z]*",
		"\\\\(?:neg(?:thin|med|thick)space|thinspace|medspace|thickspace|enspace|nobreakspace|space)(?![A-Za-z])",
		"\\\\[!,:;>/ ]",
	].join("|"),
	"g",
);
const GAP = "\\;";
const COLLAPSING_SPACING_RE = /^\\(?:!|\/|neg(?:thin|med|thick)space|(?:hspace\*?|mspace|hskip|mskip|kern|mkern)\s*\{?\s*-)/;

/** Control symbols utftex renders faithfully; anything else it mangles silently. */
const SUPPORTED_CONTROL_SYMBOLS = new Set([
	"\\",
	"{",
	"}",
	"_",
	"^",
	"~",
	"|",
	"#",
	"%",
	"&",
	"$",
	".",
	"-",
	"+",
	"=",
	"*",
	"(",
	")",
	"[",
	"]",
	"'",
	'"',
	"`",
	";", // the gap normalizeSpacing emits; the other spacing macros never reach here
]);
const CONTROL_SEQUENCE_RE = /\\([A-Za-z]+|[\s\S])/g;

/** Normalise every sub-em horizontal-spacing macro to zero or one column. */
export function normalizeSpacing(tex: string): string {
	return tex.replace(SPACING_MACRO_RE, (macro) => {
		if (macro === "\\\\") return macro;
		return COLLAPSING_SPACING_RE.test(macro) ? "" : GAP;
	});
}

/**
 * True when the TeX contains a control symbol utftex would print as its bare
 * character instead of interpreting it. Unknown *word* commands raise a
 * render error and are caught by the caller's error check; unknown control
 * symbols do not, so they must be rejected up front.
 */
export function hasUnsupportedControlSymbol(tex: string): boolean {
	CONTROL_SEQUENCE_RE.lastIndex = 0;
	for (let match = CONTROL_SEQUENCE_RE.exec(tex); match !== null; match = CONTROL_SEQUENCE_RE.exec(tex)) {
		const token = match[1];
		if (/^[A-Za-z]+$/.test(token)) continue;
		if (!SUPPORTED_CONTROL_SYMBOLS.has(token)) return true;
	}
	return false;
}

/**
 * Resolve script fragments to inline Unicode using utftex's own symbol table.
 *
 * Replaces a hand-maintained Greek/symbol map: the engine already knows ~3000
 * commands, so ask it. Only compact, single-row, whitespace-free results are
 * usable inline; \frac or \sum render across rows and are rejected.
 */
export function createSymbolResolver(typeset: TypesetFn): SymbolResolver {
	const memo = new Map<string, string | null>();
	return (fragment) => {
		const cached = memo.get(fragment);
		if (cached !== undefined) return cached;
		const art = typeset(fragment);
		const text = art?.trim() ?? "";
		const usable = text.length > 0 && text.length <= 8 && !/\s/.test(text) ? text : null;
		memo.set(fragment, usable);
		return usable;
	};
}

/** Post-process utftex art: stacked sums and sentinel → ASCII underscore. */
export function polishArt(art: string): string {
	return replaceStackedSums(art).replaceAll(SUBSCRIPT_SENTINEL, "_");
}

/**
 * Rewrite \frac{a}{b} to inline (a)/(b) so utftex renders it on one line.
 *
 * utftex always stacks \frac across three rows, which is fatal for inline
 * substitution inside table cells or prose. Parenthesize only when the
 * operand has internal structure — a bare `\pi/2` is more readable than
 * `(\pi)/(2)`. Iterate to collapse nested \frac occurrences.
 */
const FRAC_RE = /\\frac\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
const BARE_SYMBOL_RE = /^(?:\\[A-Za-z]+|[A-Za-z]|\d+)(?:_(?:\{[^{}]+\}|[A-Za-z0-9]))?$/;

function needsFractionParens(expr: string): boolean {
	const trimmed = expr.trim();
	if (trimmed.length === 0) return false;
	if (BARE_SYMBOL_RE.test(trimmed)) return false;
	if (/^\{[^{}]*\}$/.test(trimmed)) return false;
	return true;
}

export function flattenFractions(tex: string): string {
	let out = tex;
	for (let i = 0; i < 8; i++) {
		const next = out.replace(FRAC_RE, (_full, num: string, den: string) => {
			const n = needsFractionParens(num) ? `(${num})` : num;
			const d = needsFractionParens(den) ? `(${den})` : den;
			return `${n}/${d}`;
		});
		if (next === out) break;
		out = next;
	}
	return out;
}

/**
 * Escape markdown-significant characters in a substitution so the surrounding
 * parser leaves it alone.
 *
 * The only reason this matters is table cells: an unescaped `|` in the middle
 * of a rendered formula splits the row into extra cells and destroys the
 * table (this is exactly why users write $\|q\|$ in the source). Emphasis and
 * code delimiters get the same treatment for safety even though utftex rarely
 * emits them.
 */
const OUTPUT_ESCAPE_RE = /[\\`*_~|[\]]/g;
function escapeInlineOutput(text: string): string {
	return text.replace(OUTPUT_ESCAPE_RE, "\\$&");
}

/**
 * Marked's table-cell splitter interprets `\|` as a literal `|`, so by the
 * time a cell's inline body is tokenized the backslash is gone. Our transform
 * runs on the RAW source (before that splitter), so we mirror the same rule
 * inside the math body. Users who need TeX's `\|` (double vertical bars) can
 * write `\Vert` instead — utftex renders `\|` inconsistently anyway.
 */
function unescapePipeEscape(tex: string): string {
	return tex.replace(/\\\|/g, "|");
}

/** Try to substitute one inline math span with a single-line typeset. */
function typesetInline(
	tex: string,
	options: TransformOptions,
	resolveSymbol: SymbolResolver,
): string | null {
	if (tex.length === 0 || tex.length > MAX_TEX_LENGTH) return null;
	if (!looksLikeMath(tex)) return null;

	const cleaned = normalizeSpacing(unescapePipeEscape(tex));
	if (hasUnsupportedControlSymbol(cleaned)) return null;

	const compacted = compactScripts(cleaned, resolveSymbol);
	let rawArt = options.typeset(compacted);
	if (rawArt !== null && rawArt.includes("\n")) {
		// utftex stacks \frac vertically; retry with an inline (a)/(b) rewrite
		// so the result fits on one line inside a table cell.
		const flat = flattenFractions(compacted);
		if (flat !== compacted) {
			const flatArt = options.typeset(flat);
			if (flatArt !== null && !flatArt.includes("\n")) rawArt = flatArt;
		}
	}
	if (rawArt === null || rawArt.includes("\n")) return null;

	const art = polishArt(rawArt).trim();
	if (art.length === 0) return null;
	if (options.measureWidth(art) > options.availableWidth) return null;
	return escapeInlineOutput(art);
}

/** Split markdown into alternating segments, isolating fenced code blocks. */
function splitByFences(markdown: string): Array<{ text: string; code: boolean }> {
	const lines = markdown.split("\n");
	const segments: Array<{ text: string; code: boolean }> = [];
	let current: string[] = [];
	let inFence = false;
	let fenceChar = "";
	for (const line of lines) {
		const match = line.match(FENCE_OPEN_RE);
		if (!inFence && match) {
			if (current.length > 0) segments.push({ text: current.join("\n"), code: false });
			current = [line];
			inFence = true;
			fenceChar = match[1][0];
			continue;
		}
		if (inFence && match && match[1][0] === fenceChar) {
			current.push(line);
			segments.push({ text: current.join("\n"), code: true });
			current = [];
			inFence = false;
			continue;
		}
		current.push(line);
	}
	if (current.length > 0) segments.push({ text: current.join("\n"), code: inFence });
	return segments;
}

/** Build a fenced-block replacement for one display-math span, or null. */
function typesetDisplay(
	tex: string,
	dollarSyntax: boolean,
	options: TransformOptions,
	resolveSymbol: SymbolResolver,
): string | null {
	if (tex.length === 0 || tex.length > MAX_TEX_LENGTH) return null;
	if (!dollarSyntax && !looksLikeMath(tex)) return null;

	const cleaned = normalizeSpacing(tex);
	if (hasUnsupportedControlSymbol(cleaned)) return null;

	const compacted = compactScripts(cleaned, resolveSymbol);
	const rawArt = options.typeset(compacted) ?? (compacted !== cleaned ? options.typeset(cleaned) : null);
	if (rawArt === null) return null;
	const art = polishArt(rawArt);

	const maxLineWidth = Math.max(...art.split("\n").map(options.measureWidth));
	if (maxLineWidth > options.availableWidth - FENCE_INDENT_RESERVE) return null;

	return `\n\n\`\`\`\n${art}\n\`\`\`\n\n`;
}

// Literal to keep the linter's ReDoS check happy; must stay in sync with MASK_SENTINEL.
const MASK_RESTORE_RE = /\u0000(\d+)\u0000/g;

/** Replace display and inline math in one non-code segment. */
function transformSegment(segment: string, options: TransformOptions, resolveSymbol: SymbolResolver): string {
	// Mask inline code spans so `$$...$$` inside backticks is never rewritten.
	const masked: string[] = [];
	const withMasks = segment.replace(INLINE_CODE_RE, (span) => {
		masked.push(span);
		return `${MASK_SENTINEL}${masked.length - 1}${MASK_SENTINEL}`;
	});

	const afterDisplay = withMasks.replace(DISPLAY_MATH_RE, (full, dollarBody, bracketBody) => {
		const body: string = dollarBody ?? bracketBody ?? "";
		const tex = body.trim();
		if (tex.includes(MASK_SENTINEL)) return full;
		return typesetDisplay(tex, dollarBody !== undefined, options, resolveSymbol) ?? full;
	});

	// Inline pass: substitute $...$ that survived the display pass. Runs on
	// the masked text so inline code spans still shield their bodies, and skips
	// $-pairs still glued to a $$ (those failed the display pass and would
	// re-fail here for the same reason).
	const afterInline = afterDisplay.replace(INLINE_MATH_RE, (full, body: string) => {
		if (body.includes(MASK_SENTINEL)) return full;
		return typesetInline(body, options, resolveSymbol) ?? full;
	});

	return afterInline.replace(MASK_RESTORE_RE, (_m, index) => masked[Number(index)]);
}

/**
 * Transform markdown, typesetting display math outside code regions.
 *
 * Args:
 *     markdown: Source markdown of a user/assistant/thinking message.
 *     options: Width context and the typesetting callback.
 *
 * Returns:
 *     The transformed markdown; identical to the input when nothing applies.
 */
export function transformMarkdown(markdown: string, options: TransformOptions): string {
	if (options.availableWidth < MIN_USEFUL_WIDTH) return markdown;
	if (!markdown.includes("$") && !markdown.includes("\\[")) return markdown;

	const segments = splitByFences(markdown);
	if (!segments.some((segment) => !segment.code)) return markdown;

	const resolveSymbol = createSymbolResolver(options.typeset);
	return segments
		.map((segment) => (segment.code ? segment.text : transformSegment(segment.text, options, resolveSymbol)))
		.join("\n");
}
