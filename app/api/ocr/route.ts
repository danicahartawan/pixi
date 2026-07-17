import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

const MAX_MARKDOWN_CHARS = 100_000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}

const spatialSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "page_type", "markdown", "confidence", "blocks"],
  properties: {
    title: { type: "string" },
    page_type: { type: "string", enum: ["notes", "journal", "mind_map", "diagram", "wireframe", "mixed"] },
    markdown: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "text", "position", "relationships"],
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["heading", "text", "list", "drawing", "diagram", "wireframe", "annotation", "arrow", "unknown"] },
          text: { type: "string" },
          position: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y", "width", "height"],
            properties: {
              x: { type: "number", minimum: 0, maximum: 1 },
              y: { type: "number", minimum: 0, maximum: 1 },
              width: { type: "number", minimum: 0, maximum: 1 },
              height: { type: "number", minimum: 0, maximum: 1 },
            },
          },
          relationships: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const prompt = `You are Pixi, a faithful spatial OCR engine for handwritten notebook pages.

Transcribe the page without summarizing, rewriting, correcting tone, or inventing content. Preserve the author's original wording, spelling, hierarchy, grouping, relative placement, arrows, labels, diagrams, mind maps, wireframes, marginalia, and crossed-out content when readable.

Return useful Markdown in the markdown field:
- Reproduce headings, paragraphs, lists, checkboxes, and tables.
- Add a short "Spatial layout" section describing columns, clusters, and relative positions when layout carries meaning.
- Use Mermaid flowcharts for connected nodes, arrows, mind maps, or process diagrams when that preserves the page better than prose.
- Describe non-text drawings in concise bracketed annotations at their original logical position.
- Mark unreadable text as [unclear] instead of guessing.
- Do not include analysis or a summary.

Also return normalized 0–1 bounding boxes for each meaningful block and relationships using block ids.`;

function responseText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output as Array<Record<string, unknown>>) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "Please start a Pixi session first." }, 401);

  const body = await request.json().catch(() => null) as {
    pageId?: string;
    imagePath?: string;
    imageName?: string;
  } | null;
  const pageId = String(body?.pageId || "");
  const imagePath = String(body?.imagePath || "");
  const imageName = String(body?.imageName || "Notebook page").slice(0, 180);

  if (!pageId || !imagePath || !imagePath.startsWith(`${user.id}/`) || imagePath.includes("..")) {
    return json({ error: "A valid uploaded notebook page is required." }, 400);
  }

  const { data: page } = await supabase
    .from("pages")
    .select("id, notebook_id, image_path")
    .eq("id", pageId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!page) return json({ error: "Page not found." }, 404);
  if (!imagePath.startsWith(`${user.id}/${page.notebook_id}/${pageId}-`)) {
    return json({ error: "The uploaded image does not belong to this page." }, 403);
  }

  const { data: quotaData, error: quotaError } = await supabase.rpc("consume_ocr_quota").single();
  const quota = quotaData as { allowed: boolean; remaining: number; reset_at: string } | null;
  if (quotaError) return json({ error: "OCR quota service is unavailable." }, 503);
  if (!quota?.allowed) {
    await supabase.storage.from("notebook-pages").remove([imagePath]);
    const resetAt = new Date(quota?.reset_at || Date.now() + 60 * 60 * 1000);
    const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
    return json({ error: "You have reached the limit of 10 scans per hour.", resetAt: resetAt.toISOString() }, 429, {
      "Retry-After": String(retryAfter),
      "X-RateLimit-Remaining": "0",
    });
  }

  await supabase.from("pages").update({ status: "processing", error_message: null }).eq("id", pageId);

  const { data: signed } = await supabase.storage.from("notebook-pages").createSignedUrl(imagePath, 60 * 10);
  if (!signed?.signedUrl) {
    await supabase.storage.from("notebook-pages").remove([imagePath]);
    await supabase.from("pages").update({ status: "error", error_message: "Could not read the uploaded image." }).eq("id", pageId);
    return json({ error: "Could not read the uploaded image." }, 500);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    await supabase.storage.from("notebook-pages").remove([imagePath]);
    await supabase.from("pages").update({ status: "error", image_path: page.image_path, error_message: "OPENAI_API_KEY is missing." }).eq("id", pageId);
    return json({ error: "OpenAI is not configured." }, 503);
  }

  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || "gpt-5.5",
        store: false,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: signed.signedUrl, detail: "original" },
          ],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "pixi_spatial_ocr",
            strict: true,
            schema: spatialSchema,
          },
        },
        max_output_tokens: 6000,
      }),
      signal: AbortSignal.timeout(90_000),
    });

    const raw = await openaiResponse.json() as Record<string, unknown>;
    if (!openaiResponse.ok) {
      const message = typeof raw.error === "object" && raw.error && "message" in raw.error
        ? String((raw.error as { message: unknown }).message)
        : "Spatial OCR failed.";
      throw new Error(message);
    }

    const text = responseText(raw);
    if (!text) throw new Error("The OCR response was empty.");
    const result = JSON.parse(text) as {
      title: string;
      page_type: string;
      markdown: string;
      confidence: number;
      blocks: unknown[];
    };
    if (!result.markdown || result.markdown.length > MAX_MARKDOWN_CHARS || !Array.isArray(result.blocks) || result.blocks.length > 500) {
      throw new Error("The OCR response exceeded Pixi's safe output limits.");
    }

    const { data: updated, error: updateError } = await supabase
      .from("pages")
      .update({
        title: result.title || imageName.replace(/\.[^/.]+$/, ""),
        status: "review",
        image_path: imagePath,
        markdown: result.markdown,
        spatial_data: { page_type: result.page_type, blocks: result.blocks },
        confidence: result.confidence,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", pageId)
      .select()
      .single();
    if (updateError) throw updateError;

    if (page.image_path && page.image_path !== imagePath) {
      await supabase.storage.from("notebook-pages").remove([page.image_path]);
    }

    return json({ page: updated, imageUrl: signed.signedUrl }, 200, {
      "X-RateLimit-Remaining": String(quota.remaining),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Spatial OCR failed.";
    await supabase.storage.from("notebook-pages").remove([imagePath]);
    await supabase.from("pages").update({ status: "error", image_path: page.image_path, error_message: message }).eq("id", pageId);
    return json({ error: message }, 500);
  }
}
