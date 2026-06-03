/**
 * config.ts — 从环境变量读取运行时配置
 * 所有模块通过此文件获取配置，避免直接访问 process.env。
 */
import "dotenv/config";

function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (!value) {
    throw new Error(`缺少必需的环境变量: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

// ---------- 模型 ----------
export const modelConfig = {
  apiKey: requireEnv("DEEPSEEK_API_KEY", "sk-placeholder"),
  baseURL: optionalEnv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
  chatModel: optionalEnv("CHAT_MODEL", "deepseek-chat"),
};

export const supervisorModelConfig = {
  apiKey: optionalEnv("SUPERVISOR_API_KEY", modelConfig.apiKey),
  baseURL: optionalEnv("SUPERVISOR_BASE_URL", modelConfig.baseURL),
  model: optionalEnv("SUPERVISOR_MODEL", modelConfig.chatModel),
};

// ---------- 图像 ----------
export const imageConfig = {
  apiKey: optionalEnv("IMAGE_API_KEY"),
  baseURL: optionalEnv("IMAGE_API_BASE_URL", "https://aigc.x-see.cn"),
  model: optionalEnv("IMAGE_MODEL", "gpt-image-2-reverse"),
};

// ---------- 视频 ----------
export const videoConfig = {
  apiKey: optionalEnv("VIDEO_API_KEY", optionalEnv("IMAGE_API_KEY")),
  baseURL: optionalEnv("VIDEO_API_BASE_URL", optionalEnv("IMAGE_API_BASE_URL", "https://aigc.x-see.cn")),
  model: optionalEnv("VIDEO_MODEL", "sora-2-reverse"),
  requestTimeoutMs: parseInt(optionalEnv("VIDEO_REQUEST_TIMEOUT_MS", "120000"), 10),
  pollIntervalMs: parseInt(optionalEnv("VIDEO_POLL_INTERVAL_MS", "5000"), 10),
  maxWaitMs: parseInt(optionalEnv("VIDEO_MAX_WAIT_MS", "900000"), 10),
};

// ---------- 本地文件存储（开源版默认） ----------
export const localStorageConfig = {
  rootDir: optionalEnv("LOCAL_STORAGE_ROOT_DIR", "./storage/uploads"),
  publicBaseUrl: optionalEnv("LOCAL_STORAGE_PUBLIC_BASE_URL", "http://localhost:3002/storage/uploads"),
  keyPrefix: optionalEnv("LOCAL_STORAGE_KEY_PREFIX", "agent/generated"),
};

// ---------- AI Comics 后端 ----------
export const comicsConfig = {
  baseURL: optionalEnv("COMICS_API_URL", "http://localhost:8080"),
  jwtToken: optionalEnv("COMICS_JWT_TOKEN"),
};

// ---------- JWT 鉴权 ----------
export const jwtConfig = {
  secret: requireEnv("JWT_SECRET"),
};

// ---------- 开源版鉴权 ----------
export const opensourceAuthConfig = {
  expiresInHours: parseInt(optionalEnv("AUTH_TOKEN_EXPIRES_HOURS", optionalEnv("OPENSOURCE_LOGIN_EXPIRES_HOURS", "24")), 10),
};

// ---------- 数据库（开源版默认 SQLite） ----------
export const databaseConfig = {
  sqlitePath: optionalEnv("SQLITE_PATH", "./storage/opensource-manus-agent.sqlite"),
};

// ---------- 服务器 ----------
export const serverConfig = {
  port: parseInt(optionalEnv("PORT", "3002")),
  corsOrigins: optionalEnv(
    "CORS_ORIGINS",
    "http://localhost:5173,http://localhost:3000,http://localhost:3002,http://localhost:3003,http://localhost:3004,http://localhost:3005",
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
};
