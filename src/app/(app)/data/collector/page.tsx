import PageHeader from "@/components/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
export default function Collector() {
  return (
    <>
      <PageHeader title="Browser export helper" subtitle="For the CSV/JSON provider — you run this yourself in your own browser session" />
      <div className="p-6"><Card>
        <CardHeader title="Compliance note" />
        <CardBody className="space-y-3 text-sm text-slate-700">
          <p>This app does <b>not</b> scrape listing sites from the server and includes no bot-circumvention of any kind. The launch path is the <b>CSV provider</b>: export active listings from your MLS (or ask your agent for a CSV export) and import it on the Data page in Phase 4.</p>
          <p>The weekly path is a file, not a feed: export active listings from ImagineMLS and load the CSV with the <b>Weekly MLS export</b> button on <a className="text-blue-600 underline" href="/admin">Admin</a>. Tick <i>complete active set</i> only when the file is the whole export — that is what lets withdrawals be detected.</p><p>A live feed is optional, not required. <code className="rounded bg-slate-100 px-1">ResoWebApiProvider</code> is implemented against the RESO Web API and works with a Spark key; set <code className="rounded bg-slate-100 px-1">LISTINGS_PROVIDER=reso</code> once an MLS data plan is approved. For one county screened weekly, the export is the simpler answer.</p>
          <p className="text-slate-500">Expected CSV columns (aliases accepted): id, address, zip, lat, lng, price, beds, baths, sqft, lot_sqft, year_built, hoa, hoa_fee, hoa_name, status, dom, url, photo. Only <strong>address</strong> is required — rows without lat/lng are geocoded against the city address points, then the US Census. A row with no address, or one the geocoder cannot place, is skipped and listed with its reason.</p>
          <p className="mt-1 text-slate-500">Include lat/lng when your export can. A Census-geocoded pin is interpolated along the street, so it is recorded as approximate and the property is held for review rather than cleared on a separation result measured from a guessed point.</p>
        </CardBody>
      </Card></div>
    </>
  );
}
