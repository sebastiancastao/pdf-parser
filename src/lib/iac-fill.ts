// Fill the DHL "Indirect Air Carrier Security Certification" (IAC) form.
//
// Unlike the Air Waybill, the IAC PDF is a flat scanned image with NO AcroForm
// fields, so we can't just set field values — we overlay text at fixed
// positions on top of the scan. The positions below were measured once, via
// OCR word boxes, from the blank DHL IAC form (a 612x792pt / US-Letter page,
// rendered at 3x). They anchor each value just to the right of its printed
// label's colon, on the same baseline.
//
// pdf-lib is server-only; it's listed in `serverExternalPackages`.

import type { DocumentMapping } from "./documents";

// Scale the OCR image was measured at (renderPageAsImage scale), and the page
// height in points. Used to map image pixels -> PDF points (origin bottom-left).
const OCR_SCALE = 3;
const PAGE_HEIGHT_PT = 792;
// A label line's text baseline sits ~30px below the line's top edge at 3x.
const BASELINE_OFFSET_PX = 30;
// Gap (pt) between the label's colon and the value we write after it.
const VALUE_GAP_PT = 8;

// Each tender field, keyed by its printed label, with the OCR-measured pixel
// position of the end of the label (the colon) and the line's top edge.
const FIELD_POSITIONS: Record<string, { colonXpx: number; topPx: number }> = {
  "Master Air Waybill": { colonXpx: 386, topPx: 1734 },
  "DHL Same Day Job #": { colonXpx: 418, topPx: 1790 },
  "Airline Tendered": { colonXpx: 351, topPx: 1844 },
  "Flight Number": { colonXpx: 320, topPx: 1898 },
  "Date Tendered": { colonXpx: 320, topPx: 1954 },
};

const px = (v: number) => v / OCR_SCALE;

/**
 * Map a DHL SameDay dispatch-ticket mapping onto the IAC tender fields, or null
 * if the document isn't a ticket. Keys match FIELD_POSITIONS labels; blank
 * ticket fields are omitted so we only write where we have data.
 */
export function ticketToIacValues(
  mapping: DocumentMapping,
): Record<string, string> | null {
  if (mapping.type !== "dhl-sameday-ticket") return null;

  const field = (label: string) =>
    mapping.fields.find((f) => f.label === label)?.value ?? null;

  const out: Record<string, string> = {};
  const set = (name: string, value: string | null) => {
    if (value) out[name] = value;
  };

  set("Master Air Waybill", field("Air Waybill Number"));
  set("DHL Same Day Job #", field("Ticket Number"));
  set("Airline Tendered", field("Carrier"));
  set("Flight Number", field("Flight Number"));
  set("Date Tendered", field("Flight Date"));

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Overlay the given tender values onto the scanned IAC form and return the saved
 * PDF bytes. Values whose label isn't a known position are skipped.
 */
export async function fillIacForm(
  pdfBytes: Uint8Array,
  values: Record<string, string>,
): Promise<{ bytes: Uint8Array; filled: string[]; skipped: string[] }> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdfBytes);
  const page = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const filled: string[] = [];
  const skipped: string[] = [];
  for (const [label, value] of Object.entries(values)) {
    const pos = FIELD_POSITIONS[label];
    if (!pos) {
      skipped.push(label);
      continue;
    }
    page.drawText(value, {
      x: px(pos.colonXpx) + VALUE_GAP_PT,
      y: PAGE_HEIGHT_PT - px(pos.topPx + BASELINE_OFFSET_PX),
      size: 11,
      font,
      color: rgb(0, 0, 0.6),
    });
    filled.push(label);
  }

  const bytes = await doc.save();
  return { bytes, filled, skipped };
}
