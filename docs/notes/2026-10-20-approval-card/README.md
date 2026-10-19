# 2026-10-20 现场样本：ChatGPT 连接器授权卡（「允许 ChatGPT 使用 Google Drive 吗？」）

![授权卡](card-before-click.png)

[2026-10-19 纪要](../2026-10-19-drive-github.md)里写到，这张授权卡在测试中一次都没出现过。我们用 GPT-6 Pro（聊天模式）让它往 Google Drive **写**文件时遇到过两次：

| 时间             | 情况                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------- |
| 2026-10-18       | 一个对话第一次往 Drive 写文件，卡在干活中途出现；点了「始终允许」，之后几个新对话里都没再出现 |
| 2026-10-20 01:09 | 另一个新对话里又出现了：Pro 要调用 Drive 的 Upload File 工具                                  |

「始终允许」不是点一次就永久有效，它在什么条件下会重新出现还不清楚。只读 Drive 时没见过这张卡，和纪要里的结果一致。

## 定下的处理方式

bridge 不替用户点这张卡：「始终允许」和「允许一次」都是用户的权限决定。遇到它时停下，按需要人处理（退出码 3）交给用户，提示去 ChatGPT 页面上自己点。

没处理之前，回复会停在卡上等人点。按 `turns.waitReply` 现在的规则，可能 20 分钟没动静后报 `reply-stalled`，也可能因为页面一直显示在工作中而等到 12 小时上限。这一段是推断，没用 bridge 实测。

## 怎么认（完整结构见 [dom-structure.json](dom-structure.json)）

- 卡在对话流里、助手回复下方，在思考步骤「正在运行命令」后面，不是弹出的对话框。
- 卡上的文字：`Google Drive / 允许 ChatGPT 使用 Google Drive 吗？/ ChatGPT 将调用 Google Drive 的 Upload File 工具。查看详情 / 始终允许 / 拒绝 Esc / 允许一次 ⏎`
- 卡容器的 class 含 `@container/approval-card`，最内层带 `role="alert"`；按钮所在 form 的 class 含 `@max-md/approval-card:flex-col`。识别卡用 class 里的 `approval-card`，不靠文字，换了界面语言也认得出。
- 按钮都没有 `data-testid`、`aria-label` 或 `name`，只能按文字认；「始终允许」是 form 里第一个按钮。
- 键盘：Esc 是拒绝，Enter 是允许一次；「始终允许」没有快捷键。
- 在另一个新标签页里打开同一个对话，卡照样在、能点。
- 只在中文界面（zh-CN）见过，英文界面的文字没核对过。
- 只见过 Google Drive 这张；GitHub 等别的连接器的授权卡是不是同一个结构还不知道。
- 没存 outerHTML：里面带会话数据，所以只存了结构。

点「始终允许」后（2026-10-20 实测）：5 秒内卡从页面上消失，对话里出现「已使用 Google Drive 集成运行了命令」，要写的文件出现在 Drive 的目标文件夹里。
