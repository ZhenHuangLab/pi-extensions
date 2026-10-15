/**
 * prompt-per-model
 *
 * Adds the Markdown files that match the current model to the system prompt, as a
 * `model_prompt` section after `cwd`. Files live in ~/.pi/agent/prompt-per-model/ and, in
 * trusted projects, in .pi/prompt-per-model/. They are read again before every run, so edits
 * apply from the next message.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPrompts, matchesModel, type PromptDir, type PromptFile } from "./prompts.ts";

const NAME = "prompt-per-model";
const SECTION = "model_prompt";
const PROJECT_DIR = join(".pi", NAME);

type State = { files: PromptFile[]; active: PromptFile[]; problems: PromptFile[] };

export default function promptPerModel(pi: ExtensionAPI) {
	const globalDir = join(getAgentDir(), NAME);

	function refresh(ctx: ExtensionContext): State {
		const dirs: PromptDir[] = [{ scope: "global", dir: globalDir }];
		if (ctx.isProjectTrusted()) dirs.push({ scope: "project", dir: join(ctx.cwd, PROJECT_DIR) });
		const files = loadPrompts(dirs);
		const model = ctx.model;
		const active = model ? files.filter((file) => matchesModel(file, model)) : [];
		const problems = files.filter((file) => file.error !== undefined);
		ctx.ui.setStatus(NAME, statusText(active, problems));
		return { files, active, problems };
	}

	function report({ files, active }: State, ctx: ExtensionContext): string {
		const lines = [`${modelLabel(ctx)} → ${names(active) || "(none)"}`];
		const width = Math.max(0, ...files.map((file) => file.name.length));
		for (const file of files) {
			const mark = file.error !== undefined ? "!" : active.includes(file) ? "✓" : " ";
			const detail = file.error ?? file.match.join(", ");
			const scope = file.scope === "project" ? "  (project)" : "";
			lines.push(`${mark} ${file.name.padEnd(width)}  ${detail}${scope}`);
		}
		if (files.length === 0) lines.push("No prompt files.");
		lines.push(`global:  ${shortPath(globalDir)}`);
		lines.push(`project: ${PROJECT_DIR}${ctx.isProjectTrusted() ? "" : " (skipped: project not trusted)"}`);
		return lines.join("\n");
	}

	pi.on("session_start", (_event, ctx) => {
		try {
			mkdirSync(globalDir, { recursive: true });
		} catch (error) {
			ctx.ui.notify(`${NAME}: cannot create ${shortPath(globalDir)}: ${(error as Error).message}`, "warning");
		}
		const { problems } = refresh(ctx);
		if (problems.length > 0) {
			const details = problems.map((file) => `  ${shortPath(file.path)}: ${file.error}`);
			ctx.ui.notify([`${NAME}: ${countFiles(problems.length)} not used`, ...details].join("\n"), "warning");
		}
	});

	pi.on("model_select", (_event, ctx) => {
		refresh(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const { active } = refresh(ctx);
		if (active.length > 0) {
			event.systemPromptOptions.sections[SECTION] = active.map((file) => file.body).join("\n\n");
		}
	});

	pi.registerCommand(NAME, {
		description: "Show the prompt files and which of them apply to the current model",
		handler: async (_args, ctx) => {
			ctx.ui.notify(report(refresh(ctx), ctx), "info");
		},
	});
}

function statusText(active: PromptFile[], problems: PromptFile[]): string | undefined {
	const parts: string[] = [];
	if (active.length > 0) parts.push(names(active));
	if (problems.length > 0) parts.push(`${countFiles(problems.length)} not used`);
	return parts.length > 0 ? `${NAME}: ${parts.join(" · ")}` : undefined;
}

function names(files: PromptFile[]): string {
	return files.map((file) => file.name).join(", ");
}

function countFiles(count: number): string {
	return count === 1 ? "1 file" : `${count} files`;
}

function modelLabel(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no model)";
}

function shortPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
