// Document classification + field mapping.
//
// Given the text of a PDF (extracted directly, or via OCR for scanned files)
// and its file name, we try to recognise *which* known document it is and pull
// a set of structured fields out of it. This is intentionally pure and
// dependency-free so it can run anywhere and be unit-tested in isolation.

export type MappedField = {
  /** Human-readable field name, e.g. "IAC Number". */
  label: string;
  /** Extracted value, or null when the field is present but blank. */
  value: string | null;
};

export type DocumentMapping = {
  /** Machine id of the matched type, e.g. "dhl-iac". */
  type: string;
  /** Human label, e.g. "DHL Indirect Air Carrier Security Certification". */
  label: string;
  /** Rough confidence in the match, 0–1. */
  confidence: number;
  /** Structured fields pulled from the document. */
  fields: MappedField[];
};

type MatchContext = { text: string; fileName: string };

type DocumentDefinition = {
  type: string;
  label: string;
  /** Returns 0–1 confidence that this context is the given document type. */
  match: (ctx: MatchContext) => number;
  /** Extracts the structured fields once a type has matched. */
  extract: (ctx: MatchContext) => MappedField[];
};

// --- Text helpers -----------------------------------------------------------

// Collapse all runs of whitespace to single spaces. Useful for matching across
// line breaks introduced by the PDF layout or OCR.
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Escape a literal string for use inside a RegExp.
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Normalise a value: trim, drop dotted/underscore form-blank fillers, and
// return null when nothing meaningful is left. OCR of a blank form field often
// leaves stray punctuation ("|", "]", "’"), so anything without a letter or
// digit is treated as blank.
function cleanValue(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw
    .replace(/[._…]+/g, " ") // dotted / underscore blanks
    .replace(/\s+/g, " ")
    .replace(/[\s,;:|]+$/, "") // trailing separators / OCR specks
    .trim();
  if (!/[A-Za-z0-9]/.test(v)) return null;
  return v.length > 0 ? v : null;
}

// Pull the description that sits between a field label and the next field label
// in a single-line "Field: description Field: description …" document.
function descBetween(
  flat: string,
  start: string,
  end: string,
): string | null {
  const sm = flat.match(new RegExp(esc(start), "i"));
  if (!sm || sm.index === undefined) return null;
  let rest = flat.slice(sm.index + sm[0].length);
  const em = rest.match(new RegExp(esc(end), "i"));
  if (em && em.index !== undefined) rest = rest.slice(0, em.index);
  // Drop the remainder of the label (any parenthetical) up to its colon.
  rest = rest.replace(/^[^:]*:/, "");
  return cleanValue(rest);
}

// Pull the text that follows a label on the same line. Works on the original
// (line-broken) text so a blank form field yields null rather than swallowing
// the next line. `label` is a regex source matched case-insensitively.
function valueAfter(text: string, label: string): string | null {
  const re = new RegExp(`${label}[^\\S\\r\\n]*:?[^\\S\\r\\n]*([^\\r\\n]*)`, "i");
  const m = text.match(re);
  return m ? cleanValue(m[1]) : null;
}

// First capture group of a pattern over the whitespace-flattened text.
function capture(text: string, re: RegExp): string | null {
  const m = flatten(text).match(re);
  return m ? cleanValue(m[1]) : null;
}

// A Yes/No checkbox field. When the box is unmarked, OCR just reads back the
// "Yes No" options — which isn't an answer, so treat it as blank.
function checkbox(text: string, label: string): string | null {
  const v = valueAfter(text, label);
  if (!v) return null;
  return /^yes\s*[\/_]?\s*no$/i.test(v.replace(/[.,;:|]/g, "").trim())
    ? null
    : v;
}

// --- Known documents --------------------------------------------------------

