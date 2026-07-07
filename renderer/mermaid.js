// marked emits ```mermaid fences as inert <pre><code class="language-mermaid">; render them to
// inline SVG via the mermaid UMD global. Called on doc.js's cached tree — once per file, not per morph.

let counter = 0;
let themedDark = null;

// theme is baked at initialize(), so re-init when the OS scheme flips to re-theme the next render
function ensureInit() {
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  if (themedDark === dark) return;
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    fontFamily: 'inherit',
    // SVG <text> labels, not foreignObject — DOMPurify (below) drops foreignObject, blanking every label
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  });
  themedDark = dark;
}

// mermaid.render shares a measurement sandbox on document.body, so overlapping calls (a fast file
// switch) corrupt each other — serialize; swallow rejections so one bad batch can't wedge the chain
let chain = Promise.resolve();
export function renderMermaidBlocks(tree) {
  const run = chain.then(() => renderBlocks(tree));
  chain = run.catch(() => {});
  return run;
}

async function renderBlocks(tree) {
  if (!window.mermaid) return false;
  const blocks = tree.querySelectorAll('pre > code.language-mermaid');
  if (!blocks.length) return false;
  ensureInit();
  for (const code of blocks) {
    const pre = code.closest('pre');
    try {
      const { svg } = await window.mermaid.render(`anno-mmd-${counter++}`, code.textContent);
      const fig = document.createElement('div');
      fig.className = 'mermaid-diagram';
      // the only render path that skips doc.js's DOMPurify — strict already sanitized, this is belt-and-suspenders
      fig.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      pre.replaceWith(fig);
    } catch {
      pre.classList.add('mermaid-error'); // keep the source fence visible, tinted as an error
    }
  }
  return true;
}
