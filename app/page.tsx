"use client";

import { DragEvent, useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";

type ScanStage = "empty" | "scanning" | "review" | "confirmed";
type PageStatus = "blank" | "processing" | "review" | "confirmed" | "error";
type NotebookPage = {
  id: string;
  name: string;
  status: PageStatus;
  imageUrl?: string;
  imagePath?: string;
  markdown?: string;
  spatialData?: unknown;
  confidence?: number;
  blank?: boolean;
};
type Notebook = { id: string; name: string; pages: NotebookPage[] };

const demoMarkdown = `# Brainstorm OCR notebook app

> Transcription mode: verbatim
> No summarization applied

## Spatial layout
- A central question appears above two side-by-side wireframes.
- An arrow connects the left wireframe to the right wireframe.

## Central question
How can checkout feel less like a form?

## Connections
\`\`\`mermaid
flowchart LR
  A[Cart review] --> B[Payment]
\`\`\`

## Annotations
- keep the cart visible — below the left wireframe
- one clear next step — below the right wireframe`;

const initialNotebooks: Notebook[] = [{
  id: "local-ideas",
  name: "notebook OCR",
  pages: [{ id: "local-brainstorm", name: "Brainstorm OCR notebook app", status: "confirmed", markdown: demoMarkdown }],
}];

function stageFor(page?: NotebookPage): ScanStage {
  if (!page || page.status === "blank" || page.status === "error") return "empty";
  if (page.status === "processing") return "scanning";
  if (page.status === "review") return "review";
  return "confirmed";
}

export default function Home() {
  const [notebooks, setNotebooks] = useState<Notebook[]>(initialNotebooks);
  const [activeNotebookId, setActiveNotebookId] = useState(initialNotebooks[0].id);
  const [activePageId, setActivePageId] = useState(initialNotebooks[0].pages[0].id);
  const [scanStage, setScanStage] = useState<ScanStage>("confirmed");
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [addingNotebook, setAddingNotebook] = useState(false);
  const [newNotebookName, setNewNotebookName] = useState("");
  const [userId, setUserId] = useState("");
  const [syncMessage, setSyncMessage] = useState("Connecting...");
  const fileRef = useRef<HTMLInputElement>(null);

  const activeNotebook = notebooks.find((notebook) => notebook.id === activeNotebookId);
  const activePage = activeNotebook?.pages.find((page) => page.id === activePageId);

  useEffect(() => {
    void hydrate();
  }, []);

  async function sessionUser() {
    const supabase = createClient();
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session?.user) return sessionData.session.user;
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error || !data.user) throw error || new Error("Anonymous Supabase sessions are not enabled.");
    return data.user;
  }

  async function signedImage(path?: string) {
    if (!path) return undefined;
    const { data } = await createClient().storage.from("notebook-pages").createSignedUrl(path, 60 * 60);
    return data?.signedUrl;
  }

  async function hydrate() {
    try {
      const user = await sessionUser();
      setUserId(user.id);
      const supabase = createClient();
      let { data, error } = await supabase
        .from("notebooks")
        .select("id,title,pages(id,title,status,image_path,markdown,spatial_data,confidence,position)")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true });
      if (error) throw error;

      if (!data?.length) {
        const { data: created, error: createError } = await supabase
          .from("notebooks")
          .insert({ user_id: user.id, title: "My notebook" })
          .select("id,title")
          .single();
        if (createError) throw createError;
        const pageId = crypto.randomUUID();
        const { error: pageError } = await supabase.from("pages").insert({
          id: pageId, notebook_id: created.id, user_id: user.id, title: "Page 1", position: 0, status: "blank",
        });
        if (pageError) throw pageError;
        data = [{ ...created, pages: [{ id: pageId, title: "Page 1", status: "blank", image_path: null, markdown: null, spatial_data: null, confidence: null, position: 0 }] }];
      }

      const hydrated = await Promise.all(
        data.map(async (notebook) => ({
          id: notebook.id,
          name: notebook.title,
          pages: await Promise.all(
            (notebook.pages || [])
              .sort((a: { position: number }, b: { position: number }) => a.position - b.position)
              .map(async (page: Record<string, unknown>) => ({
                id: String(page.id),
                name: String(page.title),
                status: String(page.status) as PageStatus,
                imagePath: page.image_path ? String(page.image_path) : undefined,
                imageUrl: await signedImage(page.image_path ? String(page.image_path) : undefined),
                markdown: page.markdown ? String(page.markdown) : undefined,
                spatialData: page.spatial_data,
                confidence: typeof page.confidence === "number" ? page.confidence : undefined,
                blank: page.status === "blank",
              })),
          ),
        })),
      );
      setNotebooks(hydrated);
      const firstNotebook = hydrated[0];
      const firstPage = firstNotebook.pages[0];
      setActiveNotebookId(firstNotebook.id);
      setActivePageId(firstPage?.id || "");
      setScanStage(stageFor(firstPage));
      setSyncMessage("Synced");
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "Backend unavailable");
    }
  }

  function updateLocalPage(notebookId: string, pageId: string, patch: Partial<NotebookPage>) {
    setNotebooks((current) => current.map((notebook) => notebook.id === notebookId
      ? { ...notebook, pages: notebook.pages.map((page) => page.id === pageId ? { ...page, ...patch } : page) }
      : notebook));
  }

  async function addNotebook() {
    const name = newNotebookName.trim();
    if (!name) return;
    try {
      const currentUser = userId || (await sessionUser()).id;
      setUserId(currentUser);
      const { data, error } = await createClient().from("notebooks")
        .insert({ user_id: currentUser, title: name }).select("id,title").single();
      if (error) throw error;
      setNotebooks((current) => [...current, { id: data.id, name: data.title, pages: [] }]);
      setActiveNotebookId(data.id);
      setActivePageId("");
      setScanStage("empty");
      setSyncMessage("Synced");
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "Could not create notebook");
    } finally {
      setNewNotebookName("");
      setAddingNotebook(false);
    }
  }

  async function addPageTo(notebookId: string) {
    const notebook = notebooks.find((item) => item.id === notebookId);
    const page: NotebookPage = {
      id: crypto.randomUUID(), name: `Page ${(notebook?.pages.length || 0) + 1}`, status: "blank", blank: true,
    };
    try {
      const currentUser = userId || (await sessionUser()).id;
      setUserId(currentUser);
      const { error } = await createClient().from("pages").insert({
        id: page.id, notebook_id: notebookId, user_id: currentUser, title: page.name,
        position: notebook?.pages.length || 0, status: "blank",
      });
      if (error) throw error;
      setNotebooks((current) => current.map((item) => item.id === notebookId ? { ...item, pages: [...item.pages, page] } : item));
      setActiveNotebookId(notebookId);
      setActivePageId(page.id);
      setScanStage("empty");
      setSyncMessage("Synced");
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "Could not add page");
    }
  }

  function choosePage(notebookId: string, page: NotebookPage) {
    setActiveNotebookId(notebookId);
    setActivePageId(page.id);
    setScanStage(stageFor(page));
  }

  async function loadFiles(files: File[]) {
    const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    const images = files.filter((file) => allowedTypes.has(file.type) && file.size <= 20 * 1024 * 1024);
    if (files.length && !images.length) {
      setSyncMessage("Use a PNG, JPEG, WEBP, or GIF under 20 MB.");
      return;
    }
    if (!images.length || !activeNotebookId) return;
    let currentUser: string;
    try {
      currentUser = userId || (await sessionUser()).id;
      setUserId(currentUser);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "Could not start a Pixi session");
      return;
    }
    let notebook = notebooks.find((item) => item.id === activeNotebookId);
    if (!notebook) return;
    let availableBlank = notebook.pages.find((page) => page.id === activePageId && page.status === "blank");

    for (const [index, image] of images.entries()) {
      let page = index === 0 ? availableBlank : undefined;
      if (!page) {
        page = { id: crypto.randomUUID(), name: image.name.replace(/\.[^/.]+$/, ""), status: "blank", blank: true };
        const { error } = await createClient().from("pages").insert({
          id: page.id, notebook_id: activeNotebookId, user_id: currentUser, title: page.name,
          position: notebook.pages.length + index, status: "blank",
        });
        if (error) { setSyncMessage(error.message); return; }
        setNotebooks((current) => current.map((item) => item.id === activeNotebookId ? { ...item, pages: [...item.pages, page!] } : item));
      }

      const pageId = page.id;
      const localUrl = URL.createObjectURL(image);
      const name = image.name.replace(/\.[^/.]+$/, "");
      updateLocalPage(activeNotebookId, pageId, { name, imageUrl: localUrl, status: "processing", blank: false });
      setActivePageId(pageId);
      setScanStage("scanning");
      setSyncMessage("Reading page...");

      const extension = image.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      const imagePath = `${currentUser}/${activeNotebookId}/${pageId}-${crypto.randomUUID()}.${extension}`;
      const started = Date.now();
      try {
        const supabase = createClient();
        const { error: uploadError } = await supabase.storage.from("notebook-pages").upload(imagePath, image, {
          contentType: image.type,
          upsert: false,
        });
        if (uploadError) throw uploadError;
        const response = await fetch("/api/ocr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pageId, imagePath, imageName: image.name }),
        });
        const result = await response.json();
        const wait = Math.max(0, 1900 - (Date.now() - started));
        if (wait) await new Promise((resolve) => window.setTimeout(resolve, wait));
        if (!response.ok) throw new Error(result.error || "Spatial OCR failed");
        const saved = result.page;
        updateLocalPage(activeNotebookId, pageId, {
          name: saved.title, status: "review", imageUrl: result.imageUrl || localUrl,
          imagePath: saved.image_path, markdown: saved.markdown, spatialData: saved.spatial_data,
          confidence: saved.confidence, blank: false,
        });
        setScanStage("review");
        setSyncMessage("Ready to review");
      } catch (error) {
        await createClient().storage.from("notebook-pages").remove([imagePath]);
        updateLocalPage(activeNotebookId, pageId, { status: "error", blank: false });
        setScanStage("empty");
        setSyncMessage(error instanceof Error ? error.message : "Spatial OCR failed");
        return;
      }
    }
  }

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    void loadFiles(Array.from(event.dataTransfer.files));
  }

  async function confirmPage() {
    if (!activePage) return;
    const { error } = await createClient().from("pages")
      .update({ status: "confirmed", markdown: activePage.markdown, updated_at: new Date().toISOString() })
      .eq("id", activePage.id);
    if (error) { setSyncMessage(error.message); return; }
    updateLocalPage(activeNotebookId, activePage.id, { status: "confirmed" });
    setScanStage("confirmed");
    setSyncMessage("Saved");
  }

  async function copySpatialOcr() {
    await navigator.clipboard?.writeText(activePage?.markdown || "");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function navigatePage(direction: number) {
    if (!activeNotebook?.pages.length) return;
    const currentIndex = Math.max(0, activeNotebook.pages.findIndex((page) => page.id === activePageId));
    const nextIndex = Math.min(activeNotebook.pages.length - 1, Math.max(0, currentIndex + direction));
    choosePage(activeNotebook.id, activeNotebook.pages[nextIndex]);
  }

  return (
    <main className={dragging ? "app is-dragging" : "app"}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.target === event.currentTarget) setDragging(false); }}
      onDrop={drop}>
      <aside className="sidebar">
        <div className="pixi-brand">Pixi <span>✦</span></div>
        <nav className="primary-nav" aria-label="Main navigation">
          <button onClick={() => activeNotebookId && void addPageTo(activeNotebookId)}><span>＋</span>New scan</button>
        </nav>
        <div className="notebooks-section">
          <div className="notebooks-title"><span>Notebooks</span><button aria-label="Add notebook" onClick={() => setAddingNotebook(true)}>＋</button></div>
          {addingNotebook && <div className="new-notebook-row"><span className="folder-glyph" /><input autoFocus value={newNotebookName} placeholder="Notebook name"
            onChange={(event) => setNewNotebookName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void addNotebook(); if (event.key === "Escape") setAddingNotebook(false); }} /></div>}
          <div className="notebook-tree">
            {notebooks.map((notebook) => <div className="notebook-group" key={notebook.id}>
              <div className={activeNotebookId === notebook.id && !activePageId ? "notebook-row selected" : "notebook-row"}>
                <button className="notebook-name" onClick={() => { setActiveNotebookId(notebook.id); setActivePageId(""); setScanStage("empty"); }}><span className="folder-glyph" /><strong>{notebook.name}</strong></button>
                <div className="notebook-actions"><button aria-label={`More options for ${notebook.name}`}>•••</button><button aria-label={`Add a page to ${notebook.name}`} onClick={() => void addPageTo(notebook.id)}>✎</button></div>
              </div>
              <div className="page-list">
                {notebook.pages.map((page) => <button key={page.id} className={`${activePageId === page.id ? "page-item active" : "page-item"}${page.status === "blank" ? " blank" : ""}`} onClick={() => choosePage(notebook.id, page)}>
                  <span>{page.name}{page.status === "blank" && <em> (blank)</em>}</span>
                </button>)}
                {!notebook.pages.length && <button className="empty-pages" onClick={() => void addPageTo(notebook.id)}>Add the first page</button>}
              </div>
            </div>)}
          </div>
        </div>
      </aside>

      <section className="chat-main">
        <header className="chat-header">
          <div className="page-context"><strong>{activeNotebook?.name || "Notebook"}</strong><span>{scanStage === "empty" ? "New page" : activePage?.name || "Page"}</span></div>
          <div className="header-actions"><span className="sync-message" title={syncMessage}>{syncMessage}</span><button className="help">Help</button></div>
        </header>
        <PageWorkspace stage={scanStage} page={activePage} openPicker={() => fileRef.current?.click()} confirm={() => void confirmPage()}
          copy={() => void copySpatialOcr()} copied={copied} previous={() => navigatePage(-1)} next={() => navigatePage(1)}
          pageIndex={Math.max(0, activeNotebook?.pages.findIndex((page) => page.id === activePageId) ?? 0)} pageCount={activeNotebook?.pages.length || 1}
          updateMarkdown={(markdown) => activePage && updateLocalPage(activeNotebookId, activePage.id, { markdown })} />
      </section>

      <input ref={fileRef} className="hidden-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => void loadFiles(Array.from(event.target.files || []))} />
      {dragging && <div className="drop-screen"><div><span>↓</span><strong>Drop pages into Pixi</strong><small>Add one image or an entire set of notebook pages</small></div></div>}
    </main>
  );
}

