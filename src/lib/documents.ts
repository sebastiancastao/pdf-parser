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

// Convert a "YY/MM/DD" routing date (e.g. "26/06/08") to ISO "20YY-MM-DD".
function isoFromYYMMDD(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/(\d{2})\/(\d{2})\/(\d{2})/);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : raw;
}

// Build a multi-line "Name / street / city / Attn" address from the lines that
// follow an "Address" label on the dispatch ticket, appending the phone. Unlike
// cleanValue this preserves line breaks (AWB address boxes are multi-line) and
// strips a trailing e-mail that OCR/extraction leaves on the Attn line.
function composeAddress(block: string | undefined, phone?: string): string | null {
  if (!block) return null;
  const lines = block
    .split("\n")
    .map((l) => l.replace(/\s+[\w.+-]+@[\w.-]+\b.*$/, "").trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return phone ? `${lines.join("\n")}\nTel: ${phone}` : lines.join("\n");
}

// A DHL SameDay / Sky Courier dispatch & routing ticket. Unlike the IAC
// certification this carries the full shipment (shipper, consignee, routing,
// AWB number), so it maps directly onto the Air Waybill form.
const DHL_SAMEDAY_TICKET: DocumentDefinition = {
  type: "dhl-sameday-ticket",
  label: "DHL SameDay Dispatch Ticket",
  match: ({ text }) => {
    const flat = flatten(text).toLowerCase();
    let score = 0;
    if (/dhl\s*sameday\/sky courier/.test(flat)) score += 0.5;
    if (/ticket#\s*\d+/.test(flat)) score += 0.2;
    if (/air waybill#:\s*\d+/.test(flat)) score += 0.2;
    if (/routing info/.test(flat)) score += 0.1;
    return Math.min(score, 1);
  },
  extract: ({ text }) => {
    // Pickup/delivery address blocks: the lines after each "Address" label up to
    // the next blank line, with their phones (in document order).
    const blocks = [...text.matchAll(/Address\s+([\s\S]*?)(?=\n[ \t]*\n)/g)].map(
      (m) => m[1],
    );
    const phones = [
      ...text.matchAll(/Phone\s*(\(\d{3}\)\s*\d{3}-?\d{4})/g),
    ].map((m) => m[1]);

    // Routing leg: "ORIG CARRIER FLT DATE ETD ETA DEST" on a single line.
    const route = text.match(
      /^([A-Z]{3})\s+([A-Z]{2})\s+(\w+)\s+(\d{2}\/\d{2}\/\d{2})\s+\d{1,2}:\d{2}\s+\d{1,2}:\d{2}\s+([A-Z]{3})/m,
    );

    // Totals row: "Total <pcs> <wgt> <len> <wid> <hgt>".
    const totals = text.match(
      /Total\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/,
    );

    // Issuing agent city/state from the header banner.
    const agentCity = capture(
      text,
      /Sky Courier\s*-\s*[^-]*-\s*([A-Za-z .]+,\s*[A-Z]{2})/i,
    );

    return [
      { label: "Air Waybill Number", value: capture(text, /AIR WAYBILL#:\s*(\d+)/i) },
      { label: "Ticket Number", value: capture(text, /Ticket#\s*(\d+)/i) },
      { label: "Customer", value: valueAfter(text, "Cust Name") },
      { label: "Reference Number", value: capture(text, /Reference#\s*(\d+)/i) },
      { label: "Description", value: valueAfter(text, "Description") },
      { label: "Pieces", value: totals ? totals[1] : null },
      { label: "Gross Weight (lb)", value: totals ? totals[2] : null },
      {
        label: "Dimensions (in)",
        value: totals ? `${totals[3]} x ${totals[4]} x ${totals[5]}` : null,
      },
      {
        label: "Shipper Name and Address",
        value: composeAddress(blocks[0], phones[0]),
      },
      {
        label: "Consignee Name and Address",
        value: composeAddress(blocks[1], phones[1]),
      },
      { label: "Origin Airport", value: route ? route[1] : null },
      { label: "Destination Airport", value: route ? route[5] : null },
      { label: "Carrier", value: route ? route[2] : null },
      { label: "Flight Number", value: route ? route[3] : null },
      { label: "Flight Date", value: route ? isoFromYYMMDD(route[4]) : null },
      {
        label: "Issuing Agent",
        value: agentCity ? `DHL SameDay / Sky Courier, ${agentCity}` : null,
      },
      { label: "Part Number", value: capture(text, /\b(\d{4}-\d{4}-\d{4})\b/) },
    ];
  },
};

const DEFINITIONS: DocumentDefinition[] = [
  DHL_IAC,
  AWB_GUIDE,
  DHL_SAMEDAY_TICKET,
];

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
