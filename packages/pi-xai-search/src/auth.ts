import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const XAI_PROVIDER_ID = "xai";

export interface ResolvedXaiRuntime {
  apiKey: string;
  baseUrl: string;
  headers: Record<string, string>;
  authSource?: string;
}

type HeaderRecord = Record<string, string | null> | undefined;

function mergeHeaders(...sources: HeaderRecord[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      if (value === null) delete merged[name];
      else merged[name] = value;
    }
  }
  return merged;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function resolveXaiRuntime(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  modelId: string,
): Promise<ResolvedXaiRuntime> {
  const provider = ctx.modelRegistry.getProvider(XAI_PROVIDER_ID);
  if (!provider) {
    throw new Error(
      'Pi\'s built-in "xai" provider is unavailable. Upgrade Pi, then run `/login xai`.',
    );
  }

  let resolution: Awaited<ReturnType<typeof ctx.modelRegistry.getProviderAuth>>;
  try {
    resolution = await ctx.modelRegistry.getProviderAuth(XAI_PROVIDER_ID);
  } catch (error) {
    throw new Error(
      `Could not resolve xAI credentials: ${errorMessage(error)}. Run \`/login xai\` to sign in again.`,
      { cause: error },
    );
  }

  if (!resolution) {
    throw new Error(
      "No xAI credentials found. Run `/login xai` for a Grok/X subscription, or set `XAI_API_KEY`.",
    );
  }

  const apiKey = resolution.auth.apiKey?.trim();
  if (!apiKey) {
    throw new Error('Pi\'s built-in "xai" provider resolved credentials without an API key.');
  }

  const model = ctx.modelRegistry.find(XAI_PROVIDER_ID, modelId);
  const baseUrl = (resolution.auth.baseUrl ?? model?.baseUrl ?? provider.baseUrl)?.replace(
    /\/+$/,
    "",
  );
  if (!baseUrl) {
    throw new Error('Pi\'s built-in "xai" provider did not supply an API base URL.');
  }

  return {
    apiKey,
    baseUrl,
    headers: mergeHeaders(provider.headers, model?.headers, resolution.auth.headers),
    ...(resolution.source ? { authSource: resolution.source } : {}),
  };
}
