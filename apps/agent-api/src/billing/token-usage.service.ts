/**
 * billing/token-usage.service.ts — Agent Token 用量与访问校验
 *
 * 负责：
 * 1. 查询用户当前可用积分，用于不足时阻止继续调用 Agent
 * 2. 记录每次 Agent 请求的模型 token 使用情况，为后续账单提供数据基础
 */
import { HttpException, HttpStatus } from "@nestjs/common";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db, balanceLogs, chatTokenUsages } from "../database/index.js";

/** 每个用户每日最多可消耗的 token 数。 */
export const DAILY_TOKEN_LIMIT = 1_000_000;

/** 每个用户每日最多可发起的视频生成次数。 */
export const DAILY_VIDEO_GENERATION_LIMIT = 3;

/** Agent 日限额按北京时间自然日统计。 */
const CHINA_TIMEZONE_OFFSET_MINUTES = 8 * 60;

/** Token 使用统计。 */
export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  callCount: number;
}

/** 每日用量点。 */
export interface TokenUsageDailyPoint {
  date: string;
  totalTokens: number;
  requestCount: number;
}

/** 模型维度用量汇总。 */
export interface TokenUsageModelBreakdown {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}

/** 月度用量页数据。 */
export interface TokenUsageOverview {
  month: string;
  availableCredits: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
  activeModels: number;
  daily: TokenUsageDailyPoint[];
  models: TokenUsageModelBreakdown[];
}

/** 初始化空的 Token 统计。 */
export function createEmptyTokenUsageSummary(): TokenUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    model: "",
    callCount: 0,
  };
}

/**
 * 计算北京时间对应的自然日窗口，并转换为 UTC 时间范围供数据库查询。
 */
