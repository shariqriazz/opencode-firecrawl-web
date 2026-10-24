# AGENTS.md

## Project

An OpenCode 2 plugin that registers three native Firecrawl tools: `web_search`, `web_scrape`, and `dev_search`. It ports the `firecrawl-web` Pi extension and deliberately adds no skills, system prompt text, or shell integration.

## Commands

- `mise exec --locked -- bun run validate`: typecheck and tests. Run it before every commit.
- `mise exec --locked -- bun run pack:inspect`: check the npm payload after changing `package.json` or `files`.

## Layout

- `src/index.ts`: plugin setup, tool definitions, permission checks, and the OpenCode connection lookup.
- `src/auth.ts`: credential order (OpenCode connection, `FIRECRAWL_API_KEY`, Firecrawl CLI store) and API URL validation.
- `src/client.ts`: request bodies and the bounded, retrying Firecrawl HTTP client.
- `src/format.ts`: model-facing result text.

## Critical patterns

- Target the OpenCode 2 plugin API only (`{ id, setup }`). Import only types from `@opencode/plugin`; it stays a dev and optional peer dependency.
- Keep `codemode: false` and the `websearch`/`webfetch` permission actions on the tools. The built-in `explore` agent denies every action it does not list, so tool-specific action names would hide these tools from it.
- Validate the request before `permission.assert`, and never put a credential in tool output or metadata.
- OpenCode bounds tool output and keeps the full text, so do not add truncation or artifact files.
- Tool descriptions are sent on every request; keep them short. Keep request and formatting behavior aligned with the Pi extension unless OpenCode needs a difference.
- Test live on an isolated `opencode serve` with its own `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME`, never by restarting the user's OpenCode service. Use a cheap model.

## Releases

Bump `version` in `package.json` with every functional change; pushing it to `main` publishes through `.github/workflows/publish-npm.yml` with npm trusted publishing. After npm serves the new version, run `opencode plugin update opencode-firecrawl-web` from a project directory. The user's OpenCode service loads it only after a restart, which needs the user's go-ahead.

## Documentation

Update `README.md` when tools, inputs, authentication, or permissions change.