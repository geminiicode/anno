---
name: review-md
description: Open a markdown file in the anno editor and start the AI review loop, so comments you leave get auto-addressed by Claude. Use when the user wants to review/comment on a markdown file interactively.
disable-model-invocation: true
allowed-tools: Bash(anno *), Bash(command -v anno), Bash(npm install -g github:geminiicode/anno*)
---

# Review a markdown file with anno

Launch the anno editor on the file the user named and start the
auto-address watcher, so any comments they leave are revised automatically.

## Prerequisite check

Check that `anno` is installed (`command -v anno`). If it is missing, offer to
install it for the user and, if they accept, run:

```bash
npm install -g github:geminiicode/anno
```

(This downloads Electron, so it can take a minute.) Verify `anno` resolves
afterwards, then continue. If they decline, give them the command to run
later and stop.

## Steps

1. Resolve the target from `$ARGUMENTS` — a markdown file path **or** a folder
   to browse. If none was provided, ask which file or folder to review.
2. Launch the full loop **in the background** so it does not block the
   session, using the Bash tool's `run_in_background: true` option — do NOT
   append `&`, which ties the process to a shell that exits with the call:

   ```bash
   anno review "<file-or-folder>"
   ```

   A folder opens the editor on the whole tree and watches every doc in it, so
   comments on any file get addressed.
3. Tell the user the editor is opening and the watcher is running: they can
   highlight text and leave comments, and within a few seconds Claude will
   revise the document and reply to each comment in the margin. Closing the
   editor window stops the watcher.

## Notes

- The revision uses the user's own authenticated `claude` CLI, so no API keys
  are needed.
