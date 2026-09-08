import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readWorkbookInfo, readSheetRows, readSheetMatrix } from "../src/lib/xlsx";
import { suggestMapping } from "../src/lib/import/columns";

/**
 * Builds a real (if minimal) .xlsx in memory so the reader is exercised against
 * actual ZIP + OOXML bytes rather than a stub. CRC fields are left zero — the
 * reader does not verify them, and doing so here would only test node's zlib.
 */
function xlsx(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, "utf8");
    const comp = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(0, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  const n = Object.keys(files).length;
  eocd.writeUInt16LE(n, 8); eocd.writeUInt16LE(n, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

const SHARED = ["Street Number", "Street Name", "Suffix", "Hosted/Unhosted", "Cindy Blair", "Way", "Unhosted"];

const BOOK = xlsx({
  "xl/workbook.xml":
    `<?xml version="1.0"?><workbook><sheets>` +
    `<sheet name="2026" sheetId="1" r:id="rId1"/><sheet name="2024" sheetId="2" r:id="rId2"/>` +
    `</sheets></workbook>`,
  "xl/_rels/workbook.xml.rels":
    `<?xml version="1.0"?><Relationships>` +
    `<Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/></Relationships>`,
  "xl/sharedStrings.xml":
    `<?xml version="1.0"?><sst>${SHARED.map((s) => `<si><t>${s.replace(/&/g, "&amp;")}</t></si>`).join("")}</sst>`,
  "xl/worksheets/sheet1.xml":
    `<?xml version="1.0"?><worksheet><sheetData>` +
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>` +
    `<row r="2"><c r="A2"><v>697</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c><c r="D2" t="s"><v>6</v></c></row>` +
    // sparse: no C cell at all, and the value arrives as an inline string
    `<row r="3"><c r="A3"><v>3865</v></c><c r="B3" t="inlineStr"><is><t>Glad</t><t>man</t></is></c><c r="D3" t="s"><v>6</v></c></row>` +
    `</sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml":
    `<?xml version="1.0"?><worksheet><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>Property Address</t></is></c></row>` +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>300 N Broadway St, Lexington, KY 40508</t></is></c></row>` +
    `</sheetData></worksheet>`,
});

test("worksheet names are listed before anything is parsed", () => {
  assert.deepEqual(readWorkbookInfo(BOOK).sheets.map((s) => s.name), ["2026", "2024"]);
});

test("shared strings, inline strings, numbers, and sparse cells all read correctly", () => {
  const { name, rows } = readSheetMatrix(BOOK, "2026");
  assert.equal(name, "2026");
  assert.deepEqual(rows[0], ["Street Number", "Street Name", "Suffix", "Hosted/Unhosted"]);
  assert.deepEqual(rows[1], ["697", "Cindy Blair", "Way", "Unhosted"]);
  // C3 is absent from the XML entirely — the D value must not slide left into it
  assert.deepEqual(rows[2], ["3865", "Gladman", "", "Unhosted"]);
});

test("a sheet becomes the same row shape the CSV path produces", () => {
  const { headers, rows } = readSheetRows(BOOK, "2026");
  assert.deepEqual(headers, ["Street Number", "Street Name", "Suffix", "Hosted/Unhosted"]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { street_number: "697", street_name: "Cindy Blair", suffix: "Way", hosted_unhosted: "Unhosted" });
  assert.equal(rows[1].suffix, "");
});

test("tabs of the same workbook can carry different columns", () => {
  const a = suggestMapping(readSheetRows(BOOK, "2026").headers);
  const b = suggestMapping(readSheetRows(BOOK, "2024").headers);
  assert.equal(a.mapping.address_number, "street_number");
  assert.equal(a.mapping.address_full, undefined);
  assert.equal(b.mapping.address_full, "property_address");
  assert.equal(b.mapping.address_number, undefined);
});

test("sheets are addressable by index as well as by name", () => {
  assert.equal(readSheetMatrix(BOOK, 1).name, "2024");
  assert.equal(readSheetMatrix(BOOK).name, "2026", "no argument means the first sheet");
});

test("a non-xlsx buffer and an unknown sheet fail loudly", () => {
  assert.throws(() => readWorkbookInfo(Buffer.from("id,address\n1,x\n")), /not a valid \.xlsx/i);
  assert.throws(() => readSheetMatrix(BOOK, "1999"), /not found/i);
});
