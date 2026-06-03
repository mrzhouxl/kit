import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_KEY_LEN = 64;

/**
 * 生成可持久化的密码哈希（格式：salt.hash）。
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, SCRYPT_KEY_LEN).toString("base64url");
  return `${salt}.${hash}`;
}

/**
 * 校验明文密码是否匹配持久化哈希。
 */
export function verifyPassword(password: string, passwordHash: string): boolean {
  const [salt, stored] = passwordHash.split(".");
  if (!salt || !stored) {
    return false;
  }

  const expectedBuffer = Buffer.from(stored, "base64url");
  const actualBuffer = scryptSync(password, salt, SCRYPT_KEY_LEN);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}
