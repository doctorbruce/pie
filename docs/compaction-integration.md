# Pie 自动压缩接入与 Amio 对比

## 来源和适配范围

参考上游 earendil-works/pi 的提交 `6fb2e7815167e6b19006fc526d1a5d0f5f998787`（2026-10-09 核验）：

- `packages/ai/src/utils/overflow.ts`：移植上下文超限分类器；保留多 Provider 错误模式、静默超限和零输出 length 识别，排除限流误判。
- `packages/ai/src/utils/retry.ts`：移植摘要调用的瞬时错误分类、有限次数指数退避和取消处理；等待改用 Node 的可取消定时器，避免积累 abort 监听器。
- `packages/coding-agent/src/core/compaction/utils.ts`：移植摘要专用系统提示、文本序列化、工具结果截断，以及 read/write/edit 文件列表。原版 codemode nestedCalls 尚无对应的 Pie 消息契约，未接入。
- `packages/coding-agent/src/core/compaction/compaction.ts`：适配用量分量回退、压缩后旧用量失效、工具调用安全边界和旧摘要合并。Pie 沿用已有结构化 checkpoint 格式，不搬入 CodingAgent 的树形 SessionManager。

当前仍是原生 Pie Core + SQLite 完整历史。手动压缩、slash 命令、CLI/TUI、扩展 hooks、分支树摘要和 context-edit 不在本轮范围内；未导入一套平行运行时。

## 自动路径

1. 在真实 SDK 调用前，按最终暴露的工具 schema、系统提示和消息估算输入；与有效最近用量取较大值。
2. 达到预算后摘要旧历史，合并旧 checkpoint，保留最近消息；切点不落在 toolResult 前，长工具轮次保留对应 assistant 调用。
3. 切分当前轮次时，额外保留当前原始 user 消息（包含图片），不为了恢复溢出而偷偷删除媒体。
4. 保存摘要、边界、生成时原始消息数量、文件列表和摘要用量；后续请求不再相信压缩前捕获的 usage。SQLite 和导出继续保留完整历史。
5. Provider 仍返回上下文超限，或零输出的提前 length 截断时，只在尚未转发内容事件且响应无有效内容时强制压缩并重试一次。重试不重复提交用户消息，不写入被抑制的错误 assistant，不重放已经执行的工具。
6. 摘要瞬时错误按上游策略重试，额度/计费错误不重试；空摘要、length、工具调用、取消或压缩后仍超预算都不写入 checkpoint。失败明确结束本轮，不再静默发送超预算上下文。

摘要请求本身采用上游文本序列化，不重新发送旧图片像素；已移入摘要的旧图片不再作为图片传入后续调用。当前轮次和保留区内的图片仍原样传入，原始图片始终保留在历史中。

## 和 Amio 的取舍

只读对照 `E:/Projects/amio-opencode/opencode/packages/opencode/src/session/overflow.ts`、`compaction.ts` 与 `prompt.ts`：

| 项目 | Amio | 本轮 Pie |
| --- | --- | --- |
| 实用安全预算 | 90% context 上限，并预留输出空间 | 同样采用 90% 上限，结合 reserveTokens |
| 自定义阈值 | threshold_tokens 不允许越过安全预算 | thresholdTokens 同样取安全预算的较小值 |
| 请求前检查 | 序列化 system + messages 估算 | system + 最终工具 schema + 消息，另参考有效 usage |
| 最近内容 | 尾部轮次与 token 预算 | keepRecentTokens + 工具调用安全切点，保留当前 user |
| Provider 超限 | 压缩任务后恢复执行 | 同一原生调用强制压缩后至多重试一次 |
| 图片处理 | 部分 overflow 路径会移除媒体 | 不删除当前图片；无法容纳时明确失败 |
| 运行时/存储 | OpenCode Session/Effect | 保持 Pie Agent loop 和 SQLite |

例如 contextWindow=1,048,576、默认 reserveTokens=16,384 时，预算是 943,718 tokens（90%），不再等到旧实现的 1,032,192 tokens。模型 ID、contextWindow 和 maxTokens 元数据均未改变。

## 配置

配置放在独立的 `PI_DATA_DIR/settings.json`，支持 JSON 注释，避免宿主重写 `models.json` 时丢失。配置在创建或重建 Agent 时读取，现有 Agent 需重启服务或重建运行时后应用。

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "astron-builtin/deepseek/deepseek-flash": {
        "thresholdTokens": 900000
      }
    }
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "maxAgentDelayMs": 60000
  }
}
```

键为 `provider/modelId`，modelId 可包含斜杠。默认 reserveTokens 为 16,384，较小窗口自动限制为四分之一；默认 keepRecentTokens 为 20,000，且不超过安全预算的一半。thresholdTokens 不填写时取 `min(floor(contextWindow * 0.9), contextWindow - reserveTokens)`。显式 reserveTokens 必须小于窗口，阈值必须为正，数字配置必须是非负安全整数。

`compaction.enabled=false` 同时关闭阈值压缩和 Provider 超限恢复。`retry` 控制摘要调用，不改变普通模型 SDK 的重试配置。

## 事件与验证

会话 SSE 和全局 SSE 提供 `compaction.started`、`compaction.retry`、`compaction.finished`（completed/failed/cancelled）。会话的 `compaction.updated` 和 `snapshot.compaction` 保持持久 checkpoint 的事实来源。

采用服务边界契约测试：本地 HTTP 模拟 Provider + 真实 SDK + SQLite，验证超限重试、摘要退避、额度失败、不完整摘要、取消、重启和图片保留；无需真实凭据或付费请求。确定性预算、用量、工具边界与摘要投影使用行为级单测。

```powershell
node --conditions=source --test packages/server/test/auto-compaction.test.ts packages/server/test/auto-compaction-server.test.ts packages/server/test/compaction.test.ts packages/server/test/compaction-server.test.ts packages/server/test/multimodal-input.test.ts
npm run check
```
