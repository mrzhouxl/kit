import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { AppModule } from "./app.module.js";
import { localStorageConfig, serverConfig } from "./config.js";
import { shutdownAll, initWarmPool } from "./sandbox/index.js";
import { testConnection, runMigrations, closeDatabase } from "./database/index.js";
import { initGraph } from "./graph/index.js";

/** 检查端口是否可用 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, "0.0.0.0");
  });
}

/** 查询占用指定端口的监听进程 PID 列表。 */
function getListeningPidsByPort(port: number): number[] {
  if (process.platform === "win32") {
    return getListeningPidsByPortWindows(port);
  }
  return getListeningPidsByPortPosix(port);
}

function getListeningPidsByPortPosix(port: number): number[] {
  try {
    const output = execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) return [];
    return output
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function getListeningPidsByPortWindows(port: number): number[] {
  try {
    const output = execFileSync("netstat", ["-ano", "-p", "tcp"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes("LISTENING"))
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts.length >= 5 && parts[1].endsWith(`:${port}`))
      .map((parts) => Number(parts[4]))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 端口被占用时，尝试终止占用进程并等待释放。
 * 主要用于 watch 热重启时清理上一轮还未完全退出的进程。
 */
async function ensurePortFree(port: number): Promise<void> {
  if (await isPortAvailable(port)) return;

  const pids = getListeningPidsByPort(port).filter((pid) => pid !== process.pid);
  if (pids.length === 0) {
    throw new Error(`端口 ${port} 已被占用，且未能定位占用进程`);
  }

  for (const pid of pids) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(pid), "/T"]);
      } else {
        process.kill(pid, "SIGTERM");
      }
      console.warn(`[Agent] 已发送 SIGTERM 到占用端口 ${port} 的进程 PID=${pid}`);
    } catch {
      // ignore
    }
  }

  for (let i = 0; i < 12; i += 1) {
    await delay(150);
    if (await isPortAvailable(port)) return;
  }

  for (const pid of pids) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
      } else {
        process.kill(pid, "SIGKILL");
      }
      console.warn(`[Agent] 已发送 SIGKILL 到占用端口 ${port} 的进程 PID=${pid}`);
    } catch {
      // ignore
    }
  }

  for (let i = 0; i < 12; i += 1) {
    await delay(150);
    if (await isPortAvailable(port)) return;
  }

  throw new Error(`端口 ${port} 释放失败，请手动检查占用进程`);
}

let shuttingDown = false;

async function shutdownSandboxes(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.warn(`[Agent] 收到 ${signal}，准备清理沙箱资源...`);
  try {
    await shutdownAll();
    await closeDatabase();
  } catch (err) {
    console.error("[Agent] 清理沙箱失败:", err);
  }
}

async function bootstrap() {
  const port = serverConfig.port;
  await ensurePortFree(port);

  // 初始化数据库连接并执行迁移
  await testConnection();
  await runMigrations();

  // 初始化 LangGraph 图（开源版固定 SQLite Checkpointer）
  await initGraph();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ["log", "warn", "error"] });

  // CORS — 全开放，允许任意来源访问
  app.enableCors({
    origin: true,
    allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "cache-control"],
    methods: ["GET", "POST", "OPTIONS"],
    exposedHeaders: ["X-Request-Id"],
    credentials: false,
    maxAge: 86400,
  });

  // 本地上传目录静态托管：确保右侧实时面板可访问本地文件 URL
  const uploadsRoot = resolve(process.cwd(), localStorageConfig.rootDir);
  if (!existsSync(uploadsRoot)) {
    mkdirSync(uploadsRoot, { recursive: true });
  }
  app.useStaticAssets(uploadsRoot, {
    prefix: "/storage/uploads/",
  });

  await app.listen(port);
  console.log(`[Agent] 服务已启动，监听端口 ${port}`);

  // 异步初始化预热容器池（不阻塞服务启动）
  initWarmPool().catch((err) => {
    console.warn("[Agent] 预热池初始化失败（不影响服务运行）:", err instanceof Error ? err.message : err);
  });
}

process.once("SIGINT", () => {
  void shutdownSandboxes("SIGINT").finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void shutdownSandboxes("SIGTERM").finally(() => process.exit(0));
});

bootstrap().catch((err) => {
  console.error("[Agent] 启动失败:", err);
  process.exit(1);
});
