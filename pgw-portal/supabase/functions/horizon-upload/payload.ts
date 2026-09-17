// =====================================================================
// Horizon payload builder — pure, no I/O.
//
// Reproduces what the store workbook's macro (Module1.SendDataToServer)
// POSTs to Horizon's importer, from portal rows instead of sheet cells.
// The workbook is the specification; every rule below names the cell
// or formula it copies.
//
// Arithmetic is done in JavaScript doubles, in the workbook's order, and
// numbers are written the way VBA converts a Double to text (15
// significant digits). That is what makes a field-by-field comparison
// with the workbook's own output meaningful.
//
// Runs under Deno (the Edge Function) and Node (local comparison).
// =====================================================================

export type KpiRow = {
  business_date: string;
  ro_count: number | string | null;
  sales_labor?: number | string | null;
  sales_parts: number | string | null;
  sales_tires: number | string | null;
  sales_discounts: number | string | null;
  sales_supplies: number | string | null;
  sales_adjustments: number | string | null;
  cost_parts: number | string | null;
  cost_tires: number | string | null;
  declined_sales: number | string | null;
  credit_apps: number | string | null;
  credit_dollars: number | string | null;
  units: Record<string, number | string>; // horizon_key -> units
};

export type PayloadInput = {
  shopNumber: string;
  month: string;          // 'YYYY-MM'
  today: string;          // 'YYYY-MM-DD', the store's local date
  frontStaffSlot: number; // from horizon_upload_target(), never a constant
  categories: { horizon_key: string; display_order: number | null }[]; // active for the brand
  goals: { horizon_key: string; goal_pct_of_cars: number | string | null }[];
  kpi: KpiRow[];
  techSlots: { id: string; employee_id: string | null; label: string | null; is_manager_or_sa: boolean }[];
  techDaily: {
    tech_slot_id: string; employee_id: string | null; work_date: string;
    hours_worked: number | string | null; flag_hours: number | string | null; labor_sales: number | string | null;
  }[];
  techWeekly: { tech_slot_id: string; week_start: string; other_pay: number | string | null }[];
  rates: { employee_id: string; effective_date: string; flat_rate: number | string | null; guarantee_rate: number | string | null }[];
  employees: { id: string; full_name: string }[];
  horizonSlots: {
    slot_number: number; current_technician_id: string | null;
    is_reserved: boolean; reservation_kind: string | null; reservation_label: string | null;
  }[];
};

export type Pair = [string, string];
export type PayloadResult = {
  pairs: Pair[];          // the POST fields, in order; the password is a marker
  days: number;           // how many days of the month are sent
  techSlotsSent: number;  // 12, or more if slots 13-20 are in use
  warnings: string[];
  totals: Record<string, number>;
};

export const PASSWORD_MARKER = '\u0000PASSWORD\u0000';
const OT_THRESHOLD = 40;

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

// VBA's implicit Double -> String: 15 significant digits, no trailing
// zeros, no exponent for the magnitudes a store produces.
export function vbNumber(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`not a finite number: ${v}`);
  const r = Number(v.toPrecision(15));
  return Object.is(r, -0) ? '0' : String(r);
}

// Module1.URLEncode: A-Z a-z 0-9 - . _ ~ pass through; everything else
// becomes %XX in upper-case hex. (VBA encodes the ANSI byte; for the
// ASCII a store sends this is identical. Non-ASCII goes out as UTF-8.)
export function vbUrlEncode(s: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(s)) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~]/.test(ch) ? ch : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

// Fingerprint of the fields with the password still a marker, so it
// never depends on the password. A send must quote the fingerprint of
// the preview that was approved.
export async function fieldsDigest(pairs: Pair[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(pairs));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function encodeBody(pairs: Pair[], password: string): string {
  return pairs
    .map(([k, v]) => vbUrlEncode(k) + '=' + vbUrlEncode(v === PASSWORD_MARKER ? password : v))
    .join('&');
}

const isoAddDays = (iso: string, n: number): string => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// ReportingDate - #1/1/1970#, in whole days.
const epochDays = (iso: string): number => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);
const weekStartOf = (iso: string): string => isoAddDays(iso, -new Date(iso + 'T00:00:00Z').getUTCDay());

