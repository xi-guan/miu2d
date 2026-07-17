const SALT_ROUNDS = 12;

/**
 * Hash a plaintext password with bcrypt (Bun native).
 */
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: SALT_ROUNDS });
}

/**
 * Compare a plaintext password against a stored bcrypt hash.
 * >72 字节密码 node bcrypt 截断而 Bun 先 SHA-512 预哈希, 结果不同; 存量 hash 已实测双向兼容
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

/**
 * Return true when the stored value looks like a bcrypt hash.
 * Used by the rehash migration to detect un-hashed legacy passwords.
 */
export function isBcryptHash(value: string): boolean {
  return /^\$2[aby]\$\d{2}\$/.test(value);
}
