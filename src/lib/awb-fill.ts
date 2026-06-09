// Fill the Air Waybill (AWB) AcroForm on page 3 of the airway-bill PDF using
// data mapped from another document (currently the DHL IAC certification).
//
// pdf-lib is server-only; it's listed in `serverExternalPackages`.

import type { DocumentMapping } from "./documents";

const SOUTHWEST_ACCOUNT_NO = "30021-015";

// The Air Waybill is tendered by the Indirect Air Carrier, so the shipper of
// record is Sky Courier (DHL Same Day) — not the pickup customer — and the
// shipper's account-number blank carries the IAC account number together with
// DHL's reference number for the job (both sit in that one box on the form).
const SKY_COURIER_SHIPPER =
  "SKY COURIER\n21240 RIDGE TOP CIRCLE\nSTERLING, VA 20166\nUS +1 (800) 336-3344";
const SKY_COURIER_ACCOUNT_NO = "30021-15";

// Look up a mapped field's value by label, returning null when absent/blank.
function field(mapping: DocumentMapping, label: string): string | null {
  return mapping.fields.find((f) => f.label === label)?.value ?? null;
}

/**
 * Translate a DHL IAC document mapping into AWB AcroForm field values.
 * Keys are the exact AcroForm field names found on the AWB form (page 3);
 * blank IAC fields are omitted so the form is only filled where we have data.
 */
export function iacToAwbValues(
  mapping: DocumentMapping,
): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (name: string, value: string | null | undefined) => {
    if (value) out[name] = value;
  };

  const carrier = field(mapping, "Carrier");
  const iac = field(mapping, "IAC Number");

  // Southwest uses a fixed customer account number on the AWB regardless of
  // which source document we mapped from.
  set("Issuing Carriers Agent Name and City", carrier);
  set("Account No", SOUTHWEST_ACCOUNT_NO);

  // Pass through any IAC tender fields that happen to be filled in.
  set("Air Waybill Number", field(mapping, "Master Air Waybill"));
  set("Reference Number", field(mapping, "DHL Same Day Job #"));
  set("By First Carrier", field(mapping, "Airline Tendered"));
  set("Flight Date", field(mapping, "Date Tendered"));

  // Summarise the IAC tender context in the free-text handling box.
  const handling: string[] = [];
  if (carrier || iac) {
    handling.push(
      `Tendered by Indirect Air Carrier: ${carrier ?? "DHL Same Day"}` +
        (iac ? ` (IAC ${iac})` : ""),
    );
  }
  const under16 = field(mapping, "Items under 16 oz (453.6 g)");
  if (under16) handling.push(`Items under 16 oz: ${under16}`);
  set("Handling Information", handling.join(" | "));

  return out;
}

/**
 * Translate a DHL SameDay dispatch-ticket mapping into AWB AcroForm field
 * values. The ticket carries the full shipment, so it populates the shipper,
 * consignee, routing, cargo and handling boxes directly. Keys are the exact
 * AcroForm field names on the AWB form (page 3); blank ticket fields are omitted.
 */
