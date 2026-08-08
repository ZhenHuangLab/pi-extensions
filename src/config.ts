import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type StripPiDocsConfig = {
  /** Whether stripping is enabled for new sessions. Default: true. */
  enabled: boolean;
};

export const DEFAULT_CONFIG: StripPiDocsConfig = {
  enabled: true,
};

/**
 * Config path: ~/.pi/agent/strip-pi-docs.json
 * Override with STRIP_PI_DOCS_CONFIG for tests.
 */
export function getConfigPath(): string {
  if (process.env.STRIP_PI_DOCS_CONFIG) {
    return process.env.STRIP_PI_DOCS_CONFIG;
  }
  return join(homedir(), ".pi", "agent", "strip-pi-docs.json");
}

export function loadConfig(): StripPiDocsConfig {
  const path = getConfigPath();
  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<StripPiDocsConfig>;
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: StripPiDocsConfig): void {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}
