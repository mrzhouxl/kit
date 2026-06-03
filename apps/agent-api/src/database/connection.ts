/**
 * database/connection.ts — Drizzle ORM 数据库连接
 *
 * 开源版默认使用本地 SQLite 文件（独立数据，不影响正式库）。
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { databaseConfig } from "../config.js";
import * as schema from "./schema.js";

/** SQLite 数据库文件绝对路径 */
const sqlitePath = resolve(process.cwd(), databaseConfig.sqlitePath);
const sqliteDir = dirname(sqlitePath);
if (!existsSync(sqliteDir)) {
  mkdirSync(sqliteDir, { recursive: true });
}

/** SQLite 连接 */
const sqlite = new Database(sqlitePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

/** Drizzle ORM 实例（带 schema 类型推导） */
export const db = drizzle(sqlite, { schema });

/** 关闭数据库连接 */
export async function closeDatabase(): Promise<void> {
  sqlite.close();
  console.log("[Database] SQLite 已关闭");
}

/** 测试数据库连接 */
export async function testConnection(): Promise<void> {
  sqlite.prepare("SELECT 1").get();
  console.log(`[Database] SQLite 连接成功: ${sqlitePath}`);
}
