import type { Request, Response } from 'express';
import { badRequest } from './errors.js';

/** Read a required single-value route param as a string (Express 5 params are loosely typed). */
export function param(req: Request, name: string): string {
  const raw = (req.params as Record<string, string | string[] | undefined>)[
    name
  ];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`Missing route parameter '${name}'.`);
  }
  return value;
}

/** Standard success envelope: { data, ...extra }. */
export function ok<T>(
  res: Response,
  data: T,
  status = 200,
  extra?: Record<string, unknown>,
): void {
  res.status(status).json({ data, ...(extra ?? {}) });
}

export function created<T>(
  res: Response,
  data: T,
  extra?: Record<string, unknown>,
): void {
  ok(res, data, 201, extra);
}

/** Serialize a Date (or unix-second number) to an ISO string or null. */
export function toIso(v: Date | number | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return new Date(v * 1000).toISOString();
}
