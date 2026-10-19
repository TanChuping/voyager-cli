// approval_card_click.js — find ChatGPT's "允许 ChatGPT 使用 Google Drive 吗？" approval card
// on a conversation page and click "始终允许" (Always allow).
// Run the whole file as one expression in the page (we ran it through a browser automation
// tool's "execute JavaScript"). Returns { status, ... }:
//   clicked   = a card was found and its Always-allow button clicked
//   none      = no approval card on the page
//   ambiguous = a card was found but the button could not be told apart; nothing clicked
// The buttons carry no data-testid / aria-label / name, so they are matched by text (see
// dom-structure.json). Only seen on the zh-CN UI; "Always allow" is a guess, not measured.
(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cards = [...document.querySelectorAll('div')].filter(
    (d) =>
      /approval-card/.test(String(d.className)) &&
      /Google Drive/.test(d.innerText || '') &&
      /允许|Allow/.test(d.innerText || ''),
  );
  // Keep the innermost card only (its ancestors match too).
  const inner = cards.filter((c) => !cards.some((o) => o !== c && c.contains(o)));
  if (inner.length === 0) return { status: 'none' };
  const results = [];
  for (const card of inner) {
    const btns = [...card.querySelectorAll('button')].filter((b) =>
      ['始终允许', 'Always allow'].includes(norm(b.innerText)),
    );
    if (btns.length !== 1 || btns[0].disabled) {
      results.push({
        status: 'ambiguous',
        found: btns.length,
        text: norm(card.innerText).slice(0, 200),
      });
      continue;
    }
    btns[0].click();
    results.push({ status: 'clicked', text: norm(card.innerText).slice(0, 120) });
  }
  const clicked = results.filter((r) => r.status === 'clicked').length;
  return {
    status: clicked ? 'clicked' : 'ambiguous',
    clicked,
    cards: inner.length,
    results,
    url: location.pathname,
  };
})();
