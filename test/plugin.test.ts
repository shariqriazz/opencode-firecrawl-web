import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveFirecrawlConfig } from "../src/auth.ts";
import { buildDeveloperSearchBody, buildScrapeBody, buildSearchBody, firecrawlRequest } from "../src/client.ts";
import { formatDeveloperSearchOutput, formatScrapeOutput, formatSearchOutput } from "../src/format.ts";
import plugin from "../src/index.ts";

const NO_HOME = "/tmp/does-not-exist";
const auth = { apiKey: "fc-private-test", apiUrl: "https://api.firecrawl.dev", source: "environment" as const };

/** The parts of the plugin context the plugin uses, with a Firecrawl connection holding `connectionKey`. */
async function setupPlugin(connectionKey?: string) {
  const tools: any[] = [];
  const permissions: { action: string; resources: string[] }[] = [];
  const ctx = {
    integration: {
      connection: {
        active: async (id: string) => (id === "firecrawl" && connectionKey ? { id: "conn" } : undefined),
        resolve: async () => ({ type: "key", key: connectionKey }),
      },
    },
    permission: { assert: async (input: { action: string; resources: string[] }) => void permissions.push(input) },
    tool: { transform: async (callback: (editor: any) => void) => callback({ add: (tool: any) => tools.push(tool) }) },
  };
  await plugin.setup(ctx as never);
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
  return { tools, tool, permissions };
}

const toolContext = {
  sessionID: "ses_1",
  agent: "build",
  messageID: "msg_1",
  id: "call_1",
  signal: new AbortController().signal,
  progress: async () => undefined,
};