export function buildChinaDayRange(date: Date = new Date()): { start: Date; end: Date; day: string } {
  const shifted = new Date(date.getTime() + CHINA_TIMEZONE_OFFSET_MINUTES * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const startMs = Date.UTC(year, month, day, 0, 0, 0, 0) - CHINA_TIMEZONE_OFFSET_MINUTES * 60 * 1000;
  const endMs = startMs + 24 * 60 * 60 * 1000;

  return {
    start: new Date(startMs),
    end: new Date(endMs),
    day: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/**
 * 判断在给定已用 token 数下，是否还允许继续发起新的 Agent 请求。
 */
export function isDailyTokenUsageAllowed(totalTokensToday: number, limit: number = DAILY_TOKEN_LIMIT): boolean {
  return totalTokensToday < limit;
}

/**
 * 构造每日 token 超限提示文案。
 */
export function buildDailyTokenLimitMessage(totalTokensToday: number, limit: number = DAILY_TOKEN_LIMIT): string {
  return `今日 token 使用量已达 ${totalTokensToday.toLocaleString("zh-CN")} / ${limit.toLocaleString("zh-CN")}，已触发每日上限，请明天再试。`;
}

/**
 * 判断在给定已用视频生成次数下，是否还允许继续发起新的视频生成。
 */
export function isDailyVideoGenerationAllowed(countToday: number, limit: number = DAILY_VIDEO_GENERATION_LIMIT): boolean {
  return countToday < limit;
}

/**
 * 构造每日视频生成次数超限提示文案。
 */
export function buildDailyVideoGenerationLimitMessage(countToday: number, limit: number = DAILY_VIDEO_GENERATION_LIMIT): string {
  return `今日视频生成次数已达 ${countToday.toLocaleString("zh-CN")} / ${limit.toLocaleString("zh-CN")}，请明天再试。`;
}

/**
 * 查询用户当前可用积分。
 * 复用 Go 服务的 balance_logs 口径，避免重复维护余额字段。
 */
export async function getAvailableCredits(userId: number): Promise<number> {
  const rows = await db
    .select({
      credits: sql<number>`COALESCE(SUM(${balanceLogs.credits}), 0)`,
    })
    .from(balanceLogs)
    .where(eq(balanceLogs.userId, userId));

  return Number(rows[0]?.credits ?? 0);
}

/**
 * 查询用户在北京时间当天已累计消耗的 token。
 */
export async function getTodayTokenUsage(userId: number, now: Date = new Date()): Promise<number> {
  const { start, end } = buildChinaDayRange(now);
  const rows = await db
    .select({
      totalTokens: sql<number>`COALESCE(SUM(${chatTokenUsages.totalTokens}), 0)`,
    })
    .from(chatTokenUsages)
    .where(and(
      eq(chatTokenUsages.userId, userId),
      gte(chatTokenUsages.createdAt, start),
      lt(chatTokenUsages.createdAt, end),
    ));

  return Number(rows[0]?.totalTokens ?? 0);
}

/**
 * 查询用户在北京时间当天已发起的视频生成次数。
 */
export async function getTodayVideoGenerationCount(userId: number, now: Date = new Date()): Promise<number> {
  const { start, end } = buildChinaDayRange(now);
  const rows = await db
    .select({
      count: sql<number>`COUNT(*)`,
    })
    .from(chatTokenUsages)
    .where(and(
      eq(chatTokenUsages.userId, userId),
      eq(chatTokenUsages.endpoint, "video"),
      gte(chatTokenUsages.createdAt, start),
      lt(chatTokenUsages.createdAt, end),
    ));

  return Number(rows[0]?.count ?? 0);
}

/**
 * 校验用户当前是否允许继续使用 Agent。
 * 当前策略：没有可用积分时直接拒绝，后续可替换为更精细的 token 计费规则。
 */
export async function assertAgentUsageAllowed(userId?: number): Promise<void> {
  if (!userId || userId <= 0) {
    return;
  }

  const availableCredits = await getAvailableCredits(userId);
  if (availableCredits <= 0) {
    throw new HttpException("余额不足，暂时无法继续使用。请先充值后再试。", HttpStatus.PAYMENT_REQUIRED);
  }

  const totalTokensToday = await getTodayTokenUsage(userId);
  if (!isDailyTokenUsageAllowed(totalTokensToday)) {
    throw new HttpException(buildDailyTokenLimitMessage(totalTokensToday), HttpStatus.TOO_MANY_REQUESTS);
  }
}

/**
 * 校验用户当天是否仍允许发起视频生成。
 */
export async function assertVideoGenerationAllowed(userId?: number): Promise<void> {
  if (!userId || userId <= 0) {
    return;
  }

  const countToday = await getTodayVideoGenerationCount(userId);
  if (!isDailyVideoGenerationAllowed(countToday)) {
    throw new HttpException(
      buildDailyVideoGenerationLimitMessage(countToday),
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * 记录一次 Agent 请求的 token 用量。
 */
export async function recordChatTokenUsage(params: {
  userId?: number;
  threadId: string;
  endpoint: "chat" | "generate" | "sse" | "video";
  usage: TokenUsageSummary;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  const { userId, threadId, endpoint, usage, metadata } = params;
  if (!userId || userId <= 0) {
    return;
  }
  if (usage.totalTokens <= 0 && usage.inputTokens <= 0 && usage.outputTokens <= 0) {
    return;
  }

  await db.insert(chatTokenUsages).values({
    userId,
    threadId,
    endpoint,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    metadata: metadata ?? {
      callCount: usage.callCount,
    },
  });
}

/**
 * 记录一次视频生成尝试，用于按天限流。
 */
export async function recordVideoGenerationAttempt(params: {
  userId?: number;
  threadId?: string;
  model?: string;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  const { userId, threadId, model, metadata } = params;
  if (!userId || userId <= 0) {
    return;
  }

  await db.insert(chatTokenUsages).values({
    userId,
    threadId: threadId ?? "",
    endpoint: "video",
    model: model ?? "",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    metadata: metadata ?? { type: "video_generation" },
  });
}

function buildMonthRange(month?: string): { month: string; start: Date; end: Date } {
  const normalized = typeof month === "string" ? month.trim() : "";
  const monthText = normalized || new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(monthText)) {
    throw new Error("month 参数格式错误，应为 YYYY-MM");
  }

  const [yearText, monthNumberText] = monthText.split("-");
  const year = Number(yearText);
  const monthNumber = Number(monthNumberText);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new Error("month 参数超出有效范围");
  }

  const start = new Date(Date.UTC(year, monthNumber - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthNumber, 1, 0, 0, 0, 0));
  return { month: monthText, start, end };
}

/**
 * 查询某个用户某个月的 Agent token 用量概览。
 */
export async function getTokenUsageOverview(userId: number, month?: string): Promise<TokenUsageOverview> {
  const { month: resolvedMonth, start, end } = buildMonthRange(month);
  const availableCredits = await getAvailableCredits(userId);
  // SQLite 按毫秒时间戳存储 created_at，这里统一转 UTC 日期字符串用于按天聚合。
  const dailyDateExpr = sql<string>`strftime('%Y-%m-%d', ${chatTokenUsages.createdAt} / 1000, 'unixepoch')`;

  const [summaryRow] = await db
    .select({
      totalTokens: sql<number>`COALESCE(SUM(${chatTokenUsages.totalTokens}), 0)`,
      totalInputTokens: sql<number>`COALESCE(SUM(${chatTokenUsages.inputTokens}), 0)`,
      totalOutputTokens: sql<number>`COALESCE(SUM(${chatTokenUsages.outputTokens}), 0)`,
      requestCount: sql<number>`COUNT(*)`,
      activeModels: sql<number>`COUNT(DISTINCT ${chatTokenUsages.model})`,
    })
    .from(chatTokenUsages)
    .where(and(
      eq(chatTokenUsages.userId, userId),
      gte(chatTokenUsages.createdAt, start),
      lt(chatTokenUsages.createdAt, end),
    ));

  const dailyRows = await db
    .select({
      date: dailyDateExpr,
      totalTokens: sql<number>`COALESCE(SUM(${chatTokenUsages.totalTokens}), 0)`,
      requestCount: sql<number>`COUNT(*)`,
    })
    .from(chatTokenUsages)
    .where(and(
      eq(chatTokenUsages.userId, userId),
      gte(chatTokenUsages.createdAt, start),
      lt(chatTokenUsages.createdAt, end),
    ))
    .groupBy(dailyDateExpr)
    .orderBy(dailyDateExpr);

  const modelRows = await db
    .select({
      model: chatTokenUsages.model,
      totalTokens: sql<number>`COALESCE(SUM(${chatTokenUsages.totalTokens}), 0)`,
      inputTokens: sql<number>`COALESCE(SUM(${chatTokenUsages.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${chatTokenUsages.outputTokens}), 0)`,
      requestCount: sql<number>`COUNT(*)`,
    })
    .from(chatTokenUsages)
    .where(and(
      eq(chatTokenUsages.userId, userId),
      gte(chatTokenUsages.createdAt, start),
      lt(chatTokenUsages.createdAt, end),
    ))
    .groupBy(chatTokenUsages.model)
    .orderBy(desc(sql`COALESCE(SUM(${chatTokenUsages.totalTokens}), 0)`));

  return {
    month: resolvedMonth,
    availableCredits,
    totalTokens: Number(summaryRow?.totalTokens ?? 0),
    totalInputTokens: Number(summaryRow?.totalInputTokens ?? 0),
    totalOutputTokens: Number(summaryRow?.totalOutputTokens ?? 0),
    requestCount: Number(summaryRow?.requestCount ?? 0),
    activeModels: Number(summaryRow?.activeModels ?? 0),
    daily: dailyRows.map((row) => ({
      date: row.date,
      totalTokens: Number(row.totalTokens ?? 0),
      requestCount: Number(row.requestCount ?? 0),
    })),
    models: modelRows.map((row) => ({
      model: row.model || "unknown",
      totalTokens: Number(row.totalTokens ?? 0),
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      requestCount: Number(row.requestCount ?? 0),
    })),
  };
}
