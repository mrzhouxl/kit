# Contributing

## 开发约定

- 保持前后端分离：`apps/web`、`apps/agent-api`、`apps/sandbox-server`
- 新能力优先在对应子项目内实现，避免跨目录耦合
- 提交前确保最小可运行验证通过

## 本地启动

1. 安装依赖：
   - 在各子项目目录分别执行安装命令
2. 配置环境变量：
   - 参考各子项目的 `.env.example` 或 README
3. 启动服务：
   - 前端：`pnpm dev:web`
   - Agent API：`pnpm dev:agent`
   - Sandbox：`pnpm dev:sandbox`

## 提交规范

- 使用小步提交，描述清晰
- 避免提交构建产物、日志、密钥与敏感信息