const DHL_IAC: DocumentDefinition = {
  type: "dhl-iac",
  label: "DHL Indirect Air Carrier Security Certification",
  match: ({ text, fileName }) => {
    const flat = flatten(text).toLowerCase();
    const name = fileName.toLowerCase();
    let score = 0;
    if (/indirect air carrier security certification/.test(flat)) score += 0.6;
    if (/d\/?b\/?a\s+dhl same day/.test(flat)) score += 0.25;
    if (/\biac\s*ne\d+/.test(flat) || /assigned by tsa is\s*ne\d+/.test(flat))
      score += 0.2;
    if (/dhl/.test(name) && /iac/.test(name)) score += 0.2;
    return Math.min(score, 1);
  },
  extract: ({ text }) => [
    {
      label: "IAC Number",
      value:
        capture(text, /assigned by tsa is\s*([A-Z]{2}\d+)/i) ??
        capture(text, /\bIAC\s*([A-Z]{2}\d+)/i),
    },
    {
      label: "Carrier",
      // OCR mangles the punctuation ("Inc ,"), so normalise to the canonical
      // name whenever the carrier is present.
      value: capture(text, /(Sky Courier Inc[\s.,]*d\/?b\/?a\s*DHL Same Day)/i)
        ? "Sky Courier Inc., d/b/a DHL Same Day"
        : null,
    },
    {
      label: "Revision",
      value: capture(text, /(CHANGE\s*\d+\s*[–\-]\s*[A-Za-z]+\s*\d{4})/i),
    },
    {
      label: "Items under 16 oz (453.6 g)",
      value: checkbox(text, "453\\.6\\s*grams\\)\\?"),
    },
    {
      label: "Authorized Representative / Driver's Name",
      value: valueAfter(text, "Driver'?s Name \\(printed\\)"),
    },
    { label: "Employer / Company Name", value: valueAfter(text, "Employer/?Company Name") },
    {
      label: "Evidence of TSA Certification",
      value: checkbox(text, "SIDA Badge, etc\\.\\):"),
    },
    { label: "Master Air Waybill", value: valueAfter(text, "Master Air Waybill") },
    { label: "DHL Same Day Job #", value: valueAfter(text, "DHL Same Day Job #") },
    { label: "Airline Tendered", value: valueAfter(text, "Airline Tendered") },
    { label: "Flight Number", value: valueAfter(text, "Flight Number") },
    { label: "Date Tendered", value: valueAfter(text, "Date Tendered") },
  ],
};

const AWB_GUIDE: DocumentDefinition = {
  type: "awb-guide",
  label: "Air Waybill Completion Guide",
  match: ({ text, fileName }) => {
    const flat = flatten(text).toLowerCase();
    const name = fileName.toLowerCase();
    let score = 0;
    if (/guide to completing a paper air waybill/.test(flat)) score += 0.7;
    if (/master air waybill|shipper'?s account number/.test(flat)) score += 0.2;
    if (/airwaybill|air waybill|awb/.test(name)) score += 0.2;
    return Math.min(score, 1);
  },
  // The guide is one long "Field name: description Field name: description …"
  // run. Pull each field's description as the text up to the next field's label.
  extract: ({ text }) => {
    const flat = flatten(text);
    // Ordered as they appear; the trailing entry is only a boundary sentinel.
    const fields = [
      "Shippers account number",
      "Shipper’s Name and Address",
      "Consignee’s Name and Address",
      "Airport of Departure",
      "Airport of Destination",
      "Declared Value for Carriage",
      "Accounting Information",
      "Handling Information",
      "No. of Pieces RCP",
      "Gross Weight",
      "Nature and Quantity of Goods",
      "Signature of Shipper", // boundary only
    ];
    return fields.slice(0, -1).map((label, i) => ({
      label: label.replace(/’/g, "'"),
      value: descBetween(flat, label, fields[i + 1]),
    }));
  },
};

const DEFINITIONS: DocumentDefinition[] = [DHL_IAC, AWB_GUIDE];

const MIN_CONFIDENCE = 0.5;

/**
 * Identify the document type and map its fields. Returns null when nothing
 * matches confidently enough.
 */
export function classifyAndMap(
  text: string,
  fileName: string,
): DocumentMapping | null {
  const ctx: MatchContext = { text, fileName };

  let best: { def: DocumentDefinition; score: number } | null = null;
  for (const def of DEFINITIONS) {
    const score = def.match(ctx);
    if (!best || score > best.score) best = { def, score };
  }

  if (!best || best.score < MIN_CONFIDENCE) return null;

  return {
    type: best.def.type,
    label: best.def.label,
    confidence: Math.round(best.score * 100) / 100,
    fields: best.def.extract(ctx),
  };
}
