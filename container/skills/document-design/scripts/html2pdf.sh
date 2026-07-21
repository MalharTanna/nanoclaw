#!/usr/bin/env bash
# html2pdf.sh — render an HTML document to an expert-grade PDF with WeasyPrint.
#
#   html2pdf.sh <input.html> [output.pdf]
#
# WeasyPrint is a pure-Python HTML/CSS -> PDF engine (no browser, no GPU), which
# makes it reliable inside containers. It renders @page margin boxes, so cover
# pages, running headers, and real page numbers all work.
#
# The design system (document-design.css) is inlined into a temporary copy of the
# HTML before rendering, so the PDF is fully self-contained and there are no
# missing-stylesheet issues wherever the source HTML happens to live.
set -euo pipefail

IN="${1:-}"
if [[ -z "$IN" || ! -f "$IN" ]]; then
  echo "usage: html2pdf.sh <input.html> [output.pdf]" >&2
  exit 2
fi
IN="$(cd "$(dirname "$IN")" && pwd)/$(basename "$IN")"
OUT="${2:-${IN%.*}.pdf}"

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS="$SKILL_DIR/assets"

TMP="$(mktemp --suffix=.html 2>/dev/null || mktemp)"
trap 'rm -f "$TMP"' EXIT

# Inline any <link ... document-design.css> with the canonical stylesheet.
node -e '
const fs = require("fs"), path = require("path");
const [html, assets] = process.argv.slice(1);
let s = fs.readFileSync(html, "utf8");
s = s.replace(/<link\b[^>]*href=["'"'"']([^"'"'"']*document-design\.css)["'"'"'][^>]*>/gi, (m, href) => {
  const cands = [path.resolve(path.dirname(html), href), path.join(assets, path.basename(href))];
  for (const p of cands) { try { if (fs.existsSync(p)) return "<style>\n" + fs.readFileSync(p, "utf8") + "\n</style>"; } catch {} }
  return m;
});
process.stdout.write(s);
' "$IN" "$ASSETS" > "$TMP"

# --base-url lets relative <img> paths in the source resolve correctly.
if weasyprint --base-url "$IN" "$TMP" "$OUT" 2>/tmp/weasy-err.$$; then
  rm -f "/tmp/weasy-err.$$"
  echo "PDF written: $OUT ($(du -h "$OUT" | cut -f1))"
else
  echo "weasyprint failed to render PDF:" >&2
  tail -8 "/tmp/weasy-err.$$" >&2 || true
  rm -f "/tmp/weasy-err.$$"
  exit 1
fi
