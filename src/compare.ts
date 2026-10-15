import { usage } from './errors.js';

/** How far a restored count may drift from the source before it is a mismatch. */
export type Tolerance = { kind: 'rows'; value: number } | { kind: 'percent'; value: number };

/** `"0"`, `"25"` (rows) or `"0.5%"` (of the source count). */
export function parseTolerance(input: string | number | Tolerance | undefined): Tolerance {
  if (input === undefined) return { kind: 'rows', value: 0 };
  if (typeof input === 'object') return validate(input);
  const s = String(input).trim();
  const m = /^(\d+(?:\.\d+)?)(%?)$/.exec(s);
  if (!m?.[1]) {
    throw usage(`--tolerance must be a number of rows (e.g. 10) or a percentage (e.g. 0.5%), got "${s}".`);
  }
  const value = Number(m[1]);
  if (m[2] === '%') return validate({ kind: 'percent', value });
  if (!Number.isInteger(value)) throw usage(`--tolerance in rows must be a whole number, got "${s}".`);
  return validate({ kind: 'rows', value });
}

function validate(t: Tolerance): Tolerance {
  if (!Number.isFinite(t.value) || t.value < 0) throw usage('--tolerance cannot be negative.');
  if (t.kind === 'percent' && t.value > 100) throw usage('--tolerance cannot exceed 100%.');
  return t;
}

export const formatTolerance = (t: Tolerance) => (t.kind === 'percent' ? `${t.value}%` : `${t.value} rows`);

/**
 * - `match`: identical counts.
 * - `within-tolerance`: different, but inside `--tolerance`.
 * - `restored-fewer` / `restored-more`: different, outside the tolerance.
 * - `missing-in-restore`: in the source, not in the restored dump.
 * - `missing-in-source`: in the restored dump, not in the source.
 * - `restored`: `--no-source` mode, nothing to compare against.
 */
export type TableStatus =
  | 'match'
  | 'within-tolerance'
  | 'restored-fewer'
  | 'restored-more'
  | 'missing-in-restore'
  | 'missing-in-source'
  | 'restored';

export interface TableResult {
  schema: string;
  table: string;
  /** Exact row count in the scratch database, or null when the table was not restored. */
  restored: number | null;
  /** Exact row count in the source, or null when absent there (or in `--no-source` mode). */
  source: number | null;
  /** `restored - source` when both exist. Negative: the restore has fewer rows. */
  difference: number | null;
  status: TableStatus;
  ok: boolean;
}

export function withinTolerance(restored: number, source: number, t: Tolerance): boolean {
  const diff = Math.abs(restored - source);
  if (t.kind === 'rows') return diff <= t.value;
  return diff <= (source * t.value) / 100;
}

const split = (key: string) => {
  const i = key.indexOf('.');
  return { schema: key.slice(0, i), table: key.slice(i + 1) };
};

/** Compares per-table counts. `source` is null in `--no-source` mode. */
export function compareCounts(
  restored: Map<string, number>,
  source: Map<string, number> | null,
  tolerance: Tolerance,
): TableResult[] {
  const keys = new Set([...restored.keys(), ...(source?.keys() ?? [])]);
  return [...keys].sort().map((key) => {
    const r = restored.get(key);
    const { schema, table } = split(key);
    if (!source) {
      return { schema, table, restored: r ?? null, source: null, difference: null, status: 'restored', ok: true };
    }
    const s = source.get(key);
    if (r === undefined) {
      return { schema, table, restored: null, source: s ?? null, difference: null, status: 'missing-in-restore', ok: false };
    }
    if (s === undefined) {
      return { schema, table, restored: r, source: null, difference: null, status: 'missing-in-source', ok: false };
    }
    const difference = r - s;
    if (difference === 0) return { schema, table, restored: r, source: s, difference, status: 'match', ok: true };
    if (withinTolerance(r, s, tolerance)) {
      return { schema, table, restored: r, source: s, difference, status: 'within-tolerance', ok: true };
    }
    return {
      schema,
      table,
      restored: r,
      source: s,
      difference,
      status: difference < 0 ? 'restored-fewer' : 'restored-more',
      ok: false,
    };
  });
}

/**
 * Glob match for `--exclude-table`: `*` matches any run of characters, `?` one.
 * A pattern with a dot is matched against `schema.table`; one without, against
 * the bare table name in any schema.
 */
export function matchesPattern(schema: string, table: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return p.includes('.') ? re.test(`${schema}.${table}`) : re.test(table);
  });
}
