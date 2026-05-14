// =============================================================================
// edit.js — WYSIWYG-ish HTML editor (/edit)
//
// Two views over a single source-of-truth Document:
//   - Preview: sandboxed iframe; click text to edit. Edits flow back to
//     sourceDoc via a textNode map.
//   - Code: CodeJar + Prism. Edits flow back as a re-parse on tab switch.
//
// Dirty flags coordinate the round-trips so code-only edits preserve
// formatting exactly; preview edits accept one normalization pass.
// =============================================================================

initNavbar();

// =============================================================================
// State
// =============================================================================

const parser = new DOMParser();

let rawHtml = "";
let sourceDoc = null;            // Document parsed from rawHtml (canonical)
let textNodeMap = new Map();     // edit-id (string) -> Text node in sourceDoc
let filename = "index.html";
let currentView = "preview";
let codeDirty = false;
let previewDirty = false;
let previewStale = true;         // iframe needs re-render from rawHtml
let jar = null;
let suppressCodeUpdate = false;

// When the source came from a published repo, this carries enough context to
// resolve relative asset paths (via injected <base>) and, later, to republish.
let repoContext = null;          // { username, repo, path, sha } | null

const STEPS = ["step-source", "step-loading", "step-pick-file", "step-source-error", "step-editor"];

function showStep(id) {
  STEPS.forEach((s) => {
    const el = $(s);
    if (!el) return;
    el.classList.toggle("active", s === id);
  });
}

const sourceStep = $("step-source");
const editorStep = $("step-editor");
const previewFrame = $("preview-frame");
const codeEditor = $("code-editor");
const editorStatus = $("editor-status");

// =============================================================================
// Source step — tabs (paste / upload)
// =============================================================================

document.querySelectorAll("[data-source-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("[data-source-tab]").forEach((t) =>
      t.classList.remove("active")
    );
    tab.classList.add("active");
    const target = tab.dataset.sourceTab;
    $("panel-source-paste").hidden = target !== "paste";
    $("panel-source-upload").hidden = target !== "upload";
  });
});

$("btn-source-paste").addEventListener("click", () => {
  const text = $("source-paste").value;
  if (!text.trim()) return;
  loadSource(text, "index.html");
});

$("btn-upload-pick").addEventListener("click", (e) => {
  e.stopPropagation();
  $("upload-input").click();
});

$("upload-input").addEventListener("change", async () => {
  const file = $("upload-input").files[0];
  if (!file) return;
  await openFile(file);
});

const dropZone = $("upload-drop");
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});
dropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (!file) return;
  await openFile(file);
});

async function openFile(file) {
  if (!/\.html?$/i.test(file.name) && file.type !== "text/html") {
    showUploadError("Please choose a single HTML file (.html or .htm).");
    return;
  }
  const text = await file.text();
  loadSource(text, file.name || "index.html");
}

function showUploadError(msg) {
  const el = $("upload-error");
  el.textContent = msg;
  el.hidden = false;
}

// =============================================================================
// Load HTML into the editor
// =============================================================================

function loadSource(html, name) {
  rawHtml = html;
  filename = (name || "index.html").split("/").pop();
  const prefix = repoContext ? repoContext.repo : "untitled";
  $("editor-filename").textContent = prefix + "/" + filename;
  editorStatus.hidden = true;
  codeDirty = false;
  previewDirty = false;
  previewStale = true;

  showStep("step-editor");

  setCodeContent(rawHtml);
  switchView("preview", { force: true });
}

// =============================================================================
// Serialize / parse helpers
// =============================================================================

function serializeDoc(doc) {
  const dt = doc.doctype;
  let prefix = "";
  if (dt) {
    prefix = "<!DOCTYPE " + dt.name;
    if (dt.publicId) prefix += ' PUBLIC "' + dt.publicId + '"';
    if (dt.systemId) prefix += (dt.publicId ? "" : " SYSTEM") + ' "' + dt.systemId + '"';
    prefix += ">\n";
  }
  return prefix + doc.documentElement.outerHTML;
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"]);

function collectEditableTextNodes(doc) {
  const out = [];
  const root = doc.body || doc.documentElement;
  if (!root) return out;
  const walk = (node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (SKIP_TAGS.has(node.tagName)) return;
      for (const child of node.childNodes) walk(child);
    } else if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue && node.nodeValue.trim()) out.push(node);
    }
  };
  walk(root);
  return out;
}

// =============================================================================
// Preview rendering + edit wiring
// =============================================================================

function refreshFromRawHtml() {
  sourceDoc = parser.parseFromString(rawHtml, "text/html");

  let renderHtml;
  if (repoContext) {
    // Clone sourceDoc and prepend a <base> in the clone only — keeps the
    // canonical doc free of the helper tag so saves stay clean.
    const previewDoc = sourceDoc.cloneNode(true);
    if (previewDoc.head && !previewDoc.head.querySelector("base")) {
      const base = previewDoc.createElement("base");
      base.href = `https://${repoContext.username}.github.io/${repoContext.repo}/`;
      previewDoc.head.insertBefore(base, previewDoc.head.firstChild);
    }
    renderHtml = serializeDoc(previewDoc);
  } else {
    renderHtml = serializeDoc(sourceDoc);
  }

  previewFrame.onload = () => {
    setupPreviewEditing();
  };
  previewFrame.srcdoc = renderHtml;
  previewStale = false;
}

