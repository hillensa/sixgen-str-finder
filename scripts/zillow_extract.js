// Zillow search-page extractor for the weekly Lexington pull.
//
// Paste this whole file into the browser's JavaScript console tool while a
// Zillow search results page is open. It reads ONLY what the page already
// rendered (__NEXT_DATA__). It makes no requests of its own: a scripted
// fetch() of the next page is exactly what Zillow's bot protection challenges,
// so pages are advanced by clicking "Next page", as a person would.
//
// Returns one of:
//   { blocked: true, ... }   a challenge page — STOP, do not try to solve it
//   { stale: true, ... }     Zillow changed pages in place — reload the URL, rerun
//   { blocked: false, page, totalPages, total, count, sha256, psv, filters }
//
// `psv` is one line per home, pipe-separated, newline-terminated:
//   zpid|address|zip|lat|lng|price|beds|baths|sqft|lot_sqft|home_type|dom|photo_hash
// Write it to a file EXACTLY, then check it with
//   python scripts/zillow_weekly.py verify <file> <sha256>
// so a transcription slip can never reach the database.
(async () => {
  const el = document.getElementById('__NEXT_DATA__');
  const challenged = !el || /press\s*&\s*hold|access to this page has been denied|px-captcha/i
    .test(document.title + ' ' + (document.body?.innerText || '').slice(0, 600));
  if (challenged) {
    return { blocked: true, title: document.title, url: location.href };
  }
  const nd = JSON.parse(el.textContent);
  const sps = nd?.props?.pageProps?.searchPageState;
  // Zillow may change pages in place, leaving __NEXT_DATA__ on the page that
  // was first loaded. Reading it then would re-capture the wrong page.
  const dataPage = sps?.queryState?.pagination?.currentPage || 1;
  const urlMatch = String(location.pathname).match(/\/(\d+)_p\/?$/);
  const urlPage = urlMatch ? Number(urlMatch[1]) : 1;
  if (dataPage !== urlPage) {
    return { blocked: false, stale: true, urlPage, dataPage,
      note: 'Page changed in place. Reload this same URL (navigate to it), wait, and run the extractor again.' };
  }
  const list = sps?.cat1?.searchResults?.listResults || [];
  const clean = (v) => String(v ?? '').replace(/[|\r\n]/g, ' ').trim();
  const photoHash = (u) => {
    const m = String(u || '').match(/\/fp\/([0-9a-f]+)-p_[a-z]\.jpg/);
    return m ? m[1] : '';
  };
  const lines = list.map((r) => {
    const h = r.hdpData?.homeInfo || {};
    const lot = h.lotAreaValue == null ? ''
      : Math.round(h.lotAreaUnit === 'acres' ? h.lotAreaValue * 43560 : h.lotAreaValue);
    return [
      r.zpid, h.streetAddress || r.addressStreet, h.zipcode || r.addressZipcode,
      h.latitude ?? r.latLong?.latitude ?? '', h.longitude ?? r.latLong?.longitude ?? '',
      h.price ?? r.unformattedPrice ?? '', h.bedrooms ?? r.beds ?? '', h.bathrooms ?? r.baths ?? '',
      h.livingArea ?? r.area ?? '', lot, h.homeType || '', h.daysOnZillow ?? '', photoHash(r.imgSrc),
    ].map(clean).join('|');
  });
  const psv = lines.join('\n') + (lines.length ? '\n' : '');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(psv));
  const sha256 = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    blocked: false,
    page: sps?.queryState?.pagination?.currentPage || 1,
    totalPages: sps?.cat1?.searchList?.totalPages ?? null,
    total: sps?.cat1?.searchList?.totalResultCount ?? null,
    filters: sps?.queryState?.filterState ?? null,
    count: lines.length,
    sha256,
    psv,
  };
})();