export function buildPayload(inp: PayloadInput): PayloadResult {
  const warnings: string[] = [];
  const [y, m] = inp.month.split('-').map(Number);
  const first = `${inp.month}-01`;
  const monthDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  // Days = Max(0, Min(days in month, Date - FirstDate + 1))
  const days = Math.max(0, Math.min(monthDays, epochDays(inp.today) - epochDays(first) + 1));
  const lastSent = isoAddDays(first, days - 1);
  const inMonth = (iso: string) => iso >= first && iso <= isoAddDays(first, monthDays - 1);

  // ---- Horizon slot lookup -------------------------------------------
  const slotOfEmployee = new Map<string, number>();
  for (const s of inp.horizonSlots) {
    if (s.current_technician_id) slotOfEmployee.set(s.current_technician_id, s.slot_number);
  }
  const nameOf = new Map(inp.employees.map((e) => [e.id, e.full_name]));
  const gridSlot = new Map(inp.techSlots.map((s) => [s.id, s]));

  // Slots 1-12 always (the workbook's twelve blocks); 13-20 only when
  // the store actually uses them, so an empty slot never zeroes Horizon.
  const used = inp.horizonSlots
    .filter((s) => s.current_technician_id || s.is_reserved)
    .map((s) => s.slot_number);
  const techSlotsSent = Math.max(12, ...used);
  if (techSlotsSent > 12) {
    warnings.push(`Slots 13-${techSlotsSent} are in use and are sent as kpi_tech_13..${techSlotsSent}; the store workbook only ever sent 12, so Horizon has not been seen to accept these keys.`);
  }

  // ---- Technician pay, one "sheet" per grid slot + person ------------
  // A workbook tech sheet is one person. Here a person is the day's
  // employee_id (pay resolves from the day, migration 29); a placeholder
  // grid slot (no employee) is its own sheet.
  type Day = { hours: number; flag: number; labor: number; guar: number; comm: number };
  type Sheet = {
    key: string; gridSlotId: string; employeeId: string | null; frontStaff: boolean;
    horizonSlot: number | null; days: Map<string, Day>; alloc: Map<string, number>;
  };
  const sheets = new Map<string, Sheet>();
  const ratesByEmp = new Map<string, PayloadInput['rates']>();
  for (const r of inp.rates) {
    if (!ratesByEmp.has(r.employee_id)) ratesByEmp.set(r.employee_id, []);
    ratesByEmp.get(r.employee_id)!.push(r);
  }
  const rateAt = (emp: string | null, iso: string) => {
    let best: PayloadInput['rates'][number] | null = null;
    for (const r of (emp && ratesByEmp.get(emp)) || []) {
      if (r.effective_date <= iso && (!best || r.effective_date > best.effective_date)) best = r;
    }
    return best;
  };

  for (const d of inp.techDaily) {
    if (!inMonth(d.work_date)) continue; // the workbook holds this month only
    const g = gridSlot.get(d.tech_slot_id);
    if (!g) { warnings.push(`A tech day on ${d.work_date} points at an unknown grid slot; skipped.`); continue; }
    const key = `${d.tech_slot_id}|${d.employee_id ?? ''}`;
    let sh = sheets.get(key);
    if (!sh) {
      const frontStaff = g.is_manager_or_sa;
      const horizonSlot = frontStaff ? inp.frontStaffSlot
        : d.employee_id ? slotOfEmployee.get(d.employee_id) ?? null : null;
      sh = { key, gridSlotId: d.tech_slot_id, employeeId: d.employee_id, frontStaff, horizonSlot, days: new Map(), alloc: new Map() };
      sheets.set(key, sh);
    }
    sh.days.set(d.work_date, { hours: num(d.hours_worked), flag: num(d.flag_hours), labor: num(d.labor_sales), guar: 0, comm: 0 });
  }

  const otherPay = new Map(inp.techWeekly.map((w) => [`${w.tech_slot_id}|${w.week_start}`, num(w.other_pay)]));

  for (const sh of sheets.values()) {
    const weeks = new Map<string, string[]>();
    for (const iso of [...sh.days.keys()].sort()) {
      const ws = weekStartOf(iso);
      if (!weeks.has(ws)) weeks.set(ws, []);
      weeks.get(ws)!.push(iso);
    }
    for (const [ws, isoDays] of weeks) {
      // One rate per week, as the tech tracker does ($E$2/$E$3 per sheet).
      // Front Staff carries no labor cost by definition.
      const rate = sh.frontStaff ? null : rateAt(sh.employeeId, ws);
      if (!sh.frontStaff && sh.employeeId && !rate) {
        warnings.push(`${nameOf.get(sh.employeeId) ?? sh.employeeId} has no pay rate for the week of ${ws}; their compensation is 0.`);
      }
      const guarRate = num(rate?.guarantee_rate);
      const flatRate = num(rate?.flat_rate);
      let E13 = 0, K13 = 0, L13 = 0, N = 0;
      for (const iso of isoDays) {
        const d = sh.days.get(iso)!;
        d.guar = d.hours * guarRate;   // K = E * $E$3
        d.comm = d.flag * flatRate;    // L = F * $E$2
        E13 += d.hours; K13 += d.guar; L13 += d.comm;
        if (d.hours > 0) N++;          // COUNTIF(E6:E12,">0")
      }
      // M13 = IF(E13<40,0,IF(K13>L13,(E13-40)*E$3*0.5,(E13-40)*(L13/E13)*0.5)), ISERROR -> 0
      const M13 = E13 === 0 || E13 < OT_THRESHOLD ? 0
        : K13 > L13 ? (E13 - OT_THRESHOLD) * guarRate * 0.5
        : (E13 - OT_THRESHOLD) * (L13 / E13) * 0.5;
      // H13 = H6: other pay is weekly. With two people in one grid slot
      // in the same week, it goes to the slot's current occupant.
      const g = gridSlot.get(sh.gridSlotId)!;
      const weekSheets = [...sheets.values()].filter((o) => o.gridSlotId === sh.gridSlotId && [...o.days.keys()].some((i) => weekStartOf(i) === ws));
      const ownsOtherPay = weekSheets.length === 1 || sh.employeeId === g.employee_id;
      if (weekSheets.length > 1 && sh.employeeId === g.employee_id) {
        warnings.push(`Grid slot with ${nameOf.get(g.employee_id ?? '') ?? 'a placeholder'} had more than one person in the week of ${ws}; its other pay was given to the current occupant.`);
      }
      const H13 = sh.frontStaff || !ownsOtherPay ? 0 : otherPay.get(`${sh.gridSlotId}|${ws}`) ?? 0;
      for (const iso of isoDays) {
        const d = sh.days.get(iso)!;
        // P = IF((K+L)>0, IF(K13+M13>L13, K+(M13/N), L) + (H13/N), 0)
        // N = 0 is #DIV/0!, which the uploader's ISERROR turns into 0.
        let p = 0;
        if (d.guar + d.comm > 0) {
          p = N === 0 ? 0 : (K13 + M13 > L13 ? d.guar + M13 / N : d.comm) + H13 / N;
        }
        sh.alloc.set(iso, p);
      }
    }
    if (sh.horizonSlot === null) {
      const who = sh.employeeId ? nameOf.get(sh.employeeId) ?? sh.employeeId
        : gridSlot.get(sh.gridSlotId)?.label ?? 'an empty grid slot';
      warnings.push(`${who} has ${sh.days.size} day(s) this month but holds no Horizon slot today. Their labor sales still count in the store totals; their hours and pay are not sent under any slot, but their pay still counts in the store's labor cost.`);
    }
  }

  // Two sheets landing on one Horizon slot (a slot changed hands mid-month
  // is the usual cause) are summed, and flagged.
  const bySlot = new Map<number, Sheet[]>();
  for (const sh of sheets.values()) {
    if (sh.horizonSlot === null) continue;
    if (!bySlot.has(sh.horizonSlot)) bySlot.set(sh.horizonSlot, []);
    bySlot.get(sh.horizonSlot)!.push(sh);
  }
  for (const [slot, list] of bySlot) {
    if (list.length > 1) warnings.push(`Horizon slot ${slot} receives days from ${list.length} people or grid slots this month; their figures are added together.`);
  }
  const orderedSheets = [
    ...[...bySlot.keys()].sort((a, b) => a - b).flatMap((s) => bySlot.get(s)!),
    ...[...sheets.values()].filter((s) => s.horizonSlot === null),
  ];

  // ---- Daily fields ---------------------------------------------------
  const kpiByDate = new Map(inp.kpi.map((k) => [k.business_date, k]));
  const suKeys = inp.categories
    .filter((c) => c.horizon_key.startsWith('kpi_su_')) // local_* categories never leave the portal
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0) || a.horizon_key.localeCompare(b.horizon_key))
    .map((c) => c.horizon_key);

  const pairs: Pair[] = [
    ['data[SHOP_STORENUMBER]', inp.shopNumber],
    ['data[PASSWORD]', PASSWORD_MARKER],
  ];
  const totals: Record<string, number> = { kpi_ro: 0, kpi_sales_labor: 0, kpi_sales_parts: 0, kpi_sales_tires: 0, kpi_sales_discounts: 0, kpi_cost_labor: 0, kpi_cost_parts: 0, kpi_cost_tires: 0 };

  for (let i = 0; i < days; i++) {
    const iso = isoAddDays(first, i);
    const k = kpiByDate.get(iso);
    if (k && num(k.sales_labor) !== 0) {
      warnings.push(`${iso}: the tic sheet's own labor sales (${k.sales_labor}) is not used; labor sales come from the tech tracker.`);
    }
    const p = `data[kpi][${epochDays(iso)}]`;
    const put = (key: string, v: number | string) => pairs.push([`${p}[${key}]`, typeof v === 'number' ? vbNumber(v) : v]);

    // Summary G: the sum of every tech sheet's labor sales, sheet by sheet.
    let G = 0;
    for (const sh of orderedSheets) G += sh.days.get(iso)?.labor ?? 0;
    const ro = num(k?.ro_count);
    const disc = num(k?.sales_discounts);
    const adjustments = num(k?.sales_adjustments);

    const perSlot = new Map<number, { hours: number; flag: number; labor: number; comp: number }>();
    for (let n = 1; n <= techSlotsSent; n++) perSlot.set(n, { hours: 0, flag: 0, labor: 0, comp: 0 });
    let costLabor = 0;
    for (const sh of orderedSheets) {
      const d = sh.days.get(iso);
      if (!d) continue;
      const comp = sh.frontStaff ? 0 : sh.alloc.get(iso) ?? 0;
      if (sh.horizonSlot !== null && perSlot.has(sh.horizonSlot)) {
        const t = perSlot.get(sh.horizonSlot)!;
        t.hours += d.hours; t.flag += d.flag; t.labor += d.labor; t.comp += comp;
      }
      costLabor += comp;
    }

    const salesLabor = G + disc * 0.5 + 0.5 * adjustments;
    const salesParts = num(k?.sales_parts) + num(k?.sales_supplies) + disc * 0.5 + 0.5 * adjustments;
    put('kpi_days', ro >= 1 ? 1 : 0);
    put('kpi_ro', ro);
    put('kpi_sales_labor', salesLabor);
    put('kpi_sales_parts', salesParts);
    put('kpi_sales_tires', num(k?.sales_tires));
    put('kpi_sales_discounts', disc);
    put('kpi_cost_labor', costLabor);
    put('kpi_cost_parts', num(k?.cost_parts));
    put('kpi_cost_tires', num(k?.cost_tires));
    for (const key of suKeys) put(key, num(k?.units?.[key]));
    for (const [n, t] of perSlot) {
      put(`kpi_tech_${n}_hours_worked`, t.hours);
      put(`kpi_tech_${n}_hours_sold`, t.flag);
      put(`kpi_tech_${n}_labor_sales`, t.labor);
      put(`kpi_tech_${n}_daily_compensation`, t.comp);
    }
    put('kpi_declined_sales', num(k?.declined_sales));
    put('kpi_credit_apps', num(k?.credit_apps));
    put('kpi_credit_dollars', num(k?.credit_dollars));

    totals.kpi_ro += ro;
    totals.kpi_sales_labor += salesLabor;
    totals.kpi_sales_parts += salesParts;
    totals.kpi_sales_tires += num(k?.sales_tires);
    totals.kpi_sales_discounts += disc;
    totals.kpi_cost_labor += costLabor;
    totals.kpi_cost_parts += num(k?.cost_parts);
    totals.kpi_cost_tires += num(k?.cost_tires);
  }
  for (const k of inp.kpi) {
    if (k.business_date > lastSent && inMonth(k.business_date)) {
      warnings.push(`${k.business_date} has tic sheet data but is after today, so it is not sent.`);
    }
  }

  // ---- Monthly fields -------------------------------------------------
  const mp = `data[monthly][${epochDays(first)}]`;
  const goalOf = new Map(inp.goals.map((g) => [g.horizon_key, num(g.goal_pct_of_cars)]));
  for (const key of suKeys) pairs.push([`${mp}[${key}]`, vbNumber(goalOf.get(key) ?? 0)]);
  const slotRow = new Map(inp.horizonSlots.map((s) => [s.slot_number, s]));
  for (let n = 1; n <= techSlotsSent; n++) {
    const s = slotRow.get(n);
    const name = s?.current_technician_id ? nameOf.get(s.current_technician_id) ?? ''
      : s?.is_reserved ? s.reservation_label ?? '' : '';
    pairs.push([`${mp}[kpi_tech_${n}_name]`, name.trim()]);
  }

  for (const k of Object.keys(totals)) totals[k] = Number(totals[k].toFixed(2));
  return { pairs, days, techSlotsSent, warnings: [...new Set(warnings)], totals };
}
