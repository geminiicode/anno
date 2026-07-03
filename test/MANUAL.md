# Manual QA checklist

Most behavior is covered by `node --test`. Three flows can't be: they need a
real `claude` session (with its resume + judgment) and a live editor window, so
they're verified by hand. The automated siblings live in:

- `test/cli-dispatch.test.js` — CLI surface (only `review`/`list` remain)
- `test/watch-daemon.test.js` — startup 👀 sweep + daemon lifecycle (SIGINT, ppid self-exit)
- `test/address-core.test.js`, `test/watch-batch.test.js` — errored paths, warm-session bookkeeping, session-name forwarding

Run the branch build, **not** the globally-installed `anno` (that's the published
version): `node <repo>/anno.js review <target>`.

## Seed fixtures

```bash
ROOT=$(mktemp -d)/anno-manual
mkdir -p "$ROOT/docs"

cat > "$ROOT/notes.md" <<'EOF'
# Meeting Notes

Hey so basically we talked about the roadmap and it's gonna be a lot of
work but I think we can totally pull it off if everyone pitches in.

The main thing is we need to lock down the timeline before we tell the
custmers anything, otherwise it'll be a mess.
EOF

for f in overview pricing faq; do
  cat > "$ROOT/docs/$f.md" <<EOF
# The $f doc

The Widget is our flagship product. A Widget syncs your data in the
background. Every Widget ships with a one-year warranty.
EOF
done
echo "fixtures at $ROOT"
```

## Flow 1 — warm-session continuity (single file)

Verifies the per-tab Claude session **resumes** across comments instead of
starting cold each time.

1. `node <repo>/anno.js review "$ROOT/notes.md"`
2. Highlight the "Hey so basically…" paragraph → comment **"make this formal and professional."** Wait ~5s for the reply + diff.
3. Highlight the sentence containing `custmers` → comment **"keep this casual, just fix the typo."**

**Expect:** the second revision keeps the casual tone and only fixes the typo —
it does **not** re-formalize. The reply reads like a follow-up, not a fresh
rewrite. (A cold session would formalize it again.)

## Flow 2 — cross-file context (folder tab)

Verifies one shared session spans a folder, and the manifest carries sibling
context — while each batch still edits only its own file.

1. `node <repo>/anno.js review "$ROOT/docs"`
2. Open **overview.md**, highlight a "Widget" → comment **"rename Widget to Gadget everywhere in this file."** Wait for the revision.
3. Open **pricing.md**, highlight some text → comment **"make the product terminology here match the other docs."**

**Expect:**
- pricing.md switches to **"Gadget"** — it only knows the new term because the
  shared folder session carried overview.md's rename via the manifest.
- overview.md's batch edited **only** overview.md; faq.md is untouched until you
  comment on it. Confirm no file changed except the one you commented on.

## Flow 5 — session naming

Verifies spawned sessions carry an `anno:`-prefixed display name so the user can
find them in the session picker. (The *forwarding* is unit-tested; this checks
the real CLI actually writes the name.)

1. With either tab from above open, inspect the session's title record:
   ```bash
   # project dir is the watched cwd with slashes turned to dashes
   for d in ~/.claude/projects/*anno-manual*; do
     head -2 "$d"/*.jsonl | grep -o '"type":"custom-title"' >/dev/null && \
       echo "$d has a custom-title"
   done
   ```
   Or just open the `claude` session picker.

**Expect:** a session titled **`anno: notes.md`** (single file) or
**`anno: docs/`** (folder tab). Applied on creation only — a resumed session
keeps the name it was created with.

## Forcing failures safely

Some checks want a mid-run failure. **Do not** use `pkill -f "claude -p"** — it's
a broad regex against every process's command line, and `-9` is unrecoverable;
it can match unrelated `claude` sessions (including your own Claude Code).

Target the specific daemon's child instead:

```bash
pgrep -fl watch-daemon              # find the daemon PID for the tab you commented in
pkill -9 -P <daemon-pid>            # kills ONLY that daemon's claude child
```

- **Errored status:** leave a comment, and the instant it shows 👀,
  `pkill -9 -P <daemon-pid>`. The comment flips 👀 → **errored** (red); the
  tooltip detail is redacted (no home path, no raw UUID). Reopen to retry.
- **Stranded-👀 sweep:** leave a comment, and while it's 👀, `kill -9 <daemon-pid>`
  (the daemon itself, not its child), then close the window and relaunch. On
  startup the comment sweeps to **errored** ("interrupted…") with no re-revision.
- **No orphaned daemons:** close a tab's window → its daemon PID vanishes within
  ~2s. Or `kill -9` the Electron GUI parent → the daemon still self-exits within
  ~2s via the ppid poll.
