## Keyboard shortcuts

Shortcuts below use `⌘` (Command) on macOS. On Windows and Linux, use `Ctrl`.

### Document

| Shortcut | Action |
|----------|--------|
| `⌘T` | Open a new tab |
| `⌘N` | Open a new window |
| `⌘L` | Toggle the file sidebar (left) |
| `⌘R` | Toggle the comments sidebar (right) |
| `⌘⇧H` | Hide / show resolved comments |
| `⌘/` | Open this help |

### Commenting

| Shortcut | Action |
|----------|--------|
| `⌘↵` | Comment on the selected text |
| `⌘↵` | Save the comment or reply you're writing |
| `Esc` | Cancel the comment or reply (or close this help) |

---

## Command line

Comments live in a per-user store under `~/.anno/store/`, keyed by the document's
path — never next to the document, so they stay out of `git status`.

| Command | What it does |
|---------|--------------|
| `anno review <file.md\|folder>` | Open the editor and auto-address comments (the full loop) |
| `anno list <file.md>` | Show comments and their statuses |
| `anno clean <path> [--force]` | Reap store entries whose document is gone, under `<path>`. Dry-run without `--force`. |
| `anno clean --legacy <path> [--force]` | Sweep old co-located `.comments.json` files (a pre-store layout) off disk, under `<path>`. Dry-run without `--force`. |

`anno clean` requires a `<path>` and never runs on its own: a document that is
merely absent (a branch switch, a worktree, an unmounted volume) is not gone, so
its comments are only reaped once you point `clean` at that tree and pass
`--force`. `--legacy` files are litter — they are deleted, never migrated.

---

## Tips

- **Folders** open the whole tree in the left sidebar — comment across many files in
  one session.
- **Recent files** show on the home screen (`⌘T`) so you can jump back in quickly.
- Keep comments **specific** — "tighten this paragraph" addressed to a precise
  selection produces better revisions than a vague note on a whole section.
- Use **`anno list`** in the terminal for a fast status check without opening the
  editor.
