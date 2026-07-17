# Pixi

Pixi turns photos of handwritten notebook pages into faithful spatial Markdown. It keeps headings, clusters, arrows, diagrams, annotations, and relative placement instead of flattening the page into a summary.

## Pipeline

1. A user creates a notebook and blank page.
2. The original image is uploaded to the private `notebook-pages` Supabase Storage bucket.
3. `/api/ocr` sends a short-lived signed image URL to the OpenAI Responses API at original image detail.
4. The model returns schema-constrained spatial blocks plus editable Markdown.
5. Pixi saves the image path, Markdown, spatial data, confidence, and review status in Supabase.
6. The user reviews and confirms the page.

## Local setup

1. Copy `.env.example` to `.env.local` and fill in the Supabase and OpenAI values.
2. In Supabase, enable anonymous sign-ins under Authentication settings.
3. Run `supabase/migrations/20260717200000_pixi_core.sql` in the Supabase SQL editor.
4. Install dependencies with `npm install`.
5. Start Pixi with `npm run dev`.

The migration creates per-user notebooks and pages, private image storage, and row-level security policies.

## Deploy to Vercel

Import the GitHub repository into Vercel and keep the detected framework as Next.js. Add the four variables from `.env.example` to the Production, Preview, and Development environments. `OPENAI_API_KEY` must remain server-only; never prefix it with `NEXT_PUBLIC_`.

Pixi uploads notebook images directly to private Supabase Storage, then sends only the storage path to the Vercel OCR function. This avoids Vercel request-body limits while the bucket still enforces a 20 MB image limit. The OCR function uses the Node.js runtime with a 120-second maximum duration.
