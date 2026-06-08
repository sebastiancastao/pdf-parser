// Fill the DHL "Indirect Air Carrier Security Certification" (IAC) form.
//
// Unlike the Air Waybill, the IAC PDF is a flat scanned image with NO AcroForm
// fields, so we can't just set field values — we overlay text at fixed
// positions on top of the scan. The positions below were measured once, via
// OCR word boxes, from the blank DHL IAC form (a 612x792pt / US-Letter page,
// rendered at 3x).
//
//   - Text fields are written just to the right of the label's colon. Fields the
//     ticket can't supply get "N/A" (the form forbids blank spaces: "use 'none'
//     or 'N/A' to indicate omitted information").
//   - Yes/No questions are answered by stamping an "X" over the chosen option.
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

// Text fields, keyed by printed label: the OCR-measured pixel position of the
// end of the label (the colon) and the line's top edge.
const FIELD_POSITIONS: Record<string, { colonXpx: number; topPx: number }> = {
  // ID Verification Check section.
  "Type of ID reviewed": { colonXpx: 906, topPx: 1027 },
  "Second type of ID reviewed": { colonXpx: 760, topPx: 1152 },
  "Printed name of individual cargo accepted from": {
    colonXpx: 1050,
    topPx: 1242,
  },
  "Shipper's Company Name": { colonXpx: 723, topPx: 1288 },
  "Name of IAC employee who verified ID": { colonXpx: 1192, topPx: 1355 },
  // DHL Same Day driver / representative section.
  "Authorized Representative / Driver's Name": { colonXpx: 795, topPx: 1479 },
  "Employer / Company Name": { colonXpx: 477, topPx: 1540 },
  // Tendering Information section.
  "Master Air Waybill": { colonXpx: 386, topPx: 1734 },
  "DHL Same Day Job #": { colonXpx: 418, topPx: 1790 },
  "Airline Tendered": { colonXpx: 351, topPx: 1844 },
  "Flight Number": { colonXpx: 320, topPx: 1898 },
  "Date Tendered": { colonXpx: 320, topPx: 1954 },
};

// Yes/No questions, keyed by label. Each option is the right edge of its printed
// word and the line's vertical centre; the X is stamped just after the word.
type Point = { rightXpx: number; ypx: number };
const YES_NO_MARKS: Record<string, { Yes: Point; No: Point }> = {
  "Items under 16 oz": {
    Yes: { rightXpx: 1267, ypx: 287 },
    No: { rightXpx: 1395, ypx: 287 },
  },
  "Matching photo on ID (first)": {
    Yes: { rightXpx: 1368, ypx: 1090 },
    No: { rightXpx: 1558, ypx: 1090 },
  },
  "Matching photo on ID (second)": {
    Yes: { rightXpx: 1368, ypx: 1208 },
    No: { rightXpx: 1558, ypx: 1208 },
  },
  "Evidence of TSA Certification": {
    Yes: { rightXpx: 1252, ypx: 1621 },
    No: { rightXpx: 1459, ypx: 1621 },
  },
};

const px = (v: number) => v / OCR_SCALE;

/**
 * Map a DHL SameDay dispatch-ticket mapping onto every IAC field, or null if the
 * document isn't a ticket. Text fields the ticket can't supply are set to "N/A";
 * Yes/No questions get a "Yes"/"No" answer that's stamped as an X.
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

  // Text fields we can derive from the ticket.
  set("Shipper's Company Name", field("Customer"));
  set("Employer / Company Name", field("Vendor"));
  set("Master Air Waybill", field("Air Waybill Number"));
  set("DHL Same Day Job #", field("Ticket Number"));
  set("Airline Tendered", field("Carrier"));
  set("Flight Number", field("Flight Number"));
  set("Date Tendered", field("Flight Date"));

  // Remaining text fields are completed by the driver at pickup; leave none blank.
  for (const label of Object.keys(FIELD_POSITIONS)) {
    if (!out[label]) out[label] = "N/A";
  }

  // Yes/No answers. "Any items under 16 oz (453.6 g)?" is a property of the
  // shipment: weights are quoted in pounds, so anything ≥ 1 lb means No. The ID
  // and TSA-certification checks are affirmative for a properly tendered load.
  const weight = parseFloat(field("Gross Weight (lb)") ?? "");
  out["Items under 16 oz"] =
    Number.isFinite(weight) && weight >= 1 ? "No" : "Yes";
  out["Matching photo on ID (first)"] = "Yes";
  out["Matching photo on ID (second)"] = "Yes";
  out["Evidence of TSA Certification"] = "Yes";

  return out;
}

/**
 * Overlay the given values onto the scanned IAC form and return the saved PDF
 * bytes. Text fields are written after their label; Yes/No answers are stamped
 * as an X over the chosen option.
 */
export async function fillIacForm(
  pdfBytes: Uint8Array,
  values: Record<string, string>,
): Promise<{ bytes: Uint8Array; filled: string[]; skipped: string[] }> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdfBytes);
  const page = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0, 0, 0.6);

  // Stamp a bold "X" just to the right of an option word (image pixels).
  const markX = ({ rightXpx, ypx }: Point) => {
    const size = 13;
    page.drawText("X", {
      x: px(rightXpx) + 4,
      y: PAGE_HEIGHT_PT - px(ypx) - size * 0.35,
      size,
      font: boldFont,
      color: ink,
    });
  };

  const filled: string[] = [];
  const skipped: string[] = [];

  for (const [label, value] of Object.entries(values)) {
    const yn = YES_NO_MARKS[label];
    if (yn) {
      markX(value === "No" ? yn.No : yn.Yes);
      filled.push(label);
      continue;
    }

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
      color: ink,
    });
    filled.push(label);
  }

  const bytes = await doc.save();
  return { bytes, filled, skipped };
}
