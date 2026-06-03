/**
 * sandbox/sandbox-manager.ts — 沙箱容器生命周期管理器（生产优化版）
 *
 * 通过 dockerode 管理沙箱容器的创建、复用、销毁。
 * 策略：
 *   - 每个 thread 一个容器，避免多会话串环境
 *   - 最多同时运行 N 个容器（可配置）
 *   - 预热容器池：启动时预创建就绪容器，分配时零等待
 *   - 容器全满时新请求排队等候（带超时保护）
 *   - 通过 WebSocket 接收容器实时事件并转发
 *   - 空闲容器定时回收，避免长期占用资源
 *   - 定期健康巡检，自动回收不健康容器
 *   - 执行指标收集，支持可观测性
 */
import Docker from "dockerode";
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sandboxConfig } from "./sandbox.config.js";
import { getSkillsDir } from "../skills/registry.js";
import type {
  SandboxSession,
  WarmContainer,
  SandboxMetrics,
  BrowseRequest,
  BrowseResponse,
  ExecRequest,
  ExecResponse,
  SandboxEvent,
} from "./sandbox.types.js";

// ── Docker 客户端 ───────────────────────────────────────────

const docker = new Docker();

function buildSandboxBaseUrl(hostPort: number): string {
  return `${sandboxConfig.hostBaseUrl}:${hostPort}`;
}

// ── 启动时清理孤儿容器 ──────────────────────────────────────

/** 清理上次遗留的 sandbox-* 容器（进程重启后内存丢失但容器还在） */
async function cleanupOrphanContainers(): Promise<void> {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { name: ["sandbox-"] },
    });
    for (const info of containers) {
      const name = info.Names?.[0] ?? "";
      if (!name.includes("sandbox-")) continue;
      console.log(`[Sandbox] 清理孤儿容器 | ${name} (${info.Id.slice(0, 12)})`);
      const c = docker.getContainer(info.Id);

      // 尝试从容器名解析 userId/threadId，清理前先保存文件到宿主机
      // 容器名格式：sandbox-{userSegment}-{threadSegment}-{timestamp}
      // 预热容器名含 "warm"，没有用户数据，跳过文件保存
      const segments = name.replace(/^\//, "").split("-");
      const isWarm = name.includes("warm");
      if (!isWarm && segments.length >= 4 && info.State === "running") {
        const userSeg = segments[1];
        const threadSeg = segments[2];
        const orphanWorkDir = join(sandboxConfig.workspaceBaseDir, userSeg, threadSeg).replace(/\\/g, "/");
        await syncContainerToWorkspace(info.Id, orphanWorkDir).catch(() => {});
        console.log(`[Sandbox] 孤儿容器文件已保存 | ${orphanWorkDir}`);
      }

      await c.stop({ t: 3 }).catch(() => {});
      await c.remove({ force: true }).catch(() => {});
    }
  } catch (err) {
    console.warn("[Sandbox] 孤儿容器清理失败:", err instanceof Error ? err.message : err);
  }
}

// 模块加载时异步清理
cleanupOrphanContainers();

// ── 活跃会话存储 ────────────────────────────────────────────

/** sessionKey(user + thread) → SandboxSession */
const sessions = new Map<string, SandboxSession>();

/** 预热容器池：已启动且健康就绪，但未分配给任何会话的容器 */
const warmPool: WarmContainer[] = [];

/** 正在补充预热池的容器数（避免超量创建） */
let warmPoolRefilling = 0;

/** 等待队列：容器全满时排队的请求（带超时） */
const waitQueue: Array<{
  sessionKey: string;
  userId: string;
  threadId: string;
  resolve: (session: SandboxSession) => void;
  reject: (err: Error) => void;
  /** 队列超时定时器 */
  timer: ReturnType<typeof setTimeout>;
}> = [];

/** 已分配的端口集合 */
const allocatedPorts = new Set<number>();

// ── 执行指标 ────────────────────────────────────────────────

/** 全局执行指标（进程生命周期内累计） */
const metrics: SandboxMetrics = {
  containersCreated: 0,
  warmPoolHits: 0,
  warmPoolMisses: 0,
  queuedRequests: 0,
  queueTimeouts: 0,
  execTotal: 0,
  execSuccess: 0,
  execFailed: 0,
  browseTotal: 0,
  unhealthyRecycled: 0,
  idleRecycled: 0,
  activeContainers: 0,
  warmPoolSize: 0,
  queueLength: 0,
  startedAt: Date.now(),
};

// ── 事件总线（沙箱事件 → SSE 转发）──────────────────────────

/** 沙箱事件发射器，ChatController 监听此事件将数据写入 SSE */
export const sandboxEvents = new EventEmitter();

