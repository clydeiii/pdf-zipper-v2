# DeCruft

A Chrome extension (MV3) that strips tracking & campaign cruft from links so they
open in their clean, canonical form — including **open-in-new-tab** (middle-click,
Ctrl/Cmd-click, right-click → open in new tab).

### What it does
- Rewrites every `<a href>` on the page to its cleaned form (on load + as the DOM
  changes, so SPA-rendered links are covered too).
- A capture-phase `pointerdown`/`auxclick`/`contextmenu` safety net re-cleans the
  exact link you're about to open, for frameworks that set the href at the last moment.
- Toolbar badge shows how many links it cleaned on the current tab.
- Popup: global on/off, per-site on/off.

### Examples
```
https://www.wsj.com/.../anthropic-model-ban-e8284434?utm_source=...&utm_medium=referral&utm_campaign=...
  → https://www.wsj.com/.../anthropic-model-ban-e8284434

https://hollyelmore.substack.com/p/the-ai-genies-out-of-the-bottle-now?utm_source=...&publication_id=...&post_id=...&isFreemail=true&r=...&triedRedirect=true&utm_medium=email
  → https://hollyelmore.substack.com/p/the-ai-genies-out-of-the-bottle-now
```
Content params (`?v=`, `?q=`, `?id=`, `?page=`) are preserved — only known trackers are removed.

### Rules — how to extend
All rules live in **`cleaner.js`**:
- `GLOBAL_PREFIXES` — name prefixes stripped on every site (`utm_`, `hsa_`, ...).
- `GLOBAL_EXACT` — exact param names that are tracking-only everywhere (`fbclid`, `gclid`, ...).
- `SITE_RULES` — per-host extras, keyed by host suffix, for junk only safe to strip on
  that host (e.g. Substack's `publication_id`, `post_id`, `r`, `isFreemail`).

To handle a new example: if the junk param is universal, add it to `GLOBAL_EXACT`;
if it's site-specific, add it under the host in `SITE_RULES`. Nothing else to touch.

### Install (unpacked)
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `decruft/` folder.
3. Pin DeCruft (broom icon) to the toolbar.

### Regenerate icons
`python3 make_icons.py` (needs Pillow).
