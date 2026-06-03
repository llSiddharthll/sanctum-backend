import argon2 from 'argon2';

/**
 * Argon2id password hashing (OWASP baseline params).
 */
const OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // ~19 MiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, OPTS);
}

export async function verifyPassword(
  hash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}
