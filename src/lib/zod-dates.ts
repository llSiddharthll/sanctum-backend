import { z } from 'zod';

/**
 * An optional date in a request body or query. `null` and `''` mean "not
 * given". (Plain `z.coerce.date().optional()` runs `new Date(null)`, which is
 * 1 Jan 1970: a task created on the web with no due date showed as overdue.)
 * For PATCH bodies where `null` must CLEAR a date, use
 * `z.coerce.date().nullable().optional()` instead.
 */
export const optionalDate = () =>
  z.preprocess((v) => (v === null || v === '' ? undefined : v), z.coerce.date().optional());
