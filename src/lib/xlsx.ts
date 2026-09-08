/**
 * Minimal XLSX reader — enough to read a government spreadsheet, no dependency.
 *
 * The ORR-2026-1259 file is an .xlsx with three year-tabs whose columns differ
 * per tab, so the wizard has to list sheets and let the operator pick one.
 * Pulling in a full spreadsheet library for that is not worth the supply-chain
 * surface; ZIP + inflate + a few tag scans is ~150 lines and runs server-side
 * only (node:zlib).
 *
 * Supports: shared strings, inline strings, formula results, sparse rows,
 * and columns past Z. Does NOT support: styles/number formats (dates arrive as
 * Excel serials — `parseDate` in import/columns.ts handles that), or the older
 * binary .xls format.
 */
import { inflateRawSync } from "node:zlib";

type ZipEntry = { name: string; data: Buffer };

/** Read the central directory and inflate every entry we care about. */
function unzip(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>();

  // End of central directory: signature 0x06054b50, scanned from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsx file (no ZIP end-of-central-directory record).");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (!want(name)) continue;
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    try {
      out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    } catch {
      throw new Error(`Could not decompress ${name} — the file may be corrupt or password-protected.`);
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(parseInt(e[1] === "x" || e[1] === "X" ? e.slice(2) : e.slice(1), e[1] === "x" || e[1] === "X" ? 16 : 10)) : ENTITIES[e] ?? _);

/** Concatenated <t> runs inside one <si> / <is> element. */
const textOf = (xml: string) => {
  let s = "";
  for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) s += decode(m[1] ?? "");
  return s;
};

const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

export type Sheet = { name: string; path: string };

function sheetList(files: Map<string, Buffer>): Sheet[] {
  const wb = files.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) target.set(m[1], m[2]);
  for (const m of rels.matchAll(/<Relationship\b[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g)) if (!target.has(m[2])) target.set(m[2], m[1]);

  const out: Sheet[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const tag = m[0];
    const name = decode(tag.match(/\bname="([^"]*)"/)?.[1] ?? `Sheet${out.length + 1}`);
    const rid = tag.match(/r:id="([^"]+)"/)?.[1];
    let t = (rid && target.get(rid)) || `worksheets/sheet${out.length + 1}.xml`;
    t = t.replace(/^\/?xl\//, "").replace(/^\//, "");
    out.push({ name, path: `xl/${t}` });
  }
  return out;
}

export type WorkbookInfo = { sheets: Sheet[] };

/** Sheet names only — the wizard shows these before anything is parsed. */
export function readWorkbookInfo(buf: Buffer): WorkbookInfo {
  const files = unzip(buf, (n) => n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels");
  const sheets = sheetList(files);
  if (!sheets.length) throw new Error("No worksheets found in this workbook.");
  return { sheets };
}

/**
 * Read one sheet as a matrix of strings. `sheet` is a name or a 0-based index;
 * omitted → the first sheet.
 */
export function readSheetMatrix(buf: Buffer, sheet?: string | number): { name: string; rows: string[][] } {
  const files = unzip(buf, (n) => n.startsWith("xl/") && (n.endsWith(".xml") || n.endsWith(".rels")));
  const sheets = sheetList(files);
  if (!sheets.length) throw new Error("No worksheets found in this workbook.");

  const chosen =
    typeof sheet === "number" ? sheets[sheet]
    : typeof sheet === "string" ? sheets.find((s) => s.name === sheet) ?? sheets.find((s) => s.name.toLowerCase() === sheet.toLowerCase())
    : sheets[0];
  if (!chosen) throw new Error(`Sheet "${sheet}" not found. Available: ${sheets.map((s) => s.name).join(", ")}`);
  const xml = files.get(chosen.path)?.toString("utf8");
  if (!xml) throw new Error(`Sheet "${chosen.name}" could not be read from the workbook.`);

  const shared: string[] = [];
  const ss = files.get("xl/sharedStrings.xml")?.toString("utf8");
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));

  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNum = Number(rm[1].match(/\br="(\d+)"/)?.[1] ?? rows.length + 1);
    const cells: string[] = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const idx = ref ? colIndex(ref) : cells.length;
      const t = attrs.match(/\bt="([^"]+)"/)?.[1];
      let v = "";
      if (t === "inlineStr") v = textOf(inner);
      else {
        const raw = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
        if (t === "s") v = shared[Number(raw)] ?? "";
        else if (t === "b") v = raw === "1" ? "TRUE" : "FALSE";
        else if (t === "e") v = "";                       // error cell → empty
        else v = decode(raw);
      }
      while (cells.length < idx) cells.push("");
      cells[idx] = v.trim();
    }
    while (rows.length < rowNum - 1) rows.push([]);
    rows[rowNum - 1] = cells;
  }
  return { name: chosen.name, rows };
}

/**
 * Sheet → objects keyed by normalized header, matching the shape `parseCsv`
 * produces so both file types feed one pipeline.
 * `headerRow` is 1-based; government files often have a title row above the header.
 */
export function readSheetRows(buf: Buffer, sheet?: string | number, headerRow = 1): { name: string; headers: string[]; rows: Record<string, string>[] } {
  const { name, rows } = readSheetMatrix(buf, sheet);
  const nonEmpty = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.some((c) => c !== ""));
  if (!nonEmpty.length) return { name, headers: [], rows: [] };

  const hdrAt = headerRow > 1 ? rows[headerRow - 1] ?? [] : nonEmpty[0].r;
  const startIdx = headerRow > 1 ? headerRow : nonEmpty[0].i + 1;
  const headers = hdrAt.map((h) => String(h ?? "").trim());
  const keys = headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));

  const out: Record<string, string>[] = [];
  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i] ?? [];
    if (!r.some((c) => c !== "")) continue;
    const o: Record<string, string> = {};
    keys.forEach((k, ci) => { if (k) o[k] = (r[ci] ?? "").trim(); });
    out.push(o);
  }
  return { name, headers, rows: out };
}
