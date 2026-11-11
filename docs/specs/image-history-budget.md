# 历史图片预算

状态：已完成

## 问题与目标

长会话会在后续请求中重复发送历史图片。图片的上下文 token 估算不能限制 base64 请求体积，可能在用户只发短文字时继续触发上游 413。参考 Amio 已实现的策略，在共享 Runtime 发送前控制历史图片，并让视觉模型的压缩摘要读取预算内图片。

## 范围与方案

- 默认图片编码总量目标为 16 MiB，宿主通过 `runtime.maxHistoryImageBytes` 配置正安全整数；下一 Turn 应用，子助手使用自己的配置。独立本地模式使用默认值，不新增本地设置项。优先省略旧工具图片，再省略旧用户图片，同来源按历史顺序处理。
- 最新真实用户消息中的所有图片保留，合成通知和 checkpoint 不抢占保护。省略的图片替换为明确文本，保留文字与工具调用配对；不修改原始消息或持久历史。
- 视觉模型摘要接收预算内图片及原文位置标记，文字模型继续只接收文本；当前用户图片、已执行工具结果及既有一次超限恢复语义保留。token 预检按实际图片投影估算，历史图片被省略后不再复用原请求的 usage。
- 完整 HTTP 请求大小、图片文件重编码、远程内容获取、数据库修复和产品构建部署不在本次范围。图片预算不保证上游接受，当前用户图片可超过目标。

## 验收与测试决策

- T1：图片来源优先级、重复图片逐份计费、真实用户保护、原始消息不变。
- T2：通过本地模型端点验证真实出站裁剪、持久原图、视觉摘要及 413 恢复边界；沿用现有压缩回归。
- 运行最小相关测试文件及仓库要求的 `npm run check`，安排独立审核；不调用真实上游或付费模型。

## 实施与证据

- 共享纯投影及真实用户判定位于 `packages/runtime/src/image-history.ts`；排除合成消息、能力清单、checkpoint、Worker 来信和导入的系统消息。`agent.ts` 只在最终模型请求副本裁剪图片，不把副本交给持久化或压缩提交。
- `compaction.ts` 将视觉摘要中的图片与原位置标记对应；保留原对象及存储边界。`compaction/overflow.ts` 识别 HTTP/流式 413 和请求体过大，沿用每次原生模型调用最多一次强制压缩恢复。
- `protocol.ts`、`config.ts` 提供并校验公开预算字段，子助手按目标配置传递。复用既有上传 MIME/base64 与单轮解码总量校验；未增加图片重编码或依赖。
- 配置校验、真实出站历史裁剪和视觉摘要测试已在旧行为下失败，再由实际实现转绿。

## 验证结果

以下命令均从仓库根目录运行，相关 60 项测试通过：

- `node --conditions=source --test packages/runtime/test/image-history.test.ts packages/runtime/test/image-history-config.test.ts`：10 项，覆盖预算、真实用户保护、不可变性和宿主/子助手配置。
- `node --conditions=source --test packages/server/test/compaction.test.ts packages/server/test/auto-compaction.test.ts`：23 项，覆盖视觉摘要、43 张图片的完整来源索引、投影后用量和已有压缩边界。
- `node --conditions=source --test packages/server/test/auto-compaction-server.test.ts`：15 项，使用真实 SDK、本地 HTTP 和 SQLite，覆盖实际出站、下一轮预算更新、重启后原图保留、HTTP/SSE 413 有限恢复及已执行工具不重放。
- `node --conditions=source --test packages/server/test/multimodal-input.test.ts packages/server/test/host-compaction.test.ts`：7 项，覆盖输入校验与宿主压缩配置回归。
- `node --conditions=source --test packages/server/test/working-history.test.ts packages/server/test/compaction-server.test.ts`：5 项；未启用 `--expose-gc`，不作为强制 GC 的验证证据。
- `npm run check`：通过 Biome 严格检查、TypeScript 和生成模型数据检查。`git diff --check` 通过。独立源码审核通过，无剩余阻塞。

未调用真实上游或付费模型，未打包、部署或重启用户实例，未修改同事数据库。最新用户图片仍可超过目标，16 MiB 只约束图片编码部分，不能保证完整请求不触发 413。没有增加图片重编码；跨核导出沿用既有契约，工具图片仍导出为文本占位。
