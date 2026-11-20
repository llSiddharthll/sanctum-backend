/**
 * Platform names arrive in many spellings (Google Sheet cells, old data, AI
 * output): "Instagram", "IG", "Twitter", "Google Business"... Everything is
 * stored and compared as the canonical lowercase key; unknown names are dropped.
 */
const ALIASES: Record<string, string> = {
  instagram: 'instagram', insta: 'instagram', ig: 'instagram', 'instagram reels': 'instagram', reels: 'instagram',
  facebook: 'facebook', fb: 'facebook', 'facebook page': 'facebook', meta: 'facebook',
  threads: 'threads',
  linkedin: 'linkedin', 'linked in': 'linkedin', li: 'linkedin',
  youtube: 'youtube', yt: 'youtube', 'youtube shorts': 'youtube', shorts: 'youtube',
  google_business: 'google_business', 'google business': 'google_business',
  'google business profile': 'google_business', 'google my business': 'google_business', gmb: 'google_business', gbp: 'google_business',
  x: 'x', twitter: 'x', 'x (twitter)': 'x', 'twitter / x': 'x', 'x / twitter': 'x',
  tiktok: 'tiktok', 'tik tok': 'tiktok',
  pinterest: 'pinterest',
};

export function normalizePlatform(raw: unknown): string | null {
  const key = String(raw ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  return ALIASES[key] ?? ALIASES[key.replace(/ /g, '_')] ?? null;
}

/** Canonical, de-duplicated platform keys (unknown names dropped). */
export function normalizePlatforms(list: unknown): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const p = normalizePlatform(raw);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
