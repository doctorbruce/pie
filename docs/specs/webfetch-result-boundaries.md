# webfetch 结果语义边界

状态：已完成

## 问题与目标

现有 webfetch 成功结果缺少 HTTP 状态和重定向后的最终 URL，空正文也没有明确说明。补充可验证的抓取事实，避免把“收到响应”理解为“业务成功或已找到答案”。

## 范围与方案

- 成功结果增加 finalUrl、statusCode、bodyBytes、contentEmpty；保留请求 url、B 站兜底 sourceUrl、格式与截断信息。
- 模型文本先展示来源、HTTP 状态、正文大小与空内容标记，再展示有界正文；外部内容明确标为不可信数据。HTML 正文不做额外转换，长正文落盘仍保存完整的格式化正文。
- 区分零字节响应和格式转换后没有非空白内容；均不自动解释为“搜索无结果”。
- 保留非 2xx 抛错约定，仅补请求/最终 URL，不新增错误体读取；网络、超时、取消、权限和内容限额仍按现有错误语义处理。
- 不扫描业务码、success 字段、Error 或验证码关键词；不新增站点判错器，不改通用 loop、重试策略或 Astron UI。

## 验收

- T1/T2：重定向元数据、200/204 空正文、转换后空文本、HTTP 200 业务错误/验证码原样返回、非 2xx 与网络错误仍失败。
- 复验所有格式、B 站兜底、长输出、响应限额、超时与取消。
- 执行 node --conditions=source --test packages/server/test/webfetch.test.ts packages/server/test/tools.test.ts 及 npm run check。

## 实施记录

- 实际改动：packages/server/src/tools/webfetch.ts 补充结果元数据、前置来源/状态/空内容说明和 HTTP 错误 URL；packages/server/test/webfetch.test.ts 补充语义边界回归并适配结果头；server/CHANGELOG.md 记录修复。
- 验证：实现前 4 项针对性测试失败；实现后上述 webfetch 与原生工具测试 29/29 通过。覆盖重定向、空正文、转换后空内容、HTTP 200 业务错误/验证码不误判、HTTP/网络失败和原有格式/兜底/限额/超时/取消。
- npm run check 通过：Biome、当时的类型检查和模型数据校验；git diff --check 通过。
- 无实现偏差或范围内未完成项；未运行全量测试、真实站点/桌面验证，未打包、重启或提交。
