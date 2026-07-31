import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveXaiRuntime } from "./auth.ts";
import type { FetchLike } from "./client.ts";
import {
  loadXaiSearchConfig,
  saveXaiSearchConfig,
  XAI_SEARCH_CONFIG_FILENAME,
  type XaiSearchConfig,
} from "./config.ts";
import { listXaiModels } from "./models.ts";
import { DEFAULT_XAI_SEARCH_MODEL } from "./schema.ts";
import { selectXaiModel } from "./ui.ts";

export interface XaiSearchSettingsOptions {
  configPath?: string;
  fetch?: FetchLike;
  listModels?: typeof listXaiModels;
  selectModel?: typeof selectXaiModel;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class XaiSearchSettings {
  private readonly configPath: string;
  private config: XaiSearchConfig = { model: DEFAULT_XAI_SEARCH_MODEL };

  constructor(private readonly options: XaiSearchSettingsOptions = {}) {
    this.configPath = options.configPath ?? join(getAgentDir(), XAI_SEARCH_CONFIG_FILENAME);
  }

  get model(): string {
    return this.config.model;
  }

  async refresh(ctx: Pick<ExtensionContext, "ui" | "hasUI">): Promise<void> {
    const loaded = await loadXaiSearchConfig(this.configPath);
    this.config = loaded.config;
    if (!ctx.hasUI) return;
    for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
  }

  async open(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/xai-search config requires TUI mode", "warning");
      return;
    }

    await this.refresh(ctx);
    ctx.ui.setStatus("xai-search-config", "Loading xAI models…");
    try {
      await this.selectAndSave(ctx);
    } catch (error) {
      ctx.ui.notify(`Could not configure xai_search: ${errorMessage(error)}`, "error");
    } finally {
      ctx.ui.setStatus("xai-search-config", undefined);
    }
  }

  private async selectAndSave(ctx: ExtensionCommandContext): Promise<void> {
    const runtime = await resolveXaiRuntime(ctx, this.config.model);
    const models = await (this.options.listModels ?? listXaiModels)(runtime, {
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    ctx.ui.setStatus("xai-search-config", undefined);

    const selectedModel = await (this.options.selectModel ?? selectXaiModel)(
      ctx,
      models,
      this.config.model,
    );
    if (!selectedModel) return;
    if (selectedModel === this.config.model) {
      ctx.ui.notify(`xai_search already uses ${selectedModel}`, "info");
      return;
    }

    await saveXaiSearchConfig(this.configPath, { model: selectedModel });
    this.config = { model: selectedModel };
    ctx.ui.notify(`xai_search model changed to ${selectedModel} (applied immediately)`, "info");
  }
}
