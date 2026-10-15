/**
 * Rules that detect searching and large dumps done through bash when a bounded
 * tool exists for the same job.
 *
 * A false positive costs the model a whole wasted turn, so a rule only fires
 * when the command would put more into the context than the replacement tool.
 * Search commands are always reported; listings and dumps are reported with the
 * paths to measure, and the caller blocks them only when they are actually
 * large.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { literalWord, parseShellSegments, type ResolvedCommand, resolveCommand } from "./shell.ts";

/** Which tool family should have handled a search. */
export type SearchCapability = "searchContent" | "findFiles";

export type Finding =
	/** A content or file search. `binary` lets the caller allow its sanctioned fallback. */
	| { kind: "search"; capability: SearchCapability; binary: string }
	/** A recursive listing whose size decides whether it is blocked. */
	| { kind: "listing"; directories: string[]; includeHidden: boolean }
	/** A whole-file dump to stdout whose size decides whether it is blocked. */
	| { kind: "dump"; files: { operand: string; path: string }[] };

const CONTENT_SEARCH_BINARIES = new Set(["grep", "egrep", "fgrep", "rg"]);

/** File finders, mapped to the name a route sanctions as its bash fallback. */
const FILE_SEARCH_BINARIES = new Map([
	["find", "find"],
	["fd", "fd"],
	["fdfind", "fd"],
]);

/** Finder flags that perform an action rather than just printing paths. */
const FINDER_ACTION_FLAGS = new Set([
	// find
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-delete",
	"-print0",
	"-printf",
	"-fprint",
	"-fprintf",
	"-fls",
	// fd
	"-x",
	"--exec",
	"-X",
	"--exec-batch",
	"-0",
	"--print0",
]);

/**
 * `rtk` subcommands that stand in for a native binary, mapped to that binary.
 * pi-rtk-optimizer rewrites `grep`/`rg`/`find`/`cat`/`head`/`tail`/`ls` into
 * these forms, and `rtk` is on PATH, so the rewritten and hand-written
 * spellings must reach the same rule. Everything else (`git`, `test`,
 * `docker`, `tree`, …) is real bash work and is left alone.
 */
const RTK_SUBCOMMANDS = new Map<string, string>([
	["grep", "grep"],
	["rg", "rg"],
	["find", "find"],
	["read", "cat"],
	["ls", "ls"],
]);

/** `rtk read` flags that bound the output: rtk's spelling of `head -50 f` / `tail -20 f`. */
const RTK_BOUNDED_READ_FLAGS = ["--max-lines", "--tail-lines"];

/**
 * A redirection operator with its optional fd prefix: `>`, `2>>`, `&>`, `>|`,
 * `<`, `<<`, `<<<`, `2>&`. Whatever follows in the same word is its target.
 */
const REDIRECTION = /^(?:\d+|&)?(?:>>?|<<?<?)[&|]?/;

/** Redirection that sends stdout to a file, so nothing reaches the context. */
const STDOUT_TO_FILE = /^(?:1|&)?>>?\|?(?!&)/;

function isFlag(word: string): boolean {
	return word.startsWith("-") && word !== "-";
}

/** `ls` flags that turn a listing into a recursive walk: `-R`, `-laR`, `--recursive`. */
function isRecursiveListing(word: string): boolean {
	return word === "--recursive" || /^-[A-Za-z]*R/.test(word);
}

/** `ls` flags that include dotfiles: `-a`, `-A`, `--all`, `--almost-all`. */
function includesHidden(word: string): boolean {
	return word === "--all" || word === "--almost-all" || /^-[A-Za-z]*[aA]/.test(word);
}

/** Positional arguments, without flags, redirection operators and their targets. */
function operands(args: string[]): string[] {
	const result: string[] = [];
	let optionsEnded = false;
	for (let i = 0; i < args.length; i += 1) {
		const word = args[i];
		const redirection = REDIRECTION.exec(word);
		if (redirection) {
			if (redirection[0].length === word.length) i += 1;
			continue;
		}
		if (!optionsEnded && word === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && isFlag(word)) continue;
		result.push(word);
	}
	return result;
}

/** Literal targets of stdout-to-file redirections, e.g. "log" in `npm test > log`. */
function stdoutTargets(words: string[]): string[] {
	const targets: string[] = [];
	for (let i = 0; i < words.length; i += 1) {
		const match = STDOUT_TO_FILE.exec(words[i]);
		if (!match) continue;
		const rest = words[i].slice(match[0].length);
		const target = rest !== "" ? rest : words[i + 1];
		if (target !== undefined) targets.push(target);
	}
	return targets;
}

