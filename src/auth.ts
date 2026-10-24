import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AuthSource = "opencode" | "environment" | "firecrawl-cli";

export type FirecrawlConfig = {
  /** Missing only when the caller allowed anonymous access. */
  apiKey?: string;
  apiUrl: string;
  source?: AuthSource;
};

export type ResolveOptions = {
  /** The credential from OpenCode's `firecrawl` connection, if one is active. */
  connectionKey?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** Developer search answers without a key, at a lower rate limit. */
  allowAnonymous?: boolean;
};

const DEFAULT_API_URL = "https://api.firecrawl.dev";

function cliCredentialsPath(home: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "firecrawl-cli", "credentials.json");
  if (platform === "win32") return join(home, "AppData", "Roaming", "firecrawl-cli", "credentials.json");
  return join(home, ".config", "firecrawl-cli", "credentials.json");
}

function readCliCredentials(home: string, platform: NodeJS.Platform): { apiKey?: string; apiUrl?: string } {
  try {
    const value = JSON.parse(readFileSync(cliCredentialsPath(home, platform), "utf8")) as Record<string, unknown>;
    return {
      apiKey: typeof value.apiKey === "string" ? value.apiKey : undefined,
      apiUrl: typeof value.apiUrl === "string" ? value.apiUrl : undefined,
    };
  } catch {
    return {};
  }
}

function normalizeApiUrl(value: string | undefined): string {
  const input = value?.trim() || DEFAULT_API_URL;
  const url = new URL(input);
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("Firecrawl API URL must use HTTPS (or localhost HTTP).");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

/**
 * Picks the credential in this order: OpenCode's `firecrawl` connection (`/connect`), `FIRECRAWL_API_KEY`, then the
 * Firecrawl CLI's credential store. The API URL comes from `FIRECRAWL_API_URL` or the CLI store.
 */
export function resolveFirecrawlConfig(options: ResolveOptions = {}): FirecrawlConfig {
  const env = options.env ?? process.env;
  const cli = readCliCredentials(options.home ?? homedir(), options.platform ?? process.platform);
  const connectionKey = options.connectionKey?.trim();
  const envKey = env.FIRECRAWL_API_KEY?.trim();
  const cliKey = cli.apiKey?.trim();
  const apiKey = connectionKey || envKey || cliKey;
  const apiUrl = normalizeApiUrl(env.FIRECRAWL_API_URL || cli.apiUrl);
  if (!apiKey) {
    if (options.allowAnonymous) return { apiUrl };
    throw new Error("Firecrawl is not connected. Connect it with /connect, set FIRECRAWL_API_KEY, or run `firecrawl login`.");
  }
  const source: AuthSource = connectionKey ? "opencode" : envKey ? "environment" : "firecrawl-cli";
  return { apiKey, apiUrl, source };
}
