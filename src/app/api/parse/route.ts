import { NextRequest, NextResponse } from "next/server";
import { getDocumentProxy, getMeta } from "unpdf";
import { classifyAndMap, type DocumentMapping } from "@/lib/documents";
import { ocrPdf, TEXT_THRESHOLD } from "@/lib/ocr";

// PDF parsing relies on Node APIs, so force the Node.js runtime.
export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file
const MAX_FILES = 500;
const CONCURRENCY = 5; // parse this many PDFs at once to cap memory use

// Run an async mapper over items with a bounded number of concurrent workers,
// preserving input order in the results.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

type FileResult =
  | {
      ok: true;
      fileName: string;
      fileSize: number;
      totalPages: number;
      text: string;
      info: Record<string, unknown>;
      // True when the text was recovered via OCR (scanned/image-only PDF).
      ocrUsed: boolean;
      // Detected document type + mapped fields, or null if unrecognised.
      mapping: DocumentMapping | null;
    }
  | {
      ok: false;
      fileName: string;
      fileSize: number;
      error: string;
    };

// A pdf.js text fragment. pdf.js returns text in positioned chunks with no
// guaranteed spaces between them, so we reconstruct spacing ourselves.
type TextItem = {
  str: string;
  hasEOL: boolean;
  width: number;
  height: number;
  transform: number[]; // [a, b, c, d, e(x), f(y)]
};

function endsWithSpace(s: string) {
  return s.length === 0 || /\s$/.test(s);
}

// Rebuild readable text from positioned fragments: insert a space when there is
// a horizontal gap between fragments, and a newline on end-of-line markers or a
// vertical jump.
function reconstructPageText(items: TextItem[]): string {
  let out = "";
  let prev: TextItem | null = null;

  for (const item of items) {
    const str = item.str ?? "";

    if (prev) {
      const prevX = prev.transform[4];
      const prevY = prev.transform[5];
      const x = item.transform[4];
      const y = item.transform[5];

      const lineHeight = item.height || prev.height || 10;
      const verticalJump = Math.abs(y - prevY);

      if (verticalJump > lineHeight * 0.5) {
        // New visual line.
        out = out.replace(/[ \t]+$/, "") + "\n";
      } else {
        const prevEndX = prevX + prev.width;
        const gap = x - prevEndX;
        // A gap wider than ~a quarter em means the fragments were separated by
        // whitespace in the original document.
        const spaceWidth = lineHeight * 0.25;
        if (gap > spaceWidth && !endsWithSpace(out) && !/^\s/.test(str)) {
          out += " ";
        }
      }
    }

    out += str;

    if (item.hasEOL) {
      out = out.replace(/[ \t]+$/, "") + "\n";
      prev = null;
      continue;
    }
    prev = item;
  }

  return out;
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, "")) // trim trailing whitespace
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // collapse runs of blank lines
    .trim();
}

async function extractFormattedText(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
): Promise<{ totalPages: number; text: string }> {
  const totalPages = pdf.numPages;
  const pages: string[] = [];

  for (let n = 1; n <= totalPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    // pdf.js items are TextItem | TextMarkedContent; keep only the text ones.
    const items = content.items.filter(
      (i) => typeof (i as { str?: unknown }).str === "string",
    ) as unknown as TextItem[];
    pages.push(tidy(reconstructPageText(items)));
  }

  // Separate pages clearly while keeping the output easy to read.
  const text = pages
    .map((p, i) => `--- Page ${i + 1} ---\n${p}`.trimEnd())
    .join("\n\n")
    .trim();

  return { totalPages, text };
}

async function parseFile(input: {
  file: File;
  name: string;
}): Promise<FileResult> {
  const { file, name } = input;
  const isPdf =
    file.type === "application/pdf" || name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return { ok: false, fileName: name, fileSize: file.size, error: "Not a PDF file." };
  }
  if (file.size > MAX_BYTES) {
    return {
      ok: false,
      fileName: name,
      fileSize: file.size,
      error: "File is too large (max 25 MB).",
    };
  }

  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const pdf = await getDocumentProxy(buffer);
    const [extracted, meta] = await Promise.all([
      extractFormattedText(pdf),
      getMeta(pdf),
    ]);

    const { totalPages } = extracted;
    let text = extracted.text;
    let ocrUsed = false;

    // No usable text layer (e.g. a scanned form) — recover it with OCR so the
    // document can still be classified and mapped.
    if (text.replace(/--- Page \d+ ---/g, "").trim().length < TEXT_THRESHOLD) {
      try {
        // pdf.js transfers (and detaches) `buffer` to its worker, so OCR needs
        // its own fresh copy of the bytes.
        const ocrBuffer = new Uint8Array(await file.arrayBuffer());
        const ocrText = await ocrPdf(ocrBuffer, totalPages);
        if (ocrText.length > text.length) {
          text = ocrText;
          ocrUsed = true;
        }
      } catch (ocrErr) {
        console.error(`OCR failed for ${name}:`, ocrErr);
      }
    }

    return {
      ok: true,
      fileName: name,
      fileSize: file.size,
      totalPages,
      text,
      info: meta.info ?? {},
      ocrUsed,
      mapping: classifyAndMap(text, name),
    };
  } catch (err) {
    console.error(`PDF parse error for ${name}:`, err);
    return {
      ok: false,
      fileName: name,
      fileSize: file.size,
      error: "Failed to parse — the PDF may be corrupted or encrypted.",
    };
  }
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const files = formData.getAll("file").filter((f): f is File => f instanceof File);
  // Parallel list of relative paths (e.g. "reports/q1/file.pdf") so files from
  // folder uploads keep a distinguishable display name. Falls back to file.name.
  const paths = formData.getAll("path").map((p) => String(p));

  if (files.length === 0) {
    return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json(
      { error: `Too many files (max ${MAX_FILES}).` },
      { status: 413 },
    );
  }

  const inputs = files.map((file, i) => ({
    file,
    name: paths[i] || file.name,
  }));
  const results = await mapLimit(inputs, CONCURRENCY, parseFile);
  return NextResponse.json({ results });
}
