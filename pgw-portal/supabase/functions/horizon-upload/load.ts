// =====================================================================
// Reads one store-month for the Horizon payload. The caller supplies the
// Supabase client: the Edge Function passes its service-role client, a
// local comparison passes a signed-in admin's. No imports, so this file
// runs unchanged under Deno and Node.
// =====================================================================
import type { KpiRow, PayloadInput } from './payload.ts';

// deno-lint-ignore no-explicit-any
type Client = any;

const isoAddDays = (iso: string, n: number): string => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function rows<T>(q: PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new Error(`Loading ${what} failed: ${error.message}`);
  return data ?? [];
}

export async function loadStoreMonth(
  db: Client,
  locationId: string,
  month: string, // 'YYYY-MM'
): Promise<Omit<PayloadInput, 'shopNumber' | 'today' | 'frontStaffSlot'>> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`month must be YYYY-MM, got ${month}`);
  const first = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const last = isoAddDays(first, new Date(Date.UTC(y, m, 0)).getUTCDate() - 1);
  const firstSunday = isoAddDays(first, -new Date(first + 'T00:00:00Z').getUTCDay());

  const [loc] = await rows<{ brand: string }>(
    db.from('locations').select('brand').eq('id', locationId), 'location');
  if (!loc) throw new Error(`location ${locationId} not found`);

  const cats = await rows<{ display_order: number | null; service_categories: { id: number; horizon_key: string } }>(
    db.from('brand_service_categories')
      .select('display_order, service_categories!inner(id, horizon_key)')
      .eq('brand', loc.brand).eq('active', true),
    'service categories');
  const keyOfCategory = new Map(cats.map((c) => [c.service_categories.id, c.service_categories.horizon_key]));

  const goals = await rows<{ service_category_id: number; goal_pct_of_cars: number }>(
    db.from('store_category_goals').select('service_category_id, goal_pct_of_cars').eq('location_id', locationId),
    'category goals');

  const kpiRaw = await rows<Record<string, unknown> & { business_date: string; daily_service_units: { service_category_id: number; units: number }[] }>(
    db.from('daily_kpi')
      .select('business_date, ro_count, sales_labor, sales_parts, sales_tires, sales_discounts, sales_supplies, sales_groupon, cost_parts, cost_tires, declined_sales, credit_apps, credit_dollars, daily_service_units(service_category_id, units)')
      .eq('location_id', locationId).gte('business_date', first).lte('business_date', last),
    'tic sheet days');

  const techSlots = await rows<PayloadInput['techSlots'][number]>(
    db.from('tech_slots').select('id, employee_id, label, is_manager_or_sa').eq('location_id', locationId),
    'tech grid');
  const techDaily = await rows<PayloadInput['techDaily'][number]>(
    db.from('tech_daily').select('tech_slot_id, employee_id, work_date, hours_worked, flag_hours, labor_sales')
      .eq('location_id', locationId).gte('work_date', first).lte('work_date', last),
    'tech days');
  const slotIds = techSlots.map((s) => s.id);
  const techWeekly = slotIds.length === 0 ? [] : await rows<PayloadInput['techWeekly'][number]>(
    db.from('tech_weekly').select('tech_slot_id, week_start, other_pay')
      .in('tech_slot_id', slotIds).gte('week_start', firstSunday).lte('week_start', last),
    'weekly other pay');

  const employees = await rows<PayloadInput['employees'][number]>(
    db.from('employees').select('id, full_name').eq('location_id', locationId), 'employees');
  const empIds = [...new Set([
    ...employees.map((e) => e.id),
    ...techDaily.map((d) => d.employee_id).filter((x): x is string => !!x),
  ])];
  const rates = empIds.length === 0 ? [] : await rows<PayloadInput['rates'][number]>(
    db.from('tech_pay_rates').select('employee_id, effective_date, flat_rate, guarantee_rate')
      .in('employee_id', empIds).lte('effective_date', last),
    'pay rates');

  const horizonSlots = await rows<PayloadInput['horizonSlots'][number]>(
    db.from('location_horizon_slots')
      .select('slot_number, current_technician_id, is_reserved, reservation_kind, reservation_label')
      .eq('location_id', locationId).order('slot_number'),
    'Horizon slots');
  if (horizonSlots.length !== 20) throw new Error(`expected 20 Horizon slots, found ${horizonSlots.length}`);

  const kpi: KpiRow[] = kpiRaw.map(({ daily_service_units, ...k }) => ({
    ...(k as Omit<KpiRow, 'units'>),
    units: Object.fromEntries(
      daily_service_units
        .filter((u) => keyOfCategory.has(u.service_category_id))
        .map((u) => [keyOfCategory.get(u.service_category_id)!, u.units]),
    ),
  }));

  return {
    month,
    categories: cats.map((c) => ({ horizon_key: c.service_categories.horizon_key, display_order: c.display_order })),
    goals: goals
      .filter((g) => keyOfCategory.has(g.service_category_id))
      .map((g) => ({ horizon_key: keyOfCategory.get(g.service_category_id)!, goal_pct_of_cars: g.goal_pct_of_cars })),
    kpi,
    techSlots,
    techDaily,
    techWeekly,
    rates,
    employees,
    horizonSlots,
  };
}
