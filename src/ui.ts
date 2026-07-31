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

interface XaiModelPickerOptions {
  choices: XaiModelChoice[];
  currentModel: string;
  theme: Theme;
  keybindings: KeybindingsManager;
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
      new Text(this.options.theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0),
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

export function selectXaiModel(
  ctx: Pick<ExtensionContext, "ui">,
  models: XaiModelInfo[],
  currentModel: string,
): Promise<string | undefined> {
  const choices = createXaiModelChoices(models, currentModel);
  return ctx.ui.custom<string | undefined>(
    (tui, theme, keybindings, done) =>
      new XaiModelPicker({
        choices,
        currentModel,
        theme,
        keybindings,
        onSelect: done,
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
