<div align="center">
  <img src="assets/logo.png" alt="Voyager logo" width="96" height="96">
  <h1>voyager</h1>
  <p>在终端里向 ChatGPT 提问，或者交给你的 coding agent 去问，<br>用的就是你浏览器里已经登录的那个 ChatGPT。</p>
  <p>
    <a href="https://www.npmjs.com/package/@voyager-crew/cli"><img src="https://img.shields.io/npm/v/@voyager-crew/cli?style=flat-square" alt="npm version"></a>
    <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license">
  </p>
  <p><a href="README.md">English</a> • <b>简体中文</b></p>
</div>

```sh
voyager ask "帮我审一下这份设计" --attach ./docs/design.md
```

`voyager` 把问题交给 [Voyager](https://github.com/voyager-crew/voyager) 浏览器插件。插件在
ChatGPT 标签页里填好问题、等它回答完，再把回答存成 `response.md`。全程都在你自己的电脑上：命令行只监听
`127.0.0.1`，ChatGPT 看到的就是你浏览器里一次普通的对话。

## 安装

1. 安装命令行（需要 Node.js 20.3 或更高版本）：

   ```sh
   npm install -g @voyager-crew/cli
   ```

2. 在浏览器里安装 Voyager。打开插件弹窗，进入 **插件**，打开 **ChatGPT · 本地桥**，并允许访问
   chatgpt.com。
3. 配对一次：

   ```sh
   voyager pair
   ```

   把它显示的 8 位配对码填进弹窗里「本地桥」的设置。

## 提问

```sh
voyager ask "解释一下这段报错" --attach crash.log
voyager ask "看看这个仓库" --attach ./src          # 文件夹会打包成 zip，自动去掉密钥等凭据
voyager ask --model high "快速检查一下"            # pro（默认）、extra-high、high、medium、instant
voyager ask --chat <链接|id> "边界情况呢？"         # 在已有对话里接着问
voyager read <链接|id>                             # 保存某个对话的最新回答
```

默认用聊天模式下的 GPT-6 Pro，除非你另选思考强度；问完保持在这个选择上。Voyager 不会把 ChatGPT
切到「工作」模式。回答保存在 `~/.voyager/jobs/<id>/output/`，加 `--json` 会输出文件路径和对话链接。

### 很长的回答

Pro 可能要想好几个小时。只要 ChatGPT 还在写，`ask` 就一直等；连续 20 分钟完全没动静才算失败。想先拿回终端，就先提交、之后再取：

```sh
voyager ask --no-wait "…"            # 输出一个任务 id
voyager job wait <id> --timeout 10m  # 退出码 4 表示还在跑：接着等，千万别重发问题
```

## 项目

ChatGPT 的项目可以存放文件，项目里的每个对话都能读到。代码库或论文传一次就行，不用每次提问都附上。

```sh
voyager project create "论文"
voyager project upload "论文" ./thesis             # 内容变了就替换，没变就跳过
voyager ask --project "论文" "论证最薄弱的地方在哪？"
voyager project files "论文"
voyager project remove "论文" old-notes.md         # 立即删除且无法恢复，会先确认
```

## 给 agent 用

Claude Code、Codex 以及任何能运行终端命令的 agent 都能用 `voyager`。
[`skills/voyager/SKILL.md`](skills/voyager/SKILL.md) 就是写给它们看的：JSON 输出、每个退出码的含义、怎么等长任务而不把问题发两遍，以及接着问时用
`--chat` 加上次拿到的对话 id，而不是 `--continue`。

同一时间只跑一个任务。每次的结果里还会带上你的 ChatGPT 套餐（`Pro Lite ($100)`、`Pro ($200)`
等），以页面最近一次报告的为准。

## 须知

- 桥会自己打开一个 ChatGPT 标签页，用完关掉。如果 ChatGPT 要求登录或人机验证，`voyager`
  会停下来告诉你（退出码 3），不会绕过。
- 全部命令见 `voyager --help`。状态保存在 `~/.voyager`（或 `$VOYAGER_HOME`），只有你的用户能读。
- 已在 Chrome 中测试。Edge 和 Firefox 版的 Voyager 也带这个桥；Safari 版没有。

## 许可证

MIT。开发说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。
