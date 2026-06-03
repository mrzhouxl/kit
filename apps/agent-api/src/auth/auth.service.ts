import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { db, users } from "../database/index.js";
import { hashPassword, verifyPassword } from "./password.js";

interface RegisterUserParams {
  phone: string;
  password: string;
  username: string;
  nickname: string;
}

export interface AuthUser {
  id: number;
  phone: string;
  username: string;
  nickname: string;
}

@Injectable()
export class AuthService {
  /**
   * 按手机号查找用户。
   */
  async findByPhone(phone: string): Promise<AuthUser | null> {
    const row = await db.query.users.findFirst({
      where: eq(users.phone, phone),
    });
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      phone: row.phone,
      username: row.username,
      nickname: row.nickname,
    };
  }

  /**
   * 创建新用户并返回脱敏用户信息。
   */
  async register(params: RegisterUserParams): Promise<AuthUser> {
    const now = new Date();
    const passwordHash = hashPassword(params.password);

    await db.insert(users).values({
      phone: params.phone,
      username: params.username,
      nickname: params.nickname,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    });

    const created = await db.query.users.findFirst({
      where: eq(users.phone, params.phone),
    });
    if (!created) {
      throw new Error("用户创建失败");
    }
    return {
      id: created.id,
      phone: created.phone,
      username: created.username,
      nickname: created.nickname,
    };
  }

  /**
   * 校验手机号和密码，成功时返回用户。
   */
  async verifyLogin(phone: string, password: string): Promise<AuthUser | null> {
    const row = await db.query.users.findFirst({
      where: eq(users.phone, phone),
    });
    if (!row) {
      return null;
    }
    if (!verifyPassword(password, row.passwordHash)) {
      return null;
    }
    return {
      id: row.id,
      phone: row.phone,
      username: row.username,
      nickname: row.nickname,
    };
  }
}
