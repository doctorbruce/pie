# Pi 上游：编辑最后一条用户 prompt 后重发

调查日期：2026-10-13。固定上游 `earendil-works/pi` main 快照：[a4d040d30f2cb30fffbd841b3f0a7052158e2e21](https://github.com/earendil-works/pi/commit/a4d040d30f2cb30fffbd841b3f0a7052158e2e21)。文档和源码均通过 `git show <sha>:<path>` 只读核对，不混用本地 Pie 实现或后续 main。仅调查既有交互能力，不判断 Astron bug。

## 结论

**上游已有“取回旧 prompt → 编辑 → 手动按 Enter 重发”的能力，但追加、原会话分支、新会话是三种不同语义。** README 指向交互文档；会话文档明确说明，`/tree` 选用户消息后可编辑并提交新分支。[R1][D1]

| 入口 | 操作 | 实际语义 |
| --- | --- | --- |
| 编辑器 `↑` | 空编辑器按 `↑` 召回最近输入，修改后 `Enter` | 在当前会话当前分支末尾追加新用户消息；不会撤回旧 prompt 或旧回复。[D2][S1a][S1b][S2][S3] |
| `/tree` | 选要改的用户消息，选 `No summary`，编辑回填文本后 `Enter` | 保持同一会话文件，从该用户消息的父节点建立新分支；旧分支仍保存。适合“不新建会话，重新回答修改后的最后一问”。[D1][S4][S5][S6] |
| `/fork` | 选要改的用户消息，编辑回填文本后 `Enter` | 新建并切换会话，复制至该用户消息之前；选中的旧 prompt 及后续回复不进入新会话路径。[D1][S7][S8] |

选消息只回填文本、切换上下文，不会自动发送；修改后仍需 `Enter`。[S2][S5][S7]

## 快捷键及边界

- 有默认 `↑` 历史召回。`tui.editor.historyPrevious/historyNext` 可自行绑定，默认均为 `None`，不受光标位置限制；默认 `↑` 则在首个视觉行且编辑器为空、正在浏览历史或光标列为 0 时进入历史。[D2][S1b]
- 文档列出的默认动作中，没有单键完成“回退到最后一问之前并编辑重发”的操作。空编辑器连续两次 `Escape`（间隔小于 500 ms）默认打开 `/tree`，仍需选节点；`doubleEscapeAction` 可设为 `fork` 或 `none`。[D2][D3][S9]
- `Ctrl+G` 编辑的是当前编辑器文本；全屏 `Ctrl+Up` 只跳转显示的历史消息；`Alt+Up` 回填排队消息（Windows/WSL 默认 `Alt+Q`），均不是撤回已完成的最后一问。[D2]
- `/fork` 默认选用户消息列表最后一项，但列表来自会话全部用户消息，不保证是“当前分支最后一问”；需确认选中了目标用户节点。[S7][S10]
- `/tree` 选当前叶节点是空操作；界面仅在编辑器为空时回填文本。导航时若响应仍在进行，界面会先中止响应；底层 `navigateTree()` 不接受 streaming/compaction 状态。[S4][S5]
- 若要仅使用修改前的上下文，选 `No summary`；选择摘要可能把离开分支的信息带入新分支。模型使用活动分支，而非文件中的全部分支。[D1][S4][S5]

## 最小例子

已完成 `P → U1 → A1 → U2 → A2`，把最后一问改成 `U2′`：

```text
↑ 召回后发送：原分支 P → U1 → A1 → U2 → A2 → U2′ → A2′
/tree 选 U2： 同一会话新分支 P → U1 → A1 → U2′ → A2′，旧分支保留
/fork 选 U2： 新会话 P → U1 → A1 → U2′ → A2′，原会话保留
```

这里 `/tree` 采用 `No summary`，省略非消息节点。路径推导来自 `navigateTree()` 取 `targetEntry.parentId`、`fork()` 默认 `position = "before"`，以及消息以当前叶节点为父节点追加。[S3][S4][S6][S8]

## 固定版本官方证据

以下链接全部指向同一 SHA；链接文字给出准确上游路径和起始行号。

- [R1：README.md:18](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/README.md#L18-L22)：官方交互文档入口。
- [D1：packages/coding-agent/docs/sessions.md:20](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/packages/coding-agent/docs/sessions.md#L20-L38)：/tree 同会话、/fork 新会话；选用户消息后编辑提交；模型使用活动分支。
- [D2：packages/coding-agent/docs/keybindings.md:49](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/packages/coding-agent/docs/keybindings.md#L49-L167)：53–68 行：历史动作；111 行：全屏跳转；128 行：外部编辑器；138–139 行：tree/fork 无默认绑定；167 行：队列回填。
- [D3：packages/coding-agent/docs/settings.md:34](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/packages/coding-agent/docs/settings.md#L34-L35)：空编辑器双 Escape 默认打开 tree。
- [S1a：packages/tui/src/components/editor.ts:425](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/packages/tui/src/components/editor.ts#L425-L485)：输入历史存储、召回到编辑器，不操作会话树。
- [S1b：packages/tui/src/components/editor.ts:860](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/packages/tui/src/components/editor.ts#L860-L949)：独立历史键；926–949 行：上下箭头进入历史的条件。
- [S2：packages/coding-agent/src/modes/interactive/interactive-mode.ts:3376](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3376-L3397)：streaming 时提交为 steer；空闲时普通提交并加入历史，不执行回退。
- [S3：packages/coding-agent/src/core/session-manager.ts:1191](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/packages/coding-agent/src/core/session-manager.ts#L1191-L1214)：新消息以 parentId = leafId 追加，并推进叶节点。
- [S4：packages/coding-agent/src/core/agent-session.ts:3989](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/packages/coding-agent/src/core/agent-session.ts#L3989-L4176)：导航状态检查；4117–4120 行取用户消息父节点和文本；4130–4163 行切换分支并刷新上下文。
- [S5：packages/coding-agent/src/modes/interactive/interactive-mode.ts:5571](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5571-L5682)：当前叶节点空操作；摘要选择；中止 streaming；空编辑器回填文本，不自动发送。
- [S6：packages/coding-agent/src/core/session-manager.ts:1573](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/packages/coding-agent/src/core/session-manager.ts#L1573-L1593)：移动叶节点不修改或删除旧节点；首问可回退到空根。
- [S7：packages/coding-agent/src/modes/interactive/interactive-mode.ts:5512](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5512-L5547)：fork 默认选列表最后一项；fork 后回填 selectedText，不自动发送。
- [S8：packages/coding-agent/src/core/agent-session-runtime.ts:262](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/packages/coding-agent/src/core/agent-session-runtime.ts#L262-L349)：fork 默认 before：取用户消息父节点与文本，创建并切换新会话。
- [S9：packages/coding-agent/src/modes/interactive/interactive-mode.ts:3070](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3070-L3095)：空编辑器双 Escape 的 500 ms 门槛及 tree/fork 分派。
- [S10：packages/coding-agent/src/core/agent-session.ts:4186](https://github.com/earendil-works/pi/blob/a4d040d30f2cb30fffbd841b3f0a7052158e2e21/packages/coding-agent/src/core/agent-session.ts#L4186-L4201)：从 getEntries() 收集全部有文本的用户消息供 fork 选择。

验证方式：固定提交文档与对应源码只读核对，未切分支、修改业务代码、安装依赖或运行真实 provider 测试。仅新增本文档，文档变更无需运行 `npm run check`。
