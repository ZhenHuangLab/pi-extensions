import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerXaiSearch from "../index.ts";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function extensionApi() {
  const registerTool = vi.fn();
  const registerCommand = vi.fn();
  const on = vi.fn();
  const pi = { registerTool, registerCommand, on } as unknown as ExtensionAPI;
  return { pi, registerTool, registerCommand, on };
}

function runtimeContext() {
  return {
    hasUI: true,
    mode: "tui",
    model: { provider: "anthropic", id: "claude-opus" },
    modelRegistry: {
      getProvider: vi.fn().mockReturnValue({ baseUrl: "https://api.x.ai/v1" }),
      getProviderAuth: vi.fn().mockResolvedValue({
        auth: { apiKey: "oauth-token" },
        source: "OAuth",
      }),
      find: vi.fn().mockReturnValue({ baseUrl: "https://api.x.ai/v1" }),
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  };
}

describe("pi extension", () => {
  it("registers one tool plus the config command and searches independently of the active model", async () => {
    const { pi, registerTool, registerCommand, on } = extensionApi();
    registerXaiSearch(pi);

    expect(registerTool).toHaveBeenCalledOnce();
    expect(registerCommand).toHaveBeenCalledOnce();
    expect(registerCommand.mock.calls[0]![0]).toBe("xai-search");
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));

    const tool = registerTool.mock.calls[0]![0];
    expect(tool.name).toBe("xai_search");

    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "grok-4.5",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Live X result" }],
            },
          ],
          citations: ["https://x.com/example/status/1"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetch;

    const ctx = runtimeContext();
    const result = await tool.execute(
      "call-1",
      { query: "latest xAI discussion" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("Live X result");
    expect(result.details).toMatchObject({ model: "grok-4.5", provider: "xai" });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(body.model).toBe("grok-4.5");
    expect(body.tools).toEqual([{ type: "x_search" }]);
    expect(ctx.model.provider).toBe("anthropic");
  });

  it("persists a menu selection and applies it to the next tool call without reloading", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-xai-search-extension-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    const listModels = vi.fn().mockResolvedValue([
      { id: "grok-4.5", aliases: [] },
      { id: "grok-4.20", aliases: [] },
    ]);
    const selectModel = vi.fn().mockResolvedValue("grok-4.20");
    const { pi, registerTool, registerCommand } = extensionApi();
    registerXaiSearch(pi, { configPath, listModels, selectModel });

    const command = registerCommand.mock.calls[0]![1];
    const ctx = runtimeContext();
    await command.handler("config", ctx);

    expect(listModels).toHaveBeenCalledOnce();
    expect(selectModel).toHaveBeenCalledWith(
      ctx,
      [
        { id: "grok-4.5", aliases: [] },
        { id: "grok-4.20", aliases: [] },
      ],
      "grok-4.5",
    );
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ model: "grok-4.20" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "xai_search model changed to grok-4.20 (applied immediately)",
      "info",
    );

    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ model: "grok-4.20", output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetch;

    const tool = registerTool.mock.calls[0]![0];
    await tool.execute("call-2", { query: "hot reload" }, undefined, undefined, ctx);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).model).toBe("grok-4.20");
  });

  it("loads the persisted model when a new session starts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-xai-search-extension-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    await writeFile(configPath, `${JSON.stringify({ model: "grok-4.20" })}\n`, "utf8");

    const { pi, registerTool, on } = extensionApi();
    registerXaiSearch(pi, { configPath });
    const ctx = runtimeContext();
    const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1];
    await sessionStart({}, ctx);

    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ model: "grok-4.20", output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetch;

    const tool = registerTool.mock.calls[0]![0];
    await tool.execute("call-3", { query: "persisted config" }, undefined, undefined, ctx);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).model).toBe("grok-4.20");
  });
});