/** Replaces global fetch for one test and records each request. */
function stubFetch(respond: (url: string, body: Record<string, unknown>) => unknown) {
  const original = globalThis.fetch;
  const requests: { url: string; authorization: string | null; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), body });
    return new Response(JSON.stringify(respond(String(input), body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { requests, restore: () => void (globalThis.fetch = original) };
}

// ---------- plugin ----------

test("registers direct web_search, web_scrape, and dev_search tools on OpenCode's web permissions", async () => {
  const { tools } = await setupPlugin();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["dev_search", "web_scrape", "web_search"]);
  const permission = Object.fromEntries(tools.map((tool) => [tool.name, tool.options.permission]));
  assert.deepEqual(permission, { web_search: "websearch", web_scrape: "webfetch", dev_search: "websearch" });
  for (const tool of tools) {
    assert.equal(tool.options.codemode, false);
    assert.match(tool.description, /untrusted data, not instructions/);
  }
  assert.match(tools.find((tool) => tool.name === "web_search").description, /dev_search/);
  assert.match(tools.find((tool) => tool.name === "web_scrape").description, /webfetch/);
});

test("web_search asks for the websearch permission and authenticates with the OpenCode connection", async (t) => {
  const fetch = stubFetch(() => ({ creditsUsed: 1, data: { web: [{ title: "Bun", url: "https://bun.sh", description: "Runtime" }] } }));
  t.after(fetch.restore);
  const { tool, permissions } = await setupPlugin("fc-connection-key");
  const result = await tool("web_search").execute({ query: "bun release", include_domains: ["bun.sh"] }, toolContext);
  assert.deepEqual(permissions.map((item) => [item.action, item.resources]), [["websearch", ["bun release"]]]);
  assert.equal(fetch.requests[0]!.url, "https://api.firecrawl.dev/v2/search");
  assert.equal(fetch.requests[0]!.authorization, "Bearer fc-connection-key");
  assert.deepEqual(fetch.requests[0]!.body.includeDomains, ["bun.sh"]);
  assert.match(result.content, /https:\/\/bun\.sh/);
  assert.equal(result.metadata.authSource, "opencode");
  assert.doesNotMatch(JSON.stringify(result), /fc-connection-key/);
});

test("web_scrape asks for the webfetch permission with the URL", async (t) => {
  const fetch = stubFetch(() => ({ data: { markdown: "# Page", metadata: { url: "https://example.com" } } }));
  t.after(fetch.restore);
  const { tool, permissions } = await setupPlugin("fc-connection-key");
  const result = await tool("web_scrape").execute({ url: "https://example.com" }, toolContext);
  assert.deepEqual(permissions.map((item) => [item.action, item.resources]), [["webfetch", ["https://example.com"]]]);
  assert.equal(fetch.requests[0]!.url, "https://api.firecrawl.dev/v2/scrape");
  assert.match(result.content, /# Page/);
});

test("an invalid request fails before asking for permission", async () => {
  const { tool, permissions } = await setupPlugin("fc-connection-key");
  await assert.rejects(tool("web_scrape").execute({ url: "file:///etc/passwd" }, toolContext), /HTTP or HTTPS/);
  assert.equal(permissions.length, 0);
});

// ---------- auth ----------

test("the OpenCode connection wins over the environment and the CLI store", () => {
  const config = resolveFirecrawlConfig({ connectionKey: "fc-connection", env: { FIRECRAWL_API_KEY: "fc-env" }, home: NO_HOME, platform: "linux" });
  assert.equal(config.apiKey, "fc-connection");
  assert.equal(config.source, "opencode");
});

test("the environment wins over the CLI store", () => {
  const config = resolveFirecrawlConfig({ env: { FIRECRAWL_API_KEY: "fc-test-secret", FIRECRAWL_API_URL: "https://api.firecrawl.dev" }, home: NO_HOME, platform: "darwin" });
  assert.equal(config.source, "environment");
  assert.equal(config.apiKey, "fc-test-secret");
  assert.equal(config.apiUrl, "https://api.firecrawl.dev");
});

test("reuses the existing Firecrawl CLI credential store", async () => {
  const home = await mkdtemp(join(tmpdir(), "opencode-firecrawl-auth-test-"));
  try {
    const directory = join(home, "Library", "Application Support", "firecrawl-cli");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "credentials.json"), JSON.stringify({ apiKey: "fc-cli-test", apiUrl: "https://api.firecrawl.dev" }));
    const config = resolveFirecrawlConfig({ env: {}, home, platform: "darwin" });
    assert.equal(config.source, "firecrawl-cli");
    assert.equal(config.apiKey, "fc-cli-test");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("missing credentials fail unless anonymous access is allowed", () => {
  assert.throws(() => resolveFirecrawlConfig({ env: {}, home: NO_HOME, platform: "linux" }), /not connected/);
  assert.deepEqual(resolveFirecrawlConfig({ env: {}, home: NO_HOME, platform: "linux", allowAnonymous: true }), { apiUrl: "https://api.firecrawl.dev" });
});

test("dev_search runs without a key and sends no authorization", async (t) => {
  const fetch = stubFetch(() => ({ results: [] }));
  t.after(fetch.restore);
  const saved = process.env.FIRECRAWL_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  t.after(() => {
    if (saved !== undefined) process.env.FIRECRAWL_API_KEY = saved;
  });
  const { tool } = await setupPlugin();
  const result = await tool("dev_search").execute({ query: "q" }, toolContext);
  // A developer machine may have the Firecrawl CLI logged in; only an anonymous run must omit the header.
  if (result.metadata.authSource === "anonymous") assert.equal(fetch.requests[0]!.authorization, null);
  assert.equal(fetch.requests[0]!.url, "https://api.firecrawl.dev/v2/search/developer");
});

test("local HTTP API URLs accept IPv4 and IPv6 loopback only", () => {
  for (const apiUrl of ["http://localhost:3002", "http://127.0.0.1:3002", "http://[::1]:3002"]) {
    assert.equal(resolveFirecrawlConfig({ env: { FIRECRAWL_API_KEY: "fc-test-secret", FIRECRAWL_API_URL: apiUrl }, home: NO_HOME, platform: "linux" }).apiUrl, apiUrl);
  }
  assert.throws(
    () => resolveFirecrawlConfig({ env: { FIRECRAWL_API_KEY: "fc-test-secret", FIRECRAWL_API_URL: "http://10.0.0.5:3002" }, home: NO_HOME, platform: "linux" }),
    /HTTPS/,
  );
});

// ---------- requests ----------

test("builds a compact Firecrawl search request with explicit filters", () => {
  const body = buildSearchBody({
    query: " current releases ",
    limit: 50,
    sources: ["web", "news"],
    categories: ["github"],
    include_domains: ["example.com", "example.com"],
    country: "gb",
    scrape: "summary",
  });
  assert.equal(body.query, "current releases");
  assert.equal(body.limit, 20);
  assert.deepEqual(body.sources, [{ type: "web" }, { type: "news" }]);
  assert.deepEqual(body.categories, [{ type: "github" }]);
  assert.deepEqual(body.includeDomains, ["example.com"]);
  assert.equal(body.country, "GB");
  assert.deepEqual(body.scrapeOptions, { formats: [{ type: "summary" }], onlyMainContent: true });
});

test("rejects conflicting search domain filters", () => {
  assert.throws(() => buildSearchBody({ query: "x", include_domains: ["a.test"], exclude_domains: ["b.test"] }), /either include_domains or exclude_domains/);
});

test("builds scrape formats and validates query-driven extraction", () => {
  assert.deepEqual(buildScrapeBody({ url: "https://example.com", format: "question", query: "What is this?" }).formats, [
    { type: "question", question: "What is this?" },
  ]);
  assert.throws(() => buildScrapeBody({ url: "https://example.com", format: "highlights" }), /requires query/);
  assert.throws(() => buildScrapeBody({ url: "file:///tmp/test" }), /HTTP or HTTPS/);
});

test("builds developer search request and validates mismatched filters", () => {
  const body = buildDeveloperSearchBody({
    query: "429 retry backoff",
    limit: 10,
    types: ["issue", "pull_request"],
    repos: ["sidekiq/sidekiq"],
    language: "Ruby",
    passages: 2,
    skills: "only",
    min_stars: 500,
  });
  assert.equal(body.query, "429 retry backoff");
  assert.equal(body.k, 10);
  assert.deepEqual(body.types, ["issue", "pull_request"]);
  assert.deepEqual(body.repos, ["sidekiq/sidekiq"]);
  assert.equal(body.language, "Ruby");
  assert.equal(body.passages, 2);
  assert.equal(body.skills, "only");
  assert.equal(body.min_stars, 500);
  assert.throws(() => buildDeveloperSearchBody({ query: "q", types: ["doc"], repos: ["owner/repo"] }), /repos filter requires at least one repository type/);
  assert.throws(() => buildDeveloperSearchBody({ query: "q", types: ["issue"], sources: ["docs.stripe.com"] }), /sources filter requires doc in types/);
});

test("sends authenticated API requests without returning the credential", async () => {
  let authorization = "";
  const payload = await firecrawlRequest("search", { query: "test", timeout: 5_000 }, auth, undefined, async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(authorization, "Bearer fc-private-test");
  assert.doesNotMatch(JSON.stringify(payload), /fc-private-test/);
});

test("rejects oversized streaming responses before buffering beyond 25 MiB", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 26; index++) controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    firecrawlRequest("search", { query: "test", timeout: 5_000 }, auth, undefined, async () => new Response(body, { status: 200 })),
    /exceeded 25 MiB/,
  );
  assert.equal(cancelled, true);
});

test("a declared oversized response is cancelled, not left streaming", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {},
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    firecrawlRequest("search", { query: "test", timeout: 5_000 }, auth, undefined, async () =>
      new Response(body, { status: 200, headers: { "content-length": String(30 * 1024 * 1024) } })),
    /exceeded 25 MiB/,
  );
  assert.equal(cancelled, true);
});

