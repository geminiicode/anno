// Markdown image paths are relative to the doc dir, but the rendered HTML lives in
// index.html, so the browser resolves them against the app dir — rewrite local srcs
// to absolute file:// URLs. Must run AFTER DOMPurify (its URI filter strips file:).
export function resolveImageSrcs(container, filePath) {
  if (!filePath) return;
  const dir = filePath.slice(0, filePath.lastIndexOf('/') + 1);
  const base = 'file://' + encodeURI(dir);
  for (const img of container.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    // capture the markdown SOURCE src before the rewrite below — the stable anchor key
    // for image comments; deterministic from the doc, survives reload, no absolute path leaks to the sidecar
    if (src != null) img.dataset.annoSrc = src;
    // a relative `../` src resolves to an arbitrary local file — read-into-<img> only, no remote sink survives the CSP; clamp to doc dir if egress is added
    if (!src || /^(?:https?|data|file|blob):/i.test(src)) continue;
    try {
      img.setAttribute('src', new URL(src, base).href);
    } catch {
      /* malformed src — leave it for the browser to reject */
    }
  }
}
