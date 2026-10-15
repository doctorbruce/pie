# webfetch B 站公开视频页兜底

状态：已完成

## 问题与目标

- 桌面视频页返回 HTTP 412，现有 `webfetch` 直接失败。实测替换 Accept、Referer、语言或复用匿名 Cookie 都未解决；同一视频的官方移动页配合移动端 User-Agent 可返回 HTML。
- 目标：原页面被拦截时，仍能读取该公开视频的页面文本，明确实际来源，不把页面信息当成视频转录。

## 范围与不做

- 仅处理 B 站官方域名下 BV/av 视频页的 HTTP 412，最多请求一次对应官方移动页，保留查询参数。
- 不读取浏览器 Cookie、不登录、不处理验证码，不接入第三方代理、浏览器或新依赖；不抓取音视频、不承诺字幕或视频内容。
- 不改变其他站点、正常响应或其他错误码的行为；保留现有 Cloudflare 分支。

## 实现思路

- 在 `packages/server/src/tools/webfetch.ts` 中限定域名、端口和视频路径；先释放失败响应，再确认移动页权限，然后携带移动端 UA 请求。
- 沿用同一取消信号、总超时、5 MiB 限额和 HTML 转换；返回实际移动页来源，文本结果说明不是视频转录。
- 在 `packages/server/test/webfetch.test.ts` 用本地响应与 transport mock 覆盖触发边界、权限、格式、限额和取消，不把真实网站作为自动测试依赖。

## 验收与记录

- 已复现：原生工具抓取 `BV12Gah67EZk` 返回 `Request failed with status code: 412`。
- 已实测：官方移动页 + iPhone UA 返回 200；桌面 URL 仅替换移动端 UA 仍为 412，不能只改 UA。
- 实际改动：`packages/server/src/tools/webfetch.ts` 增加限定域名、端口、BV/av 路径的单次移动页兜底；移动页单独确认权限，复用原请求的总超时和取消信号。返回 `sourceUrl`，文本/Markdown 标明来源与非转录限制，HTML 保持原始格式；原有转换、响应限额和长输出落盘继续共用。
- `packages/server/test/webfetch.test.ts` 新增 5 项测试：格式/域名/查询参数、触发边界、不重复重试、权限拒绝/取消、响应限额和共用超时。实现前定向运行 1 通过、4 失败，失败包含原始 412；实现后在 `packages/server` 执行 `node --conditions=source --test test/webfetch.test.ts test/tools.test.ts`，21 项全部通过。
- 真实链接复验：未修改 transport 的原生 `webfetch` 读取同一桌面 URL，经移动页兜底返回 200，Markdown 包含该视频标题、作者和 09:01 时长；本次约 0.86 秒。不是仅以 HTTP 状态判断成功。
- 根目录 `npm run check` 通过，包含 Biome、服务/Web 类型检查和模型数据校验；`git diff --check` 通过。`packages/server/CHANGELOG.md` 已记录。
- 相对方案无偏差；没有新增依赖、浏览器或登录态。未覆盖短链接、专栏、其他错误码、需登录内容和字幕/视频转录；未打包或替换运行中的 Sidecar，未提交。
