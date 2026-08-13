import { computeGrossProfit, effectiveLaborRate } from "./grossProfit.js";
let pass=0, fail=0; const close=(a,b,e=0.02)=>Math.abs(a-b)<=e;
const ok=(n,c,g)=>{ if(c){pass++;} else {fail++; console.log("FAIL",n,"got",g);} };

// July Millwood aggregates (from workbook Summary):
const tech = { labor_sales: 58582.50, labor_cost: 15640.19, flag_hours: 370.33 };
const k = { parts_sales:52290.36, supplies:7510.35, tire_sales:25363.72,
            groupon:-942.44, discounts:-1997.91, parts_cost:0, tire_cost:0 };
const gp = computeGrossProfit(k, tech);
ok("labor R36",  close(gp.laborLine, 58111.28), gp.laborLine);
ok("parts R37",  close(gp.partsAndSupplies, 59329.49), gp.partsAndSupplies);
ok("tires R38",  close(gp.tires, 25363.72), gp.tires);
ok("disc R39",   close(gp.discounts, -1997.91), gp.discounts);
ok("gross R35",  close(gp.grossSales, 140806.58), gp.grossSales);

// ELR — groupon-blended, Summary R22.
ok("ELR 156.92", close(effectiveLaborRate(58582.50, -942.44, 370.33), 156.9176, 0.001),
   effectiveLaborRate(58582.50,-942.44,370.33));
// raw would be 158.19 — confirm they differ as expected
ok("ELR raw diff", close(58582.50/370.33, 158.19, 0.01), 58582.50/370.33);

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
