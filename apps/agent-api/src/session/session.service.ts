/**
 * session/session.service.ts — 聊天会话 CRUD 服务
 *
 * 提供会话和消息的增删改查操作，数据默认持久化到本地 SQLite。
 */
import { eq, desc, isNull, and, sql } from "drizzle-orm";
import { db, chatSessions, chatMessages } from "../database/index.js";
import type { ChatSession, NewChatSession, ChatMessage, NewChatMessage } from "../database/index.js";
import { randomUUID } from "node:crypto";

// ── 会话操作 ─────────────────────────────────────────────────

/** 创建新会话 */
export async function createSession(params: {
  userId: number;
  title?: string;
  mode?: string;
  threadId?: string;
}): Promise<ChatSession> {
  const threadId = params.threadId?.trim() || randomUUID();
  const rows = await db.insert(chatSessions).values({
    userId: params.userId,
    threadId,
    title: params.title ?? "新会话",
    mode: params.mode ?? "chat",
  }).returning();
  return rows[0];
}

/** 查询用户的会话列表（按更新时间倒序，排除软删除） */
export async function listSessions(userId: number): Promise<ChatSession[]> {
  return db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.userId, userId), isNull(chatSessions.deletedAt)))
    .orderBy(desc(chatSessions.updatedAt));
}

/** 查询单个会话 */
export async function getSession(sessionId: number): Promise<ChatSession | undefined> {
  const rows = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), isNull(chatSessions.deletedAt)))
    .limit(1);
  return rows[0];
}

/** 通过 threadId 查询会话 */
export async function getSessionByThreadId(threadId: string): Promise<ChatSession | undefined> {
  const rows = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.threadId, threadId), isNull(chatSessions.deletedAt)))
    .limit(1);
  return rows[0];
}

/** 判断指定 threadId 是否已有持久化消息。 */
export async function hasPersistedConversationByThreadId(threadId: string): Promise<boolean> {
  const rows = await db
    .select({
      count: sql<number>`COUNT(${chatMessages.id})`,
    })
    .from(chatMessages)
    .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
    .where(and(eq(chatSessions.threadId, threadId), isNull(chatSessions.deletedAt)))
    .limit(1);

  return Number(rows[0]?.count ?? 0) > 0;
}

/** 更新会话标题 */
export async function updateSessionTitle(sessionId: number, title: string): Promise<void> {
  await db
    .update(chatSessions)
    .set({ title, updatedAt: new Date() })
    .where(eq(chatSessions.id, sessionId));
}

/** 更新会话的 updatedAt 时间戳 */
export async function touchSession(sessionId: number): Promise<void> {
  await db
    .update(chatSessions)
    .set({ updatedAt: new Date() })
    .where(eq(chatSessions.id, sessionId));
}

/** 软删除会话 */
export async function deleteSession(sessionId: number): Promise<void> {
  await db
    .update(chatSessions)
    .set({ deletedAt: new Date() })
    .where(eq(chatSessions.id, sessionId));
}

// ── 消息操作 ─────────────────────────────────────────────────

/** 追加一条消息到会话 */
export async function addMessage(params: NewChatMessage): Promise<ChatMessage> {
  const rows = await db.insert(chatMessages).values(params).returning();
  return rows[0];
}

/** 批量追加消息 */
export async function addMessages(messages: NewChatMessage[]): Promise<void> {
  if (messages.length === 0) return;
  await db.insert(chatMessages).values(messages);
}

/** 查询会话的消息列表（按时间正序） */
export async function getMessages(sessionId: number): Promise<ChatMessage[]> {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(chatMessages.createdAt);
}

/** 从消息内容自动提取会话标题（取前 50 个字符） */
export function extractTitle(content: string): string {
  const clean = content.replace(/[\r\n]+/g, " ").trim();
  return clean.length > 50 ? clean.slice(0, 50) + "…" : clean || "新会话";
}
