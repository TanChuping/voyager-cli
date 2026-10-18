# voyager-cli

`voyager` is the local half of the Voyager Local Bridge. `voyager serve` listens on
`127.0.0.1` only. The Voyager extension long-polls it for tasks and runs neutral ops
(open a conversation, send, wait for the reply, read) in a ChatGPT tab it opens itself.
Plugins such as `ask` combine those ops, and their `run()` executes inside serve, so a job
outlives the terminal that started it.

> Status: Phase B, text-only `ask`. Attachments, downloads, `--model`, restore,
> `job harvest` and third-party plugins arrive in Phase C.

```sh
voyager pair                             # one-time code for the extension popup
voyager ask --json "Reply with OK"       # new conversation → response.md
voyager read https://chatgpt.com/c/<id>  # an existing conversation's last finished reply
voyager ask --chat <link|id> "Follow-up" # ask in an existing conversation
voyager ask --continue "And then?"       # ask where the last succeeded ask/read was
voyager status
voyager job list | show <id> | wait <id> | cancel <id>
```

State lives in `~/.voyager/` (0700), or `$VOYAGER_HOME`: `config.json` (`{"port": 47321}`),
`serve.json`, `serve.lock`, `cli-token` and `pairings.json` (both 0600), `jobs/<id>/`,
`last-conversation.json` (0600, what `--continue` uses) and `logs/serve.log`.
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

### The protocol package (temporary local path)

`@voyager-crew/bridge-protocol` is the source of truth for wire types, validators and
golden fixtures. It lives in the Voyager repository, and for now this package depends on
it through a local path:

```json
"@voyager-crew/bridge-protocol": "file:../gemini-voyager/packages/bridge-protocol"
```

This is a development-only path. Before publishing, it becomes a pinned npm version.
Bun links each existing file as a symlink, so edits to existing protocol files show up
here right away. A file added to the package needs `bun install` again. The package
ships TypeScript source: `bun build` bundles it, and Vitest inlines it
(`server.deps.inline`).

### Trying it by hand without the extension

```sh
VOYAGER_HOME=/tmp/vh bun src/cli/main.ts serve --foreground   # terminal 1
VOYAGER_HOME=/tmp/vh bun src/cli/main.ts pair                 # terminal 2: prints the code
```

The extension side is the `FakeExtension` in `test/helpers/fakeExtension.ts`.
`test/cli/e2e.test.ts` shows it pairing and answering an `ask`.
