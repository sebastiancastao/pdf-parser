import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentMapping } from "@/lib/documents";
import { mappingToAwbValues, fillAwbForm } from "@/lib/awb-fill";

// pdf-lib needs the Node.js runtime.
export const runtime = "nodejs";

// The blank Air Waybill template lives in /public so it's bundled with the app.
const TEMPLATE_PATH = join(process.cwd(), "public", "awb-template.pdf");

export async function POST(req: NextRequest) {
  let mapping: DocumentMapping;
  try {
    const body = await req.json();
    mapping = body.mapping;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const values = mapping ? mappingToAwbValues(mapping) : null;
  if (!values) {
    return NextResponse.json(
      {
        error:
          "Filling is only supported for DHL IAC and DHL SameDay ticket documents.",
      },
      { status: 400 },
    );
  }

  try {
    const template = new Uint8Array(await readFile(TEMPLATE_PATH));
    const { bytes } = await fillAwbForm(template, values);

    // Hand back a plain ArrayBuffer slice — a valid BodyInit regardless of the
    // Uint8Array's backing buffer type.
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return new NextResponse(body, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition":
          'attachment; filename="Air_Waybill_filled.pdf"',
      },
    });
  } catch (err) {
    console.error("AWB fill failed:", err);
    return NextResponse.json(
      { error: "Failed to generate the filled Air Waybill." },
      { status: 500 },
    );
  }
}
