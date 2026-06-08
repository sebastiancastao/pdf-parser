"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type MappedField = { label: string; value: string | null };
type DocumentMapping = {
  type: string;
  label: string;
  confidence: number;
  fields: MappedField[];
};

type FileResult =
  | {
      ok: true;
      fileName: string;
      fileSize: number;
      totalPages: number;
      text: string;
      info: Record<string, unknown>;
      ocrUsed: boolean;
      mapping: DocumentMapping | null;
    }
  | {
      ok: false;
      fileName: string;
      fileSize: number;
      error: string;
    };

type PickedFile = { file: File; path: string };

// Document types that can be mapped onto the Air Waybill form. Keep in sync
// with mappingToAwbValues in lib/awb-fill.
const AWB_FILLABLE_TYPES = new Set(["dhl-iac", "dhl-sameday-ticket"]);

type FillableResult = Extract<FileResult, { ok: true }> & {
  mapping: DocumentMapping;
};

function canFillAwb(result: FileResult): result is FillableResult {
  return Boolean(
    result.ok && result.mapping && AWB_FILLABLE_TYPES.has(result.mapping.type),
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// A display path may be a nested path like "reports/q1/file.pdf"; turn it into a
// safe ".txt" download name from just the final segment.
function downloadName(path: string) {
  const leaf = path.split("/").pop() ?? path;
  return leaf.replace(/\.pdf$/i, "") + ".txt";
}

// Download name for the filled document(s) generated from a source PDF. A
// ticket yields a merged Air Waybill + IAC packet; an IAC yields the Air Waybill.
function filledFileName(path: string, mapping: DocumentMapping) {
  const leaf = path.split("/").pop() ?? path;
  const suffix =
    mapping.type === "dhl-sameday-ticket" ? "_AirWaybill_IAC" : "_AirWaybill";
  return leaf.replace(/\.pdf$/i, "") + suffix + ".pdf";
}

// Request the filled PDF for a mapping. The server returns a single PDF — for a
// ticket it's the Air Waybill and IAC certification merged into one packet.
async function fetchFilled(mapping: DocumentMapping): Promise<Blob> {
  const res = await fetch("/api/fill-awb", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapping }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to generate the document.");
  }
  return res.blob();
}

// Generate and download the filled PDF for one parsed result.
async function downloadFilledDocs(result: FillableResult) {
  const blob = await fetchFilled(result.mapping);
  downloadBlob(blob, filledFileName(result.fileName, result.mapping));
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function isPdf(file: File, path: string) {
  return file.type === "application/pdf" || path.toLowerCase().endsWith(".pdf");
}

function fromFileList(list: FileList): PickedFile[] {
  // webkitRelativePath is populated for folder (webkitdirectory) selections.
  return Array.from(list).map((file) => ({
    file,
    path: file.webkitRelativePath || file.name,
  }));
}

// --- Recursive folder traversal for drag-and-drop (File System Entry API) ---

function readEntriesBatch(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function getFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walkEntry(entry: FileSystemEntry, out: PickedFile[]) {
  if (entry.isFile) {
    const file = await getFile(entry as FileSystemFileEntry);
    out.push({ file, path: (entry.fullPath || file.name).replace(/^\//, "") });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns results in batches; keep reading until it's empty.
    let batch: FileSystemEntry[];
    do {
      batch = await readEntriesBatch(reader);
      for (const e of batch) await walkEntry(e, out);
    } while (batch.length > 0);
  }
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<FileResult[]>([]);

  // webkitdirectory isn't in React's input typings, so set it on mount.
  useEffect(() => {
    const el = folderInputRef.current;
    if (el) {
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("directory", "");
    }
  }, []);

  const handleFiles = useCallback(async (picked: PickedFile[]) => {
    if (picked.length === 0) return;
    const pdfs = picked.filter(({ file, path }) => isPdf(file, path));
    if (pdfs.length === 0) {
      setResults([]);
      setError("No PDF files found in the selection.");
      return;
    }
    setError(null);
    setResults([]);
    setLoading(true);
    try {
      const formData = new FormData();
      for (const { file, path } of pdfs) {
        formData.append("file", file);
        formData.append("path", path);
      }
      const res = await fetch("/api/parse", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      setResults(data.results as FileResult[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setLoading(false);
    }
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);

      // Collect entries synchronously — the DataTransfer list is cleared once
      // the handler yields to an await.
      const entries: FileSystemEntry[] = [];
      const items = e.dataTransfer.items;
      if (items?.length) {
        for (const item of Array.from(items)) {
          const entry = item.webkitGetAsEntry?.();
          if (entry) entries.push(entry);
        }
      }

      const picked: PickedFile[] = [];
      if (entries.length) {
        for (const entry of entries) await walkEntry(entry, picked);
      } else if (e.dataTransfer.files?.length) {
        for (const file of Array.from(e.dataTransfer.files)) {
          picked.push({ file, path: file.name });
        }
      }
      handleFiles(picked);
    },
    [handleFiles],
  );

  const [downloadingAwbs, setDownloadingAwbs] = useState(false);
  const [awbError, setAwbError] = useState<string | null>(null);

  // Every parsed fillable document can produce one or more filled forms.
  const awbResults = results.filter(canFillAwb);

  const downloadAllAwbs = useCallback(async () => {
    setDownloadingAwbs(true);
    setAwbError(null);
    let failures = 0;
    for (const r of results) {
      if (!canFillAwb(r)) continue;
      try {
        await downloadFilledDocs(r);
      } catch {
        failures++;
      }
    }
    if (failures > 0) {
      setAwbError(`${failures} document${failures > 1 ? "s" : ""} failed to generate.`);
    }
    setDownloadingAwbs(false);
  }, [results]);

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">PDF Parser</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Upload PDFs — or whole folders of them — to extract text and metadata.
          Files are parsed on the server and never stored.
        </p>
      </header>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 text-center transition ${
          dragging
            ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
            : "border-gray-300 dark:border-gray-700"
        }`}
      >
        <svg
          className="mb-3 h-10 w-10 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
          />
        </svg>
        <p className="font-medium">Drop a folder here</p>
        <p className="mt-1 mb-4 text-xs text-gray-500">
          Folders are scanned recursively · max 25 MB each · up to 500 files
        </p>

        <div className="flex gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
          >
            Browse files
          </button>
          <button
            onClick={() => folderInputRef.current?.click()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Select folder
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(fromFileList(e.target.files));
            e.target.value = "";
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(fromFileList(e.target.files));
            e.target.value = "";
          }}
        />
      </div>

      {loading && (
        <p className="mt-6 flex items-center gap-2 text-sm text-gray-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
          Parsing PDFs…
        </p>
      )}

      {error && (
        <div className="mt-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </div>
      )}

      {results.length > 0 && (
        <section className="mt-8">
          <div className="mb-4 flex items-center justify-between gap-3">
            <p className="text-sm text-gray-500">
              {okCount} parsed
              {failCount > 0 ? ` · ${failCount} failed` : ""}
              {awbResults.length > 0
                ? ` · ${awbResults.length} fillable`
                : ""}
            </p>
            <div className="flex items-center gap-2">
              {awbError && (
                <span className="text-sm text-red-600 dark:text-red-400">
                  {awbError}
                </span>
              )}
              {awbResults.length > 0 && (
                <button
                  onClick={downloadAllAwbs}
                  disabled={downloadingAwbs}
                  className="rounded-md border border-blue-600 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-60 dark:text-blue-300 dark:hover:bg-blue-950/40"
                >
                  {downloadingAwbs
                    ? "Generating…"
                    : `Download all filled forms (${awbResults.length})`}
                </button>
              )}
            </div>
          </div>

          <div className="space-y-3">
            {results.map((r, i) => (
              <FileCard key={`${r.fileName}-${i}`} result={r} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function FileCard({ result }: { result: FileResult }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [filling, setFilling] = useState(false);
  const [fillError, setFillError] = useState<string | null>(null);

  // Documents we know how to map onto the Air Waybill form.
  const fillable = canFillAwb(result);
  // Ticket → Air Waybill + IAC; IAC certification → Air Waybill only.
  const fillLabel =
    result.ok && result.mapping?.type === "dhl-sameday-ticket"
      ? "Download filled Air Waybill + IAC"
      : "Download filled Air Waybill";

  const downloadAwb = useCallback(async () => {
    if (!canFillAwb(result)) return;
    setFilling(true);
    setFillError(null);
    try {
      await downloadFilledDocs(result);
    } catch (err) {
      setFillError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setFilling(false);
    }
  }, [result]);

  const copyText = useCallback(() => {
    if (!result.ok) return;
    navigator.clipboard.writeText(result.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [result]);

  const downloadText = useCallback(() => {
    if (!result.ok) return;
    const blob = new Blob([result.text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName(result.fileName);
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  if (!result.ok) {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 dark:border-red-900 dark:bg-red-950/40">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate font-medium">{result.fileName}</span>
          <span className="shrink-0 text-xs text-gray-500">
            {formatBytes(result.fileSize)}
          </span>
        </div>
        <p className="mt-1 text-sm text-red-700 dark:text-red-400">
          {result.error}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
      <div className="flex items-center gap-2 pr-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-900"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-medium">{result.fileName}</span>
          {result.mapping && (
            <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
              {result.mapping.label}
            </span>
          )}
          {result.ocrUsed && (
            <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
              OCR
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-gray-500">
          {result.totalPages} pg · {formatBytes(result.fileSize)} ·{" "}
          {result.text.length.toLocaleString()} chars
        </span>
        <svg
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
        {fillable && (
          <button
            onClick={downloadAwb}
            disabled={filling}
            className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {filling ? "Generating…" : fillLabel}
          </button>
        )}
      </div>
      {fillError && (
        <p className="border-t border-gray-200 px-4 py-2 text-sm text-red-600 dark:border-gray-800 dark:text-red-400">
          {fillError}
        </p>
      )}

      {open && (
        <div className="border-t border-gray-200 p-4 dark:border-gray-800">
          {result.mapping && (
            <div className="mb-4">
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-sm font-semibold">
                  {result.mapping.label}
                </h3>
                <span className="text-xs text-gray-500">
                  {Math.round(result.mapping.confidence * 100)}% match
                </span>
              </div>
              <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-gray-200 bg-gray-200 text-sm sm:grid-cols-2 dark:border-gray-800 dark:bg-gray-800">
                {result.mapping.fields.map((f) => (
                  <div
                    key={f.label}
                    className="bg-white px-3 py-2 dark:bg-gray-950"
                  >
                    <dt className="text-xs text-gray-500">{f.label}</dt>
                    <dd
                      className={
                        f.value
                          ? "font-medium"
                          : "italic text-gray-400 dark:text-gray-600"
                      }
                    >
                      {f.value ?? "—"}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          <div className="mb-3 flex justify-end gap-2">
            <button
              onClick={copyText}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              onClick={downloadText}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
            >
              Download .txt
            </button>
          </div>
          <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm dark:border-gray-800 dark:bg-gray-900">
            {result.text ||
              "(No extractable text — this PDF may be made of scanned images.)"}
          </pre>
        </div>
      )}
    </div>
  );
}
