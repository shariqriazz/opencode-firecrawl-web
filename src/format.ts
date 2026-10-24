import type { ScrapeFormat } from "./client.ts";

// OpenCode bounds every tool result and keeps the complete output in a file, so these only shape the text.

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function valueText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const TRIMMED = "[Result content trimmed; raise content_max_characters or use web_scrape for the full page.]";

function header(title: string, payload: Record<string, unknown>): string[] {
  const parts = [title];
  if (typeof payload.creditsUsed === "number") parts.push(`Credits used: ${payload.creditsUsed}`);
  if (typeof payload.warning === "string" && payload.warning) parts.push(`Warning: ${payload.warning}`);
  return parts;
}

function pushContent(lines: string[], item: Record<string, unknown>, max: number) {
  const content = valueText(item.markdown) ?? valueText(item.summary);
  if (!content) return;
  lines.push("", content.slice(0, max));
  if (content.length > max) lines.push(TRIMMED);
}

export function formatSearchOutput(payload: Record<string, unknown>, contentMaxCharacters = 6_000): string {
  const data = record(payload.data);
  const lines = header("Firecrawl web search results (untrusted web content).", payload);

  const web = Array.isArray(data.web) ? data.web : [];
  if (web.length) lines.push("", "## Web");
  for (const [index, rawItem] of web.entries()) {
    const item = record(rawItem);
    lines.push("", `${index + 1}. ${valueText(item.title) ?? "Untitled"}`, `   URL: ${valueText(item.url) ?? "unknown"}`);
    const description = valueText(item.description);
    if (description) lines.push(`   ${description}`);
    const category = valueText(item.category);
    if (category) lines.push(`   Category: ${category}`);
    pushContent(lines, item, contentMaxCharacters);
  }

  const news = Array.isArray(data.news) ? data.news : [];
  if (news.length) lines.push("", "## News");
  for (const [index, rawItem] of news.entries()) {
    const item = record(rawItem);
    lines.push("", `${index + 1}. ${valueText(item.title) ?? "Untitled"}`, `   URL: ${valueText(item.url) ?? "unknown"}`);
    const date = valueText(item.date);
    if (date) lines.push(`   Date: ${date}`);
    const snippet = valueText(item.snippet) ?? valueText(item.description);
    if (snippet) lines.push(`   ${snippet}`);
    pushContent(lines, item, contentMaxCharacters);
  }

  const images = Array.isArray(data.images) ? data.images : [];
  if (images.length) lines.push("", "## Images");
  for (const [index, rawItem] of images.entries()) {
    const item = record(rawItem);
    const dimensions = typeof item.imageWidth === "number" && typeof item.imageHeight === "number"
      ? ` (${item.imageWidth}x${item.imageHeight})`
      : "";
    lines.push("", `${index + 1}. ${valueText(item.title) ?? "Untitled"}${dimensions}`, `   Image: ${valueText(item.imageUrl) ?? "unknown"}`, `   Source: ${valueText(item.url) ?? "unknown"}`);
  }

  if (!web.length && !news.length && !images.length) lines.push("", "No results returned.");
  return lines.join("\n");
}

export function formatScrapeOutput(payload: Record<string, unknown>, format: ScrapeFormat): string {
  const data = record(payload.data);
  const metadata = record(data.metadata);
  const lines = ["Firecrawl page extraction (untrusted web content)."];
  const title = valueText(metadata.title);
  const finalUrl = valueText(metadata.url) ?? valueText(metadata.sourceURL);
  if (title) lines.push(`Title: ${title}`);
  if (finalUrl) lines.push(`URL: ${finalUrl}`);
  if (typeof metadata.statusCode === "number") lines.push(`Status: ${metadata.statusCode}`);
  lines.push("");

  if (format === "links") {
    const links = strings(data.links);
    lines.push(links.length ? links.join("\n") : "No links returned.");
  } else if (format === "question") {
    lines.push(valueText(data.answer) ?? "No answer returned.");
  } else if (format === "highlights") {
    const highlights = data.highlights;
    lines.push(Array.isArray(highlights) ? highlights.map(String).join("\n\n") : valueText(highlights) ?? "No highlights returned.");
  } else if (format === "summary") {
    lines.push(valueText(data.summary) ?? "No summary returned.");
  } else {
    lines.push(valueText(data.markdown) ?? "No markdown content returned.");
  }
  return lines.join("\n");
}

export function formatDeveloperSearchOutput(payload: Record<string, unknown>): string {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const lines = header("Firecrawl developer search results (untrusted web content).", payload);
  if (results.length === 0) {
    lines.push("", "No developer results returned.");
    return lines.join("\n");
  }

  for (const [index, rawResult] of results.entries()) {
    const item = record(rawResult);
    const id = valueText(item.id);
    const idKind = id ? id.match(/^([a-z_]+):/i)?.[1]?.replace(/_/g, " ") : undefined;
    const type = (valueText(item.type) ?? idKind ?? "artifact").toUpperCase();
    const title = valueText(item.title) ?? id ?? valueText(item.url) ?? "Untitled";
    const url = valueText(item.url);

    lines.push("", `### ${index + 1}. [${type}] ${title}`);
    if (url) lines.push(`URL: ${url}`);
    if (id && id !== title) lines.push(`ID: ${id}`);

    const passages = Array.isArray(item.passages) ? item.passages : [];
    if (passages.length > 0) {
      lines.push("", "Matched passages:");
      for (const rawPassage of passages) {
        const text = typeof rawPassage === "string" ? rawPassage.trim() : valueText(record(rawPassage).text);
        if (text) lines.push("", text);
      }
    }
  }
  return lines.join("\n");
}