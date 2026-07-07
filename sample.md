# Sample Document

This is a **sample markdown file** to test the commenter. Select any text and
click the 💬 Comment button that appears above your selection.

## How commenting works

Comments are anchored to the *exact text you highlight*. They are saved next to
this file as `sample.md.comments.json`, so they travel with the document and
play nicely with git.

- Select text to leave a comment
- Click a highlight or a card to jump between them
- Resolve a comment to grey it out, or delete it entirely

> Try highlighting this blockquote and leaving a note on it.

Links open in your default browser, not in this window — try the
[anno repo](https://github.com/geminiicode/anno).

### Code is supported too

```js
function hello(name) {
  return `Hello, ${name}`;
}
```

### And so are mermaid diagrams

```mermaid
graph LR
  A[Write] --> B[Comment]
  B --> C{Address?}
  C -->|yes| D[Revise]
  C -->|no| E[Resolve]
  D --> B
```

**That's it — happy reading. 🙂**