/** 避免定时回收并发执行。 */
let cleanupInProgress = false;

// ── 端口分配 ────────────────────────────────────────────────

/** 分配一个未使用的宿主机端口 */
function allocatePort(): number {
  let port = sandboxConfig.portRangeStart;
  while (allocatedPorts.has(port)) {
    port++;
  }
  allocatedPorts.add(port);
  return port;
}

/** 释放端口 */
function releasePort(port: number) {
  allocatedPorts.delete(port);
}

// ── 容器创建 ────────────────────────────────────────────────

// ── 用户工作区持久化 ────────────────────────────────────────

/**
 * 获取用户会话的宿主机工作区目录路径，不存在则自动创建。
 * 目录结构: {workspaceBaseDir}/{userId}/{threadId}/
 */
function ensureWorkspaceDir(userId: string, threadId: string): string {
  const userSegment = sanitizeContainerSegment(userId, "user");
  const threadSegment = sanitizeContainerSegment(threadId, "thread");
  const dir = join(sandboxConfig.workspaceBaseDir, userSegment, threadSegment);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`[Sandbox] 创建工作区目录 | ${dir}`);
  }
  // 统一转正斜杠：Docker bind mount 不接受反斜杠路径
  return dir.replace(/\\/g, "/");
}

/**
 * 检查宿主机工作区目录是否有已有文件（用于判断是否需要恢复）
 */
