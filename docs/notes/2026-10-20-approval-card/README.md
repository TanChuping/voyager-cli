# 2026-10-20 现场样本：ChatGPT 连接器授权卡（「允许 ChatGPT 使用 Google Drive 吗？」）

> 这是一份附件：只有现场样本和一段参考脚本，没有接进任何代码。要不要处理、放在 CLI、site.json 还是插件哪一层，按 [AGENTS.md](../../../AGENTS.md) 的顺序由你们定。

![授权卡](card-before-click.png)

## 背景

[2026-10-19 纪要](../2026-10-19-drive-github.md)里写到，这张授权卡在测试中一次都没出现过。我们用 GPT-6 Pro（聊天模式）让它往 Google Drive **写**文件时遇到过两次：

| 时间             | 情况                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------- |
| 2026-10-18       | 一个对话第一次往 Drive 写文件，卡在干活中途出现；点了「始终允许」，之后几个新对话里都没再出现 |
| 2026-10-20 01:09 | 另一个新对话里又出现了：Pro 要调用 Drive 的 Upload File 工具                                  |

所以「始终允许」不是点一次就永久有效；它在什么条件下会重新出现，我们没弄清。只读 Drive 时没见过这张卡，这和纪要里的结果一致。

## 对 bridge 可能的影响（推断，没用 bridge 实测）

卡出现后，回复停在那里等人点，不点就不往下走。按 `turns.waitReply` 现在的规则，可能 20 分钟没动静后报 `reply-stalled`，也可能因为页面一直显示在工作中而一直等到 12 小时上限。我们是在 bridge 之外遇到的，哪种都有可能。

## 怎么认（完整结构见 [dom-structure.json](dom-structure.json)）

- 在对话流里、助手回复下方出现，是一张卡，不是弹出的对话框；位置在思考步骤「正在运行命令」后面。
- 卡上的文字：`Google Drive / 允许 ChatGPT 使用 Google Drive 吗？/ ChatGPT 将调用 Google Drive 的 Upload File 工具。查看详情 / 始终允许 / 拒绝 Esc / 允许一次 ⏎`
- 卡容器的 class 含 `@container/approval-card`；按钮所在 form 的 class 含 `@max-md/approval-card:flex-col`。
- 按钮都没有 `data-testid` / `aria-label` / `name`，只能按文字认；「始终允许」是 form 里第一个按钮。
- 键盘：Esc = 拒绝，Enter = 允许一次；「始终允许」没有快捷键。
- 在另一个新标签页里打开同一个对话，卡照样在、能点。
- 只在中文界面（zh-CN）见过。英文界面的按钮文字没核对过，脚本里的 `Always allow` 是猜的。
- outerHTML 没存到：浏览器工具把整段 outerHTML 拦下了（里面带会话数据），所以只存了结构。

## 参考脚本 [approval_card_click.js](approval_card_click.js)

在对话页里把整个文件当一个表达式执行（我们是用浏览器自动化工具的「执行 JavaScript」跑的）。它先找 class 含 `approval-card`、文字含 `Google Drive` 和「允许」的卡，再在卡里找文字恰好是「始终允许」的按钮点下去。返回值三种：`clicked`（点了）、`none`（页面上没有卡）、`ambiguous`（认不准，什么都没点）。

2026-10-20 实测返回 `{status: "clicked", clicked: 1, cards: 1}`。5 秒后页面上已经没有这张卡，对话里出现「已使用 Google Drive 集成运行了命令」，它要写的文件也出现在了 Drive 的目标文件夹里。

脚本只认 Google Drive 这张卡。GitHub 等别的连接器的授权卡我们没见过，不知道是不是同一个结构。

## 留给你们判断的

「始终允许」等于替用户做了一个权限决定。是在用户明确同意后（比如加一个开关）才自动点，还是遇到这张卡就按需要人处理（退出码 3）停下交给用户，这个由你们定。