function PageWorkspace({ stage, page, openPicker, confirm, copy, copied, previous, next, pageIndex, pageCount, updateMarkdown }: {
  stage: ScanStage; page?: NotebookPage; openPicker: () => void; confirm: () => void; copy: () => void; copied: boolean;
  previous: () => void; next: () => void; pageIndex: number; pageCount: number; updateMarkdown: (markdown: string) => void;
}) {
  if (stage === "confirmed") return <section className="confirmed-workspace">
    <button className="page-arrow previous" onClick={previous} disabled={pageIndex <= 0} aria-label="Previous page">‹</button>
    <article className="confirmed-page"><div className="confirmed-meta"><span>SPATIAL MARKDOWN</span><span>{pageIndex + 1} of {pageCount}</span></div>
      <h1>{page?.name}</h1><p className="verbatim-note">Verbatim transcription · No summarization applied</p><hr />
      <pre className="confirmed-markdown">{page?.markdown}</pre><button className="copy-confirmed" onClick={copy}>{copied ? "Copied" : "Copy Markdown"}</button>
    </article>
    <button className="page-arrow next" onClick={next} disabled={pageIndex >= pageCount - 1} aria-label="Next page">›</button>
  </section>;

  return <section className="scan-review">
    <div className="scan-source">{stage === "empty"
      ? <button className="drop-zone" onClick={openPicker}><span className="drop-icon">↓</span><strong>Drag and drop</strong><small>or click to choose notebook pages</small></button>
      : <div className="scan-image">{page?.imageUrl ? <img src={page.imageUrl} alt="Notebook page to scan" /> : null}</div>}
    </div>
    <div className="scan-output">
      {stage === "review" && <header><div><h1>{page?.name}</h1></div><button onClick={copy}>{copied ? "Copied" : "Copy"}</button></header>}
      {stage === "review" && <textarea className="ocr-document markdown-editor" value={page?.markdown || ""} onChange={(event) => updateMarkdown(event.target.value)} aria-label="Spatial Markdown transcription" />}
      {stage === "review" && <footer className="review-footer"><span>Review the transcription before saving this page.</span><button onClick={confirm}>Confirm page</button></footer>}
    </div>
    {stage === "scanning" && <div className="pixie-transition" role="status" aria-live="polite" aria-label="Turning your notebook page into Markdown">
      <div className="pixie-trail" aria-hidden="true">{Array.from({ length: 15 }, (_, index) => <i key={index}>✦</i>)}</div><span>Turning ink into Markdown...</span>
    </div>}
  </section>;
}
