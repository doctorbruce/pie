# Pie MCP 接入

## 边界与来源

协议客户端来自上游 Pi 提交 `4270522473e677ddba7b093caa0064a3df51d459` 的 `packages/mcp`，包含未发布的 OAuth issuer 校验修复。保留原客户端测试、根 MIT 许可及 MCP TypeScript SDK OAuth 第三方许可；未升级 Pie 的 Agent/AI 核心。

共享配置校验与生命周期契约在 `packages/runtime/src/mcp.ts`；本地连接、OAuth、权限和工具适配在 `packages/local/src/mcp.ts`。运行包只消费注入的 MCP 实现，不默认启动本机进程。Astron 配置投影在 `adapters/pie/runtime_config.py`，状态回传通过 Core 的 MCP_STATUS port。浏览器设置页继续经 local-router 调用 Astron，不直连 Pie。

## 配置注册

宿主通过现有 `PUT /host-runtimes` 提交 runtime.mcp；Session/Turn 仍只引用 assistantId，不接受内联 runtime。示例：

```json
{
  "runtimes": [{
    "assistantId": "helper",
    "assistantRevision": "2",
    "runtime": {
      "systemPrompt": "",
      "toolIds": [],
      "skills": [],
      "subagents": [],
      "permissions": {"*": "ask"},
      "mcp": {
        "local": {"type": "local", "command": ["node", "/absolute/server.mjs"], "environment": {"TOKEN": "$MCP_TOKEN"}},
        "remote": {"type": "remote", "url": "https://example.com/mcp", "headers": {"Authorization": "Bearer example"}, "oauth": false}
      }
    }
  }]
}
```

local.command 的首项是程序，后续项是参数，可指定 environment/cwd；remote 使用 Streamable HTTP，可指定 headers。enabled=false 保留配置但不连接、不挂工具。timeout 单位为毫秒；Astron 可选字段的 null 按未设置处理。独立 Pie 也可直接使用该宿主注册协议配置 MCP；本次未增加独立 Web 客户端的 MCP 编辑页。

Astron 将共享 settings.mcp 与助手挂载且启用的 Plugin MCP 合并；群聊采用成员挂载范围。未挂载的 Plugin MCP 不进入该 owner 的工具集。已有 MCP 保存、删除、启停入口继续触发 runtime 配置刷新。

## 工具与生命周期

- 工具名为 mcp__server__tool，最大 64 字符，超长/清洗碰撞加哈希；与原生工具和外部分发工具共同进入已有 tool_search，默认延迟暴露 schema。
- system prompt 的“工具发现”概览列当前助手已挂载且支持延迟加载的工具 ID 和不超过 160 字符的一行用途，包含已连接的 MCP 工具，不包含参数 schema。按 runtime.language 选择中英文提示；同一配置下，搜索加载不删除概览中的条目，避免改写已有 system 前缀。加载状态以实际工具列表和 tool_search 结果为准；配置/语言变更可以更新概览，不修改持久化的宿主 prompt。
- MCP 的 initialize.instructions 不注入 system prompt。tool_search 发现某个 MCP 工具时，在该次工具结果中附带对应服务完整说明及权限边界，随后作为消息历史追加给模型；不修改已发送的消息或宿主 prompt，缺失或空白说明跳过。只提供本次选中工具所属服务的说明；精确工具 ID 重查可取得已加载工具的最新说明，旧说明保留在历史中，以最新搜索结果为准。删除/停用服务后不再返回其新说明，历史消息不回写。
- 这保证说明采用追加式消息上下文，而不是保证厂商缓存必然命中。动态加载仍改变请求 tools 字段；配置变更、历史分支、上下文压缩及 provider 的缓存策略也可能改变缓存前缀或命中结果。
- 执行仍经过当前助手 permissions/context.ask；远端 readOnly 等 hints 不绕过权限。取消与进度走原 AgentTool 信号和事件。
- MCP 的 isError 通过服务层 afterToolCall 映射为真实失败，同时保留结构化 details；不修改旧 Agent Loop 的成功/异常语义。
- 模型侧文本超过 20 KiB 时保留首尾，全文写入 PI_DATA_DIR/mcp-output；图片仍传模型，结构化结果保留在 details。
- stdio 按配置和工作目录管理，roots 指向该目录；HTTP 按完整配置共享，不向远端提供本地工作目录 roots。各会话只能挂载其 runtime 允许的工具。
- 配置更新保留在途 turn 的连接引用，停用/删除后待引用归零回收；退出先取消会话再关闭所有连接。断开/失败的空闲连接在下次调用时重新建立。

## 状态与 OAuth

原生 GET /mcp 返回 servers 映射，状态为 connecting、connected、disabled、disconnected、failed 或 needs_auth，可带 toolCount/error/authorizationUrl。读取仅访问内存，不探测下游。

Astron GET /agent/mcp 保留原有 mcp/status 返回形状，status 来自 Pie 的真实缓存状态；MCP_STATUS capability 使能力提示能读取这些状态。

remote 未关闭 OAuth 且无 Authorization header 时启用 MCP OAuth。授权需要浏览器时，status 中返回 authorizationUrl；调用方可打开该链接，loopback 回调交换 code、校验 issuer 后自动连接。凭据位于当前 Core 私有 PI_DATA_DIR/mcp-oauth，不写共享 providers/settings。此处是协议与状态接入，不代表 Astron 设置页已经有自动弹出授权浏览器的 UI。

## 兼容限制与交付

支持 stdio 和 Streamable HTTP，不支持旧 HTTP+SSE transport、sampling、tasks 或 batch JSON-RPC。复制协议包不意味着所有 MCP 符合性场景均通过。

Sidecar 构建同时生成可执行文件旁的 .LICENSES.txt，发行时须一起交付。开发源码验收不替代 EXE 验收；部署新版功能需重新构建/替换 Pie Sidecar，并重启所属 Runtime。

## 验证

选择 T2：本地真实 stdio/HTTP MCP fixture + faux provider，覆盖协议/服务边界，不使用收费模型。packages/server/test/mcp.test.ts 验证工具调用、业务失败、owner 隔离、权限、取消、配置刷新/在途引用、OAuth 回调及凭据恢复。上游 packages/mcp/test 原测试保留。

packages/server/test/tool-search.test.ts 捕获真实模型 SDK 发往本地 provider 的请求，验证首请求不带 MCP 说明、加载对应工具后的 tool 结果说明、空白/停用/未挂载隔离，以及重启/配置刷新后的精确 ID 重查。直接比较前后请求的 system 和完整 messages 前缀，确认说明仅追加、旧说明不回写；工具 schema 仍延迟暴露。

Astron test/test_pie_mcp.py 验证共享/Plugin 投影、配置 revision、状态 port，并启动真实 Pie Node Core 跑 Python→配置注册→stdio 工具循环→状态→停用刷新。没有 sibling Pie/Node 依赖的环境跳过跨仓库 smoke，其余契约测试仍执行。

```sh
npm run test:mcp
node --conditions=source --test packages/server/test/mcp.test.ts
node --conditions=source --test packages/server/test/tool-search.test.ts
npm run check
```