/**
 * Rewrite `rtk <subcommand> …` into the native command it replaces, so a single
 * set of rules covers both spellings. Other subcommands, and bounded
 * `rtk read`, are returned unchanged and therefore never match a rule.
 */
function unwrapRtk(resolved: ResolvedCommand): ResolvedCommand {
	if (resolved.name !== "rtk" || resolved.args.length === 0) return resolved;
	const [subcommand, ...args] = resolved.args;
	const native = RTK_SUBCOMMANDS.get(subcommand);
	if (native === undefined) return resolved;
	if (native === "cat" && args.some((arg) => RTK_BOUNDED_READ_FLAGS.some((flag) => arg.startsWith(flag)))) {
		return resolved;
	}
	return { name: native, args };
}

/**
 * Tracks the working directory of each subshell scope while walking a command,
 * so relative paths after `cd dir &&` resolve against `dir`. Null means the
 * directory is no longer known, and relative paths are then left alone.
 */
class WorkingDirectories {
	readonly #byScope = new Map<string, string | null>();

	constructor(cwd: string) {
		this.#byScope.set("0", cwd);
	}

	get(scope: string): string | null {
		const known = this.#byScope.get(scope);
		if (known !== undefined) return known;
		// A subshell starts in its parent's directory.
		const inherited = this.get(scope.slice(0, scope.lastIndexOf("/")));
		this.#byScope.set(scope, inherited);
		return inherited;
	}

	change(scope: string, args: string[]): void {
		const targets = operands(args);
		const current = this.get(scope);
		if (targets.length === 0) {
			this.#byScope.set(scope, homedir());
			return;
		}
		const target = targets.length === 1 ? literalWord(targets[0]) : null;
		this.#byScope.set(scope, target === null || target === "-" ? null : this.#resolve(current, target));
	}

	forget(scope: string): void {
		this.#byScope.set(scope, null);
	}

	/** Absolute path of a word, or null when its value or base directory is unknown. */
	resolveWord(scope: string, word: string): string | null {
		const literal = literalWord(word);
		return literal === null ? null : this.#resolve(this.get(scope), literal);
	}

	#resolve(base: string | null, path: string): string | null {
		if (isAbsolute(path)) return resolve(path);
		return base === null ? null : resolve(base, path);
	}
}

/**
 * Inspect one bash command run from `cwd`. Returns every finding in command
 * order; an empty list means the command is fine.
 */
export function inspectBashCommand(command: string, cwd: string): Finding[] {
	const findings: Finding[] = [];
	const directories = new WorkingDirectories(cwd);
	// Files the command itself writes; dumping them later reads fresh output.
	const written = new Set<string>();

	for (const segment of parseShellSegments(command)) {
		const { scope, words } = segment;
		for (const target of stdoutTargets(words)) {
			const path = directories.resolveWord(scope, target);
			if (path !== null) written.add(path);
		}

		const resolved = resolveCommand(segment);
		if (!resolved) continue;
		const { name, args } = unwrapRtk(resolved);

		if (name === "cd") {
			directories.change(scope, args);
			continue;
		}
		if (name === "pushd" || name === "popd") {
			directories.forget(scope);
			continue;
		}

		if (segment.afterPipe) continue;

		if (CONTENT_SEARCH_BINARIES.has(name)) {
			findings.push({ kind: "search", capability: "searchContent", binary: name });
			continue;
		}

		// The remaining rules only fire when the output reaches the context:
		// feeding a pipe (`find . -name '*.ts' | xargs ...`, `cat f | jq`) or a
		// file is a real bash job.
		if (segment.beforePipe) continue;
		if (words.some((word) => STDOUT_TO_FILE.test(word))) continue;

		const finder = FILE_SEARCH_BINARIES.get(name);
		if (finder !== undefined) {
			if (args.some((arg) => FINDER_ACTION_FLAGS.has(arg))) continue;
			findings.push({ kind: "search", capability: "findFiles", binary: finder });
			continue;
		}

		if (name === "ls") {
			if (!args.some(isRecursiveListing)) continue;
			const targets = operands(args);
			const paths = (targets.length > 0 ? targets : ["."]).map((target) =>
				directories.resolveWord(scope, target),
			);
			if (!paths.every((path): path is string => path !== null)) continue;
			findings.push({
				kind: "listing",
				directories: paths,
				includeHidden: args.some(includesHidden),
			});
			continue;
		}

		if (name === "cat") {
			const files: { operand: string; path: string }[] = [];
			for (const operand of operands(args)) {
				if (operand === "-") continue;
				const path = directories.resolveWord(scope, operand);
				if (path !== null && !written.has(path)) files.push({ operand: literalWord(operand) ?? operand, path });
			}
			if (files.length > 0) findings.push({ kind: "dump", files });
		}
	}

	return findings;
}
