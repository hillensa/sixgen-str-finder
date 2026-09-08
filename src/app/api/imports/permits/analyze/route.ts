import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin, errStatus } from "@/lib/supabase/admin";
import { readUploadedFile, bufferFromForm } from "@/lib/import/readFile";
import { suggestMapping, validateMapping, mappingWarnings, FIELD_SPECS } from "@/lib/import/columns";
import { normalizePermitRows } from "@/lib/import/permits";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/imports/permits/analyze   (multipart: file, sheet?, headerRow?)
 *
 * Step 1 of the wizard. Reads the file, lists worksheets, suggests a column
 * mapping and shows what that mapping would produce — writing nothing.
 */
export async function POST(req: Request) {
  const s = createClient();
  try { await requireAdmin(s); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });
  const got = await bufferFromForm(form);
  if ("error" in got) return NextResponse.json({ error: got.error }, { status: 400 });

  const sheetField = String(form.get("sheet") ?? "");
  const headerRow = Number(form.get("headerRow") ?? 1) || 1;

  let file;
  try {
    file = readUploadedFile(got.buf, { sheet: sheetField === "" ? undefined : (/^\d+$/.test(sheetField) ? Number(sheetField) : sheetField), headerRow });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  if (!file.headers.length) return NextResponse.json({ error: "No header row found. If the file has a title above the header, set the header row number." }, { status: 400 });

  // The operator's own mapping wins; `suggestMapping` only seeds the first pass,
  // so re-analyzing after an edit previews exactly what will be committed.
  const suggested = suggestMapping(file.headers);
  let mapping = suggested.mapping;
  const override = String(form.get("mapping") ?? "");
  if (override) {
    try { mapping = JSON.parse(override); }
    catch { return NextResponse.json({ error: "mapping must be JSON." }, { status: 400 }); }
  }
  const claimed = new Set(Object.values(mapping).filter(Boolean) as string[]);
  const unmapped = file.headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")).filter((k) => k && !claimed.has(k));
  const errors = validateMapping(mapping, file.headers);
  const preview = normalizePermitRows(file.rows.slice(0, 25), mapping);

  return NextResponse.json({
    fileName: got.name, kind: file.kind,
    sheets: file.sheets.map((x) => x.name), sheetName: file.sheetName, headerRow,
    headers: file.headers, rowCount: file.rows.length,
    sample: file.rows.slice(0, 5),
    mapping, unmapped, errors, warnings: mappingWarnings(mapping, unmapped),
    fields: FIELD_SPECS.map(({ key, label, group, hint }) => ({ key, label, group, hint })),
    preview: preview.rows.map((r) => ({
      rowNumber: r.rowNumber, addressRaw: r.addressRaw, addressNorm: r.addressNorm, unit: r.unit, zip: r.zip,
      permitNumber: r.permitNumber, strType: r.strType, permitStatus: r.permitStatus, status: r.status, errors: r.errors,
    })),
    previewCounts: preview.counts,
  });
}
