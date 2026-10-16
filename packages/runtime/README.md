# Pie Runtime

`@pie/runtime` 提供可嵌入的会话运行时：Turn、消息树、上下文压缩、Subagent、工具发现与运行事件。底层模型 / 工具循环继续复用 `packages/agent`，不复制 Loop。

- 从包根入口导入 `createRuntime`、`createAgentFactory`、`RuntimeStore` 与能力契约；共享协议与工具类型可从 `@pie/runtime/protocol`、`@pie/runtime/tools` 导入。
- 宿主必须提供会话存储，以及模型、工具、Skill、MCP 和请求记录实现。导入此包不会打开 SQLite、读取本地模型配置、扫描工具目录或监听 HTTP。
- 本地实现位于 `@pie/local`；云端 `agent-service` 应自行装配数据库与 tools-sdk，不依赖本地适配包。
- 单次用户输入后，连续三次及以上使用相同 JSON 参数调用同一工具时，最终工具结果追加模型可见提醒；对象键顺序不影响判断。提醒不阻止必要的轮询或重试，不修改工具成功/失败状态，也不限制步数。检测覆盖当前工作窗口内的跨轮次调用；新用户输入或不同调用打断计数。
- 当前为源码 workspace 包，运行时需能解析内部 Agent / AI 依赖，并使用 `node --conditions=source`；发行产物及 Cloud workspace 接入尚待完成。

完整契约与示例见 [嵌入接入说明](../../docs/runtime-embedding.md)。仓库根目录执行 `npm run test:runtime` 验证嵌入调用和依赖边界，不调用真实模型。
