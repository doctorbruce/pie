# Shell 命令结果契约

状态：已完成

## 问题与目标

命令非零退出目前仍被后台任务登记为 completed，且前台、完成通知、job_output 暴露的退出码不一致。参考 Codex，区分“工具成功执行”和“命令执行成功”，让模型依据明确元数据判断结果，不扫描输出中的 Error。

## 范围与方案

- 在 shell job 的统一结算处按退出码判定状态：0 为 completed，非零或未知退出码为 failed，取消优先为 cancelled；不改变 task job 的完成语义。
- 复用同一状态文本，前置状态、耗时、退出码或缺失原因，再附有界输出；覆盖 bash 前台返回、后台完成通知及 job_output。
- job_output 的结构化结果补充已知退出码；运行中不伪造退出码，重复读取无新输出时仍保留终态信息。
- 普通非零退出正常返回 status=failed 与 exit；启动失败、超时、取消保留原有异常语义及原因。
- 不修改通用 loop 的 isError，不修改独立 grep 的无匹配语义，不新增搜索次数限制，也不改 Astron UI。

## 验收

- T1/T2 回归：真实命令的前台/后台非零退出一致，输出含 Error 但退出 0 不误判，超时/取消/启动失败不被吞掉，task 与 grep 不受影响。
- 执行 node --conditions=source --test packages/server/test/tools.test.ts packages/server/test/tool-progress.test.ts。
- 执行 npm run check；未运行全量测试、构建或桌面运行时验证。

## 实施记录

- 实际改动：packages/server/src/tools/jobs.ts 负责 shell 退出状态与共用结果头；shell.ts 接入前台和后台通知；job.ts 补充退出码并统一读取/停止结果；tools.test.ts 补充回归；server/CHANGELOG.md 记录修复。
- 验证：实现前回归测试复现 3 项失败；实现后上述定向测试 17/17 通过，覆盖普通非零退出、无新输出轮询、未知退出码、启动失败、超时、取消及 task/grep 语义隔离。
- npm run check 通过：Biome、当时的类型检查、模型数据校验；git diff --check 通过。
- 偏差与未完成项：无实现偏差；未构建、打包、重启 Astron 或做桌面 UI 验证，现有运行时需加载新版本后才生效。
