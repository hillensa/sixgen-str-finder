import test from "node:test";
import assert from "node:assert/strict";
import { BOOKMARKLET_SOURCE, bookmarkletHref } from "../src/lib/zillow/bookmarklet";
import { parsePayload, isComplete } from "../src/lib/zillow/payload";

/** A fake zillow.com: just enough DOM, storage and clipboard to run the bookmark. */
function zillowPage(opts: { page: number; urlPage?: number; totalPages: number; total: number; zpids: string[]; beds?: number; storage?: Map<string, string> }) {
  const nextData = {
    props: { pageProps: { searchPageState: {
      queryState: { pagination: opts.page > 1 ? { currentPage: opts.page } : {}, filterState: { beds: { min: opts.beds ?? 4 }, baths: { min: 3 }, hoa: { max: 0 } } },
      cat1: {
        searchList: { totalResultCount: opts.total, totalPages: opts.totalPages },
        searchResults: { listResults: opts.zpids.map((z) => ({
          zpid: z, imgSrc: "https://photos.zillowstatic.com/fp/abc-p_e.jpg",
          hdpData: { homeInfo: { streetAddress: `${z} Main St`, zipcode: "40502", latitude: 38.03, longitude: -84.49,
            price: 500000, bedrooms: 4, bathrooms: 3, livingArea: 2500, lotAreaValue: 0.25, lotAreaUnit: "acres", homeType: "SINGLE_FAMILY", daysOnZillow: 3 } },
        })) },
      },
    } } },
  };
  const storage = opts.storage ?? new Map<string, string>();
  const out = { copied: null as string | null, alerts: [] as string[], reloaded: false };
  const node = () => ({ style: {} as any, value: "", textContent: "", innerHTML: "", appendChild() {}, focus() {}, select() {}, parentNode: { removeChild() {} } });
  const document = {
    getElementById: (id: string) => (id === "__NEXT_DATA__" ? { textContent: JSON.stringify(nextData) } : null),
    createElement: () => node(),
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => false,
  };
  const sessionStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) };
  const navigator = { clipboard: { writeText: async (t: string) => { out.copied = t; } } };
  const urlPage = opts.urlPage ?? opts.page;
  const location = { pathname: urlPage > 1 ? `/lexington-ky/${urlPage}_p/` : "/lexington-ky/", reload: () => { out.reloaded = true; } };
  const run = async () => {
    new Function("document", "sessionStorage", "navigator", "location", "alert", "setTimeout", BOOKMARKLET_SOURCE)(
      document, sessionStorage, navigator, location, (m: string) => out.alerts.push(m), (fn: () => void) => fn());
    await new Promise((r) => setImmediate(r));
    return out;
  };
  return { run, storage };
}

test("page 1 copies a payload the /zillow page accepts", async () => {
  const { run } = zillowPage({ page: 1, totalPages: 2, total: 3, zpids: ["11", "12"] });
  const out = await run();
  const p = parsePayload(out.copied!);
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.deepEqual(p.value.homes.map((h) => h.zpid), ["11", "12"]);
  assert.deepEqual(p.value.pages, [1]);
  assert.equal(p.value.signature, "beds>=4|baths>=3|hoa<=0");
  assert.equal(p.value.homes[0].lotSqft, 10890, "acres converted to square feet");
  assert.equal(isComplete(p.value), false);
});

test("page 2 adds to page 1, so the last click carries the whole search", async () => {
  const storage = new Map<string, string>();
  await zillowPage({ page: 1, totalPages: 2, total: 3, zpids: ["11", "12"], storage }).run();
  const out = await zillowPage({ page: 2, totalPages: 2, total: 3, zpids: ["13"], storage }).run();
  const p = parsePayload(out.copied!);
  assert.ok(p.ok && isComplete(p.value));
  if (p.ok) assert.deepEqual(p.value.homes.map((h) => h.zpid).sort(), ["11", "12", "13"]);
});

test("a page Zillow changed in place is reloaded, never re-copied as the wrong page", async () => {
  // URL says page 2, the embedded data still says page 1.
  const out = await zillowPage({ page: 1, urlPage: 2, totalPages: 2, total: 3, zpids: ["11"] }).run();
  assert.equal(out.copied, null);
  assert.equal(out.reloaded, true);
});

test("changing the filters starts a fresh collection", async () => {
  const storage = new Map<string, string>();
  await zillowPage({ page: 1, totalPages: 2, total: 3, zpids: ["11", "12"], storage }).run();
  const out = await zillowPage({ page: 2, totalPages: 2, total: 3, zpids: ["99"], beds: 5, storage }).run();
  const p = parsePayload(out.copied!);
  assert.ok(p.ok);
  if (p.ok) assert.deepEqual(p.value.homes.map((h) => h.zpid), ["99"]);
});

test("the bookmark is a single javascript: URL that makes no requests of its own", () => {
  assert.match(bookmarkletHref(), /^javascript:/);
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|\.src\s*=/.test(BOOKMARKLET_SOURCE));
});
