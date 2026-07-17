import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Pixi notebook workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Pixi — Spatial notebook OCR<\/title>/i);
  assert.match(html, />Pixi /);
  assert.match(html, />New scan</);
  assert.match(html, />Notebooks</);
  assert.match(html, /SPATIAL MARKDOWN/);
  assert.match(html, /Copy Markdown/);
});

test("keeps secrets server-side and ships the persistent OCR pipeline", async () => {
  const [route, page, migration, gitignore] = await Promise.all([
    readFile(new URL("../app/api/ocr/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/20260717200000_pixi_core.sql", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);

  assert.match(route, /https:\/\/api\.openai\.com\/v1\/responses/);
  assert.match(route, /detail:\s*"original"/);
  assert.match(route, /type:\s*"json_schema"/);
  assert.match(route, /process\.env\.OPENAI_API_KEY/);
  assert.doesNotMatch(page, /OPENAI_API_KEY|sk-proj-/);
  assert.match(page, /from\("notebooks"\)/);
  assert.match(page, /from\("pages"\)/);
  assert.match(page, /\/api\/ocr/);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /notebook-pages/);
  assert.match(gitignore, /^\.env\*/m);
});
