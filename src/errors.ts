/**
 * Why a verification could not produce a report at all.
 *
 * - `USAGE`: the options are wrong (missing dump, bad tolerance, no source).
 * - `ENVIRONMENT`: the machine or server is not ready (no `psql` on PATH, the
 *   source cannot be reached, no permission to create a database).
 * - `ABORTED`: the caller's `AbortSignal` fired (the CLI wires SIGINT and
 *   SIGTERM to it). The scratch database has been dropped by the time this is
 *   thrown, unless `scratchDropped` says otherwise.
 *
 * A dump that fails to restore, or restores to different row counts, is not an
 * error: it is a report with `ok: false`.
 */
export type VerifyErrorCode = 'USAGE' | 'ENVIRONMENT' | 'ABORTED';

export class VerifyError extends Error {
  readonly code: VerifyErrorCode;
  /** For `ABORTED`: whether the scratch database was dropped (null if none was created). */
  scratchDropped: boolean | null = null;
  /** For `ABORTED`: the scratch database's name, when one had been created. */
  scratchDatabase: string | null = null;

  constructor(code: VerifyErrorCode, message: string) {
    super(message);
    this.name = 'VerifyError';
    this.code = code;
  }
}

export const usage = (message: string) => new VerifyError('USAGE', message);
export const environment = (message: string) => new VerifyError('ENVIRONMENT', message);
