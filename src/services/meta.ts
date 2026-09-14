/**
 * Meta Graph API client: Facebook Login (OAuth), a user's Pages with their
 * linked Instagram business accounts, and publishing to Instagram / Pages.
 *
 * Plain fetch (like refrens.ts) so tests can stub it. Calls carry an
 * appsecret_proof, which Meta requires when "Require App Secret" is on.
 */
import crypto from 'node:crypto';
import { env } from '../env.js';

/** True when the Meta app credentials are configured on the server. */
export const metaConfigured = (): boolean =>
  Boolean(env.META_APP_ID && env.META_APP_SECRET);

const graphBase = () => `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;

/** Facebook Login scopes: list Pages, publish to them and their linked Instagram accounts. */
export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
] as const;

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }

  /** Token expired/revoked or a permission is missing — reconnecting fixes it. */
  get isAuthError(): boolean {
    const c = this.code;
    return c === 190 || c === 102 || c === 10 || (c !== undefined && c >= 200 && c < 300);
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;

async function graph<T>(
  path: string,
  opts: { method?: 'GET' | 'POST'; params?: Params; token?: string } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  if (opts.token) {
    params.set('access_token', opts.token);
    params.set(
      'appsecret_proof',
      crypto
        .createHmac('sha256', env.META_APP_SECRET ?? '')
        .update(opts.token)
        .digest('hex'),
    );
  }
  const url = `${graphBase()}${path}`;
  const res =
    method === 'GET'
      ? await fetch(`${url}?${params}`)
      : await fetch(url, { method, body: params });

  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok || body?.error) {
    const e = body?.error ?? {};
    throw new MetaApiError(
      String(e.error_user_msg || e.message || `Meta API error (${res.status})`),
      res.status,
      typeof e.code === 'number' ? e.code : undefined,
    );
  }
  return body as T;
}

// ---------------------------------------------------------------------------
//  OAuth
// ---------------------------------------------------------------------------

/** URL of the Facebook Login dialog for this app. */
export function authorizeUrl(state: string, redirectUri: string): string {
  const u = new URL(`https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth`);
  u.searchParams.set('client_id', env.META_APP_ID ?? '');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('response_type', 'code');
  if (env.META_LOGIN_CONFIG_ID) {
    u.searchParams.set('config_id', env.META_LOGIN_CONFIG_ID);
    u.searchParams.set('override_default_response_type', 'true');
  } else {
    u.searchParams.set('scope', META_SCOPES.join(','));
  }
  return u.toString();
}

/** Exchange the login code for a long-lived user token (Page tokens derived from it don't expire). */
export async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const short = await graph<{ access_token: string }>('/oauth/access_token', {
    params: {
      client_id: env.META_APP_ID,
      client_secret: env.META_APP_SECRET,
      redirect_uri: redirectUri,
      code,
    },
  });
  const long = await graph<{ access_token: string }>('/oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: env.META_APP_ID,
      client_secret: env.META_APP_SECRET,
      fb_exchange_token: short.access_token,
    },
  });
  return long.access_token;
}

export async function fetchMetaUser(token: string): Promise<{ id: string; name: string | null }> {
  const me = await graph<{ id: string; name?: string }>('/me', {
    params: { fields: 'id,name' },
    token,
  });
  return { id: me.id, name: me.name ?? null };
}

// ---------------------------------------------------------------------------
//  Pages + Instagram accounts
// ---------------------------------------------------------------------------

export interface MetaInstagram {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  followers: number | null;
}

export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  pictureUrl: string | null;
  instagram: MetaInstagram | null;
}

const PAGE_FIELDS =
  'id,name,access_token,picture{url},' +
  'instagram_business_account{id,username,name,profile_picture_url,followers_count}';

/** Pages the user granted, each with its Page token and linked Instagram account. */
export async function listPages(userToken: string): Promise<MetaPage[]> {
  type Raw = {
    id: string;
    name: string;
    access_token: string;
    picture?: { data?: { url?: string } };
    instagram_business_account?: {
      id: string;
      username?: string;
      name?: string;
      profile_picture_url?: string;
      followers_count?: number;
    };
  };
  const out: MetaPage[] = [];
  let after: string | undefined;
  for (let i = 0; i < 10; i++) {
    const r = await graph<{
      data?: Raw[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>('/me/accounts', {
      params: { fields: PAGE_FIELDS, limit: 100, after },
      token: userToken,
    });
    for (const p of r.data ?? []) {
      const ig = p.instagram_business_account;
      out.push({
        id: p.id,
        name: p.name,
        accessToken: p.access_token,
        pictureUrl: p.picture?.data?.url ?? null,
        instagram: ig
          ? {
              id: ig.id,
              username: ig.username ?? null,
              name: ig.name ?? null,
              avatarUrl: ig.profile_picture_url ?? null,
              followers: ig.followers_count ?? null,
            }
          : null,
      });
    }
    after = r.paging?.next ? r.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

export async function instagramProfile(igId: string, token: string): Promise<MetaInstagram> {
  const r = await graph<{
    id: string;
    username?: string;
    name?: string;
    profile_picture_url?: string;
    followers_count?: number;
  }>(`/${igId}`, {
    params: { fields: 'id,username,name,profile_picture_url,followers_count' },
    token,
  });
  return {
    id: r.id,
    username: r.username ?? null,
    name: r.name ?? null,
    avatarUrl: r.profile_picture_url ?? null,
    followers: r.followers_count ?? null,
  };
}

export async function pageProfile(
  pageId: string,
  token: string,
): Promise<{ name: string | null; pictureUrl: string | null; followers: number | null }> {
  const r = await graph<{
    name?: string;
    picture?: { data?: { url?: string } };
    followers_count?: number;
    fan_count?: number;
  }>(`/${pageId}`, {
    params: { fields: 'name,picture{url},followers_count,fan_count' },
    token,
  });
  return {
    name: r.name ?? null,
    pictureUrl: r.picture?.data?.url ?? null,
    followers: r.followers_count ?? r.fan_count ?? null,
  };
}

// ---------------------------------------------------------------------------
//  Publishing
// ---------------------------------------------------------------------------

export interface PublishMedia {
  url: string;
  video: boolean;
}

export interface PublishInput {
  postType: 'reel' | 'story' | 'carousel' | 'post';
  caption: string;
  media: PublishMedia[];
}

export interface Published {
  id: string;
  permalink: string | null;
}

const mediaSource = (m: PublishMedia) =>
  m.video ? { video_url: m.url } : { image_url: m.url };

/**
 * Create the Instagram media container for a post (not visible yet). Video
 * containers process asynchronously — poll igContainerStatus before publishing.
 */
export async function igCreateContainer(
  igId: string,
  token: string,
  input: PublishInput,
): Promise<string> {
  const { postType, caption, media } = input;
  const first = media[0];
  if (!first) {
    throw new MetaApiError('Instagram posts need at least one image or video.', 400);
  }

  if (postType === 'story') {
    const r = await graph<{ id: string }>(`/${igId}/media`, {
      method: 'POST',
      token,
      params: { media_type: 'STORIES', ...mediaSource(first) },
    });
    return r.id;
  }

  if (media.length > 1 && postType !== 'reel') {
    const children: string[] = [];
    for (const m of media.slice(0, 10)) {
      const c = await graph<{ id: string }>(`/${igId}/media`, {
        method: 'POST',
        token,
        params: {
          is_carousel_item: true,
          ...(m.video ? { media_type: 'VIDEO' } : {}),
          ...mediaSource(m),
        },
      });
      children.push(c.id);
    }
    const r = await graph<{ id: string }>(`/${igId}/media`, {
      method: 'POST',
      token,
      params: { media_type: 'CAROUSEL', children: children.join(','), caption },
    });
    return r.id;
  }

  // Instagram only accepts feed videos as Reels.
  if (first.video) {
    const r = await graph<{ id: string }>(`/${igId}/media`, {
      method: 'POST',
      token,
      params: { media_type: 'REELS', video_url: first.url, caption, share_to_feed: true },
    });
    return r.id;
  }

  const r = await graph<{ id: string }>(`/${igId}/media`, {
    method: 'POST',
    token,
    params: { image_url: first.url, caption },
  });
  return r.id;
}

/** FINISHED | IN_PROGRESS | ERROR | EXPIRED | PUBLISHED */
export async function igContainerStatus(
  containerId: string,
  token: string,
): Promise<{ code: string; message: string | null }> {
  const r = await graph<{ status_code?: string; status?: string }>(`/${containerId}`, {
    params: { fields: 'status_code,status' },
    token,
  });
  return { code: r.status_code ?? 'IN_PROGRESS', message: r.status ?? null };
}

export async function igPublishContainer(
  igId: string,
  containerId: string,
  token: string,
): Promise<Published> {
  const r = await graph<{ id: string }>(`/${igId}/media_publish`, {
    method: 'POST',
    token,
    params: { creation_id: containerId },
  });
  let permalink: string | null = null;
  try {
    const p = await graph<{ permalink?: string }>(`/${r.id}`, {
      params: { fields: 'permalink' },
      token,
    });
    permalink = p.permalink ?? null;
  } catch {
    // The post is live either way; the link is a nicety.
  }
  return { id: r.id, permalink };
}

/** Publish to a Facebook Page (text, photo, photo album, or video). */
export async function fbPublish(
  pageId: string,
  token: string,
  input: PublishInput,
): Promise<Published> {
  const { caption, media } = input;
  const images = media.filter((m) => !m.video);
  const video = media.find((m) => m.video);
  const postLink = (id: string) => `https://www.facebook.com/${id}`;

  if (video && (images.length === 0 || input.postType === 'reel')) {
    const r = await graph<{ id: string }>(`/${pageId}/videos`, {
      method: 'POST',
      token,
      params: { file_url: video.url, description: caption },
    });
    return { id: r.id, permalink: `https://www.facebook.com/${pageId}/videos/${r.id}` };
  }

  if (images.length === 1) {
    const r = await graph<{ id: string; post_id?: string }>(`/${pageId}/photos`, {
      method: 'POST',
      token,
      params: { url: images[0].url, message: caption },
    });
    const id = r.post_id ?? r.id;
    return { id, permalink: postLink(id) };
  }

  if (images.length > 1) {
    const ids: string[] = [];
    for (const m of images.slice(0, 10)) {
      const r = await graph<{ id: string }>(`/${pageId}/photos`, {
        method: 'POST',
        token,
        params: { url: m.url, published: false },
      });
      ids.push(r.id);
    }
    const r = await graph<{ id: string }>(`/${pageId}/feed`, {
      method: 'POST',
      token,
      params: {
        message: caption,
        attached_media: JSON.stringify(ids.map((id) => ({ media_fbid: id }))),
      },
    });
    return { id: r.id, permalink: postLink(r.id) };
  }

  const r = await graph<{ id: string }>(`/${pageId}/feed`, {
    method: 'POST',
    token,
    params: { message: caption },
  });
  return { id: r.id, permalink: postLink(r.id) };
}

// ---------------------------------------------------------------------------
//  Platform callbacks
// ---------------------------------------------------------------------------

/** Verify and decode a Meta `signed_request` (deauthorize / data-deletion callbacks). */
export function parseSignedRequest(signed: string): { user_id?: string } | null {
  const [sig, payload] = signed.split('.');
  if (!sig || !payload || !env.META_APP_SECRET) return null;
  const expected = crypto
    .createHmac('sha256', env.META_APP_SECRET)
    .update(payload)
    .digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
