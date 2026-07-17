import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("contains the complete Pixi notebook workspace", async () => {
  const [layout, page] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /Pixi — Spatial notebook OCR/i);
  assert.match(page, /Pixi /);
  assert.match(page, /New scan/);
  assert.match(page, /Notebooks/);
  assert.match(page, /SPATIAL MARKDOWN/);
  assert.match(page, /Copy Markdown/);
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
  assert.match(route, /consume_ocr_quota/);
  assert.match(route, /max_output_tokens:\s*6000/);
  assert.match(route, /AbortSignal\.timeout\(90_000\)/);
  assert.match(route, /maxDuration = 120/);
  assert.match(page, /storage\.from\("notebook-pages"\)\.upload/);
  assert.doesNotMatch(route, /request\.formData/);
  assert.match(route, /process\.env\.OPENAI_API_KEY/);
  assert.doesNotMatch(page, /OPENAI_API_KEY|sk-proj-/);
  assert.match(page, /from\("notebooks"\)/);
  assert.match(page, /from\("pages"\)/);
  assert.match(page, /\/api\/ocr/);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /create or replace function public\.consume_ocr_quota/);
  assert.match(migration, /grant execute on function public\.consume_ocr_quota\(\) to authenticated/);
  assert.match(migration, /notebook-pages/);
  assert.match(gitignore, /^\.env\*/m);
});
