/**
 * database/schema.ts — 数据库表定义
 *
 * 开源版使用独立 SQLite 表结构（chat_sessions / chat_messages 等）。
 */
import {
  sqliteTable,
  integer,
  text,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const nowMs = sql`(CAST(strftime('%s','now') AS INTEGER) * 1000)`;

// ── 用户表（开源版本地账号）──────────────────────────────────

export const users = sqliteTable(
  "users",
  {
    /** 主键 */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 手机号（唯一） */
    phone: text("phone").notNull(),
    /** 用户名 */
    username: text("username").notNull().default(""),
    /** 昵称 */
    nickname: text("nickname").notNull().default(""),
    /** 密码哈希（salt + hash） */
    passwordHash: text("password_hash").notNull(),
    /** 创建时间 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    /** 更新时间 */
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => ({
    phoneUnique: uniqueIndex("idx_users_phone_unique").on(table.phone),
  }),
);

// ── 聊天会话表（开源版独立） ───────────────────────────────────

export const chatSessions = sqliteTable(
  "chat_sessions",
  {
    /** 主键 */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 用户 ID */
    userId: integer("user_id").notNull(),
    /** Agent 线程 ID，对应 LangGraph Checkpointer 的 thread_id */
    threadId: text("thread_id").notNull().default(""),
    /** 会话标题（自动从首条用户消息提取） */
    title: text("title").notNull().default("新会话"),
    /** 会话模式：chat / image */
    mode: text("mode").notNull().default("chat"),
    /** 创建时间 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    /** 更新时间 */
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    /** 软删除时间 */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => ({
    userUpdatedIdx: index("idx_chat_sessions_user_id_updated_at").on(table.userId, table.updatedAt),
    threadUnique: uniqueIndex("idx_chat_sessions_thread_id_unique").on(table.threadId),
  }),
);

// ── 聊天消息表（新增） ───────────────────────────────────────

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    /** 主键 */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 关联会话 ID */
    sessionId: integer("session_id").notNull(),
    /** 消息角色：user / assistant / system */
    role: text("role").notNull(),
    /** 消息文本内容 */
    content: text("content").notNull().default(""),
    /** 扩展元数据（工具调用结果、图片 URL 等） */
    metadata: text("metadata", { mode: "json" }),
    /** 创建时间 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => ({
    sessionIdx: index("idx_chat_messages_session_id").on(table.sessionId),
  }),
);

// ── 余额流水表（开源版兼容，仅用于可选用量/额度查询）────────────

export const balanceLogs = sqliteTable(
  "balance_logs",
  {
    /** 主键 */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 用户 ID */
    userId: integer("user_id").notNull(),
    /** 本次积分变动 */
    credits: integer("credits").notNull().default(0),
    /** 创建时间 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => ({
    userCreatedIdx: index("idx_balance_logs_user_id_created_at").on(table.userId, table.createdAt),
  }),
);

// ── Agent Token 用量表（新增）──────────────────────────────

export const chatTokenUsages = sqliteTable(
  "chat_token_usages",
  {
    /** 主键 */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 用户 ID */
    userId: integer("user_id").notNull(),
    /** Agent 线程 ID */
    threadId: text("thread_id").notNull().default(""),
    /** 接口入口：chat / generate / sse / video */
    endpoint: text("endpoint").notNull(),
    /** 模型名称 */
    model: text("model").notNull().default(""),
    /** 输入 token 数 */
    inputTokens: integer("input_tokens").notNull().default(0),
    /** 输出 token 数 */
    outputTokens: integer("output_tokens").notNull().default(0),
    /** 总 token 数 */
    totalTokens: integer("total_tokens").notNull().default(0),
    /** 扩展元数据 */
    metadata: text("metadata", { mode: "json" }),
    /** 创建时间 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (table) => ({
    userCreatedIdx: index("idx_chat_token_usages_user_id_created_at").on(table.userId, table.createdAt),
    threadIdx: index("idx_chat_token_usages_thread_id").on(table.threadId),
  }),
);

// ── 类型导出 ─────────────────────────────────────────────────

/** 会话行类型 */
export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;

/** 用户行类型 */
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** 消息行类型 */
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;

/** 余额流水行类型 */
export type BalanceLog = typeof balanceLogs.$inferSelect;

/** Token 用量行类型 */
export type ChatTokenUsage = typeof chatTokenUsages.$inferSelect;
export type NewChatTokenUsage = typeof chatTokenUsages.$inferInsert;
