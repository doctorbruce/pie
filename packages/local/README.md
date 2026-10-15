# Pie 本地适配

`@pie/local` 为共享 Runtime 提供 SQLite、本机原生 / 外部工具、模型文件配置、Skill 文件读取、MCP 连接和请求记录，同时保留本地助手 / Plugin 管理。

- `createLocalHost(env)` 返回本地模型设置、Agent 工厂与异步 `ready` 运行时；资源由运行时 `close()` 释放。
- `createAgentFactory(env, options)` 提供本地默认装配；它不同于 `@pie/runtime` 中要求显式能力注入的同名工厂。
- `createSqliteRuntimeStore` 可将现有本地数据库适配到共享异步存储契约。
- 依赖方向只指向 Runtime 与底层协议 / 模型包，不导入 Server。云端宿主不应依赖此包以复用本机执行默认值。

本地 HTTP、CLI 和 Sidecar 入口仍位于 `packages/server`，原有命令与 `.pie` 数据格式不变。第三方工具许可随实现在本包 `LICENSES/` 保留；Sidecar 构建继续生成旁置 `.LICENSES.txt`。
