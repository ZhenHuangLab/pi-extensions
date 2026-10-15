import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type Scope = "global" | "project";

export type PromptDir = { scope: Scope; dir: string };

export type ModelRef = { provider: string; id: string; name?: string };

export type PromptFile = {
	/** File name, such as `gpt-6.1-sol.md`. A project file replaces a global file of the same name. */
	name: string;
	path: string;
	scope: Scope;
	/** Patterns as written: the `match` frontmatter, or the file name without `.md`. */
	match: string[];
	patterns: RegExp[];
	body: string;
	/** Why the file cannot be used. A file with an error never matches. */
	error?: string;
};

/**
 * Reads the `*.md` files of each directory. A later directory replaces files of the same name
 * from an earlier one, also when its own file has an error. Files are sorted by name.
 */
export function loadPrompts(dirs: PromptDir[]): PromptFile[] {
	const byName = new Map<string, PromptFile>();
	for (const { scope, dir } of dirs) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				const name = `${basename(dir)}/`;
				byName.set(`${scope}:${name}`, failed(name, dir, scope, error));
			}
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".md") || name.startsWith(".")) continue;
			const path = join(dir, name);
			const file = readPrompt(name, path, scope);
			if (file) byName.set(name, file);
		}
	}
	return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function matchesModel(file: PromptFile, model: ModelRef): boolean {
	if (file.error) return false;
	const values = [`${model.provider}/${model.id}`, model.id];
	if (model.name) values.push(model.name);
	return file.patterns.some((pattern) => values.some((value) => pattern.test(value)));
}

function readPrompt(name: string, path: string, scope: Scope): PromptFile | undefined {
	try {
		if (!statSync(path).isFile()) return undefined;
		const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
		if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
			throw new Error("frontmatter must be a YAML mapping");
		}
		const match = parseMatch(frontmatter.match, name.slice(0, -".md".length));
		const text = body.trim();
		const file: PromptFile = { name, path, scope, match, patterns: match.map(globToRegExp), body: text };
		if (!text) file.error = "no prompt text";
		return file;
	} catch (error) {
		return failed(name, path, scope, error);
	}
}

function parseMatch(value: unknown, stem: string): string[] {
	if (value === undefined || value === null) return [stem];
	const items = typeof value === "string" ? [value] : value;
	if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) {
		throw new Error("`match` must be a string or a list of strings");
	}
	const patterns = items
		.flatMap((item) => item.split(","))
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	if (patterns.length === 0) throw new Error("`match` is empty");
	return patterns;
}

/** `*` matches any run of characters, including `/`; `?` matches one character. Case is ignored. */
function globToRegExp(pattern: string): RegExp {
	const source = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${source}$`, "i");
}

function failed(name: string, path: string, scope: Scope, error: unknown): PromptFile {
	const message = error instanceof Error ? error.message : String(error);
	return { name, path, scope, match: [], patterns: [], body: "", error: message.split("\n")[0].replace(/:$/, "") };
}
