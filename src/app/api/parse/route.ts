import { NextRequest, NextResponse } from "next/server";
import { getDocumentProxy, getMeta } from "unpdf";

// PDF parsing relies on Node APIs, so force the Node.js runtime.
export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file
const MAX_FILES = 50;

type FileResult =
  | {
      ok: true;
      fileName: string;
      fileSize: number;
      totalPages: number;
      text: string;
      info: Record<string, unknown>;
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

async function parseFile(file: File): Promise<FileResult> {
  const isPdf =
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return {
      ok: false,
      fileName: file.name,
      fileSize: file.size,
      error: "Not a PDF file.",
    };
  }
  if (file.size > MAX_BYTES) {
    return {
      ok: false,
      fileName: file.name,
      fileSize: file.size,
      error: "File is too large (max 25 MB).",
    };
  }

  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const pdf = await getDocumentProxy(buffer);
    const [{ totalPages, text }, meta] = await Promise.all([
      extractFormattedText(pdf),
      getMeta(pdf),
    ]);
    return {
      ok: true,
      fileName: file.name,
      fileSize: file.size,
      totalPages,
      text,
      info: meta.info ?? {},
    };
  } catch (err) {
    console.error(`PDF parse error for ${file.name}:`, err);
    return {
      ok: false,
      fileName: file.name,
      fileSize: file.size,
      error: "Failed to parse — the PDF may be corrupted or encrypted.",
    };
  }
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const files = formData.getAll("file").filter((f): f is File => f instanceof File);

  if (files.length === 0) {
    return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json(
      { error: `Too many files (max ${MAX_FILES}).` },
      { status: 413 },
    );
  }

  const results = await Promise.all(files.map(parseFile));
  return NextResponse.json({ results });
}
