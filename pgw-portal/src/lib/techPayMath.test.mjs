import { computeTechWeek, computeTechMonth, rateForDate, monthWeekStarts } from "./techPayMath.js";
let pass=0, fail=0;
const close=(a,b,eps=0.005)=>Math.abs(a-b)<=eps;
function ok(name, cond, got){ if(cond){pass++; /*console.log("ok",name)*/} else {fail++; console.log("FAIL",name,"got",got);} }

const rate = { flat_rate:36, guarantee_rate:16 };

// Test A — guarantee-dominant, OT, plus a flag-only day (hours=0) that
// passes the allocation gate but is excluded from divisor N.
const A = computeTechWeek([
  {hours_worked:10,flag_hours:3,labor_sales:400},
  {hours_worked:10,flag_hours:3,labor_sales:400},
  {hours_worked:10,flag_hours:3,labor_sales:400},
  {hours_worked:15,flag_hours:3,labor_sales:400},
  {hours_worked:0, flag_hours:5,labor_sales:700}, // flag-only
], rate, 0);
ok("A.hours",   close(A.hoursTotal,45), A.hoursTotal);
ok("A.flag",    close(A.flagTotal,17), A.flagTotal);
ok("A.guar",    close(A.guarTotal,720), A.guarTotal);
ok("A.comm",    close(A.commTotal,612), A.commTotal);
ok("A.OT",      close(A.overtime,40), A.overtime);       // (45-40)*16*0.5
ok("A.total",   close(A.totalPay,760), A.totalPay);      // max(720+40,612)
ok("A.N",       A.daysWorked===4, A.daysWorked);         // Fri hours=0 excluded
ok("A.alloc",   close(A.allocationTotal,770), A.allocationTotal); // surplus +10
ok("A.gap",     close(A.allocationTotal-A.totalPay,10), A.allocationTotal-A.totalPay);
ok("A.friShare",close(A.allocations[4],10), A.allocations[4]); // flag-only day collects OT share
ok("A.countdown0", A.countdown===0, A.countdown);

// Test B — commission-dominant, no OT; commission path sums exactly.
const B = computeTechWeek([
  {hours_worked:8,flag_hours:6,labor_sales:900},
  {hours_worked:8,flag_hours:6,labor_sales:900},
], rate, 0);
ok("B.OT0",   close(B.overtime,0), B.overtime);
ok("B.total", close(B.totalPay,432), B.totalPay);   // max(256,432)
ok("B.allocExact", close(B.allocationTotal,432), B.allocationTotal);
ok("B.countdown", close(B.countdown,24), B.countdown);

// Test B2 — other_pay adds to total and spreads across N.
const B2 = computeTechWeek([
  {hours_worked:8,flag_hours:6,labor_sales:900},
  {hours_worked:8,flag_hours:6,labor_sales:900},
], rate, 50);
ok("B2.total", close(B2.totalPay,482), B2.totalPay);       // 432 + 50
ok("B2.alloc", close(B2.allocationTotal,482), B2.allocationTotal); // 50 spread over N=2

// Test C — effective dating picks greatest effective_date <= date.
const rates=[{effective_date:"2026-01-01",flat_rate:30,guarantee_rate:14},
             {effective_date:"2026-07-01",flat_rate:36,guarantee_rate:16}];
ok("C.jun", rateForDate(rates,"2026-06-30")?.flat_rate===30, rateForDate(rates,"2026-06-30"));
ok("C.jul", rateForDate(rates,"2026-07-01")?.flat_rate===36, rateForDate(rates,"2026-07-01"));
ok("C.none", rateForDate(rates,"2025-12-31")===null, rateForDate(rates,"2025-12-31"));

// Test D — empty slot: zeros, no NaN/Infinity.
const D = computeTechWeek([], null, 0);
ok("D.total0", D.totalPay===0, D.totalPay);
ok("D.prof0",  D.proficiency===0, D.proficiency);
ok("D.elr0",   D.elrWeek===0, D.elrWeek);
ok("D.alloc0", D.allocationTotal===0, D.allocationTotal);
ok("D.finite", Number.isFinite(D.totalPay)&&Number.isFinite(D.proficiency), D);

// Test E — month rollup sums weekly total_pay (correct) not allocations.
const M = computeTechMonth([A,B]);
ok("E.total", close(M.totalPay, 760+432), M.totalPay);
ok("E.costPerHour", close(M.costPerHour, (760+432)/(17+12)), M.costPerHour);

// Test F — month week-starts for July 2026 = Jun28..Jul26 (5 Sundays).
const ws = monthWeekStarts(2026,7);
ok("F.weeks", JSON.stringify(ws)===JSON.stringify(["2026-06-28","2026-07-05","2026-07-12","2026-07-19","2026-07-26"]), ws);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
