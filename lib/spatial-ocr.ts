const MAX_MARKDOWN_CHARS = 100_000;

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

export type SpatialOcrResult = {
  title: string;
  page_type: string;
  markdown: string;
  confidence: number;
  blocks: unknown[];
};

export async function runSpatialOcr(imageUrl: string): Promise<SpatialOcrResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI is not configured.");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || "gpt-5.5",
      store: false,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: imageUrl, detail: "original" },
        ],
      }],
      text: { format: { type: "json_schema", name: "pixi_spatial_ocr", strict: true, schema: spatialSchema } },
      max_output_tokens: 6000,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  const raw = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof raw.error === "object" && raw.error && "message" in raw.error
      ? String((raw.error as { message: unknown }).message)
      : "Spatial OCR failed.";
    throw new Error(message);
  }

  const text = responseText(raw);
  if (!text) throw new Error("The OCR response was empty.");
  const result = JSON.parse(text) as SpatialOcrResult;
  if (!result.markdown || result.markdown.length > MAX_MARKDOWN_CHARS || !Array.isArray(result.blocks) || result.blocks.length > 500) {
    throw new Error("The OCR response exceeded Pixi's safe output limits.");
  }
  return result;
}
