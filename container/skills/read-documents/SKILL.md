---
name: read-documents
description: Read and extract content from attachments and files the user sends — Word (.docx/.doc), Excel (.xlsx/.xls/.csv), PowerPoint (.pptx/.ppt), PDF, and images in any format (jpg, png, heic, tiff, bmp, webp, scanned docs). Use whenever a message has an attachment "saved to /workspace/inbox/..." or the user asks you to read, summarize, or pull data from a document, spreadsheet, slide deck, or picture.
allowed-tools: Read, Bash(pdftotext:*), Bash(soffice:*), Bash(libreoffice:*), Bash(tesseract:*), Bash(pdftoppm:*), Bash(pdfimages:*), Bash(convert:*), Bash(identify:*), Bash(ls:*), Bash(file:*)
---

# Reading documents & images

When a message arrives with an attachment, the formatter notes it like:

```
[document: invoice.pdf — saved to /workspace/inbox/<id>/invoice.pdf]
[image: receipt.jpg — saved to /workspace/inbox/<id>/receipt.jpg]
```

That path is a real file in your sandbox. Pick the method below by file type. **Always
prefer the `Read` tool when the format supports it** — you see the document directly, with
no lossy text extraction.

## PDF and common images → just Read them

The `Read` tool natively renders these to you. No conversion needed.

- **PDF** — `Read` the `.pdf` path. For PDFs over 10 pages, pass a `pages` range.
- **Images** `.jpg .jpeg .png .gif .webp` — `Read` the path; you see the image.

If a PDF looks empty or text-only extraction is cleaner (long reports), use:

```bash
pdftotext "/workspace/inbox/<id>/file.pdf" -    # text to stdout; empty output ⇒ scanned, use OCR below
```

## Word / PowerPoint / Excel → convert, then Read

LibreOffice headless converts every Office format, including legacy `.doc/.xls/.ppt`
and OpenDocument `.odt/.ods/.odp`. Convert into `/tmp`, then `Read` the result.

```bash
# Word / PowerPoint → PDF (preserves layout; then Read the PDF)
soffice --headless --convert-to pdf --outdir /tmp "/workspace/inbox/<id>/report.docx"
# → /tmp/report.pdf   (then: Read /tmp/report.pdf)

# Excel → PDF to view the sheets, OR → csv to extract data
soffice --headless --convert-to pdf --outdir /tmp "/workspace/inbox/<id>/sheet.xlsx"
soffice --headless --convert-to csv --outdir /tmp "/workspace/inbox/<id>/sheet.xlsx"  # first sheet only
```

Notes:
- Run `soffice` calls **one at a time** — it uses a single profile and concurrent runs fail.
- The first conversion in a fresh container is slow (profile init); later ones are fast.
- `.csv` export only emits the active/first sheet. For multi-sheet workbooks, convert to PDF
  and `Read`, or open the file and ask which sheet matters.

## Scanned PDFs & photos of documents → OCR

If `pdftotext` returns nothing (scanned/photographed), or the user sends a photo of a bill/
invoice, OCR it with tesseract.

```bash
# Image → text
tesseract "/workspace/inbox/<id>/receipt.jpg" /tmp/out && cat /tmp/out.txt

# Scanned PDF → rasterize each page → OCR
pdftoppm -png -r 300 "/workspace/inbox/<id>/scan.pdf" /tmp/page
for p in /tmp/page-*.png; do tesseract "$p" "${p%.png}"; done && cat /tmp/page-*.txt
```

For a clean photo you can usually just `Read` the image and read it yourself — OCR is for
when you need the literal text as data (totals, line items, IDs).

## Exotic image formats → convert to PNG, then Read

The `Read` tool doesn't render `.tiff/.bmp/.heic/.svg`. Convert with ImageMagick first.

```bash
convert "/workspace/inbox/<id>/photo.heic" /tmp/photo.png   # then: Read /tmp/photo.png
```

## After extracting

Don't dump raw extracted text back to the user. Summarize, pull the data they asked for, or
save structured data to a workspace file (e.g. a ledger) per your memory conventions, then
reply with the answer.
