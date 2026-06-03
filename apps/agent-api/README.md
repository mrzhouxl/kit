# AI Comics Agent

类 Manus 风格的多功能 AI Agent，基于 **LangGraph** + **NestJS** + **TypeScript** 构建，可被 Vue3 前端直接接入。

---

## 能力清单

| 能力 | 说明 |
|------|------|
| 代码生成 | 任意语言代码生成、分析、解释 |
| UI 生成 | Vue3 + Tailwind 组件、页面布局 |
| 图像生成 | 文生图（Grok / Gemini / OpenAI 兼容） |
| 网页抓取 | 抓取指定 URL，提取正文内容分析 |
| 平台操作 | 查询和操作 ai-comics 项目、片段、素材 |
| 计划执行 | 先生成计划，再由图按步骤路由专业 Agent 执行 |

---

## 快速开始

### 1. 安装依赖

```bash
cd apps/agent-api
pnpm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，至少填写 DEEPSEEK_API_KEY
```

最小配置：

```env
DEEPSEEK_API_KEY=sk-xxxxxx
```

默认使用本地 SQLite：

```env
SQLITE_PATH=./storage/opensource-manus-agent.sqlite
```

说明：LangGraph Checkpointer 也固定使用同一个 SQLite 文件，无需额外配置。

### 3. 启动开发服务器

```bash
pnpm run dev
# → http://localhost:3002
```

### Docker 部署

Agent 服务已提供独立 Dockerfile，并接入根目录 docker compose 的 `agent` profile。

```bash
# 构建 sandbox 镜像（Agent 运行时按需创建沙箱容器）
docker compose --profile build-only build sandbox

# 构建并启动 agent
docker compose --profile agent up -d --build agent
```

如果在 Linux 服务器部署，建议设置：

compose 会将 `agent/.sandbox-workspaces` 与 `agent/src/skills` 以宿主机绝对路径挂载给 Agent，保证容器内通过 Docker Socket 创建 sandbox 时，bind mount 的源路径对宿主机 Docker daemon 可见。

---

## API 接口

### `POST /api/chat` — 流式 Agent 对话

接收 Vercel AI SDK 标准 messages 格式，通过 Data Stream Protocol 流式返回。

**请求体：**

```json
{
  "messages": [
    { "role": "user", "content": "帮我搜索 Vue3 最新版本的变化" }
  ],
  "toolset": "all",
  "maxSteps": 20,
  "projectContext": {
    "projectId": "xxx",
    "projectName": "我的漫画"
  }
}
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `messages` | `CoreMessage[]` | 必填 | 对话历史 |
| `toolset` | `"all"\|"web"\|"code"\|"comics"` | `"all"` | 工具集范围 |
| `systemPrompt` | `string` | 内置 | 覆盖系统提示词 |
| `projectContext` | `{ projectId, projectName? }` | — | 注入项目上下文 |
| `maxSteps` | `number` | `20` | Agent 最大迭代步数 |

### `POST /api/chat/generate` — 非流式对话

同上，同步返回完整结果（适合服务端调用）。

### `GET /api/chat/models` — 可用模型列表

### `GET /health` — 健康检查

---

## 前端接入（Vue3）

### 安装

```bash
npm install ai @ai-sdk/vue
```

### 示例组件

```vue
<script setup lang="ts">
import { useChat } from '@ai-sdk/vue'

const { messages, input, handleSubmit, isLoading } = useChat({
  api: 'http://localhost:3002/api/chat',
  body: {
    toolset: 'all',
    projectContext: { projectId: 'your-project-id' },
  },
})
</script>

<template>
  <div>
    <div v-for="msg in messages" :key="msg.id">
      <b>{{ msg.role }}</b>: {{ msg.content }}
    </div>
    <form @submit="handleSubmit">
      <input v-model="input" :disabled="isLoading" placeholder="输入指令..." />
      <button type="submit" :disabled="isLoading">发送</button>
    </form>
  </div>
</template>
```

---

## 工具集说明

| 工具 | 用途 |
|------|------|
| `fetchWebpage` | 抓取 URL 并提取正文 |
| `generateImage` | 文生图 |
| `saveCode` | 保存代码片段（前端展示用） |
| `explainCode` | 代码结构分析 |
| `listProjects` | 列出 ai-comics 项目 |
| `getProjectDetail` | 项目详情 |
| `listFragments` | 片段列表 |
| `createFragment` | 新建片段 |
| `triggerFragmentImage` | 触发片段图像生成 |
| `listMaterials` | 素材列表 |

---

## 目录结构

```
agent/
├── src/
│   ├── index.ts              # 服务入口（Nest bootstrap）
│   ├── config.ts             # 环境变量配置
│   ├── model.ts              # AI 模型实例
│   ├── chat/                 # 聊天控制器
│   ├── graph/                # LangGraph 多 Agent 编排
│   │   ├── prompts/          # Planner / Execution 等提示词
│   ├── sandbox/              # Docker 沙箱生命周期管理
│   └── tools/
│       ├── index.ts          # 工具导出汇总
│       ├── web.ts            # 网络工具
│       ├── image.ts          # 图像生成工具
│       ├── code.ts           # 代码工具
│       └── comics.ts         # ai-comics 平台工具
├── package.json
├── tsconfig.json
└── .env.example
```

---

## 运行说明

- 默认端口为 `3002`，与前端 `workspace/agent` 页面默认配置一致。
- 每个 `threadId` 会绑定独立沙箱，避免不同 Agent 会话串用浏览器/终端状态。
- 沙箱空闲超过 10 分钟会自动回收，可通过 `.env` 中的 `SANDBOX_*` 配置调整。
- 复杂任务默认先进入 Planner Agent 生成执行计划，再由图根据步骤路由到对应专业 Agent。

## 扩展工具

在 `src/tools/` 下新建 `.ts` 文件，使用 Vercel AI SDK 的 `tool()` 函数定义，然后在 `src/tools/index.ts` 的 `allTools` 中注册即可。

```typescript
import { tool } from 'ai'
import { z } from 'zod'

export const myTool = tool({
  description: '工具描述',
  parameters: z.object({ input: z.string() }),
  execute: async ({ input }) => {
    // 实现逻辑
    return { result: '...' }
  },
})
```
