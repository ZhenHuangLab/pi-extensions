import {
  DynamicBorder,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import type { XaiModelInfo } from "./models.ts";

export interface XaiModelChoice {
  id: string;
  description?: string;
  searchText: string;
}

function describeModel(model: XaiModelInfo): string | undefined {
  const parts: string[] = [];
  if (model.ownedBy) parts.push(model.ownedBy);
  if (model.contextLength) parts.push(`${model.contextLength.toLocaleString("en-US")} tokens`);
  if (model.aliases.length > 0) parts.push(`aliases: ${model.aliases.join(", ")}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function createXaiModelChoices(
  models: XaiModelInfo[],
  currentModel: string,
): XaiModelChoice[] {
  const choices = new Map<string, XaiModelChoice>();

  for (const model of models) {
    const description = describeModel(model);
    choices.set(model.id, {
      id: model.id,
      ...(description ? { description } : {}),
      searchText: `${model.id} ${model.aliases.join(" ")}`,
    });
  }

  for (const model of models) {
    for (const alias of model.aliases) {
      if (choices.has(alias)) continue;
      choices.set(alias, {
        id: alias,
        description: `Alias for ${model.id}`,
        searchText: `${alias} ${model.id}`,
      });
    }
  }

  if (!choices.has(currentModel)) {
    choices.set(currentModel, {
      id: currentModel,
      description: "Current configured model (not returned by /models)",
      searchText: currentModel,
    });
  }

  return [...choices.values()].sort((left, right) => {
    if (left.id === currentModel) return -1;
    if (right.id === currentModel) return 1;
    return left.id.localeCompare(right.id);
  });
}

export function filterXaiModelChoices(choices: XaiModelChoice[], query: string): XaiModelChoice[] {
  return fuzzyFilter(choices, query.trim(), (choice: XaiModelChoice) => choice.searchText);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface XaiSettingsMenuOptions {
  currentModel: string;
  theme: Theme;
  keybindings: KeybindingsManager;
  onSelectModel(): void;
  onCancel(): void;
  requestRender(): void;
}

class XaiSettingsMenu implements Component, Focusable {
  private readonly container = new Container();
  private list!: SelectList;
  private focusedValue = false;

  constructor(private readonly options: XaiSettingsMenuOptions) {
    this.rebuild();
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
  }

  private rebuild(): void {
    const items: SelectItem[] = [
      {
        value: "model",
        label: "Search model",
        description: `Current: ${this.options.currentModel}`,
      },
    ];

    this.list = new SelectList(items, items.length, {
      selectedPrefix: (text: string) => this.options.theme.fg("accent", text),
      selectedText: (text: string) => this.options.theme.fg("accent", text),
      description: (text: string) => this.options.theme.fg("muted", text),
      scrollInfo: (text: string) => this.options.theme.fg("dim", text),
      noMatch: (text: string) => this.options.theme.fg("warning", text),
    });
    this.list.onSelect = () => this.options.onSelectModel();
    this.list.onCancel = this.options.onCancel;

    this.container.clear();
    this.container.addChild(
      new DynamicBorder((text: string) => this.options.theme.fg("borderAccent", text)),
    );
    this.container.addChild(
      new Text(
        this.options.theme.fg("accent", this.options.theme.bold("xAI Search Settings")),
        1,
        0,
      ),
    );
    this.container.addChild(
      new Text(this.options.theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0),
    );
    this.container.addChild(this.list);
    this.container.addChild(
      new DynamicBorder((text: string) => this.options.theme.fg("borderAccent", text)),
    );
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
    this.options.requestRender();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
    this.rebuild();
  }
}

class XaiSettingsMessage implements Component, Focusable {
  private readonly container = new Container();
  private focusedValue = false;

  constructor(theme: Theme, title: string, body: string, hint: string) {
    this.container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));
    this.container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    this.container.addChild(new Text(theme.fg("muted", body), 1, 0));
    this.container.addChild(new Text(theme.fg("dim", hint), 1, 0));
    this.container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
  }

  handleInput(_data: string): void {
    // Esc is handled by XaiSettingsFlow, which owns the view switching.
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }
}

interface XaiModelPickerOptions {
  choices: XaiModelChoice[];
  currentModel: string;
  theme: Theme;
  keybindings: KeybindingsManager;
  cancelHint?: string;
  onSelect(model: string): void;
  onCancel(): void;
  requestRender(): void;
}

class XaiModelPicker implements Component, Focusable {
  private readonly container = new Container();
  private readonly input = new Input();
  private list!: SelectList;
  private focusedValue = false;

  constructor(private readonly options: XaiModelPickerOptions) {
    this.rebuild();
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.input.focused = value;
  }

  private rebuild(): void {
    const filtered = filterXaiModelChoices(this.options.choices, this.input.getValue());
    const items: SelectItem[] = filtered.map((choice) => ({
      value: choice.id,
      label: choice.id === this.options.currentModel ? `${choice.id} (current)` : choice.id,
      ...(choice.description ? { description: choice.description } : {}),
    }));

    this.list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), {
      selectedPrefix: (text: string) => this.options.theme.fg("accent", text),
      selectedText: (text: string) => this.options.theme.fg("accent", text),
      description: (text: string) => this.options.theme.fg("muted", text),
      scrollInfo: (text: string) => this.options.theme.fg("dim", text),
      noMatch: (text: string) =>
        this.options.theme.fg("warning", text.replace("commands", "models")),
    });
    this.list.onSelect = (item: SelectItem) => this.options.onSelect(item.value);
    this.list.onCancel = this.options.onCancel;

    this.container.clear();
    this.container.addChild(
      new DynamicBorder((text: string) => this.options.theme.fg("borderAccent", text)),
    );
    this.container.addChild(
      new Text(this.options.theme.fg("accent", this.options.theme.bold("xAI Search Model")), 1, 0),
    );
    this.container.addChild(
      new Text(this.options.theme.fg("muted", `Current: ${this.options.currentModel}`), 1, 0),
    );
    this.container.addChild(new Text(this.options.theme.fg("dim", "Type to fuzzy search"), 1, 0));
    this.container.addChild(this.input);
    this.container.addChild(this.list);
    this.container.addChild(
      new Text(
        this.options.theme.fg(
          "dim",
          `↑↓ navigate • enter select • ${this.options.cancelHint ?? "esc cancel"}`,
        ),
        1,
        0,
      ),
    );
    this.container.addChild(
      new DynamicBorder((text: string) => this.options.theme.fg("borderAccent", text)),
    );
  }

  handleInput(data: string): void {
    if (
      this.options.keybindings.matches(data, "tui.select.up") ||
      this.options.keybindings.matches(data, "tui.select.down") ||
      this.options.keybindings.matches(data, "tui.select.confirm") ||
      this.options.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.list.handleInput(data);
    } else {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (this.input.getValue() !== previous) this.rebuild();
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
    this.rebuild();
  }
}

type XaiSettingsView = "menu" | "loading" | "error" | "model";

interface XaiSettingsFlowOptions {
  currentModel: string;
  theme: Theme;
  keybindings: KeybindingsManager;
  loadModels(): Promise<XaiModelInfo[]>;
  onSelectModel(model: string): void;
  onCancel(): void;
  requestRender(): void;
}

class XaiSettingsFlow implements Component, Focusable {
  private viewName: XaiSettingsView = "menu";
  private readonly menu: XaiSettingsMenu;
  private readonly loadingView: XaiSettingsMessage;
  private errorView: XaiSettingsMessage | null = null;
  private picker: XaiModelPicker | null = null;
  private focusedValue = false;

  constructor(private readonly options: XaiSettingsFlowOptions) {
    this.menu = new XaiSettingsMenu({
      currentModel: options.currentModel,
      theme: options.theme,
      keybindings: options.keybindings,
      onSelectModel: () => void this.startModelLoading(),
      onCancel: options.onCancel,
      requestRender: options.requestRender,
    });
    this.loadingView = new XaiSettingsMessage(
      options.theme,
      "xAI Search Settings",
      "Loading xAI models…",
      "esc to go back",
    );
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.activeView.focused = value;
  }

  private get activeView(): Component & Focusable & { handleInput(data: string): void } {
    switch (this.viewName) {
      case "menu":
        return this.menu;
      case "loading":
        return this.loadingView;
      case "error":
        return this.errorView!;
      case "model":
        return this.picker!;
    }
  }

  private switchTo(view: XaiSettingsView): void {
    this.activeView.focused = false;
    this.viewName = view;
    this.activeView.focused = this.focusedValue;
    this.options.requestRender();
  }

  private async startModelLoading(): Promise<void> {
    this.switchTo("loading");
    let models: XaiModelInfo[];
    try {
      models = await this.options.loadModels();
    } catch (error) {
      if (this.viewName !== "loading") return;
      this.errorView = new XaiSettingsMessage(
        this.options.theme,
        "Could not load xAI models",
        errorMessage(error),
        "esc to go back",
      );
      this.switchTo("error");
      return;
    }
    if (this.viewName !== "loading") return;

    this.picker = new XaiModelPicker({
      choices: createXaiModelChoices(models, this.options.currentModel),
      currentModel: this.options.currentModel,
      theme: this.options.theme,
      keybindings: this.options.keybindings,
      cancelHint: "esc back",
      onSelect: (model: string) => this.options.onSelectModel(model),
      onCancel: () => this.switchTo("menu"),
      requestRender: this.options.requestRender,
    });
    this.switchTo("model");
  }

  handleInput(data: string): void {
    if (this.viewName === "loading" || this.viewName === "error") {
      if (this.options.keybindings.matches(data, "tui.select.cancel")) {
        this.switchTo("menu");
      }
    } else {
      this.activeView.handleInput(data);
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    return this.activeView.render(width);
  }

  invalidate(): void {
    this.menu.invalidate();
    this.loadingView.invalidate();
    this.errorView?.invalidate();
    this.picker?.invalidate();
  }
}

export function selectXaiSettingsMenu(
  ctx: Pick<ExtensionContext, "ui">,
  currentModel: string,
  loadModels: () => Promise<XaiModelInfo[]>,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, theme, keybindings, done) =>
      new XaiSettingsFlow({
        currentModel,
        theme,
        keybindings,
        loadModels,
        onSelectModel: done,
        onCancel: () => done(undefined),
        requestRender: () => tui.requestRender(),
      }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "70%",
        minWidth: 44,
        maxHeight: "80%",
        margin: 1,
      },
    },
  );
}
