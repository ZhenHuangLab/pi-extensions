import { describe, expect, it, vi } from "vitest";
import { resolveXaiRuntime } from "../src/auth.ts";

type RuntimeContext = Parameters<typeof resolveXaiRuntime>[0];

interface ContextOptions {
  provider?: unknown;
  auth?: unknown;
  model?: unknown;
  authError?: Error;
}

function makeContext(options: ContextOptions = {}): RuntimeContext {
  const getProviderAuth = options.authError
    ? vi.fn().mockRejectedValue(options.authError)
    : vi.fn().mockResolvedValue(options.auth);

  return {
    modelRegistry: {
      getProvider: vi.fn().mockReturnValue(options.provider),
      getProviderAuth,
      find: vi.fn().mockReturnValue(options.model),
    },
  } as unknown as RuntimeContext;
}

describe("resolveXaiRuntime", () => {
  it("resolves auth through Pi and merges effective headers", async () => {
    const ctx = makeContext({
      provider: {
        baseUrl: "https://provider.example/v1/",
        headers: { "X-Provider": "provider", "X-Remove": "provider" },
      },
      model: {
        baseUrl: "https://model.example/v1/",
        headers: { "X-Provider": "model", "X-Model": "model" },
      },
      auth: {
        auth: {
          apiKey: "  secret-token  ",
          baseUrl: "https://auth.example/v1/",
          headers: { "X-Auth": "auth", "X-Remove": null },
        },
        source: "OAuth",
      },
    });

    await expect(resolveXaiRuntime(ctx, "grok-4.5")).resolves.toEqual({
      apiKey: "secret-token",
      baseUrl: "https://auth.example/v1",
      headers: {
        "X-Provider": "model",
        "X-Model": "model",
        "X-Auth": "auth",
      },
      authSource: "OAuth",
    });
  });

  it("uses the selected model base URL before the provider default", async () => {
    const ctx = makeContext({
      provider: { baseUrl: "https://provider.example/v1" },
      model: { baseUrl: "https://model.example/v1" },
      auth: { auth: { apiKey: "key" } },
    });

    const runtime = await resolveXaiRuntime(ctx, "grok-4.5");
    expect(runtime.baseUrl).toBe("https://model.example/v1");
  });

  it("reports an unavailable built-in provider", async () => {
    const ctx = makeContext();
    await expect(resolveXaiRuntime(ctx, "grok-4.5")).rejects.toThrow(
      'built-in "xai" provider is unavailable',
    );
  });

  it("reports missing credentials with setup instructions", async () => {
    const ctx = makeContext({ provider: { baseUrl: "https://api.x.ai/v1" } });
    await expect(resolveXaiRuntime(ctx, "grok-4.5")).rejects.toThrow("`/login xai`");
  });

  it("preserves OAuth refresh errors and recommends signing in again", async () => {
    const ctx = makeContext({
      provider: { baseUrl: "https://api.x.ai/v1" },
      authError: new Error("refresh token expired"),
    });

    await expect(resolveXaiRuntime(ctx, "grok-4.5")).rejects.toThrow(
      "refresh token expired. Run `/login xai`",
    );
  });

  it("rejects a credential resolution without an API key", async () => {
    const ctx = makeContext({
      provider: { baseUrl: "https://api.x.ai/v1" },
      auth: { auth: {} },
    });

    await expect(resolveXaiRuntime(ctx, "grok-4.5")).rejects.toThrow(
      "resolved credentials without an API key",
    );
  });
});
