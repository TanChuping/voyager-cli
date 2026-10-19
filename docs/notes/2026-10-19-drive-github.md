# 2026-10-19 纪要：通过 Google Drive 和 GitHub 给 ChatGPT 传文件

## 结论

- 不再经过网页上传，改为让 ChatGPT 用它自带的 Google Drive 和 GitHub app 读文件。两条路都只改 voyager-cli，不动插件本体。
- 代码和需要来回改的内容走 GitHub（`--repo`），文档、PDF、打包的文件夹走 Drive（`--drive`）。
- 开发原则写进了 voyager-cli 的 `AGENTS.md`（commit `1d39569`）：尽量少改 Voyager 插件本体，新功能优先放在 CLI，其次是 site.json，最后才是新增插件 op。

## 实测结果

| 测试                                           | 结果                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Pro 读 Drive 上的 `.md`（334 KB）              | 读到全文，头尾 canary 都对                                                                  |
| Pro 读 Drive 上的 `.zip`                       | 先下载、再用 Python 解压，所有路径和 canary 都对                                            |
| 不在加号菜单里选 Drive，只贴链接或写文件夹名   | 5 档思考强度都能用（Pro 是我测的，其余 4 档是另一个 session 测的）                          |
| Pro 读私有仓库 `Nagi-ovo/voyager-gh-test`      | 3 个 canary 都对                                                                            |
| Pro 写私有仓库                                 | 建了 `chatgpt-write-test` 分支，提交 `aaf4c3b`，内容一字不差，`main` 没动；用 gh 独立核对过 |
| "允许 ChatGPT 使用 Google Drive / GitHub" 弹窗 | 测试中一次都没出现，写仓库前也没有确认                                                      |
| 通过 `voyager ask --drive --repo` 实跑         | 第一次没发出去，原因见下；改成只写文件 ID 后的结果见文末                                    |

## 发现的问题

- **ChatGPT 的 GitHub App 之前被停用了**：安全日志显示 2026-09-08 由 Nagi-ovo 本人停用（ChatGPT Codex Connector）。Jesse 已恢复，仓库范围保持 All repositories。
- **权限范围**：ChatGPT 的 Drive app 能搜、能列整个 Drive；GitHub app 能写所有仓库，而且不问。决定：权限是用户自己在 GitHub 上的设置，CLI 不管；读不到仓库时报错（退出码 3），提示去 `github.com/settings/installations` 加上。
- **提交署名**：ChatGPT 的提交，作者显示为 Jesse Zhang，提交人显示为 Nagi-ovo，和本人提交分不出来。所以 `--repo` 会要求它只写到新的 `chatgpt/*` 分支，由人来合并。这只是在提示里提要求，不是强制。
- **Drive 链接被变成卡片，导致发不出去**：ChatGPT 输入框会把 Drive 链接自动换成"Google Drive 卡片"，卡片图标里带一段 CSS。插件读输入框文字的 `domText`（`src/core/services/composer/index.ts:75`）把这段 CSS 也当成了正文，发送前核对文字对不上，报 `composer-busy`（`recent-input`），就没点发送。
- **失败后会留下草稿**：bridge 失败后，打进去的提示会作为草稿留在 ChatGPT 输入框里，下次打开还在。

## 取舍：Drive 卡片问题怎么修

| 方案                                  | 要不要发版插件 | 代价                                                                          |
| ------------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| CLI 在提示里只写文件 ID，不写链接     | 不要           | 今天就能用；依赖 ChatGPT 能按 ID 去取文件                                     |
| 插件读输入框时跳过 `<style>`、`<svg>` | 要             | 改一两行，核对保护还在；可能也修了普通用户贴 Drive 链接时的草稿问题（未验证） |
| 插件干脆不核对输入框文字              | 要             | 不省事，还会失去保护：用户在 bridge 标签页里打字时，可能把用户的字一起发出去  |

决定：CLI 先只写文件 ID，今天就能用；插件的读取修复等下次正常发版时一起带上。不去掉核对。

## 已推送的改动

