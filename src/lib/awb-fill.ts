// Fill the Air Waybill (AWB) AcroForm on page 3 of the airway-bill PDF using
// data mapped from another document (currently the DHL IAC certification).
//
// pdf-lib is server-only; it's listed in `serverExternalPackages`.

import type { DocumentMapping } from "./documents";

const SOUTHWEST_ACCOUNT_NO = "30021-015";

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
  set("Shipper Name and Address", field(mapping, "Shipper Name and Address"));
  set("Consignee Name and Address", field(mapping, "Consignee Name and Address"));
  set("Issuing Carriers Agent Name and City", field(mapping, "Issuing Agent"));
  set("Account No", SOUTHWEST_ACCOUNT_NO);

  const carrier = field(mapping, "Carrier");
  set("Carrier1", carrier);
  const origin = field(mapping, "Origin Airport");
  const dest = field(mapping, "Destination Airport");
  set("Airport of Departure", origin);
  set("Airport of Destination", dest);
  // First routing leg: To <destination>  By <first carrier>.
  set("To", dest);
  set("By First Carrier", carrier);
  set("Flight Date", field(mapping, "Flight Date"));

  set("Reference Number", field(mapping, "Reference Number"));
  const ticket = field(mapping, "Ticket Number");
  if (ticket) set("Accounting Information", `DHL Same Day Ticket# ${ticket}`);

  const pieces = field(mapping, "Pieces");
  const weight = field(mapping, "Gross Weight (lb)");
  set("No of Pieces RCPRow1", pieces);
  set("Gross W eightRow1", weight);
  set("Chargeable W eightRow1", weight);
  if (weight) set("kg lbRow1", "lb");

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
  const { PDFDocument } = await import("pdf-lib");
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

  const bytes = await out.save();
  return { bytes, filled, skipped };
}
