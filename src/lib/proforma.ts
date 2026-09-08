/**
 * Underwriting pro forma (spec §25–27, Phase 6).
 *
 * Pure arithmetic over explicit assumptions. Every line is an input the operator
 * can see and change — nothing is buried in a constant, because an underwriting
 * model whose assumptions are invisible is a model nobody should trust.
 *
 * Two things this deliberately does NOT do:
 *  · It does not present cap rate as if it were comparable to a long-term rental
 *    cap rate. STR revenue carries operating intensity a lease does not, and the
 *    expense block below is where that shows up.
 *  · It does not depreciate, amortize, or model tax treatment. That is an
 *    accountant's job and the numbers here would be a liability if used for it.
 */
export const PROFORMA_VERSION = "sixgen-proforma-v1.0";

export type ProFormaAssumptions = {
  purchasePrice: number;
  annualRevenue: number;

  managementPct: number;       // of revenue
  cleaningPerStay: number;
  avgStayNights: number;
  occupancy: number;           // used to derive the number of stays
  utilitiesMonthly: number;
  internetMonthly: number;
  lawnSnowMonthly: number;
  suppliesPct: number;         // of revenue
  repairsPct: number;          // of revenue
  insuranceAnnual: number;
  taxRatePct: number;          // of purchase price, annual
  hoaMonthly: number;

  furnishingPerBedroom: number;
  beds: number;
  closingCostPct: number;

  financed: boolean;
  downPaymentPct: number;
  interestRatePct: number;
  loanYears: number;
};

export type ExpenseLine = { key: string; label: string; annual: number; basis: string };

export type ProFormaResult = {
  version: string;
  revenue: number;
  expenses: ExpenseLine[];
  totalExpenses: number;
  noi: number;
  expenseRatio: number;
  capRatePct: number | null;
  cashInvested: number;
  annualDebtService: number;
  cashFlow: number;
  cashOnCashPct: number | null;
  dscr: number | null;
  breakEvenOccupancy: number | null;
  warnings: string[];
};

export const DEFAULT_ASSUMPTIONS: Omit<ProFormaAssumptions, "purchasePrice" | "annualRevenue" | "beds" | "occupancy"> = {
  managementPct: 0.20,
  cleaningPerStay: 175,
  avgStayNights: 3,
  utilitiesMonthly: 350,
  internetMonthly: 90,
  lawnSnowMonthly: 150,
  suppliesPct: 0.03,
  repairsPct: 0.04,
  insuranceAnnual: 3200,
  taxRatePct: 1.05,
  hoaMonthly: 0,
  furnishingPerBedroom: 9000,
  closingCostPct: 0.03,
  financed: true,
  downPaymentPct: 0.25,
  interestRatePct: 7.0,
  loanYears: 30,
};

const round = (n: number) => Math.round(n);

/** Level-payment mortgage. Returns 0 when unfinanced or the term is degenerate. */
export function annualDebtService(principal: number, ratePct: number, years: number): number {
  if (principal <= 0 || years <= 0) return 0;
  const r = ratePct / 100 / 12;
  const n = years * 12;
  if (r === 0) return round(principal / years);
  const monthly = (principal * r) / (1 - Math.pow(1 + r, -n));
  return round(monthly * 12);
}

