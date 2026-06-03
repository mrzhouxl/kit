/**
 * database/migrate.ts — 自动建表
 *
 * 应用启动时调用，确保开源版所需表结构存在。
 * 开源版默认使用 SQLite，本迁移仅针对 SQLite 语法。
 */
import { db } from "./connection.js";

/**
 * 执行自动迁移：创建并补齐开源版所需核心表。
 */
export async function runMigrations(): Promise<void> {
  console.log("[Database] 开始执行迁移...");

  // 创建 users 表（开源版本地账号表）
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      phone         TEXT NOT NULL,
      username      TEXT NOT NULL DEFAULT '',
      nickname      TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      updated_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );
  `);

  db.$client.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique
    ON users (phone);
  `);

  // 创建 chat_sessions 表（会话表）
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      thread_id   TEXT NOT NULL DEFAULT '',
      title       TEXT NOT NULL DEFAULT '新会话',
      mode        TEXT NOT NULL DEFAULT 'chat',
      created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      updated_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      deleted_at  INTEGER
    );
  `);

  db.$client.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id_updated_at
    ON chat_sessions (user_id, updated_at DESC);
  `);

  db.$client.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_thread_id_unique
    ON chat_sessions (thread_id);
  `);

  // 创建 chat_messages 表（消息表）
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    INTEGER NOT NULL,
      role          TEXT NOT NULL,
      content       TEXT NOT NULL DEFAULT '',
      metadata      TEXT,
      created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );
  `);

  // 为 chat_messages 添加索引
  db.$client.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id
    ON chat_messages (session_id);
  `);

  // 创建 chat_token_usages 表（用量表）
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS chat_token_usages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      thread_id     TEXT NOT NULL DEFAULT '',
      endpoint      TEXT NOT NULL,
      model         TEXT NOT NULL DEFAULT '',
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens  INTEGER NOT NULL DEFAULT 0,
      metadata      TEXT,
      created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );
  `);

  // 为 chat_token_usages 添加索引
  db.$client.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_token_usages_user_id_created_at
    ON chat_token_usages (user_id, created_at DESC);
  `);

  db.$client.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_token_usages_thread_id
    ON chat_token_usages (thread_id);
  `);

  // 创建 balance_logs（开源版兼容表，避免查询失败）
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS balance_logs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      credits       INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );
  `);

  db.$client.exec(`
    CREATE INDEX IF NOT EXISTS idx_balance_logs_user_id_created_at
    ON balance_logs (user_id, created_at DESC);
  `);

  console.log("[Database] 迁移完成");
}
