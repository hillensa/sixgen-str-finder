# Sixgen Rentals -- Lexington portfolio export (Guesty)

## Files
- `sixgen_properties.csv` -- 17 Lexington, KY listings (of 26 total in the Guesty account). One row per listing with address, geo, beds/baths/sleeps, and boolean amenity flags.
- `sixgen_monthly_performance.csv` -- 17 listings x 24 months (Sep 2024 - Aug 2026) = 408 rows. Zero-filled for months with no check-ins so gaps are visible.

## Source and pull
- Source: Guesty Open API v1 (`GET /listings`, `GET /reservations`), pulled 2026-09-03.
- Window: check-in dates `2024-09-01` <= checkIn < `2026-09-01` (24 calendar months). Attribution is by **check-in month**; a stay is counted entirely in the month it checks in, so long stays that straddle months are not prorated (e.g. a 57-night Jan-2025 stay at 1810 Clays Mill and a 58-night Jan-2025 stay at 617 Stratford push those months to 100% occupancy and leave Feb-2025 sparse).
- Status filter: `status $in [confirmed, checked_in, checked_out]`. Canceled, inquiry, reserved/awaiting-payment and declined reservations are excluded.
- Reservations pulled: 2,417 total. Every listing's fetched record count reconciled to the API `count` field.
- Non-Lexington listings (Shelbyville, Simpsonville, Williamstown x4, Leicester NC, Cincinnati) were excluded by `address.city` filter.

## Metric definitions
- `gross_revenue` = sum of `money.hostPayout` (USD). This is Guesty's host payout: accommodation + cleaning/fees + taxes collected by host, **net of channel (Airbnb/VRBO) host-side commission**. It is not gross booking value and not net of Sixgen's own management fee or expenses.
- `occupied_nights` = sum of `nightsCount`.
- `available_nights` = calendar days in the month. Owner blocks, maintenance blocks and days the listing was not yet live are **unknown** and are NOT removed, so `occupancy` is a floor for true bookable occupancy.
- `occupancy` = occupied_nights / calendar days, capped at 1.0.
- `adr` = gross_revenue / occupied_nights (blank when 0 nights).
- `revpar` = gross_revenue / calendar days.
- Amenity flags (`hot_tub`, `golf_sim`, `game_room`, `pool`, `fire_pit`, `pool_table`) are derived from case-insensitive matching on the listing `tags` and `title` only (amenities array was not pulled). `pool` excludes matches that are only "pool table".

## Anomalies / caveats
- No records were missing `money.hostPayout` (0 of 2,417). Three records have near-zero payout and look like comps/adjustments rather than paid stays: 1810 Clays Mill Feb-2026 (2 nights, $0.00, manual), 1810 Clays Mill May-2026 (2 nights, $3.38, manual), and 668 Springridge Jun-2026 (2 nights, $147.10, Airbnb). Also $21.20 one-night manual entries at 300 Sherman (Jan-2025) and 687 Hill N Dale (Feb-2025). Nights from these are still counted.
- 720 W Short St went live June 2025; Sep-2024 through May-2025 rows are zero because the listing did not exist, not because it was vacant. Trailing-12 figures for it are valid; 24-month totals are not comparable.
- 3141 Lamar Dr has a 22-night VRBO stay checking in 2026-05-31 with hostPayout $25,396 (about $1,150/night); it sits entirely in May-2026 by check-in attribution though nearly all nights fall in June.
- 617 Stratford Dr (2BR) shows several long stays (58, 15, 19, 20, 19, 18-night) at low nightly rates, consistent with mid-term/insurance-type bookings.
- All 17 listings are `active: true` in Guesty as of the pull date; none are inactive.
- Check-in timestamps are UTC (16:00 local = 20:00Z/21:00Z); month attribution uses the UTC date, which equals the local date for all records here.
