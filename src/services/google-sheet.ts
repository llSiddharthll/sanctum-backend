import { AppError } from '../lib/errors.js';

/**
 * Fetch a Google Sheet as CSV.
 *
 * SECURITY: the user-supplied URL is never fetched. We extract the spreadsheet
 * id (and optional gid) from it and rebuild a canonical docs.google.com export
 * URL ourselves, so a pasted link can't point the server at an internal host,
 * a redirect chain, or a non-Google origin. Anything that doesn't look like a
 * Google Sheets URL is rejected before any network call happens.
 */

/** Spreadsheet ids are the long opaque segment after /d/. */
const ID_RE = /\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/;
/** The tab is carried either as #gid=N or ?gid=N. */
const GID_RE = /[#&?]gid=([0-9]+)/;

const FETCH_TIMEOUT_MS = 15_000;
/** Generous for a content calendar; stops a huge sheet exhausting memory. */
const MAX_BYTES = 5 * 1024 * 1024;

export interface GoogleSheetCsv {
  csv: string;
  spreadsheetId: string;
  gid: string;
}

export function parseGoogleSheetUrl(raw: string): {
  spreadsheetId: string;
  gid: string;
} {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError('VALIDATION_ERROR', 'That is not a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw new AppError('VALIDATION_ERROR', 'The link must start with https://');
  }
  if (
    url.hostname !== 'docs.google.com' &&
    url.hostname !== 'www.docs.google.com'
  ) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Only Google Sheets links (docs.google.com) can be imported.',
    );
  }
  const id = ID_RE.exec(url.pathname)?.[1];
  if (!id) {
    throw new AppError(
      'VALIDATION_ERROR',
      "That link doesn't contain a spreadsheet id. Copy the URL from the browser bar with the sheet open.",
    );
  }
  // gid can live in the hash or the query depending on how it was copied.
  const gid = GID_RE.exec(url.hash)?.[1] ?? GID_RE.exec(url.search)?.[1] ?? '0';
  return { spreadsheetId: id, gid };
}

export async function fetchGoogleSheetCsv(raw: string): Promise<GoogleSheetCsv> {
  const { spreadsheetId, gid } = parseGoogleSheetUrl(raw);
  const target = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
    spreadsheetId,
  )}/export?format=csv&gid=${encodeURIComponent(gid)}`;

  let res: Response;
  try {
    res = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'text/csv,text/plain,*/*' },
    });
  } catch {
    throw new AppError(
      'VALIDATION_ERROR',
      'Could not reach Google Sheets. Check the link and try again.',
    );
  }

  // Google answers an unshared sheet with a sign-in page (302 -> 200 HTML) or
  // a 401/403, never CSV — so both are reported as the same fixable problem.
  if (res.status === 401 || res.status === 403) {
    throw new AppError('VALIDATION_ERROR', SHARE_HINT);
  }
  if (res.status === 404) {
    throw new AppError(
      'VALIDATION_ERROR',
      'That spreadsheet or tab could not be found. Check the link.',
    );
  }
  if (!res.ok) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Google Sheets returned ${res.status}. Try again in a moment.`,
    );
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    throw new AppError('VALIDATION_ERROR', SHARE_HINT);
  }

  const len = Number(res.headers.get('content-length') ?? '0');
  if (len > MAX_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'That sheet is too large to import.');
  }

  const csv = await res.text();
  if (csv.length > MAX_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'That sheet is too large to import.');
  }
  if (!csv.trim()) {
    throw new AppError('VALIDATION_ERROR', 'That sheet tab is empty.');
  }
  return { csv, spreadsheetId, gid };
}

const SHARE_HINT =
  'That sheet is not shared. In Google Sheets open Share -> General access -> "Anyone with the link" (Viewer is enough), then paste the link again.';