function setupPreviewEditing() {
  const iframeDoc = previewFrame.contentDocument;
  if (!iframeDoc) return;

  const sourceNodes = collectEditableTextNodes(sourceDoc);
  const iframeNodes = collectEditableTextNodes(iframeDoc);

  textNodeMap = new Map();

  // Walks should produce identically-ordered lists (same parser, same input).
  // If they diverge, fall back gracefully — wrap what we can in the iframe.
  const len = Math.min(sourceNodes.length, iframeNodes.length);
  for (let i = 0; i < len; i++) {
    const id = String(i);
    const node = iframeNodes[i];
    const span = iframeDoc.createElement("span");
    span.setAttribute("data-weejur-edit", id);
    node.parentNode.insertBefore(span, node);
    span.appendChild(node);
    textNodeMap.set(id, sourceNodes[i]);
  }

  injectEditingStyles(iframeDoc);
  attachEditingHandlers(iframeDoc);
}

function injectEditingStyles(doc) {
  const style = doc.createElement("style");
  style.setAttribute("data-weejur-style", "");
  style.textContent = `
    [data-weejur-edit] {
      cursor: text;
      transition: outline 0.1s ease, background 0.1s ease;
    }
    [data-weejur-edit]:hover {
      outline: 2px dashed rgba(43, 86, 59, 0.45);
      outline-offset: 2px;
    }
    [data-weejur-edit][contenteditable="true"] {
      outline: 2px solid #2b563b;
      outline-offset: 2px;
      background: rgba(214, 232, 220, 0.55);
    }
  `;
  doc.head.appendChild(style);
}

const ALLOWED_INPUT_TYPES = new Set([
  "insertText",
  "insertReplacementText",
  "insertCompositionText",
  "deleteContentBackward",
  "deleteContentForward",
  "deleteWordBackward",
  "deleteWordForward",
  "deleteByCut",
  "historyUndo",
  "historyRedo",
]);

function attachEditingHandlers(doc) {
  // Block link navigation inside the preview.
  doc.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a");
    if (a) e.preventDefault();
  });

  // Begin editing on mousedown so the click positions the caret naturally.
  doc.addEventListener("mousedown", (e) => {
    const span = e.target.closest && e.target.closest("[data-weejur-edit]");
    if (!span) return;
    if (span.contentEditable !== "true") {
      span.contentEditable = "true";
    }
  });

  // Commit on blur.
  doc.addEventListener("focusout", (e) => {
    const span = e.target.closest && e.target.closest("[data-weejur-edit]");
    if (!span) return;
    commitEdit(span);
  });

  // Constrain inputs to text-only.
  doc.addEventListener("beforeinput", (e) => {
    const span =
      e.target.closest && e.target.closest("[data-weejur-edit][contenteditable='true']");
    if (!span) return;
    if (!ALLOWED_INPUT_TYPES.has(e.inputType)) {
      e.preventDefault();
    }
  });

  // Plain-text paste only.
  doc.addEventListener("paste", (e) => {
    const span =
      e.target.closest && e.target.closest("[data-weejur-edit][contenteditable='true']");
    if (!span) return;
    e.preventDefault();
    const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    if (!text) return;
    const sel = previewFrame.contentWindow.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(doc.createTextNode(text));
    range.collapse(false);
  });

  doc.addEventListener("keydown", (e) => {
    const span =
      e.target.closest && e.target.closest("[data-weejur-edit][contenteditable='true']");
    if (!span) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (span.closest("pre")) {
        const sel = previewFrame.contentWindow.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(doc.createTextNode("\n"));
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } else {
        const sel = previewFrame.contentWindow.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const br = doc.createElement("br");
          range.insertNode(br);
          range.setStartAfter(br);
          range.setEndAfter(br);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    }
    if ((e.metaKey || e.ctrlKey) && /^[bBiIuU]$/.test(e.key)) {
      e.preventDefault();
    }
  });
}

function commitEdit(span) {
  if (span.contentEditable !== "true") return;
  const id = span.getAttribute("data-weejur-edit");
  span.contentEditable = "false";

  const sourceNode = textNodeMap.get(id);
  if (!sourceNode) return;

  if (span.querySelector("br")) {
    const parent = sourceNode.parentNode;
    if (!parent) return;
    const tempDiv = sourceDoc.createElement("div");
    tempDiv.innerHTML = span.innerHTML;
    const frag = sourceDoc.createDocumentFragment();
    while (tempDiv.firstChild) frag.appendChild(tempDiv.firstChild);
    parent.replaceChild(frag, sourceNode);
  } else {
    const newText = span.textContent;
    if (sourceNode.nodeValue === newText) return;
    sourceNode.nodeValue = newText;
  }

  previewDirty = true;
  editorStatus.hidden = false;
}