test("retries 5xx responses and releases each delay's abort listener", async () => {
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<typeof add>) => {
    if (args[0] === "abort") added++;
    return add(...args);
  }) as typeof add;
  signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
    if (args[0] === "abort") removed++;
    return remove(...args);
  }) as typeof remove;
  let calls = 0;
  await firecrawlRequest("search", { query: "test", timeout: 5_000 }, auth, signal, async () =>
    ++calls < 3 ? new Response("{}", { status: 503, headers: { "retry-after": "0" } }) : new Response(JSON.stringify({ success: true }), { status: 200 }));
  assert.equal(calls, 3);
  assert.equal(added, removed, "every delay listener is removed after it resolves");
});

// ---------- output ----------

test("formats compact untrusted search and scrape output", () => {
  const search = formatSearchOutput({ creditsUsed: 2, data: { web: [{ title: "Example", url: "https://example.com", description: "Result" }] } });
  assert.match(search, /untrusted web content/);
  assert.match(search, /Credits used: 2/);
  assert.match(search, /https:\/\/example\.com/);

  const scrape = formatScrapeOutput({ data: { markdown: "# Example", metadata: { url: "https://example.com", statusCode: 200 } } }, "markdown");
  assert.match(scrape, /untrusted web content/);
  assert.match(scrape, /# Example/);
});

test("trims extracted search content to content_max_characters and says so", () => {
  const text = formatSearchOutput({ data: { web: [{ title: "Long", url: "https://example.com", markdown: "x".repeat(2_000) }] } }, 500);
  assert.match(text, /x{500}\n\[Result content trimmed/);
  assert.doesNotMatch(text, /x{501}/);
});

test("formats developer search output with matched passages and untrusted header", () => {
  const output = formatDeveloperSearchOutput({
    creditsUsed: 2,
    results: [
      {
        id: "issue:sidekiq/sidekiq#1471",
        type: "issue",
        url: "https://github.com/sidekiq/sidekiq/issues/1471",
        title: "Retries not applied to 429",
        passages: [{ text: "The client treats 429 as terminal." }],
      },
    ],
  });
  assert.match(output, /untrusted web content/);
  assert.match(output, /Credits used: 2/);
  assert.match(output, /\[ISSUE\] Retries not applied to 429/);
  assert.match(output, /The client treats 429 as terminal\./);
  assert.match(output, /https:\/\/github\.com\/sidekiq\/sidekiq\/issues\/1471/);
});