function workspaceHasFiles(dir: string): boolean {
  try {
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * 将宿主机工作区文件同步到运行中的容器（用于预热容器分配后恢复用户文件）
 * 使用 Docker putArchive API（tar 流写入容器）
 */
async function syncWorkspaceToContainer(containerId: string, workspaceDir: string): Promise<void> {
  if (!workspaceHasFiles(workspaceDir)) return;

  const t0 = Date.now();
  console.log(`[Sandbox] 同步工作区到容器 | dir=${workspaceDir} | container=${containerId.slice(0, 12)}`);

  try {
    const { execSync } = await import("node:child_process");
    // 统一用正斜杠以兼容 Windows Docker Desktop
    const hostPath = workspaceDir.replace(/\\/g, "/");
    execSync(`docker cp "${hostPath}/." ${containerId}:${sandboxConfig.containerWorkDir}/`, {
      timeout: 30_000,
      stdio: "pipe",
    });
    console.log(`[Sandbox] 工作区同步完成 | 耗时=${Date.now() - t0}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Sandbox] 工作区同步失败（不影响容器使用）: ${msg}`);
  }
}

/**
 * 将容器内工作目录文件保存回宿主机（容器销毁前调用）
 * 使用 docker cp 从容器复制到宿主机
 */
async function syncContainerToWorkspace(containerId: string, workspaceDir: string): Promise<void> {
  const t0 = Date.now();
  console.log(`[Sandbox] 保存容器文件到工作区 | container=${containerId.slice(0, 12)} | dir=${workspaceDir}`);

  try {
    // 确保目标目录存在
    if (!existsSync(workspaceDir)) {
      mkdirSync(workspaceDir, { recursive: true });
    }

    const { execSync } = await import("node:child_process");
    // 统一用正斜杠以兼容 Windows Docker Desktop
    const hostPath = workspaceDir.replace(/\\/g, "/");
    execSync(`docker cp ${containerId}:${sandboxConfig.containerWorkDir}/. "${hostPath}/"`, {
      timeout: 30_000,
      stdio: "pipe",
    });
    console.log(`[Sandbox] 文件保存完成 | 耗时=${Date.now() - t0}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Sandbox] 文件保存失败: ${msg}`);
  }
}

/**
 * 修复容器内工作目录权限（docker cp 后文件归属可能变为 root）
 */
async function fixContainerPermissions(containerId: string): Promise<void> {
  try {
    const container = docker.getContainer(containerId);
    // Playwright 镜像预置用户为 pwuser，需与 Dockerfile USER 保持一致
    const exec = await container.exec({
      Cmd: ["chown", "-R", "pwuser:pwuser", sandboxConfig.containerWorkDir],
      User: "root",
    });
    // 必须等待 chown 完成后再标记容器 ready，否则后续命令会因权限不足失败
    const stream = await exec.start({});
    await new Promise<void>((resolve) => {
      stream.on("end", resolve);
      stream.on("error", () => resolve());
      stream.resume();           // 消费数据以驱动流结束
    });
  } catch {
    // 权限修复失败不影响主流程
  }
}

// ── 容器创建辅助 ────────────────────────────────────────────

/**
 * 创建并启动一个沙箱容器
 */
function buildSessionKey(userId: string, threadId: string): string {
  return `${userId}:${threadId}`;
}

function sanitizeContainerSegment(input: string, fallback: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

async function createContainer(userId: string, threadId: string): Promise<SandboxSession> {
  const sessionKey = buildSessionKey(userId, threadId);
  const workspaceDir = ensureWorkspaceDir(userId, threadId);

  // ── 优先从预热池取容器（复用端口，重建带 bind mount 的容器） ──
  const warm = warmPool.shift();
  if (warm) {
    metrics.warmPoolHits++;
    console.log(`[Sandbox] 预热池命中 | 会话: ${sessionKey} | 旧容器: ${warm.containerId.slice(0, 12)} | 池剩余: ${warmPool.length}`);

    // 预热容器创建时没有 bind mount 用户工作区，
    // 必须销毁后用同一端口重建，才能保证 workspace 目录实时挂载。
    try {
      const warmContainer = docker.getContainer(warm.containerId);
      await warmContainer.stop({ t: 2 }).catch(() => {});
      await warmContainer.remove({ force: true }).catch(() => {});
    } catch {
      // 清理失败不影响后续创建
    }

    const userSeg = sanitizeContainerSegment(userId, "user");
    const threadSeg = sanitizeContainerSegment(threadId, "thread");

    let container: Docker.Container;
    try {
      container = await docker.createContainer({
        Image: sandboxConfig.image,
        name: `sandbox-${userSeg}-${threadSeg}-${Date.now()}`,
        ExposedPorts: { "3100/tcp": {} },
        HostConfig: {
          Memory: parseMem(sandboxConfig.memoryLimit),
          NanoCpus: sandboxConfig.cpuLimit * 1_000_000_000,
          PortBindings: {
            "3100/tcp": [{ HostPort: String(warm.hostPort) }],
          },
          // bind mount 用户工作区到容器 + skills 目录只读挂载
          Binds: [
            `${workspaceDir}:${sandboxConfig.containerWorkDir}`,
            `${getSkillsDir().replace(/\\/g, "/")}:/skills:ro`,
          ],
        },
        Env: [`SANDBOX_PORT=3100`],
      });
    } catch (err) {
      releasePort(warm.hostPort);
      scheduleWarmPoolRefill();
      throw err;
    }

    try {
      await container.start();
    } catch (err) {
      releasePort(warm.hostPort);
      await container.remove({ force: true }).catch(() => {});
      scheduleWarmPoolRefill();
      throw err;
    }

    const session: SandboxSession = {
      sessionKey,
      containerId: container.id,
      userId,
      threadId,
      baseUrl: warm.baseUrl,
      ws: null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      state: "starting",
      hostPort: warm.hostPort,
      workspaceDir,
    };

    // 等待新容器健康就绪
    try {
      await waitForHealthy(session);
    } catch (err) {
      releasePort(warm.hostPort);
      await container.stop({ t: 3 }).catch(() => {});
      await container.remove({ force: true }).catch(() => {});
      scheduleWarmPoolRefill();
      throw err;
    }
    session.state = "ready";

    // 修复 bind mount 目录权限：宿主机目录 owner 与容器内 sandbox 用户不同
    await fixContainerPermissions(container.id);

    // 建立 WebSocket 事件连接
    connectEvents(session);
    sessions.set(sessionKey, session);
    updateLiveMetrics();

    // 异步补充预热池
    scheduleWarmPoolRefill();

    console.log(`[Sandbox] 容器就绪（预热重建） | ID: ${container.id.slice(0, 12)} | URL: ${session.baseUrl} | workspace: ${workspaceDir}`);
    return session;
  }

  // ── 预热池为空，冷启动（bind mount 用户目录） ─────────
  metrics.warmPoolMisses++;
  const hostPort = allocatePort();

  console.log(`[Sandbox] 冷启动容器 | 会话: ${sessionKey} | 端口: ${hostPort} | workspace: ${workspaceDir}`);
  metrics.containersCreated++;

  const userSegment = sanitizeContainerSegment(userId, "user");
  const threadSegment = sanitizeContainerSegment(threadId, "thread");

  let container: Docker.Container;
  try {
    container = await docker.createContainer({
      Image: sandboxConfig.image,
      name: `sandbox-${userSegment}-${threadSegment}-${Date.now()}`,
      ExposedPorts: { "3100/tcp": {} },
      HostConfig: {
        Memory: parseMem(sandboxConfig.memoryLimit),
        NanoCpus: sandboxConfig.cpuLimit * 1_000_000_000,
        PortBindings: {
          "3100/tcp": [{ HostPort: String(hostPort) }],
        },
        // 将宿主机用户工作区目录 bind mount 到容器 /home/sandbox + skills 只读挂载
        Binds: [
          `${workspaceDir}:${sandboxConfig.containerWorkDir}`,
          `${getSkillsDir().replace(/\\/g, "/")}:/skills:ro`,
        ],
      },
      Env: [
        `SANDBOX_PORT=3100`,
      ],
    });
  } catch (err) {
    // 容器创建失败，释放端口
    releasePort(hostPort);
    throw err;
  }

  try {
    await container.start();
  } catch (err) {
    // 启动失败，清理容器和端口
    releasePort(hostPort);
    await container.remove({ force: true }).catch(() => {});
    throw err;
  }

  const session: SandboxSession = {
    sessionKey,
    containerId: container.id,
    userId,
    threadId,
    baseUrl: buildSandboxBaseUrl(hostPort),
    ws: null,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    state: "starting",
    hostPort,
    workspaceDir,
  };

  // 等待容器健康就绪
  try {
    await waitForHealthy(session);
  } catch (err) {
    // 健康检查失败，清理容器和端口
    releasePort(hostPort);
    await container.stop({ t: 3 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
    throw err;
  }
  session.state = "ready";

  // 修复 bind mount 目录权限：宿主机目录 owner 与容器内 sandbox 用户不同
  await fixContainerPermissions(container.id);

  // 建立 WebSocket 事件连接
  connectEvents(session);

  sessions.set(sessionKey, session);
  updateLiveMetrics();
  console.log(`[Sandbox] 容器就绪（冷启动） | ID: ${container.id.slice(0, 12)} | URL: ${session.baseUrl}`);

  return session;
}

/**
 * 轮询 /health 等待容器就绪
 */
async function waitForHealthy(session: SandboxSession, maxRetries = 30): Promise<void> {
  console.log(`[Sandbox] 健康检查开始 | 会话: ${session.sessionKey} | url: ${session.baseUrl}/health | 最大重试: ${maxRetries}`);
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${session.baseUrl}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        console.log(`[Sandbox] 健康检查通过 | 第 ${i + 1} 次尝试`);
        return;
      }
      console.log(`[Sandbox] 健康检查未通过 | 第 ${i + 1}/${maxRetries} 次 | status=${res.status}`);
    } catch (err) {
      // 容器还在启动
      if (i % 5 === 0) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`[Sandbox] 健康检查等待中 | 第 ${i + 1}/${maxRetries} 次 | ${errMsg}`);
      }
    }
    await sleep(1_000);
  }
  throw new Error(`沙箱容器启动超时 (${maxRetries}s)`);
}

