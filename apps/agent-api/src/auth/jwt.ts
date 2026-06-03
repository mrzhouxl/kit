import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpException, HttpStatus } from "@nestjs/common";
import { jwtConfig } from "../config.js";

interface JwtHeader {
  alg?: string;
  typ?: string;
}

interface JwtPayload {
  user_id?: number;
  userId?: number;
  username?: string;
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
}

interface SignJwtOptions {
  userId: number;
  username?: string;
  expiresInSeconds?: number;
}

function normalizeAuthorizationToken(authorization?: string): string {
  const auth = authorization?.trim();
  if (!auth) {
    throw new HttpException("未提供认证信息", HttpStatus.UNAUTHORIZED);
  }
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : auth;
}

function decodeJwtPart<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf-8")) as T;
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

export function signHs256Jwt({ userId, username, expiresInSeconds = 24 * 3600 }: SignJwtOptions): string {
  const now = Math.floor(Date.now() / 1000);
  const header: JwtHeader = { alg: "HS256", typ: "JWT" };
  const payload: JwtPayload = {
    user_id: userId,
    userId,
    sub: String(userId),
    username,
    iat: now,
    exp: now + Math.max(1, expiresInSeconds),
  };

  const encodedHeader = encodeJwtPart(header);
  const encodedPayload = encodeJwtPart(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", jwtConfig.secret)
    .update(signingInput)
    .digest("base64url");

  return `${signingInput}.${signature}`;
}

function verifyHs256Signature(token: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new HttpException("无效的认证令牌", HttpStatus.UNAUTHORIZED);
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = decodeJwtPart<JwtHeader>(encodedHeader);
    payload = decodeJwtPart<JwtPayload>(encodedPayload);
  } catch {
    throw new HttpException("无效的认证令牌", HttpStatus.UNAUTHORIZED);
  }

  if (header.alg !== "HS256") {
    throw new HttpException("不支持的认证算法", HttpStatus.UNAUTHORIZED);
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = createHmac("sha256", jwtConfig.secret)
    .update(signingInput)
    .digest("base64url");

  const actualBuffer = Buffer.from(encodedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    actualBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new HttpException("登录凭证无效", HttpStatus.UNAUTHORIZED);
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.nbf === "number" && payload.nbf > now) {
    throw new HttpException("登录凭证尚未生效", HttpStatus.UNAUTHORIZED);
  }
  if (typeof payload.exp === "number" && payload.exp <= now) {
    throw new HttpException("未登录或登录已过期", HttpStatus.UNAUTHORIZED);
  }

  return payload;
}

export function extractUserIdFromAuthorizationHeader(authorization?: string): number {
  const token = normalizeAuthorizationToken(authorization);
  const payload = verifyHs256Signature(token);
  const userId = payload.user_id ?? payload.userId ?? (payload.sub ? Number(payload.sub) : undefined);
  if (!userId || !Number.isInteger(userId)) {
    throw new HttpException("无效的认证令牌", HttpStatus.UNAUTHORIZED);
  }
  return userId;
}