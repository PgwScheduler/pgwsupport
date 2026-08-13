// =====================================================================
// Gross profit — the portal-wide model completed once technician labor
// exists (Task 4, Part 4). Replaces the old "GP before labor" figure.
//
// Revenue is grouped exactly like the source Summary sheet (rows R35-R39):
//   labor              = labor_sales + 0.5*groupon            (Summary R36)
//   parts_and_supplies = parts_sales + supplies + 0.5*groupon (Summary R37)
//   tires              = tire_sales                           (Summary R38)
//   discounts          = signed, added algebraically          (Summary R39)
//   gross_sales        = labor + parts_and_supplies + tires + discounts
// Groupon splits evenly between labor and parts.
//
//   cost_of_sales      = labor_cost + parts_cost + tire_cost
//   gross_profit       = gross_sales - cost_of_sales
//
// labor_sales and labor_cost ORIGINATE in the technician tracker
// (tech_store_month); parts/tires/supplies/groupon/discounts and the
// parts/tire costs come from daily_kpi. Effective Labor Rate uses the
// SAME groupon-blended labor as Summary!R22:
//   ELR = (labor_sales + 0.5*groupon) / flag_hours
// (raw labor_sales/flag would read 158.19; the blended figure is 156.92).
// =====================================================================

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// `k` carries the monthly daily_kpi sums; `tech` carries tech_store_month
// (labor_sales, labor_cost, flag_hours). All fields optional -> 0.
export function computeGrossProfit(k, tech) {
  const laborSales = num(tech?.labor_sales);
  const laborCost = num(tech?.labor_cost);

  const parts = num(k?.parts_sales);
  const supplies = num(k?.supplies);
  const tireSales = num(k?.tire_sales);
  const groupon = num(k?.groupon);
  const discounts = num(k?.discounts); // stored signed (<= 0)
  const partsCost = num(k?.parts_cost);
  const tireCost = num(k?.tire_cost);

  const halfGroupon = 0.5 * groupon;

  const laborLine = laborSales + halfGroupon; // R36
  const partsAndSupplies = parts + supplies + halfGroupon; // R37
  const tires = tireSales; // R38
  const grossSales = laborLine + partsAndSupplies + tires + discounts; // R35

  const costOfSales = laborCost + partsCost + tireCost;
  const grossProfit = grossSales - costOfSales;

  return {
    laborLine,
    partsAndSupplies,
    tires,
    discounts,
    grossSales,
    laborCost,
    partsCost,
    tireCost,
    costOfSales,
    grossProfit,
    grossProfitPct: grossSales === 0 ? 0 : grossProfit / grossSales,
  };
}

// Official store ELR — groupon-blended labor over flag hours (Summary R22).
export function effectiveLaborRate(laborSales, groupon, flagHours) {
  const flag = num(flagHours);
  if (flag === 0) return 0;
  return (num(laborSales) + 0.5 * num(groupon)) / flag;
}
