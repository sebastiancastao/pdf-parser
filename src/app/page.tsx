"use client";

import { useCallback, useRef, useState } from "react";

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

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function baseName(name: string) {
  return name.replace(/\.pdf$/i, "");
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<FileResult[]>([]);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setError(null);
    setResults([]);
    setLoading(true);
    try {
      const formData = new FormData();
      for (const file of list) formData.append("file", file);
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
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const downloadAll = useCallback(() => {
    for (const r of results) {
      if (!r.ok) continue;
      const blob = new Blob([r.text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = baseName(r.fileName) + ".txt";
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [results]);

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">PDF Parser</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Upload one or more PDFs to extract their text and metadata. Files are
          parsed on the server and never stored.
        </p>
      </header>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 text-center transition ${
          dragging
            ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
            : "border-gray-300 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-600"
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
        <p className="font-medium">
          Drop PDFs here, or <span className="text-blue-600">browse</span>
        </p>
        <p className="mt-1 text-xs text-gray-500">
          Multiple files supported · max 25 MB each
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(e.target.files);
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
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-gray-500">
              {okCount} parsed
              {failCount > 0 ? ` · ${failCount} failed` : ""}
            </p>
            {okCount > 0 && (
              <button
                onClick={downloadAll}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
              >
                Download all .txt
              </button>
            )}
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
    a.download = baseName(result.fileName) + ".txt";
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
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-900"
      >
        <span className="min-w-0 flex-1 truncate font-medium">
          {result.fileName}
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

      {open && (
        <div className="border-t border-gray-200 p-4 dark:border-gray-800">
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
