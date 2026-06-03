# Kit
## 包含内容

- `apps/web`：前端应用（Vue3 + Vite + TDesign）
- `apps/agent-api`：Agent 服务（NestJS + LangGraph）
- `apps/sandbox-server`：沙箱执行服务（Fastify + Playwright）

## 环境要求

- Node.js `>= 20`
- pnpm `>= 10`
- Docker（用于沙箱能力与容器化部署）

## 快速开始

1. 安装依赖（工作区根目录执行）：

   ```bash
   pnpm install
   ```

2. 配置环境变量：

   - `apps/agent-api`：复制 `.env.example` 到 `.env` 并填写模型相关配置。
   - `apps/web`：按实际后端地址配置前端环境变量（如有）。
   - `apps/sandbox-server`：根据运行环境补充必要配置。

3. 分别启动服务（在工作区根目录执行）：

   ```bash
   pnpm run dev:web
   pnpm run dev:agent
   pnpm run dev:sandbox
   ```

## 根目录脚本

| 脚本 | 说明 |
|------|------|
| `pnpm run dev:web` | 启动前端开发服务器 |
| `pnpm run dev:agent` | 启动 Agent API（Nest watch 模式） |
| `pnpm run dev:sandbox` | 启动沙箱服务 |

## 工作区结构

```text
├── apps/
│   ├── web/
│   ├── agent-api/
│   └── sandbox-server/
├── package.json
└── pnpm-workspace.yaml
```

## 维护原则

- 保持开源版目录清晰、职责分离。
- 变更优先在对应子应用内完成，根目录仅维护工作区级配置。
- 尽量减少与原项目行为不一致的改动。
