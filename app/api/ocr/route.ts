import { NextResponse } from "next/server";
import { runSpatialOcr } from "@/lib/spatial-ocr";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
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

  if (!process.env.OPENAI_API_KEY) {
    await supabase.storage.from("notebook-pages").remove([imagePath]);
    await supabase.from("pages").update({ status: "error", image_path: page.image_path, error_message: "OPENAI_API_KEY is missing." }).eq("id", pageId);
    return json({ error: "OpenAI is not configured." }, 503);
  }

  try {
    const result = await runSpatialOcr(signed.signedUrl);

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