export function computeProForma(a: ProFormaAssumptions): ProFormaResult {
  const warnings: string[] = [];
  const revenue = Math.max(0, a.annualRevenue);
  const nights = Math.max(0, Math.min(1, a.occupancy)) * 365;
  const stays = a.avgStayNights > 0 ? nights / a.avgStayNights : 0;

  const expenses: ExpenseLine[] = [
    { key: "management", label: "Management", annual: round(revenue * a.managementPct), basis: `${(a.managementPct * 100).toFixed(0)}% of revenue` },
    { key: "cleaning", label: "Cleaning", annual: round(stays * a.cleaningPerStay), basis: `${stays.toFixed(0)} stays × $${a.cleaningPerStay}` },
    { key: "utilities", label: "Utilities", annual: round(a.utilitiesMonthly * 12), basis: `$${a.utilitiesMonthly}/mo` },
    { key: "internet", label: "Internet & streaming", annual: round(a.internetMonthly * 12), basis: `$${a.internetMonthly}/mo` },
    { key: "lawn_snow", label: "Lawn & snow", annual: round(a.lawnSnowMonthly * 12), basis: `$${a.lawnSnowMonthly}/mo` },
    { key: "supplies", label: "Supplies & consumables", annual: round(revenue * a.suppliesPct), basis: `${(a.suppliesPct * 100).toFixed(0)}% of revenue` },
    { key: "repairs", label: "Repairs & maintenance", annual: round(revenue * a.repairsPct), basis: `${(a.repairsPct * 100).toFixed(0)}% of revenue` },
    { key: "insurance", label: "Insurance", annual: round(a.insuranceAnnual), basis: "annual premium" },
    { key: "taxes", label: "Property tax", annual: round(a.purchasePrice * (a.taxRatePct / 100)), basis: `${a.taxRatePct}% of price` },
  ];
  if (a.hoaMonthly > 0) expenses.push({ key: "hoa", label: "HOA", annual: round(a.hoaMonthly * 12), basis: `$${a.hoaMonthly}/mo` });

  const totalExpenses = expenses.reduce((s, e) => s + e.annual, 0);
  const noi = revenue - totalExpenses;
  const expenseRatio = revenue > 0 ? +(totalExpenses / revenue).toFixed(3) : 0;

  const furnishing = round(a.furnishingPerBedroom * Math.max(0, a.beds));
  const closing = round(a.purchasePrice * a.closingCostPct);
  const downPayment = a.financed ? round(a.purchasePrice * a.downPaymentPct) : a.purchasePrice;
  const cashInvested = downPayment + closing + furnishing;

  const loan = a.financed ? a.purchasePrice - downPayment : 0;
  const debt = a.financed ? annualDebtService(loan, a.interestRatePct, a.loanYears) : 0;
  const cashFlow = noi - debt;

  if (noi < 0) warnings.push("Operating expenses exceed forecast revenue before any debt service.");
  if (a.financed && debt > 0 && noi > 0 && noi / debt < 1.2) warnings.push("Debt service coverage is under 1.2× — most lenders will want more cushion.");
  if (expenseRatio > 0.6) warnings.push(`Expenses are ${(expenseRatio * 100).toFixed(0)}% of revenue, which is high even for a short-term rental.`);
  if (a.occupancy > 0.85) warnings.push("The occupancy assumption is above the underwriting ceiling used elsewhere in this app.");

  // revenue needed to cover fixed costs + debt, expressed as occupancy
  const variableRate = a.managementPct + a.suppliesPct + a.repairsPct;
  const fixed = expenses.filter((e) => ["utilities", "internet", "lawn_snow", "insurance", "taxes", "hoa"].includes(e.key))
    .reduce((s, e) => s + e.annual, 0);
  const adr = nights > 0 ? revenue / nights : 0;
  const cleaningPerNight = a.avgStayNights > 0 ? a.cleaningPerStay / a.avgStayNights : 0;
  const contributionPerNight = adr * (1 - variableRate) - cleaningPerNight;
  const breakEvenOccupancy = contributionPerNight > 0
    ? +Math.min(1, (fixed + debt) / (contributionPerNight * 365)).toFixed(3)
    : null;
  if (breakEvenOccupancy == null && revenue > 0) warnings.push("Each additional night loses money at these assumptions, so there is no break-even occupancy.");

  return {
    version: PROFORMA_VERSION,
    revenue: round(revenue),
    expenses, totalExpenses, noi: round(noi), expenseRatio,
    capRatePct: a.purchasePrice > 0 ? +((noi / a.purchasePrice) * 100).toFixed(2) : null,
    cashInvested, annualDebtService: debt, cashFlow: round(cashFlow),
    cashOnCashPct: cashInvested > 0 ? +((cashFlow / cashInvested) * 100).toFixed(2) : null,
    dscr: debt > 0 ? +(noi / debt).toFixed(2) : null,
    breakEvenOccupancy,
    warnings,
  };
}

// ─────────────────────── amenity upside scenarios ───────────────────────────

export type AmenityUpgrade = {
  key: string; label: string; cost: number;
  /** Fractional lift on annual revenue, from the Sixgen portfolio's own spread. */
  revenueLift: number;
  note: string;
};

/**
 * Costs are Sixgen's own installed figures; the lifts are deliberately modest.
 * The portfolio shows amenity-rich listings out-earning bare ones, but seventeen
 * listings cannot separate the amenity from the house it sits in, so these are
 * planning numbers to be revised against real before/after data — which is
 * exactly what the portfolio will provide once an upgrade is made and tracked.
 */
