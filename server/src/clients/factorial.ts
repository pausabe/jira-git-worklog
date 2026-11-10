const API_VERSION = '2026-10-01';
const BASE = `https://api.factorialhr.com/api/${API_VERSION}/resources`;
/** Safety cap so a pagination bug can never loop forever. */
const MAX_PAGES = 50;

export interface FactorialEmployee {
  id: number;
  locationId: number | null;
}

/** One time-off request, normalized from Factorial's `timeoff/leaves`. */
export interface Leave {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD (inclusive)
  /** Leave type name as shown in Factorial, e.g. "holiday", "Horas Personales". */
  type: string;
  /** true = approved, false = rejected, null = still pending. */
  approved: boolean | null;
  /** Factorial's half-day marker (which half of the day is off), or null for none. */
  halfDay: string | null;
  /** Hours taken, for leaves requested by hours; null when the leave is in whole days. */
  hours: number | null;
}

export interface CompanyHoliday {
  date: string; // YYYY-MM-DD
  name: string;
  halfDay: string | null;
}

interface Page<T> {
  data?: T[];
  meta?: { has_next_page?: boolean };
}

interface RawEmployee {
  id: number;
  email?: string | null;
  login_email?: string | null;
  location_id?: number | null;
}

interface RawLeave {
  id: number;
  employee_id: number;
  start_on: string;
  finish_on: string;
  leave_type_id?: number | null;
  leave_type_name?: string | null;
  approved?: boolean | null;
  half_day?: string | null;
  hours_amount_in_cents?: number | null;
}

interface RawHoliday {
  id: number;
  location_id: number;
  summary?: string | null;
  date: string;
  half_day?: string | null;
}

/**
 * Read-only client for the Factorial HR API.
 *
 * The API key is company-wide: it can read every employee. Every method here
 * therefore narrows to one employee or one location, and re-checks the rows it
 * gets back instead of trusting the server-side filter.
 */
export class FactorialClient {
  private readonly employeeByEmails = new Map<string, FactorialEmployee | null>();
  private leaveTypeNames: Promise<Map<number, string>> | null = null;

  constructor(private readonly apiKey: string) {}

  /** Fetches every page of a list endpoint, de-duplicated by id. */
  private async list<T extends { id: number }>(
    pathname: string,
    params: Array<[string, string]> = [],
  ): Promise<T[]> {
    const byId = new Map<number, T>();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const qs = new URLSearchParams([...params, ['page', String(page)]]);
      const res = await fetch(`${BASE}/${pathname}?${qs}`, {
        headers: { 'x-api-key': this.apiKey, Accept: 'application/json' },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Factorial GET ${pathname} → ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as Page<T>;
      const rows = json.data ?? [];
      for (const row of rows) byId.set(row.id, row);
      if (rows.length === 0 || !json.meta?.has_next_page) break;
    }
    return [...byId.values()];
  }

  /**
   * Finds the employee whose work or login email is one of `emails`.
   * Emails are compared locally so they never travel in a query string.
   */
  async findEmployee(emails: string[]): Promise<FactorialEmployee | null> {
    const wanted = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
    if (wanted.size === 0) return null;
    const cacheKey = [...wanted].sort().join(',');
    const cached = this.employeeByEmails.get(cacheKey);
    if (cached !== undefined) return cached;

    const employees = await this.list<RawEmployee>('employees/employees');
    const match = employees.find(
      (e) =>
        wanted.has((e.email ?? '').toLowerCase()) ||
        wanted.has((e.login_email ?? '').toLowerCase()),
    );
    const employee = match ? { id: match.id, locationId: match.location_id ?? null } : null;
    this.employeeByEmails.set(cacheKey, employee);
    return employee;
  }

  /** Leave type names by id. The leaves list leaves `leave_type_name` empty, so they are looked up here. */
  private getLeaveTypeNames(): Promise<Map<number, string>> {
    this.leaveTypeNames ??= this.list<{ id: number; name?: string | null }>('timeoff/leave_types')
      .then((types) => new Map(types.map((t) => [t.id, t.name ?? ''])))
      .catch((err) => {
        this.leaveTypeNames = null; // do not cache a failure
        throw err;
      });
    return this.leaveTypeNames;
  }

  /** Time-off requests of one employee that overlap [from, to]. */
  async listLeaves(employeeId: number, from: string, to: string): Promise<Leave[]> {
    const [rows, typeNames] = await Promise.all([
      this.list<RawLeave>('timeoff/leaves', [
        ['employee_ids[]', String(employeeId)],
        ['from', from],
        ['to', to],
      ]),
      this.getLeaveTypeNames(),
    ]);
    const typeOf = (l: RawLeave): string =>
      l.leave_type_name || (l.leave_type_id != null ? typeNames.get(l.leave_type_id) : '') || 'Time off';
    return rows
      .filter((l) => l.employee_id === employeeId && l.start_on <= to && l.finish_on >= from)
      .map((l) => ({
        from: l.start_on,
        to: l.finish_on,
        type: typeOf(l),
        approved: l.approved ?? null,
        halfDay: l.half_day ?? null,
        hours: l.hours_amount_in_cents != null ? l.hours_amount_in_cents / 100 : null,
      }));
  }

  /**
   * Company holidays of one location within [from, to].
   * The endpoint ignores date filters, so the range is applied here.
   */
  async listCompanyHolidays(locationId: number, from: string, to: string): Promise<CompanyHoliday[]> {
    const rows = await this.list<RawHoliday>('holidays/company_holidays', [
      ['location_ids[]', String(locationId)],
    ]);
    return rows
      .filter((h) => h.location_id === locationId && h.date >= from && h.date <= to)
      .map((h) => ({ date: h.date, name: h.summary ?? 'Company holiday', halfDay: h.half_day ?? null }));
  }
}
