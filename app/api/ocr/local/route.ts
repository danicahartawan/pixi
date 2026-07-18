import { NextResponse } from "next/server";
import { runSpatialOcr } from "@/lib/spatial-ocr";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  const form = await request.formData();
  const image = form.get("image");
  if (!(image instanceof File) || !ALLOWED_TYPES.has(image.type) || image.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "Use a PNG, JPEG, WEBP, or GIF under 20 MB." }, { status: 400 });
  }

  try {
    const base64 = Buffer.from(await image.arrayBuffer()).toString("base64");
    const result = await runSpatialOcr(`data:${image.type};base64,${base64}`);
    return NextResponse.json({
      page: {
        id: crypto.randomUUID(),
        title: result.title || image.name.replace(/\.[^/.]+$/, ""),
        status: "review",
        image_path: null,
        markdown: result.markdown,
        spatial_data: { page_type: result.page_type, blocks: result.blocks },
        confidence: result.confidence,
      },
    }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Spatial OCR failed." }, {
      status: 500,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
}
