<div align="center">
  <img src="assets/logo.png" alt="Voyager logo" width="96" height="96">
  <h1>voyager</h1>
  <p>Ask ChatGPT from your terminal, or let your coding agent do it,<br>through the ChatGPT you are already signed in to in your browser.</p>
  <p>
    <a href="https://www.npmjs.com/package/@voyager-crew/cli"><img src="https://img.shields.io/npm/v/@voyager-crew/cli?style=flat-square" alt="npm version"></a>
    <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license">
  </p>
  <p><b>English</b> • <a href="README_ZH.md">简体中文</a></p>
</div>

```sh
voyager ask "Review this design" --attach ./docs/design.md
```

`voyager` hands the prompt to the [Voyager](https://github.com/voyager-crew/voyager) browser
extension, which types it into a ChatGPT tab, waits for the answer and saves it as
`response.md`. Everything stays on your machine: the CLI listens on `127.0.0.1` only, and
ChatGPT sees an ordinary chat from your own browser.

## Setup

1. Install the CLI (Node.js 20.3 or later):

   ```sh
   npm install -g @voyager-crew/cli
   ```

2. Install Voyager in your browser. In its popup, open **Plugins**, turn on
   **ChatGPT · Local Bridge** and allow access to chatgpt.com.
3. Pair them once:

   ```sh
   voyager pair
   ```

   Enter the eight-character code it prints in the Local Bridge settings in the popup.

## Asking

```sh
voyager ask "Explain this stack trace" --attach crash.log
voyager ask "Look over the repo" --attach ./src     # folders go up as a zip, secrets left out
voyager ask --model high "Quick sanity check"       # pro (default), extra-high, high, medium, instant
voyager ask --chat <link|id> "And the edge cases?"  # follow up in a conversation
voyager read <link|id>                              # save a conversation's latest reply
```

Every ask uses GPT-6 Pro in chat mode unless you pick another effort, and leaves it selected.
Voyager never switches ChatGPT to Work mode. The reply lands in `~/.voyager/jobs/<id>/output/`,
and `--json` prints its path along with the conversation link.

### Long answers

Pro can think for hours. `ask` waits as long as ChatGPT is still working on the reply, and
only gives up after 20 minutes with no sign of life. To get your terminal back, submit and
collect later:

```sh
voyager ask --no-wait "…"            # prints a job id
voyager job wait <id> --timeout 10m  # exit 4 means still running: wait again, never resend
```

## Projects

A ChatGPT project keeps files that every chat in it can read, so a codebase or a paper goes
up once instead of with every question.

```sh
voyager project create "Thesis"
voyager project upload "Thesis" ./thesis           # replaced when it changes, skipped when it hasn't
voyager ask --project "Thesis" "Where is the argument weakest?"
voyager project files "Thesis"
voyager project remove "Thesis" old-notes.md       # immediate and permanent; asks first
```

## Using it from an agent

Claude Code, Codex and any other agent that can run shell commands can use `voyager`.
[`skills/voyager/SKILL.md`](skills/voyager/SKILL.md) is written for them: JSON output, what each
exit code means, how to wait for a long job without sending the prompt twice, and how to follow
up with `--chat` and the conversation id it got rather than `--continue`.

One job runs at a time. Every result also names your ChatGPT plan (`Pro Lite ($100)`,
`Pro ($200)`, …) as the page last reported it.

## Good to know

- The bridge opens its own ChatGPT tab and closes it when done. If ChatGPT asks you to sign
  in or solve a challenge, `voyager` stops and says so (exit 3); it never works around it.
- Commands: `voyager --help`. State lives in `~/.voyager` (or `$VOYAGER_HOME`), private to
  your user.
- Tested in Chrome. Edge and Firefox builds of Voyager include the bridge too; Safari does not.

## License

MIT. Development notes are in [CONTRIBUTING.md](CONTRIBUTING.md).
