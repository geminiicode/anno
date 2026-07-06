// marked renders ```mermaid fences as inert <pre><code class="language-mermaid">; this turns
// those into inline SVG via the mermaid UMD global (window.mermaid, loaded in index.html).
// Runs on the cached base tree (see doc.js) so a diagram renders once per file, not per morph.

let counter = 0;
let themedDark = null;

// mermaid.initialize is idempotent and cheap; re-run only when the OS scheme flips so a
// dark-mode toggle re-themes on the next render. securityLevel 'strict' sanitizes diagram
// labels (we inject the returned SVG directly, bypassing DOMPurify).
function ensureInit() {
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  if (themedDark === dark) return;
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    fontFamily: 'inherit',
  });
  themedDark = dark;
}

// Replace every mermaid code block in `tree` with its rendered SVG, in place.
// Resolves true if anything changed so the caller can re-render the live DOM.
export async function renderMermaidBlocks(tree) {
  if (!window.mermaid) return false;
  const blocks = tree.querySelectorAll('pre > code.language-mermaid');
  if (!blocks.length) return false;
  ensureInit();
  let changed = false;
  // sequential: mermaid.render reuses a fixed temp DOM id internally, so concurrent renders race
  for (const code of blocks) {
    const pre = code.closest('pre');
    try {
      const { svg } = await window.mermaid.render(`anno-mmd-${counter++}`, code.textContent);
      const fig = document.createElement('div');
      fig.className = 'mermaid-diagram';
      fig.innerHTML = svg;
      pre.replaceWith(fig);
    } catch {
      // malformed diagram — leave the source fence visible, flag it so it's not mistaken for prose
      pre.classList.add('mermaid-error');
    }
    changed = true;
  }
  return changed;
}
