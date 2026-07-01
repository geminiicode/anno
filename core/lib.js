// Keep DOM-free (no document/window) so node:test can require it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.annoLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function findAnchor(text, comment) {
    const { start, end, quote, prefix } = comment;
    // Empty quote: a zero-width {start:0,end:0} would falsely "match" the empty slice.
    if (typeof quote !== 'string' || quote.trim() === '') return null;
    if (
      typeof start === 'number' &&
      typeof end === 'number' &&
      text.slice(start, end) === quote
    ) {
      return { start, end };
    }
    if (prefix) {
      const pIdx = text.indexOf(prefix + quote);
      if (pIdx !== -1) {
        const s = pIdx + prefix.length;
        return { start: s, end: s + quote.length };
      }
    }
    const idx = text.indexOf(quote);
    if (idx !== -1) return { start: idx, end: idx + quote.length };
    // CLI re-anchored quotes can arrive in markdown SOURCE syntax (**bold**) while
    // we search rendered text — strip inline markers and retry.
    const plain = quote.replace(/[*_~`]+/g, '');
    if (plain !== quote && plain.trim()) {
      const pIdx = text.indexOf(plain);
      if (pIdx !== -1) return { start: pIdx, end: pIdx + plain.length };
    }
    return null;
  }

  function diffLines(oldStr, newStr) {
    // ''.split('\n') is [''], not [] — guard or an empty doc diffs as a phantom deleted line.
    const a = oldStr === '' ? [] : oldStr.split('\n');
    const b = newStr === '' ? [] : newStr.split('\n');
    const m = a.length;
    const n = b.length;
    const lcs = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        lcs[i][j] =
          a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    const rows = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) {
        rows.push({ type: 'ctx', text: a[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        rows.push({ type: 'del', text: a[i] });
        i++;
      } else {
        rows.push({ type: 'add', text: b[j] });
        j++;
      }
    }
    while (i < m) rows.push({ type: 'del', text: a[i++] });
    while (j < n) rows.push({ type: 'add', text: b[j++] });
    return rows;
  }

  return { findAnchor, diffLines };
});