// =============================================================================
// Code editor (CodeJar + Prism)
// =============================================================================

function initCodeEditor() {
  jar = CodeJar(
    codeEditor,
    (el) => {
      el.innerHTML = Prism.highlight(
        el.textContent,
        Prism.languages.markup,
        "markup"
      );
    },
    { tab: "  ", indentOn: /[<({\[]$/ }
  );
  jar.onUpdate((code) => {
    if (suppressCodeUpdate) return;
    rawHtml = code;
    codeDirty = true;
    previewStale = true;
    editorStatus.hidden = false;
  });
}

function setCodeContent(html) {
  if (!jar) initCodeEditor();
  suppressCodeUpdate = true;
  jar.updateCode(html);
  suppressCodeUpdate = false;
}

// =============================================================================
// View tab switching
// =============================================================================

document.querySelectorAll("[data-view-tab]").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.viewTab));
});

function switchView(view, { force = false } = {}) {
  if (!force && currentView === view) return;

  // Sync OUT of the outgoing view.
  if (currentView === "code" && codeDirty) {
    rawHtml = jar.toString();
    codeDirty = false;
    previewStale = true;
  }
  if (currentView === "preview" && previewDirty) {
    rawHtml = serializeDoc(sourceDoc);
    previewDirty = false;
    setCodeContent(rawHtml);
  }

  currentView = view;
  document.querySelectorAll("[data-view-tab]").forEach((t) => {
    t.classList.toggle("active", t.dataset.viewTab === view);
  });
  $("view-preview").hidden = view !== "preview";
  $("view-code").hidden = view !== "code";

  if (view === "preview" && previewStale) {
    refreshFromRawHtml();
  }
}

// =============================================================================
// Flush pending edits before export
// =============================================================================

function flushPending() {
  if (currentView === "code" && codeDirty) {
    rawHtml = jar.toString();
    codeDirty = false;
    previewStale = true;
  }
  if (previewDirty) {
    rawHtml = serializeDoc(sourceDoc);
    previewDirty = false;
    setCodeContent(rawHtml);
  }
}

// =============================================================================
// Download
// =============================================================================

$("btn-download").addEventListener("click", () => {
  flushPending();

  const blob = new Blob([rawHtml], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "index.html";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  editorStatus.hidden = true;
});

// =============================================================================
// Copy
// =============================================================================

$("btn-copy").addEventListener("click", async () => {
  flushPending();
  const btn = $("btn-copy");
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(rawHtml);
    btn.textContent = "Copied!";
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  } catch (err) {
    btn.textContent = "Copy failed";
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  }
});

// =============================================================================
// Loading from a published repo
// =============================================================================

function showLoadError(msg) {
  $("source-error-message").textContent = msg;
  showStep("step-source-error");
}

async function loadFromRepo(repo, path) {
  const username = getUsername();
  showStep("step-loading");

  try {
    if (path) {
      // Direct file load
      await openRepoFile(username, repo, path);
      return;
    }

    const contents = await githubApi(
      `/repos/${encodeURIComponent(username)}/${encodeURIComponent(repo)}/contents/`
    );
    const htmlFiles = (contents || []).filter(
      (c) => c.type === "file" && /\.html?$/i.test(c.name)
    );

    if (htmlFiles.length === 0) {
      showLoadError(`No HTML files found at the root of "${repo}".`);
      return;
    }

    const indexFile = htmlFiles.find((f) => f.name === "index.html");
    if (indexFile) {
      await openRepoFile(username, repo, indexFile.path);
    } else if (htmlFiles.length === 1) {
      await openRepoFile(username, repo, htmlFiles[0].path);
    } else {
      showFilePicker(repo, htmlFiles);
    }
  } catch (err) {
    showLoadError(err.message || "Failed to load site from GitHub.");
  }
}

function showFilePicker(repo, files) {
  const list = $("file-pick-list");
  list.innerHTML = "";
  const username = getUsername();
  files.forEach((file) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary";
    btn.textContent = file.name;
    btn.addEventListener("click", () => openRepoFile(username, repo, file.path));
    list.appendChild(btn);
  });
  showStep("step-pick-file");
}

async function openRepoFile(username, repo, path) {
  showStep("step-loading");
  try {
    const fileData = await githubApi(
      `/repos/${encodeURIComponent(username)}/${encodeURIComponent(repo)}/contents/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`
    );
    if (fileData.type !== "file" || typeof fileData.content !== "string") {
      showLoadError(`"${path}" doesn't look like an editable file.`);
      return;
    }

    const text = base64ToText(fileData.content);
    repoContext = { username, repo, path, sha: fileData.sha };
    loadSource(text, path);
  } catch (err) {
    showLoadError(err.message || `Failed to load ${path}.`);
  }
}

// =============================================================================
// Entry: dispatch on URL params
// =============================================================================

const params = new URLSearchParams(window.location.search);
const queryRepo = params.get("repo");
const queryPath = params.get("path");

if (queryRepo) {
  if (requireAuth()) {
    loadFromRepo(queryRepo, queryPath);
  }
}

