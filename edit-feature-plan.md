# weejur — WYSIWYG text editor: implementation plan

## Goal

Let non-technical users edit the visible text of an HTML page without touching layout or styling. Two views:

- **Preview**: rendered page with click-to-edit text. No structural changes possible.
- **Code**: the raw HTML in a textarea. Full edit access. Used for things the preview deliberately can't change (titles, meta tags, attributes, structure).

Three save actions: **Download**, **Copy**, **Publish**.

Sources of HTML:
1. Pasted HTML
2. Uploaded `.html` file
3. A file pulled from one of the user's existing weejur sites (defaults to `index.html`)

## Scope

**In scope (v1):**
- Single HTML file at a time
- Edit visible text in preview; edit anything in code
- Download, copy, or publish (new repo or republish in place)
- Entry from dashboard ("Edit text" button per site) and from `/new` (optional "Preview & edit" detour)

**Out of scope (v1):**
- Multi-file/multi-page editing in a single session
- Image/asset replacement
- Side panel for non-visible content (covered by code view instead)
- Styling, structural editing, rich-text formatting
- Mobile-first experience (desktop-first; we'll show a notice on small screens)

## Location: path, not subdomain

The editor lives at `weejur.com/edit`, not `edit.weejur.com`.

Why:
- Auth currently lives in `localStorage`, which is origin-scoped — a subdomain would have no token. Fixing that means moving sessions to cookies on `.weejur.com` and reworking the worker. Real refactor for no real gain.
- Subdomains pay off when products diverge (separate deploys, separate teams, brand separation). None applies. The big apps that do this (`gist.github.com`, `drive.google.com`) share session cookies on the parent domain — a deliberate setup, not a default.
- `/edit` mirrors `/new` and `/dashboard`, gets free auth, shares `shared.js` and the design system.

## Integration with existing flows

### `/new` (publish a folder/site)

Stays as the primary publish path. After files are picked, add an optional **"Preview & edit"** button next to "Continue". Conditions:

- Only shown when exactly one HTML file is selected (single-file editing only in v1).
- Clicking it stashes the file in IndexedDB (reuse `savePendingFiles`) and routes to `/edit?from=new`.
- The editor's "Publish" action, when reached via `from=new`, routes back to `/new` to finish the naming step (preserving the existing UX for site naming).

This keeps the default upload→name→publish flow zero-friction. The detour is opt-in.

### Dashboard

Add a third button per site card: **"Edit text"** → `/edit?repo=<name>`.

- Existing **"Update"** button stays — it's still the right tool for re-uploading a whole site.
- "Edit text" assumes single-file editing. Loads `index.html` by default. If the repo has multiple `.html` files at the root, show a small picker at the top of the editor.

## Editor page

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│ nav-bar (shared)                                            │
├─────────────────────────────────────────────────────────────┤
│  index.html · status: Unsaved changes                       │
│  [ Preview | Code ]              [Download] [Copy] [Publish]│
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   <iframe sandbox preview>  OR  <textarea code editor>      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Files

- `edit.html` — page markup (entry-mode chooser, editor shell, modals)
- `js/edit.js` — all behavior
- New CSS additions in `css/style.css`

### Entry modes

`/edit` with no params shows a chooser identical in spirit to `/new`'s upload step:
- Paste HTML
- Upload single `.html` file
- (If signed in) "Open from your sites"

`/edit?repo=<name>` skips the chooser and fetches the file. Multiple HTML files → picker.

`/edit?from=new` — pulls the file out of IndexedDB pending storage.

## Editing model

### Source of truth

A single `rawHtml` string. Both views read and write to it.

- **Preview** parses it on entry, mutates the parsed Document, re-serializes back to `rawHtml` on every committed text edit.
- **Code** binds a textarea directly to `rawHtml`.
- Switching tabs flushes any pending edit on the way out and re-renders the destination view.

### Preview view: click-to-edit

1. Parse `rawHtml` with `DOMParser('text/html')`. Capture original DOCTYPE separately (`outerHTML` doesn't include it).
2. Render in an iframe via `srcdoc` — `sandbox="allow-same-origin"` (no `allow-scripts`) so we can walk the DOM but no embedded scripts run.
3. Walk text nodes inside the iframe document. For each non-whitespace text node whose ancestors are not `<script>`, `<style>`, `<noscript>`, `<template>`, or any element in `<head>`: wrap it in `<span data-edit-id="...">`. Inject a stylesheet into the iframe that gives those spans a hover outline.
4. On click of an edit-span: set `contenteditable="true"`, focus, place caret at click position.
5. On blur: read `textContent`, write the new text back to the original text node in the source-of-truth Document, drop `contenteditable`, re-serialize `rawHtml`.

### Constraining `contenteditable`

`contenteditable` is leaky by default. Active mitigations:

- `beforeinput` — allow only `insertText`, `deleteContentBackward`, `deleteContentForward`, `insertReplacementText`. Block paragraph splits, formatting, link insertion, drag/drop.
- `paste` — `preventDefault`, then insert the clipboard's plain text.
- `keydown` — swallow Enter (no new blocks). Allow newlines only when the editing span is inside `<pre>`.
- Block `Cmd/Ctrl+B/I/U` to keep formatting shortcuts from sneaking in.

### Code view

A lightweight code editor using **CodeJar** (~2KB, a thin `contenteditable` wrapper) backed by **Prism.js** (~5KB core + HTML grammar) for syntax highlighting. Both vendored under `js/vendor/` rather than loaded from a CDN — keeps the existing CSP tight, no runtime network dependency. Total weight under ~15KB.

CodeMirror / Monaco are deliberately ruled out: an order of magnitude larger, much more architectural, and weejur's "plain HTML/CSS/JS, no framework" posture is a feature not a constraint.

`DOMParser('text/html')` is forgiving — invalid markup auto-closes — so switching back to preview won't error on imperfect HTML. We deliberately don't surface a "your HTML may be broken" warning; the preview reflecting the code is feedback enough, and over-warning would punish users who are mid-tweak.

### Round-trip caveats

Parsing → serializing a Document is mostly faithful but normalizes some things (attribute quoting, self-closing tags, whitespace between top-level nodes). For text-only edits this is not noticeable. Worth documenting briefly in the FAQ.

DOCTYPE is preserved manually: `<!DOCTYPE html>\n` + `doc.documentElement.outerHTML`. Helper spans (`data-edit-id`) are stripped on serialize.

**Formatting preservation across tab switches.** Track two dirty flags: `previewDirty` (set when the user clicks-to-edit in preview) and `codeDirty` (set when the user types in the code-view textarea/CodeJar field).

- Preview → Code switch: if `previewDirty`, re-serialize the source Document and replace the code-view buffer. Otherwise leave the buffer alone — preserves user formatting exactly when edits were code-only.
- Code → Preview switch: if `codeDirty`, re-parse the code-view buffer into a fresh source Document and re-render the iframe. Otherwise leave the iframe alone.

Net effect: a user who only ever uses code view never sees their HTML normalized. A user who edits in preview will see one round-trip's worth of normalization on save (acceptable trade-off, mention in FAQ).

### Asset paths in preview

Pasted HTML and uploaded files referencing relative paths (`./logo.png`, `styles.css`) will 404 in the preview because the iframe has no real base URL. Acceptable trade-off; document it.

For HTML loaded from a published repo (`/edit?repo=<name>`), we can do better. After the iframe loads, inject a `<base>` tag into its `<head>`:

```html
<base href="https://<username>.github.io/<repo>/">
```

The browser resolves all relative URLs in the iframe against that base, so images, stylesheets, etc. render exactly as they do live. Why this stays simple:

- The iframe DOM and the source-of-truth Document are separate. We walk the iframe DOM for click-to-edit but never serialize it back.
- The injected `<base>`, edit-helper spans, and hover stylesheet are all iframe-only — they never touch the source we publish/download.
- No need to "un-rewrite" before publishing; the source still has the original paths.

Caveats:
- Project sites (served at `username.github.io/<repo>/`): absolute paths beginning with `/` will resolve to the github.io root, not the repo's subpath. Those are already broken in production for the same reason, so the preview matches reality.
- If the source already has a `<base>` tag, we leave it and don't inject — assume the author knew what they were doing.
- A `target="_top"` attribute on the injected `<base>` (or a sandbox without `allow-top-navigation`) keeps stray link clicks from trying to navigate.

## Sanitization and security

The editor runs in `weejur.com`'s origin and holds the user's GitHub token. Pasted HTML can be hostile. Defenses:

- **Preview iframe** — `sandbox="allow-same-origin"`. No `allow-scripts`, no `allow-popups`, no `allow-forms`. Scripts in the user's HTML never execute. Same-origin lets us walk and mutate the DOM.
- **No `srcdoc` shortcuts that would unsandbox** — we never `eval`/`Function` content from the HTML.
- **Code view is a textarea** — never injected into the DOM directly; rendering only happens through the sandboxed iframe.
- **CSP on `/edit`** — keep the existing tight CSP. The iframe is `srcdoc` (no `frame-src` URL needed beyond `'self' data:`).
- **No URL/asset rewriting** — relative links and assets in pasted HTML will 404 in the preview. That's fine for a text editor; document it.

## Save actions

Three buttons. Behavior depends on entry mode.

### Download
Always available. Build a `Blob` from serialized HTML, trigger an `<a download>` click. Filename = original filename (or `index.html` for pastes).

### Copy
Always available. `navigator.clipboard.writeText(serialized)`. Brief inline confirmation, same style as the dashboard's copy-link button.

### Publish

Button label and width vary by state:

- **Signed in:** `[Publish]` — normal-width primary button.
- **Signed out:** `[Sign in with GitHub to publish]` — wider primary button with the GitHub mark on the left. Download and Copy stay at their normal small width on the same row.

Behavior depends on entry mode:

- **Loaded from a repo (`?repo=...`):** GET the file to grab latest `sha`, PUT new content via `/repos/{owner}/{repo}/contents/{path}` with commit message `Edit text via weejur`. Show inline success + link to the live URL. Reuse `githubApi` from `shared.js`.
- **Coming from `/new` (`?from=new`):** save edited content to IndexedDB pending storage, redirect back to `/new` so the user finishes naming and triggers the existing publish flow.
- **Pasted/uploaded standalone (signed in):** open a small "Name your site" modal, then run the same path as `publishCreate` in `js/new.js:150` (create repo → topic `weejur` → upload → enable Pages → redirect to `/published`). Refactor that function into `shared.js` so both pages share it instead of copying.
- **Pasted/uploaded standalone (signed out):** clicking the wide "Sign in with GitHub to publish" button kicks off OAuth (existing landing-page pattern), persists the edited HTML to IndexedDB, returns to `/edit?from=auth` to resume into the name-your-site modal.

## Build order

Each step is independently shippable.

### 1. `/edit` skeleton
- New `edit.html` with nav and entry-mode chooser (paste / upload only, no GitHub yet).
- `js/edit.js` boilerplate.
- Preview tab renders the HTML in a sandboxed iframe.
- Code tab uses CodeJar + Prism (vendored under `js/vendor/`) for highlighted editing of `rawHtml`.
- Tab switching honors the `previewDirty` / `codeDirty` flags so code-only edits preserve formatting.
- Download button works.

**Verifies:** parse/serialize round-trip is acceptable; sandbox renders user HTML without script execution; CodeJar/Prism integration is solid.

### 2. Click-to-edit in preview
- Wrap text nodes in edit-spans, hover outline.
- `contenteditable` on click, constrained per the rules above.
- Blur commits to source-of-truth Document, re-serializes `rawHtml`.
- Strip helper spans on serialize.
- Copy button.

**End state:** paste HTML → click headings/paragraphs → edit → download or copy modified HTML.

### 3. Open from a repo
- `/edit?repo=<name>` fetches `index.html` from the repo.
- Multiple HTML files at root → picker.
- "Edit text" button on each dashboard card.
- Inject `<base href="https://<username>.github.io/<repo>/">` into the iframe `<head>` post-load so relative asset URLs resolve to the live site.

### 4. Republish in place
- Publish button on `?repo=` mode: PUT contents API with `sha`. Inline success.

### 5. `/new` integration
- "Preview & edit" button on `/new` after single-file pick.
- IndexedDB hand-off in both directions.
- Editor's Publish (when `from=new`) returns to `/new` for naming.

### 6. Publish from standalone editor
- Refactor `publishCreate` from `js/new.js` into a shared helper.
- Name modal in `/edit`. Wire to shared publish helper.
- Signed-out flow: stash + OAuth + resume.

### 7. Polish
- Unsaved-changes warning on navigation (`beforeunload`).
- Esc to blur an active edit.
- Small-screen notice ("Editor works best on desktop").
- FAQ entry covering: what gets edited, the round-trip note, link to code view for advanced edits.

## Out-of-scope future work

- Multi-page editor (switch between `index.html`, `about.html`, etc., within one session)
- Image replacement / `alt` editing
- Asset-path resolution for paste/upload mode (would need blob URLs or a synthetic origin)
- Mobile-tuned editor
- Visual indicator of which text node corresponds to which spot in code view
