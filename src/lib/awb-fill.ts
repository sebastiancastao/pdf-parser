// Fill the Air Waybill (AWB) AcroForm on page 3 of the airway-bill PDF using
// data mapped from another document (currently the DHL IAC certification).
//
// pdf-lib is server-only; it's listed in `serverExternalPackages`.

import type { DocumentMapping } from "./documents";

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

  // The indirect air carrier on the IAC certification is the issuing agent that
  // tenders the cargo, and its TSA-assigned number stands in for the account.
  set("Issuing Carriers Agent Name and City", carrier);
  set("Account No", iac);

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
 * Fill the AWB AcroForm with the given field values and return the saved PDF
 * bytes. Unknown or non-text fields are skipped rather than throwing, so a
 * slightly different AWB template won't break the fill.
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

  const bytes = await doc.save();
  return { bytes, filled, skipped };
}