/**
 * 建立 WebSocket 连接，接收沙箱实时事件并转发
 */
function connectEvents(session: SandboxSession) {
  const wsUrl = session.baseUrl.replace("http://", "ws://") + "/events";
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log(`[Sandbox] WS 已连接 | 用户: ${session.userId}`);
  });

  ws.on("message", (raw) => {
    try {
      const event = JSON.parse(raw.toString()) as SandboxEvent;
      // 转发事件，附带用户和线程信息
      sandboxEvents.emit("event", {
        sessionKey: session.sessionKey,
        userId: session.userId,
        threadId: session.threadId,
        event,
      });
    } catch {
      // 忽略解析错误
    }
  });

  ws.on("close", () => {
    console.log(`[Sandbox] WS 断开 | 用户: ${session.userId}`);
    session.ws = null;
  });

  ws.on("error", (err) => {
    console.error(`[Sandbox] WS 错误 | 用户: ${session.userId}:`, err.message);
  });

  session.ws = ws;
}

// ── 排队逻辑 ────────────────────────────────────────────────

/**
 * 计算当前总容器占用数（活跃会话 + 预热池 + 正在补充中的容器）
 */
function totalContainerCount(): number {
  return sessions.size + warmPool.length + warmPoolRefilling;
}

/**
 * 尝试处理等待队列中的请求（有容器被释放后调用）
 */