export const AMENITY_UPGRADES: AmenityUpgrade[] = [
  { key: "hot_tub", label: "Hot tub", cost: 12000, revenueLift: 0.10, note: "The single most common amenity across the portfolio." },
  { key: "golf_sim", label: "Golf simulator", cost: 25000, revenueLift: 0.12, note: "Needs a garage or basement bay with 10-ft ceilings." },
  { key: "game_room", label: "Game room", cost: 15000, revenueLift: 0.08, note: "Basement conversion; pairs with the golf simulator." },
  { key: "fire_pit", label: "Fire pit", cost: 3500, revenueLift: 0.03, note: "Low cost, small but reliable lift." },
  { key: "extra_bedroom", label: "Add a bedroom", cost: 22000, revenueLift: 0.15, note: "Only where floor area and egress allow it." },
];

export type UpgradeScenario = {
  upgrade: AmenityUpgrade;
  addedRevenue: number;
  newRevenue: number;
  newNoi: number;
  newCashFlow: number;
  paybackYears: number | null;
  incrementalReturnPct: number | null;
};

export function amenityScenarios(base: ProFormaAssumptions, upgrades = AMENITY_UPGRADES): UpgradeScenario[] {
  const baseline = computeProForma(base);
  return upgrades.map((u) => {
    const addedRevenue = Math.round(base.annualRevenue * u.revenueLift);
    const withUpgrade = computeProForma({ ...base, annualRevenue: base.annualRevenue + addedRevenue });
    const addedNoi = withUpgrade.noi - baseline.noi;
    return {
      upgrade: u,
      addedRevenue,
      newRevenue: withUpgrade.revenue,
      newNoi: withUpgrade.noi,
      newCashFlow: withUpgrade.cashFlow,
      paybackYears: addedNoi > 0 ? +(u.cost / addedNoi).toFixed(1) : null,
      incrementalReturnPct: u.cost > 0 && addedNoi > 0 ? +((addedNoi / u.cost) * 100).toFixed(1) : null,
    };
  }).sort((a, b) => (a.paybackYears ?? Infinity) - (b.paybackYears ?? Infinity));
}

/** Merge stored defaults (app_settings) with the property's own figures. */
export function assumptionsFrom(
  defaults: Record<string, any> | null,
  property: { purchasePrice: number; annualRevenue: number; beds: number; occupancy: number; hoaMonthly?: number | null }
): ProFormaAssumptions {
  const d = defaults ?? {};
  const n = (k: string, fallback: number) => (typeof d[k] === "number" ? d[k] : fallback);
  return {
    purchasePrice: property.purchasePrice,
    annualRevenue: property.annualRevenue,
    beds: property.beds,
    occupancy: property.occupancy,
    managementPct: n("management_pct", DEFAULT_ASSUMPTIONS.managementPct),
    cleaningPerStay: n("cleaning_per_stay", DEFAULT_ASSUMPTIONS.cleaningPerStay),
    avgStayNights: n("avg_stay_nights", DEFAULT_ASSUMPTIONS.avgStayNights),
    utilitiesMonthly: n("utilities_monthly", DEFAULT_ASSUMPTIONS.utilitiesMonthly),
    internetMonthly: n("internet_monthly", DEFAULT_ASSUMPTIONS.internetMonthly),
    lawnSnowMonthly: n("lawn_snow_monthly", DEFAULT_ASSUMPTIONS.lawnSnowMonthly),
    suppliesPct: n("supplies_pct", DEFAULT_ASSUMPTIONS.suppliesPct),
    repairsPct: n("repairs_pct", DEFAULT_ASSUMPTIONS.repairsPct),
    insuranceAnnual: n("insurance_annual", DEFAULT_ASSUMPTIONS.insuranceAnnual),
    taxRatePct: n("tax_rate_pct", DEFAULT_ASSUMPTIONS.taxRatePct),
    hoaMonthly: property.hoaMonthly ?? n("hoa_monthly", DEFAULT_ASSUMPTIONS.hoaMonthly),
    furnishingPerBedroom: n("furnishing_per_bedroom", DEFAULT_ASSUMPTIONS.furnishingPerBedroom),
    closingCostPct: n("closing_cost_pct", DEFAULT_ASSUMPTIONS.closingCostPct),
    financed: DEFAULT_ASSUMPTIONS.financed,
    downPaymentPct: n("down_payment_pct", DEFAULT_ASSUMPTIONS.downPaymentPct),
    interestRatePct: n("interest_rate_pct", DEFAULT_ASSUMPTIONS.interestRatePct),
    loanYears: n("loan_years", DEFAULT_ASSUMPTIONS.loanYears),
  };
}