两个仓库都已推送到 `main`：voyager-cli `050c9b1..ffa69bc`，插件仓库 `a3697606..5b866037`。

- voyager-cli `1d39569`：新增 `AGENTS.md` 和 `CLAUDE.md`。
- voyager-cli `b8558a5`（另一个 session）：`ask` 和 `read` 自动下载回复里附带的文件，存到 `output/files/`；`--no-files` 跳过。
- 插件仓库 `0af087a5` + `5b866037`（另一个 session）：新增 bridge op `files.download`；回复里 `sandbox:/mnt/data/…` 链接所在消息下载返回 404 时，自动换同一轮里的其他消息再试。
- voyager-cli `d4ad093`：
  - `voyager ask --drive <文件|文件夹>`：打包方式同 `--attach`（文件夹打成 zip、去掉密钥文件），用 rclone 上传到 `$VOYAGER_DRIVE_REMOTE` 下的新文件夹，在提示里写文件 ID。单个文件或 zip 上限 512 MiB，文件夹里超过 20 MiB 的单个文件仍会被跳过。
  - `voyager ask --repo owner/name[@ref]`：要求 ChatGPT 只写到新的 `chatgpt/<时间>-<id>` 分支；读不到仓库就以 `permission-missing` 失败（退出码 3），回复照样保存。
  - SKILL.md、README、README_ZH 已补上说明。

## 推送之后要做什么

| 功能                 | 要发什么版本                    | 旧版本插件的用户                           |
| -------------------- | ------------------------------- | ------------------------------------------ |
| `--drive`、`--repo`  | 只要发 CLI 的 npm 新版本        | 能用，插件不用更新                         |
| 自动下载回复里的文件 | CLI 的 npm 新版本，加插件新版本 | 照样能提问；文件不下载，CLI 提示去更新插件 |

- CLI 继续依赖已发布的 `@voyager-crew/bridge-protocol@0.3.0`，不用先发 protocol 0.3.1。0.3.1 只是清理，发了之后可以去掉 serve 里校验 base64 的临时写法。
- 插件仓库里还有 5 个改动没提交（导出、时间戳、`conversation-history-observer.js`），不属于这两份工作，没有推送。

## 待办

- [x] `--drive` / `--repo` 真实测试通过，已合并并推送（`d4ad093`）。
- [ ] 发 CLI 的 npm 新版本。
- [ ] 插件发新版本，带上 `files.download` 和下面的 `domText` 修复。
- [x] `voyager serve` 已交还给另一个 session（它需要从主工作区重启 serve）。
- [ ] 插件：`domText` 跳过 `<style>`、`<svg>` 等非正文节点；顺便看普通用户的草稿功能是否受影响。
- [ ] 插件：bridge 失败后清掉自己打进输入框的草稿。
- [x] Google Drive 授权卡抓到了，见 [2026-10-20 现场样本](2026-10-20-approval-card/README.md)。GitHub 的还没见过。
- [x] bridge：遇到授权卡默认停下（退出码 3）；加 `--approve-apps always|once` 时由插件替用户点。
- [ ] 清理测试残留（删除前再确认一次）：Drive 上的 `voyager-drive-test` 文件夹，私有仓库 `Nagi-ovo/voyager-gh-test`，ChatGPT 里的几个测试对话。

## 实跑结果（只写文件 ID 后）

通过。用 Pro 跑 `voyager ask --drive repo --repo Nagi-ovo/voyager-gh-test`（[对话](https://chatgpt.com/c/6ad6125d-b420-83ed-a9aa-3add7a936c4f)）：

- Drive：ChatGPT 按文件 ID 取到 zip，用 Python 解压，canary 正确。
- GitHub：从 `main` 读到 README 的 canary；按要求只往 `chatgpt/20261019-1251-9adf` 提交了 `1cc15b8`，只新增 `NOTES.md`，内容一字不差。用 gh 核对过，`main` 没动。
- 还没实测：读不到仓库时报退出码 3 的那条路径，目前只有单元测试覆盖。
- 合并后的 `main` 上 307 个测试全部通过。
