/**
 * One entry point for "operator handed us a file" — CSV/TSV text or an XLSX
 * workbook — producing the same `{ headers, rows }` shape either way.
 */
import { parseCsv } from "../providers/listings";
import { readSheetRows, readWorkbookInfo, type Sheet } from "../xlsx";

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export type FileRead = {
  kind: "csv" | "xlsx";
  sheets: Sheet[];
  sheetName: string | null;
  headers: string[];
  rows: Record<string, string>[];
};

const isXlsx = (buf: Buffer) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);

export function readUploadedFile(buf: Buffer, opts: { sheet?: string | number; headerRow?: number } = {}): FileRead {
  if (isXlsx(buf)) {
    const { sheets } = readWorkbookInfo(buf);
    const { name, headers, rows } = readSheetRows(buf, opts.sheet ?? 0, opts.headerRow ?? 1);
    return { kind: "xlsx", sheets, sheetName: name, headers, rows };
  }

  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);              // strip BOM
  // A tab- or semicolon-delimited export is common from government systems;
  // convert to commas only when the first line clearly uses another delimiter.
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  if (!firstLine.includes(",")) {
    if (firstLine.includes("\t")) text = text.replace(/\t/g, ",");
    else if (firstLine.includes(";")) text = text.replace(/;/g, ",");
  }
  const rows = parseCsv(text);
  const headerLine = firstLine.replace(/^"|"$/g, "");
  const headers = rows.length ? Object.keys(rows[0]) : headerLine.split(",").map((h) => h.trim());
  return { kind: "csv", sheets: [], sheetName: null, headers, rows };
}

/** Read the uploaded part of a multipart request, with a size guard. */
export async function bufferFromForm(form: FormData, field = "file"): Promise<{ buf: Buffer; name: string } | { error: string }> {
  const f = form.get(field);
  if (!f || typeof f === "string") return { error: "No file was uploaded." };
  const blob = f as File;
  if (blob.size > MAX_UPLOAD_BYTES) return { error: `File is ${(blob.size / 1048576).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1048576} MB.` };
  if (blob.size === 0) return { error: "The uploaded file is empty." };
  return { buf: Buffer.from(await blob.arrayBuffer()), name: blob.name || "upload" };
}
