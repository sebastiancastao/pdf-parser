import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentMapping } from "@/lib/documents";
import { mappingToAwbValues, fillAwbForm } from "@/lib/awb-fill";
import { ticketToIacValues, fillIacForm } from "@/lib/iac-fill";
import { mergePdfs } from "@/lib/pdf-merge";

// pdf-lib needs the Node.js runtime.
export const runtime = "nodejs";

// Blank templates live in /public so they're bundled with the app.
const AWB_TEMPLATE_PATH = join(process.cwd(), "public", "awb-template.pdf");
const IAC_TEMPLATE_PATH = join(process.cwd(), "public", "iac-template.pdf");

export async function POST(req: NextRequest) {
  let mapping: DocumentMapping;
  try {
    const body = await req.json();
    mapping = body.mapping;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const awbValues = mapping ? mappingToAwbValues(mapping) : null;
  if (!awbValues) {
    return NextResponse.json(
      {
        error:
          "Filling is only supported for DHL IAC and DHL SameDay ticket documents.",
      },
      { status: 400 },
    );
  }

  try {
    // 1) Fill the Air Waybill.
    const awbTemplate = new Uint8Array(await readFile(AWB_TEMPLATE_PATH));
    const awb = await fillAwbForm(awbTemplate, awbValues);
    const parts: Uint8Array[] = [awb.bytes];

    // 2) A DHL SameDay ticket also fills the IAC certification — append it so
    // the download is a single merged packet (Air Waybill + IAC).
    const iacValues = ticketToIacValues(mapping);
    if (iacValues) {
      const iacTemplate = new Uint8Array(await readFile(IAC_TEMPLATE_PATH));
      const iac = await fillIacForm(iacTemplate, iacValues);
      parts.push(iac.bytes);
    }

    const merged =
      parts.length > 1 ? await mergePdfs(parts) : awb.bytes;

    // Hand back a plain ArrayBuffer slice — a valid BodyInit regardless of the
    // Uint8Array's backing buffer type.
    const body = merged.buffer.slice(
      merged.byteOffset,
      merged.byteOffset + merged.byteLength,
    ) as ArrayBuffer;
    return new NextResponse(body, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="Documents_filled.pdf"',
      },
    });
  } catch (err) {
    console.error("Document fill failed:", err);
    return NextResponse.json(
      { error: "Failed to generate the filled documents." },
      { status: 500 },
    );
  }
}
