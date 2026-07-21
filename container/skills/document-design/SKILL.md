---
name: document-design
description: Produce expert-grade, beautifully formatted PDF documents — reports, proposals, invoices, letters, quotations, brochures, one-pagers, certificates. Use whenever the user asks you to create, generate, write up, make, or "send as PDF" any document, or when a polished document (not a chat message) is the right deliverable. Renders HTML/CSS to PDF with a built-in professional design system and print-quality fonts.
allowed-tools: Read, Write, Edit, Bash(bash:*), Bash(weasyprint:*), Bash(cp:*), Bash(ls:*), Bash(cat:*), Bash(mktemp:*)
---

# Document design — top-class PDFs

When the user wants a **document** (not just a chat reply), produce a real, professionally
designed PDF. Do **not** hand-format plain text or dump markdown — use this pipeline so the
output looks like an expert designed it.

The engine is **WeasyPrint** (pure-Python HTML/CSS → PDF — no browser, reliable in the
container). A ready-made design system (`assets/document-design.css`) gives you refined
typography, a cover page, styled tables, callouts, invoice totals, a signature block, and real
page numbers — all print-tuned. You supply the content.

## Workflow

1. **Pick the closest template** from this skill's `templates/` folder:
   `report.html` · `proposal.html` · `invoice.html` · `letter.html`.
   (For anything else — quotation, brochure, certificate, memo — start from `report.html`.)

2. **Copy it into your workspace and edit the content.** Keep the structure and classes;
   replace the placeholder text with the real content.
   ```bash
   cp /app/skills/document-design/templates/report.html /workspace/agent/my-report.html
   # then edit /workspace/agent/my-report.html
   ```
   Leave the `<link rel="stylesheet" href="document-design.css">` line as-is — the renderer
   inlines the design system automatically, so you do **not** need to copy the CSS.

3. **Render to PDF:**
   ```bash
   bash /app/skills/document-design/scripts/html2pdf.sh /workspace/agent/my-report.html
   # → writes /workspace/agent/my-report.pdf
   ```
   Optionally pass an output path as the second argument.

4. **Send it** with the `send_file` tool:
   `send_file(path="my-report.pdf", text="Here's the report — let me know any changes.")`
   Paths are relative to `/workspace/agent/`.

## Design principles (follow even when improvising)

- **One accent colour.** Change it in one place: `body { --accent: #1e3a5f; }` in the doc's
  `<style>`. Everything (rules, headings' underline, table headers, callouts, badges) follows.
- **Lead with the conclusion.** Executive summary / purpose first, detail after.
- **Whitespace is not wasted space.** Don't cram. Generous margins read as premium.
- **Numbers are tabular and right-aligned** — use `class="num"` on numeric table cells.
- **Restraint.** No clip-art, no rainbow colours, no more than two type weights per level.

## What the design system gives you (classes)

| Class / element | Use for |
|---|---|
| `.doc-cover` + `.bar` + `.cover-title` + `.cover-meta` | A full cover page (reports, proposals) |
| `.brand` + `.contact` | Letterhead / top-of-page company block |
| `.eyebrow`, `.label` | Small tracked uppercase section labels |
| `.lead` | Larger intro paragraph after a heading |
| `.callout` (`.warn`, `.good`) | Highlighted note boxes |
| `table` + `.num` | Clean data tables; headers repeat across pages |
| `.kv` | Key/value grid (invoice/letter meta) |
| `.totals` + `.row.grand` | Invoice / quote totals block |
| `.badge` (`.soft`) | Status pills (Paid, Draft…) |
| `.signature` + `.line` | Sign-off lines |
| `blockquote`, `code`, `pre` | Pull quotes and code |
| `body.theme-classic` | Elegant serif (EB Garamond) body — good for letters, formal docs |
| `.page-break`, `.avoid-break` | Manual page control |

Paper defaults to A4. The cover page (`.doc-cover`) is tuned for A4.

**Page numbers** are on by default in `report.html` / `proposal.html` (via a `@page` footer
rule in their `<style>` — the cover page is automatically excluded). Invoices and letters omit
them (single-page docs read cleaner without). To add them elsewhere, paste into the doc's
`<style>`:
```css
@page { @bottom-center { content: counter(page) " / " counter(pages);
        font-family: "Lato"; font-size: 8pt; color: #9aa1ab; } }
```

## Layout notes (WeasyPrint)

The design system deliberately uses tables, inline-block, and floats — **not** CSS grid or
flexbox, which WeasyPrint supports only partially. Stick to the provided classes and they'll
render predictably. If you hand-write layout, prefer `<table>` or `display:inline-block`
columns over fl/grid.

## Fonts available in the container

Professional, print-ready: **Lato** (sans, default UI/headings), **EB Garamond**
(elegant serif, `theme-classic`), **Noto Sans/Serif** (broad fallback), **Fira Code** (mono).
Don't reference web fonts — they won't load offline; these cover every need.

## Charts, logos, images

- Embed a logo or image with a normal `<img>` — use an **absolute path** or a `data:` URI so
  it resolves during rendering (`<img src="/workspace/agent/logo.png">`).
- For charts, generate an SVG or PNG and `<img>` it in, or hand-build simple bar/stat blocks
  with `<div>`s styled by the design tokens.

## Limitations (be honest with the user)

- **No CSS grid / limited flexbox.** WeasyPrint doesn't do modern grid/flex layout — use the
  provided table/inline-block classes. Complex multi-column magazine layouts are possible but
  fiddly; confirm scope before attempting one.
- Interactive/animated content, web fonts, and JavaScript don't apply — this is static print.

## Quick check

Before sending, glance at the PDF (open it with the `Read` tool) to confirm nothing overflows
the page and the accent/formatting rendered. Then `send_file` it.
