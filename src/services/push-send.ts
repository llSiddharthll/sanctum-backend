/**
 * FCM push delivery (keyless). Uses firebase-admin with Application Default
 * Credentials — on the GCE VM this authenticates via the metadata server (the
 * attached service account), so NO service-account key file is needed (which
 * the org policy forbids anyway). Everything is best-effort: a failed/missing
 * credential must never break the in-app notification that triggered it.
 */
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pushTokens } from '../db/schema.js';

const PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.FIREBASE_PROJECT_ID ||
  'project-701ed07f-d4dc-49f9-944';

let ready = false;
let initTried = false;
function ensureApp(): boolean {
  if (ready) return true;
  if (initTried) return false; // don't spam init on every notification
  initTried = true;
  try {
    if (getApps().length === 0) {
      initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
    }
    ready = true;
  } catch (e) {
    console.warn('[push] firebase-admin init failed:', (e as Error).message);
  }
  return ready;
}

export async function sendPushToUser(
  userId: string,
  payload: { title: string; body?: string | null; data?: Record<string, string> },
): Promise<void> {
  try {
    if (!ensureApp()) return;
    const rows = await db
      .select({ token: pushTokens.token })
      .from(pushTokens)
      .where(eq(pushTokens.userId, userId));
    const tokens = rows.map((r) => r.token);
    if (tokens.length === 0) return;

    const res = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: payload.title, body: payload.body ?? undefined },
      data: payload.data ?? {},
      android: { priority: 'high' },
    });

    // Prune tokens the server tells us are permanently invalid.
    const dead: string[] = [];
    res.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code ?? '';
        if (
          code.includes('registration-token-not-registered') ||
          code.includes('invalid-registration-token') ||
          code.includes('invalid-argument')
        ) {
          dead.push(tokens[i]!);
        }
      }
    });
    if (dead.length) {
      await db.delete(pushTokens).where(inArray(pushTokens.token, dead));
    }
  } catch (e) {
    console.warn('[push] send failed:', (e as Error).message);
  }
}
