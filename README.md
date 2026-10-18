# voyager-cli

`voyager` is the local half of the Voyager Local Bridge. `voyager serve` listens on
`127.0.0.1` only. The Voyager extension long-polls it for tasks and runs neutral ops
(open a conversation, send, wait for the reply, read) in a ChatGPT tab it opens itself.
Plugins such as `ask` combine those ops, and their `run()` executes inside serve, so a job
outlives the terminal that started it.

> Status: Phase C in progress. `ask` attaches files and folders and selects the model
> (`--model`, default GPT-6 Pro, which stays selected). Downloads, `--out`,
> `job harvest` and third-party plugins arrive later.

```sh
voyager pair                             # one-time code for the extension popup
voyager ask --json "Reply with OK"       # new conversation → response.md
voyager ask --model high "Quick check"   # pro (default), extra-high, high, medium, instant, current
voyager read https://chatgpt.com/c/<id>  # an existing conversation's last finished reply
voyager ask --chat <link|id> "Follow-up" # ask in an existing conversation
voyager ask --continue "And then?"       # ask where the last succeeded ask/read was
voyager status
voyager job list | show <id> | wait <id> | cancel <id>
```

A Pro reply can take hours. `ask` waits for it as long as ChatGPT is still generating; the job
fails `reply-stalled` (exit 6) only after 20 minutes without any activity, and gives up at 12
hours. `--timeout` bounds only how long a command waits in the foreground. For long prompts,
submit once and wait in rounds:

```sh
voyager ask --json --no-wait "…"                 # → {"jobId": "…", "status": "running"}
voyager job wait <jobId> --timeout 10m --json    # exit 4: still running, wait again
```

`job wait` prints the same result and exit code as `ask` once the job ends. Never resend
the prompt after exit 4: the job is still running.

ChatGPT projects keep files every chat in the project can read:

```sh
voyager project list                          # g-p-<id>  name, from the sidebar
voyager project create "论文 Q3"
voyager project files "论文 Q3"               # <project>: its name or g-p- id
voyager project upload "论文 Q3" ./thesis     # a folder goes up as thesis.zip, credentials left out
voyager project remove "论文 Q3" notes.md --yes
voyager ask --project "论文 Q3" "Summarise thesis.zip"   # a new chat in the project
```

ChatGPT ignores an upload under a name the project already holds, without a word, so
`upload` replaces: it removes the old file, uploads, and checks the new one is listed once.
A file unchanged since this machine uploaded it is skipped (fingerprints in
`plugin-state/project.json`). Removing is immediate and cannot be undone: `remove` asks on a
terminal, and without one it runs only with `--yes`. Put material many chats need in the
project; use `--attach` for files one question needs.

State lives in `~/.voyager/` (0700), or `$VOYAGER_HOME`: `config.json` (`{"port": 47321}`),
`serve.json`, `serve.lock`, `cli-token` and `pairings.json` (both 0600), `jobs/<id>/`,
`last-conversation.json` (0600, what `--continue` uses), `plugin-state/` (each plugin's own
JSON, 0600) and `logs/serve.log`.
`skills/voyager/SKILL.md` tells an agent how to use the CLI.

## Development

```sh
bun install
bun run build        # dist/cli.mjs, a single file with no runtime dependencies
bun run test         # vitest; test/cli/e2e.test.ts builds its own copy and spawns it
bun run typecheck
bun run lint:check
bun run format:check
```

Without building, run it from source with `bun src/cli/main.ts <command>`.

### The protocol package

`@voyager-crew/bridge-protocol` is the source of truth for wire types, validators and
golden fixtures. It lives in the Voyager repository (`packages/bridge-protocol`) and is
installed from npm. A protocol change lands there first: raising its version on Voyager's
`main` stages a release that a maintainer approves, then this package moves to the new
version. To try an unreleased protocol change, point the dependency at a local checkout
for a while (`"file:../gemini-voyager/packages/bridge-protocol"`) and run `bun install`.
The package ships TypeScript source: `bun build` bundles it, and Vitest inlines it
(`server.deps.inline`).

### Trying it by hand without the extension

```sh
VOYAGER_HOME=/tmp/vh bun src/cli/main.ts serve --foreground   # terminal 1
VOYAGER_HOME=/tmp/vh bun src/cli/main.ts pair                 # terminal 2: prints the code
```

The extension side is the `FakeExtension` in `test/helpers/fakeExtension.ts`.
`test/cli/e2e.test.ts` shows it pairing and answering an `ask`.
