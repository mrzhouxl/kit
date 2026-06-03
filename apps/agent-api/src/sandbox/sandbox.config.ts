/**
 * sandbox/sandbox.config.ts — 沙箱配置
 *
 * 从环境变量读取沙箱相关配置。
 * 包含容器资源限制、预热池、队列超时、健康巡检等生产级配置。
 */
import { resolve } from "node:path";
import type { SandboxConfig } from "./sandbox.types.js";

function optionalEnv(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

/** 工作区默认目录：统一放在项目目录下 .sandbox-workspaces */
function defaultWorkspaceDir(): string {
  // 统一转正斜杠：Docker bind mount 不接受反斜杠
  return resolve(process.cwd(), ".sandbox-workspaces").replace(/\\/g, "/");
}

/** 沙箱配置 */
export const sandboxConfig: SandboxConfig = {
  /** 沙箱 Docker 镜像名 */
  image: optionalEnv("SANDBOX_IMAGE", "ai-comics-sandbox:latest"),
  /** 最大并发容器数（含预热池） */
  maxContainers: parseInt(optionalEnv("SANDBOX_MAX_CONTAINERS", "5"), 10),
  /** 容器内存限制 */
  memoryLimit: optionalEnv("SANDBOX_MEMORY_LIMIT", "384m"),
  /** 容器 CPU 限制（核数） */
  cpuLimit: parseFloat(optionalEnv("SANDBOX_CPU_LIMIT", "1")),
  /** 隔离网络名 */
  network: optionalEnv("SANDBOX_NETWORK", "ai-comics-sandbox-net"),
  /** Agent 访问宿主机端口时使用的基地址 */
  hostBaseUrl: optionalEnv("SANDBOX_HOST_BASE_URL", "http://localhost"),
  /** 宿主机端口起始范围 */
  portRangeStart: parseInt(optionalEnv("SANDBOX_PORT_RANGE_START", "32000"), 10),
  /** 会话级沙箱空闲 10 分钟自动回收 */
  idleTimeoutMs: parseInt(optionalEnv("SANDBOX_IDLE_TIMEOUT_MS", "600000"), 10),
  /** 每 1 分钟扫描一次空闲沙箱 */
  cleanupIntervalMs: parseInt(optionalEnv("SANDBOX_CLEANUP_INTERVAL_MS", "60000"), 10),

  // ── 预热容器池 ──────────────────────────────────────────
  /** 预热池大小：启动后预创建 N 个就绪容器，分配时零等待 */
  warmPoolSize: parseInt(optionalEnv("SANDBOX_WARM_POOL_SIZE", "0"), 10),
  /** 预热池补充间隔（ms），池中容器被取走后延迟多久补充 */
  warmPoolRefillDelayMs: parseInt(optionalEnv("SANDBOX_WARM_POOL_REFILL_DELAY_MS", "5000"), 10),

  // ── 队列超时 ────────────────────────────────────────────
  /** 排队等待容器的最大超时时间（ms），超时后拒绝请求 */
  queueTimeoutMs: parseInt(optionalEnv("SANDBOX_QUEUE_TIMEOUT_MS", "30000"), 10),

  // ── 容器健康巡检 ────────────────────────────────────────
  /** 健康巡检间隔（ms），定期检查活跃容器是否还在响应 */
  healthCheckIntervalMs: parseInt(optionalEnv("SANDBOX_HEALTH_CHECK_INTERVAL_MS", "120000"), 10),
  /** 单次健康检查超时（ms） */
  healthCheckTimeoutMs: parseInt(optionalEnv("SANDBOX_HEALTH_CHECK_TIMEOUT_MS", "5000"), 10),

  // ── 工作区持久化 ────────────────────────────────────────
  /** 宿主机上用户工作区的根目录，每个 user+thread 在此下有独立子目录 */
  workspaceBaseDir: optionalEnv("SANDBOX_WORKSPACE_DIR", "") || defaultWorkspaceDir(),
  /** 容器内工作目录（与 Dockerfile 中 sandbox 用户的 HOME 一致） */
  containerWorkDir: optionalEnv("SANDBOX_CONTAINER_WORK_DIR", "/home/sandbox"),
};
