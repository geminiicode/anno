# anno

Comment on your markdown like you would in Google Docs — leave notes in the margin, and `anno` revises the document to address them for you. Review the changes, comment, and repeat until it's right.

```
highlight + comment  ──▶  anno revises via your Claude Code  ──▶  editor live-reloads
        ▲                                                              │
        └──────────────────────── you review ◀─────────────────────────┘
```

> **Note:** anno was developed entirely with AI ([Claude Code](https://claude.com/claude-code)) and has only been tested on macOS.

## Getting started

```bash
npm i -g anno-md
```

Requires Node 18+ and an authenticated [Claude Code](https://code.claude.com/docs) `claude` CLI on your `PATH`. The editor is [Electron](https://www.electronjs.org/), so the install downloads its runtime (~100&nbsp;MB) the first time.

## Usage

```bash
anno review <file.md|folder>   # open the editor AND auto-address comments (full loop)
anno address <file.md>         # one-shot: revise the doc to address open comments
anno watch <file.md|folder>    # auto-address watcher only (daemon, no editor)
anno list <file.md>            # show comments and their statuses
```

### Claude Code

```
/plugin marketplace add geminiicode/anno   # register this repo as a plugin marketplace
/plugin install anno                        # install the anno plugin
/anno:review-md notes.md                    # review a doc from inside Claude Code
```

## Security note

`anno` runs Claude with edit access to the document's directory (`--permission-mode acceptEdits`), and the document and comments are part of the prompt — so **reviewing a file effectively grants its author edit access to that directory**. Claude is limited to `Read,Edit` (not `Write`), so it can't create new files. Only run the loop on files you trust.

## License

MIT — see [LICENSE](LICENSE).
</content>