async function processQueue() {
  while (waitQueue.length > 0 && totalContainerCount() < sandboxConfig.maxContainers) {
    const next = waitQueue.shift()!;
    // 清除超时定时器
    clearTimeout(next.timer);
    try {
      const session = await createContainer(next.userId, next.threadId);
      next.resolve(session);
    } catch (err) {
      next.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
  updateLiveMetrics();
}

// ── 公开 API ────────────────────────────────────────────────

/**
 * 获取或创建用户的沙箱会话。
 * - 当前 thread 已有活跃容器 → 直接复用
 * - 预热池有就绪容器 → 零等待分配
 * - 容器未满 → 冷启动新容器
 * - 容器已满 → 排队等候（带超时保护）
 */
export async function getOrCreateSandbox(userId: string, threadId: string): Promise<SandboxSession> {
  const sessionKey = buildSessionKey(userId, threadId);

  // 检查是否已有当前 thread 的活跃会话
  const existing = sessions.get(sessionKey);
  if (existing && existing.state !== "stopping") {
    existing.lastActiveAt = Date.now();
    return existing;
  }

  // 有空位则直接创建（优先从预热池取）
  if (totalContainerCount() < sandboxConfig.maxContainers || warmPool.length > 0) {
    return createContainer(userId, threadId);
  }

  // 容器已满，排队等候（带超时保护）
  metrics.queuedRequests++;
  console.log(`[Sandbox] 容器已满 (${sessions.size}/${sandboxConfig.maxContainers})，会话 ${sessionKey} 排队等候 (超时: ${sandboxConfig.queueTimeoutMs}ms)`);

  return new Promise<SandboxSession>((resolve, reject) => {
    /** 超时定时器：超时后从队列中移除并拒绝 */
    const timer = setTimeout(() => {
      const idx = waitQueue.findIndex((item) => item.sessionKey === sessionKey);
      if (idx >= 0) {
        waitQueue.splice(idx, 1);
        metrics.queueTimeouts++;
        updateLiveMetrics();
        reject(new Error(`沙箱排队超时 (${sandboxConfig.queueTimeoutMs}ms)，当前 ${sessions.size} 个容器全忙`));
      }
    }, sandboxConfig.queueTimeoutMs);

    waitQueue.push({ sessionKey, userId, threadId, resolve, reject, timer });
    updateLiveMetrics();
  });
}

/**
 * 销毁指定会话的沙箱容器
 * 销毁前将容器内工作区文件保存到宿主机（预热容器无 bind mount 时需要）
 */
export async function destroySandbox(sessionKey: string): Promise<void> {
  const session = sessions.get(sessionKey);
  if (!session) return;

  session.state = "stopping";
  console.log(`[Sandbox] 销毁容器 | 会话: ${sessionKey} | ID: ${session.containerId.slice(0, 12)}`);

  // 保存容器内文件到宿主机工作区（对 bind mount 的冷启动容器来说已自动同步，但预热容器需要）
  if (session.workspaceDir) {
    await syncContainerToWorkspace(session.containerId, session.workspaceDir);
  }

  // 关闭 WebSocket
  if (session.ws) {
    session.ws.close();
    session.ws = null;
  }

  // 停止并删除容器
  try {
    const container = docker.getContainer(session.containerId);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
  } catch (err) {
    console.error(`[Sandbox] 容器清理失败:`, err instanceof Error ? err.message : err);
  }

  // 释放资源
  releasePort(session.hostPort);
  sessions.delete(sessionKey);
  updateLiveMetrics();

  // 处理排队请求
  await processQueue();
}

/**
 * 通过沙箱执行浏览器操作
 */
export async function sandboxBrowse(session: SandboxSession, req: BrowseRequest): Promise<BrowseResponse> {
  session.lastActiveAt = Date.now();
  metrics.browseTotal++;
  const actionDesc = `${req.action}${req.url ? ` url=${req.url}` : ''}${req.selector ? ` sel=${req.selector}` : ''}${req.text ? ` text="${req.text.slice(0, 30)}"` : ''}`;
  console.log(`[Sandbox] browse 请求 → ${actionDesc} | 容器: ${session.containerId.slice(0, 12)}`);
  const t0 = Date.now();
  try {
    const res = await fetch(`${session.baseUrl}/browse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json() as BrowseResponse;
    const elapsed = Date.now() - t0;
    if (data.success) {
      console.log(`[Sandbox] browse 完成 ← ${req.action} | ${elapsed}ms | success`);
    } else {
      console.warn(`[Sandbox] browse 失败 ← ${req.action} | ${elapsed}ms | error=${data.error}`);
    }
    return data;
  } catch (err) {
    const elapsed = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Sandbox] browse 异常 ← ${req.action} | ${elapsed}ms | ${msg}`);
    throw err;
  }
}

/**
 * 通过沙箱执行代码
 */
export async function sandboxExec(session: SandboxSession, req: ExecRequest): Promise<ExecResponse> {
  session.lastActiveAt = Date.now();
  metrics.execTotal++;
  const codePreview = req.code.length > 120 ? req.code.slice(0, 120) + '...' : req.code;
  console.log(`[Sandbox] exec 请求 → ${req.language} | timeout=${req.timeout ?? 'default'}ms | 容器: ${session.containerId.slice(0, 12)} | code=${codePreview}`);
  const t0 = Date.now();
  try {
    const res = await fetch(`${session.baseUrl}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json() as ExecResponse;
    const elapsed = Date.now() - t0;
    if (data.success) {
      metrics.execSuccess++;
    } else {
      metrics.execFailed++;
    }
    console.log(`[Sandbox] exec 完成 ← ${req.language} | ${elapsed}ms | exitCode=${data.exitCode} | stdout=${data.stdout.length}字符 | stderr=${data.stderr.length}字符`);
    return data;
  } catch (err) {
    metrics.execFailed++;
    const elapsed = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Sandbox] exec 异常 ← ${req.language} | ${elapsed}ms | ${msg}`);
    throw err;
  }
}

/**
 * 从沙箱容器中读取文件（base64 编码返回）
 */
export async function sandboxReadFile(
  session: SandboxSession,
  filePath: string,
): Promise<{ success: boolean; data?: string; size?: number; error?: string }> {
  session.lastActiveAt = Date.now();
  console.log(`[Sandbox] readFile 请求 → ${filePath} | 容器: ${session.containerId.slice(0, 12)}`);
  const t0 = Date.now();
  try {
    const res = await fetch(`${session.baseUrl}/files/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json() as { success: boolean; data?: string; size?: number; error?: string };
    const elapsed = Date.now() - t0;
    if (data.success) {
      console.log(`[Sandbox] readFile 完成 ← ${filePath} | ${elapsed}ms | ${data.size} 字节`);
    } else {
      console.warn(`[Sandbox] readFile 失败 ← ${filePath} | ${elapsed}ms | ${data.error}`);
    }
    return data;
  } catch (err) {
    const elapsed = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Sandbox] readFile 异常 ← ${filePath} | ${elapsed}ms | ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * 向沙箱容器写入文件内容
 */
export async function sandboxWriteFile(
  session: SandboxSession,
  filePath: string,
  content: string,
  encoding: "utf-8" | "base64" = "utf-8",
): Promise<{ success: boolean; size?: number; error?: string }> {
  session.lastActiveAt = Date.now();
  console.log(`[Sandbox] writeFile 请求 → ${filePath} | 容器: ${session.containerId.slice(0, 12)}`);
  try {
    const res = await fetch(`${session.baseUrl}/files/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content, encoding }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json() as { success: boolean; size?: number; error?: string };
    if (data.success) {
      console.log(`[Sandbox] writeFile 完成 ← ${filePath} | ${data.size} 字节`);
    } else {
      console.warn(`[Sandbox] writeFile 失败 ← ${filePath} | ${data.error}`);
    }
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Sandbox] writeFile 异常 ← ${filePath} | ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * 列出沙箱容器中指定目录的文件列表
 */
export async function sandboxListFiles(
  session: SandboxSession,
  directory: string,
): Promise<{ success: boolean; files?: Array<{ name: string; path: string; isDirectory: boolean; size: number; ext: string; modifiedAt: string }>; error?: string }> {
  session.lastActiveAt = Date.now();
  console.log(`[Sandbox] listFiles 请求 → ${directory} | 容器: ${session.containerId.slice(0, 12)}`);
  try {
    const res = await fetch(`${session.baseUrl}/files/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json() as { success: boolean; files?: Array<{ name: string; path: string; isDirectory: boolean; size: number; ext: string; modifiedAt: string }>; error?: string };
    if (data.success) {
      console.log(`[Sandbox] listFiles 完成 ← ${directory} | ${data.files?.length ?? 0} 条目`);
    } else {
      console.warn(`[Sandbox] listFiles 失败 ← ${directory} | ${data.error}`);
    }
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Sandbox] listFiles 异常 ← ${directory} | ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * 获取当前所有活跃会话的快照（调试/监控用）
 */
export function getActiveSessions(): Array<{
  sessionKey: string;
  userId: string;
  threadId: string;
  containerId: string;
  state: string;
  createdAt: number;
  lastActiveAt: number;
  queueLength: number;
}> {
  const list = Array.from(sessions.values()).map((s) => ({
    sessionKey: s.sessionKey,
    userId: s.userId,
    threadId: s.threadId,
    containerId: s.containerId.slice(0, 12),
    state: s.state,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
    queueLength: 0,
  }));
  // 附加队列长度到第一条记录（概览信息）
  if (list.length > 0) {
    list[0].queueLength = waitQueue.length;
  }
  return list;
}

/**
 * 获取执行指标快照（监控/健康端点用）
 */
export function getMetrics(): SandboxMetrics {
  updateLiveMetrics();
  return { ...metrics };
}

/**
 * 关闭所有沙箱（进程退出时调用）
 */
export async function shutdownAll(): Promise<void> {
  // 停止所有定时器
  clearInterval(cleanupTimer);
  clearInterval(healthCheckTimer);

  // 拒绝所有排队请求
  while (waitQueue.length > 0) {
    const item = waitQueue.shift()!;
    clearTimeout(item.timer);
    item.reject(new Error("沙箱管理器正在关闭"));
  }

  // 销毁预热池中的容器
  console.log(`[Sandbox] 清理预热池 (${warmPool.length} 个)...`);
  while (warmPool.length > 0) {
    const warm = warmPool.shift()!;
    try {
      const container = docker.getContainer(warm.containerId);
      await container.stop({ t: 3 }).catch(() => {});
      await container.remove({ force: true }).catch(() => {});
      releasePort(warm.hostPort);
    } catch {
      // 忽略清理错误
    }
  }

  // 销毁所有活跃会话
  console.log(`[Sandbox] 关闭所有沙箱 (${sessions.size} 个)...`);
  const sessionKeys = Array.from(sessions.keys());
  await Promise.all(sessionKeys.map((key) => destroySandbox(key)));
}

// ── 空闲回收 ────────────────────────────────────────────────

async function reapIdleSandboxes(): Promise<void> {
  if (cleanupInProgress) {
    return;
  }
  cleanupInProgress = true;
  try {
    const now = Date.now();
    const expiredKeys = Array.from(sessions.entries())
      .filter(([, session]) => now - session.lastActiveAt >= sandboxConfig.idleTimeoutMs)
      .map(([key]) => key);

    for (const key of expiredKeys) {
      console.log(`[Sandbox] 空闲回收触发 | 会话: ${key}`);
      metrics.idleRecycled++;
      await destroySandbox(key);
    }
  } finally {
    cleanupInProgress = false;
  }
}

/** 空闲回收定时器 */
const cleanupTimer = setInterval(() => {
  void reapIdleSandboxes();
}, sandboxConfig.cleanupIntervalMs);
cleanupTimer.unref?.();

// ── 预热容器池 ──────────────────────────────────────────────

/**
 * 创建一个预热容器（不绑定任何会话，仅保持就绪状态）
 */
async function createWarmContainer(): Promise<WarmContainer> {
  const hostPort = allocatePort();
  const warmId = `warm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  console.log(`[Sandbox] 预热容器创建中 | ID: ${warmId} | 端口: ${hostPort}`);
  metrics.containersCreated++;

  let container: Docker.Container;
  try {
    container = await docker.createContainer({
      Image: sandboxConfig.image,
      name: `sandbox-${warmId}`,
      ExposedPorts: { "3100/tcp": {} },
      HostConfig: {
        Memory: parseMem(sandboxConfig.memoryLimit),
        NanoCpus: sandboxConfig.cpuLimit * 1_000_000_000,
        PortBindings: {
          "3100/tcp": [{ HostPort: String(hostPort) }],
        },
        // skills 目录只读挂载（预热容器也需要，容器启动时加载 Skill 定义）
        Binds: [
          `${getSkillsDir().replace(/\\/g, "/")}:/skills:ro`,
        ],
      },
      Env: [`SANDBOX_PORT=3100`],
    });
  } catch (err) {
    releasePort(hostPort);
    throw err;
  }

  try {
    await container.start();
  } catch (err) {
    releasePort(hostPort);
    await container.remove({ force: true }).catch(() => {});
    throw err;
  }

  // 使用临时 session 结构进行健康检查
  const baseUrl = buildSandboxBaseUrl(hostPort);
  const tempSession = { baseUrl, sessionKey: warmId } as SandboxSession;
  try {
    await waitForHealthy(tempSession);
  } catch (err) {
    releasePort(hostPort);
    await container.stop({ t: 3 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
    throw err;
  }

  const warm: WarmContainer = {
    containerId: container.id,
    baseUrl,
    hostPort,
    createdAt: Date.now(),
  };

  console.log(`[Sandbox] 预热容器就绪 | ID: ${container.id.slice(0, 12)} | URL: ${baseUrl}`);
  return warm;
}

/**
 * 延迟补充预热池：当预热池容器被取走后，延迟创建新容器补充
 */
function scheduleWarmPoolRefill() {
  // 计算需要补充的数量
  const needed = sandboxConfig.warmPoolSize - warmPool.length - warmPoolRefilling;
  if (needed <= 0) return;

  // 检查总容器数是否还有空间
  const available = sandboxConfig.maxContainers - totalContainerCount();
  const toCreate = Math.min(needed, available);
  if (toCreate <= 0) return;

  setTimeout(() => {
    for (let i = 0; i < toCreate; i++) {
      warmPoolRefilling++;
      createWarmContainer()
        .then((warm) => {
          warmPool.push(warm);
          console.log(`[Sandbox] 预热池已补充 | 当前池大小: ${warmPool.length}/${sandboxConfig.warmPoolSize}`);
        })
        .catch((err) => {
          console.error(`[Sandbox] 预热容器补充失败:`, err instanceof Error ? err.message : err);
        })
        .finally(() => {
          warmPoolRefilling--;
          updateLiveMetrics();
        });
    }
  }, sandboxConfig.warmPoolRefillDelayMs);
}

/**
 * 初始化预热池（应用启动时调用）
 * 异步预创建容器，不阻塞主进程启动
 */
export async function initWarmPool(): Promise<void> {
  if (sandboxConfig.warmPoolSize <= 0) {
    console.log("[Sandbox] 预热池已禁用 (warmPoolSize=0)");
    return;
  }

  console.log(`[Sandbox] 初始化预热池 | 目标大小: ${sandboxConfig.warmPoolSize}`);
  const results = await Promise.allSettled(
    Array.from({ length: sandboxConfig.warmPoolSize }, () => createWarmContainer()),
  );

  let successCount = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      warmPool.push(result.value);
      successCount++;
    } else {
      console.error(`[Sandbox] 预热容器创建失败:`, result.reason?.message ?? result.reason);
    }
  }

  updateLiveMetrics();
  console.log(`[Sandbox] 预热池初始化完成 | 成功: ${successCount}/${sandboxConfig.warmPoolSize}`);
}

// ── 容器健康巡检 ────────────────────────────────────────────

/**
 * 定期巡检所有活跃容器和预热容器的健康状态
 * 不健康的容器会被回收并补充
 */
async function healthCheckRound(): Promise<void> {
  // 检查活跃会话中的容器
  for (const [key, session] of sessions) {
    if (session.state === "stopping") continue;
    try {
      const res = await fetch(`${session.baseUrl}/health`, {
        signal: AbortSignal.timeout(sandboxConfig.healthCheckTimeoutMs),
      });
      if (!res.ok) {
        console.warn(`[Sandbox] 健康巡检失败 | 会话: ${key} | status=${res.status}`);
        metrics.unhealthyRecycled++;
        await destroySandbox(key);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Sandbox] 健康巡检异常 | 会话: ${key} | ${msg}`);
      metrics.unhealthyRecycled++;
      await destroySandbox(key);
    }
  }

  // 检查预热池中的容器
  const unhealthyWarm: number[] = [];
  for (let i = 0; i < warmPool.length; i++) {
    const warm = warmPool[i];
    try {
      const res = await fetch(`${warm.baseUrl}/health`, {
        signal: AbortSignal.timeout(sandboxConfig.healthCheckTimeoutMs),
      });
      if (!res.ok) {
        unhealthyWarm.push(i);
      }
    } catch {
      unhealthyWarm.push(i);
    }
  }

  // 倒序移除不健康的预热容器（避免索引偏移）
  for (let i = unhealthyWarm.length - 1; i >= 0; i--) {
    const idx = unhealthyWarm[i];
    const warm = warmPool[idx];
    console.warn(`[Sandbox] 预热容器不健康，移除 | ID: ${warm.containerId.slice(0, 12)}`);
    warmPool.splice(idx, 1);
    try {
      const container = docker.getContainer(warm.containerId);
      await container.stop({ t: 3 }).catch(() => {});
      await container.remove({ force: true }).catch(() => {});
      releasePort(warm.hostPort);
    } catch {
      // 忽略清理错误
    }
  }

  // 如果有预热容器被移除，触发补充
  if (unhealthyWarm.length > 0) {
    scheduleWarmPoolRefill();
  }
  updateLiveMetrics();
}

/** 健康巡检定时器 */
const healthCheckTimer = setInterval(() => {
  void healthCheckRound();
}, sandboxConfig.healthCheckIntervalMs);
healthCheckTimer.unref?.();

// ── 实时指标更新 ────────────────────────────────────────────

/** 更新实时变化的指标字段 */
function updateLiveMetrics() {
  metrics.activeContainers = sessions.size;
  metrics.warmPoolSize = warmPool.length;
  metrics.queueLength = waitQueue.length;
}

// ── 工具函数 ────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 解析内存限制字符串（如 "512m"）为字节数 */
function parseMem(mem: string): number {
  const match = mem.match(/^(\d+)(m|g)$/i);
  if (!match) return 512 * 1024 * 1024; // 默认 512MB
  const val = parseInt(match[1]);
  return match[2].toLowerCase() === "g" ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
}
