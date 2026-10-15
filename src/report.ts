import { formatTolerance } from './compare.js';
import type { TableResult } from './compare.js';
import type { Report } from './index.js';
import { formatAge } from './age.js';

export interface FormatOptions {
  /** ANSI colors for mismatches (red), tolerated drift (yellow) and matches (green). @defaultValue false */
  color?: boolean;
  /** Restore errors and warnings shown before "and N more". @defaultValue 20 */
  maxMessages?: number;
}

const STATUS_TEXT: Record<TableResult['status'], string> = {
  match: 'ok',
  'within-tolerance': 'ok (within tolerance)',
  'restored-fewer': 'MISMATCH  restored fewer',
  'restored-more': 'MISMATCH  restored more',
  'missing-in-restore': 'MISSING   not in restore',
  'missing-in-source': 'EXTRA     not in source',
  restored: 'restored',
};

const n = (v: number | null) => (v === null ? '-' : v.toLocaleString('en-US'));
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const signed = (v: number | null) => (v === null ? '' : v > 0 ? `+${n(v)}` : n(v));

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Renders a {@link Report} as the human-readable text the CLI prints. */
export function formatReport(report: Report, options: FormatOptions = {}): string {
  const c = (code: string) => (s: string) => (options.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const red = c('31');
  const green = c('32');
  const yellow = c('33');
  const bold = c('1');
  const dim = c('2');
  const max = options.maxMessages ?? 20;
  const lines: string[] = [];
  const d = report.dump;

  const age = formatAge(new Date(report.startedAt).getTime() - new Date(d.modifiedAt).getTime());
  lines.push(
    `${bold('Dump')}     ${d.path}  ${dim(`(${d.format}${d.sizeBytes ? `, ${size(d.sizeBytes)}` : ''}, modified ${age} ago)`)}`,
  );
  if (report.source) {
    lines.push(`${bold('Source')}   ${report.source.url}  ${dim(`(Postgres ${report.source.serverVersion})`)}`);
  } else {
    lines.push(`${bold('Source')}   ${dim('none (--no-source): proving the dump restores, not comparing')}`);
  }
  const where = report.scratch.sameServerAsSource ? 'on the same server' : `at ${report.scratch.url}`;
  const fate = report.scratch.kept ? yellow('kept') : report.scratch.dropped ? 'dropped' : red('NOT dropped');
  lines.push(`${bold('Scratch')}  ${report.scratch.database} ${where}  ${dim('(')}${fate}${dim(')')}`);
  const r = report.restore;
  const rs = r.status === 'clean' ? green('clean') : r.status === 'with-errors' ? yellow('finished with errors') : red('FAILED');
  lines.push(
    `${bold('Restore')}  ${r.tool} ${r.clientVersion}: ${rs}${r.exitCode ? dim(` (exit ${r.exitCode})`) : ''}, ${(r.durationMs / 1000).toFixed(1)} s`,
  );
  lines.push('');

  if (report.tables.length) {
    const head = report.source ? ['table', 'restored', 'source', 'diff', 'status'] : ['table', 'rows'];
    const rows = report.tables.map((t) =>
      report.source
        ? [`${t.schema}.${t.table}`, n(t.restored), n(t.source), signed(t.difference), STATUS_TEXT[t.status]]
        : [`${t.schema}.${t.table}`, n(t.restored)],
    );
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
    const fmt = (cells: string[]) =>
      cells
        .map((cell, i) => (i === 0 || i === cells.length - 1 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
        .join('  ')
        .trimEnd();
    lines.push(`  ${dim(fmt(head))}`);
    report.tables.forEach((t, i) => {
      const text = fmt(rows[i]!);
      const paint = t.ok ? (t.status === 'within-tolerance' ? yellow : (s: string) => s) : red;
      lines.push(`  ${paint(text)}`);
    });
    lines.push('');
  }

  const s = report.summary;
  if (report.source) {
    const bad = s.restoredFewer + s.restoredMore + s.missingInRestore + s.missingInSource;
    const parts = [plural(s.tables, 'table'), `${s.matched} match`];
    if (s.withinTolerance) parts.push(`${s.withinTolerance} within tolerance (${formatTolerance(report.tolerance)})`);
    if (bad) parts.push(red(`${bad} mismatched`));
    lines.push(`${parts.join(', ')}. ${n(s.restoredRows)} rows restored, ${n(s.sourceRows)} in the source.`);
  } else {
    lines.push(`${plural(s.tables, 'table')}, ${n(s.restoredRows)} rows restored.`);
  }

  const messages = [...r.errors.map((m) => ['error', m] as const), ...r.warnings.map((m) => ['warning', m] as const)];
  if (messages.length) {
    lines.push('', bold(`${r.tool} reported ${r.errors.length} error(s) and ${r.warnings.length} warning(s):`));
    for (const [, m] of messages.slice(0, max)) lines.push(...m.split('\n').map((l) => `  ${l}`));
    if (messages.length > max) lines.push(dim(`  ... and ${messages.length - max} more (use --json for all of them)`));
  }

  if (report.notes.length) {
    lines.push('');
    for (const note of report.notes) lines.push(`${yellow('note')} ${note}`);
  }

  lines.push('');
  if (report.verdict === 'verified') {
    lines.push(
      green(
        report.source
          ? 'VERIFIED: the dump restored into a scratch database and every table matched the source.'
          : 'RESTORES: the dump restored cleanly into a scratch database (nothing was compared).',
      ),
    );
  } else if (report.verdict === 'mismatch') {
    lines.push(red('NOT VERIFIED: the restored dump does not match the source. Do not rely on it until you know why.'));
  } else {
    lines.push(red('NOT VERIFIED: the dump did not restore cleanly. Do not rely on it.'));
  }
  return lines.join('\n');
}