export function ticketToAwbValues(
  mapping: DocumentMapping,
): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (name: string, value: string | null | undefined) => {
    if (value) out[name] = value;
  };

  set("Air Waybill Number", field(mapping, "Air Waybill Number"));
  // Shipper of record is the IAC (Sky Courier), not the pickup customer.
  set("Shipper Name and Address", SKY_COURIER_SHIPPER);
  // The shipper's account-number blank carries the IAC account number only.
  set("Shippers Account Number", SKY_COURIER_ACCOUNT_NO);
  set("Consignee Name and Address", field(mapping, "Consignee Name and Address"));
  set("Issuing Carriers Agent Name and City", field(mapping, "Issuing Agent"));

  const carrier = field(mapping, "Carrier");
  set("Carrier1", carrier);
  const origin = field(mapping, "Origin Airport");
  const dest = field(mapping, "Destination Airport");
  set("Airport of Departure", origin);
  set("Airport of Destination", dest);

  // Requested routing, leg by leg. A connecting itinerary (e.g. ATL→MDW→SFO)
  // fills the second and third carrier boxes; a direct flight fills only the
  // first. Parsed from the "Routing" field; falls back to a single
  // origin→destination leg when that detail isn't available.
  const routing = field(mapping, "Routing");
  const legs = routing
    ? [...routing.matchAll(/([A-Z]{3})-([A-Z]{3})\s+([A-Z]{2})\s+\S+/g)].map(
        (m) => ({ des: m[2], by: m[3] }),
      )
    : [];
  if (legs.length === 0 && dest && carrier) legs.push({ des: dest, by: carrier });
  const legBoxes: Array<[string, string]> = [
    ["To", "By First Carrier"],
    ["to", "by"],
    ["to_2", "by_2"],
  ];
  legs.slice(0, legBoxes.length).forEach((leg, i) => {
    set(legBoxes[i][0], leg.des);
    set(legBoxes[i][1], leg.by);
  });

  set("Flight Date", field(mapping, "Flight Date"));

  set("Reference Number", field(mapping, "Reference Number"));
  const ticket = field(mapping, "Ticket Number");
  if (ticket) set("Accounting Information", `DHL Same Day Ticket# ${ticket}`);

  // Piece count, gross weight and chargeable weight are left blank on the
  // Southwest AWB (filled in by the carrier at acceptance).
  const pieces = field(mapping, "Pieces");

  // Goods description, with part/qty/dimensions where present.
  const description = field(mapping, "Description");
  if (description) {
    const part = field(mapping, "Part Number");
    const dims = field(mapping, "Dimensions (in)");
    const detail = [
      part && `Part# ${part}`,
      pieces && `Qty ${pieces}`,
      dims && `${dims} in`,
    ].filter(Boolean);
    set(
      "Nature and Quantity of Goods",
      detail.length ? `${description}\n${detail.join(" · ")}` : description,
    );
  }

  set(
    "Handling Information",
    `Tendered by DHL Same Day${carrier ? ` (PreBooked ${carrier})` : ""}. ` +
      "STA APPROVED – DRIVERS ONLY. MUST CHECK ID AT PICK UP.",
  );

  return out;
}

/**
 * Translate a recognised document mapping into AWB AcroForm field values, or
 * null when the document type can't fill an Air Waybill.
 */
export function mappingToAwbValues(
  mapping: DocumentMapping,
): Record<string, string> | null {
  switch (mapping.type) {
    case "dhl-iac":
      return iacToAwbValues(mapping);
    case "dhl-sameday-ticket":
      return ticketToAwbValues(mapping);
    default:
      return null;
  }
}

/**
 * Fill the AWB AcroForm with the given field values and return only the filled
 * Air Waybill page. The source template carries introductory pages ahead of the
 * actual form, and Southwest output should omit those. Unknown or non-text
 * fields are skipped rather than throwing, so a slightly different AWB
 * template won't break the fill.
 */
export async function fillAwbForm(
  pdfBytes: Uint8Array,
  values: Record<string, string>,
): Promise<{ bytes: Uint8Array; filled: string[]; skipped: string[] }> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdfBytes);
  const form = doc.getForm();

  const filled: string[] = [];
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    try {
      const tf = form.getTextField(name);
      tf.setText(value);
      filled.push(name);
    } catch {
      skipped.push(name);
    }
  }

  // Keep the typed-in values visible in viewers that don't regenerate
  // appearances, without locking the form.
  form.updateFieldAppearances();

  // The actual AWB AcroForm is page 3 of the template; flatten the form and
  // return just that page so generated Southwest packets don't include the two
  // preceding instruction/content pages.
  form.flatten();
  const out = await PDFDocument.create();
  const awbPageIndex = Math.min(2, doc.getPageCount() - 1);
  const [page] = await out.copyPages(doc, [awbPageIndex]);
  out.addPage(page);

  // Mark the prepaid charge boxes with an "X", as on the properly-completed
  // Southwest AWB: the WT/VAL and Other charges are both prepaid (CHGS Code
  // "PP"), so each gets an X in its PPD column. The Other-PPD box has no
  // AcroForm field, so both marks are drawn as an overlay at the box centres
  // (page-3 coordinates, PDF points, bottom-left origin).
  const xFont = await out.embedFont(StandardFonts.HelveticaBold);
  for (const x of [364.2, 392.9]) {
    page.drawText("X", { x, y: 501, size: 10, font: xFont, color: rgb(0, 0, 0) });
  }

  const bytes = await out.save();
  return { bytes, filled, skipped };
}
