// Lets J.A.R.V.I.S. see and use an app's screen through its control channel.
// inspect() lists what's visible (buttons, links, fields, tabs…) with short ids;
// act() clicks, types, presses keys or scrolls on one of them using real input
// events, so the page reacts exactly as it would to the mouse and keyboard.
// Shared by Listener, Gamer, Weber and Streamer (each has a copy).

// Runs inside the page. Tags visible interactive elements with data-jv="<prefix><n>".
function collect(prefix) {
  const LIMIT = 160;
  const sel = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [role=slider], [contenteditable=""], [contenteditable=true], [tabindex]:not([tabindex="-1"]), [data-url], [data-id], [data-show], [data-svc], .tab, .poster, .tile';
  document.querySelectorAll('[data-jv]').forEach((el) => el.removeAttribute('data-jv'));
  const vw = innerWidth, vh = innerHeight;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const label = (el) =>
    clean(el.getAttribute('aria-label')) ||
    clean(el.getAttribute('title')) ||
    clean(el.innerText).slice(0, 80) ||
    clean(el.getAttribute('placeholder')) ||
    clean(el.getAttribute('alt')) ||
    clean(el.value) ||
    clean(el.querySelector?.('img')?.getAttribute('alt')) ||
    clean(el.dataset.label || el.dataset.url || el.dataset.id || '');
  const kind = (el) => {
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'input') return el.type === 'checkbox' || el.type === 'radio' ? el.type : el.type === 'range' ? 'slider' : 'field';
    if (t === 'textarea' || el.isContentEditable) return 'field';
    if (t === 'select') return 'dropdown';
    return el.getAttribute('role') || 'button';
  };
  const items = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(sel)) {
    if (items.length >= LIMIT) break;
    if (!visible(el)) continue;
    // skip wrappers whose only interactive content is another listed element
    const text = label(el);
    if (!text) continue;
    const key = kind(el) + '|' + text;
    if (seen.has(key) && kind(el) !== 'field') continue;
    seen.add(key);
    const id = prefix + (items.length + 1);
    el.setAttribute('data-jv', id);
    const item = { id, kind: kind(el), label: text };
    if (item.kind === 'field') item.value = clean(el.value ?? el.innerText).slice(0, 60);
    if (el.matches('[aria-selected=true], .on, .active, [aria-current]')) item.selected = true;
    if (el.disabled) item.disabled = true;
    items.push(item);
  }
  const heading = clean(document.querySelector('h1, h2')?.innerText).slice(0, 120);
  return { title: document.title, heading, text: clean(document.body?.innerText).slice(0, 2500), elements: items };
}

// Runs inside the page: scroll the element into view and report its centre.
function locate(id) {
  const el = document.querySelector(`[data-jv="${CSS.escape(id)}"]`);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const isField = el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, [contenteditable=""], [contenteditable=true]');
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), field: isField };
}

const KEYS = { enter: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What's on screen in this webContents, with ids starting with `prefix`. */
export async function inspect(wc, prefix) {
  if (!wc || wc.isDestroyed()) return null;
  return wc.executeJavaScript(`(${collect.toString()})(${JSON.stringify(prefix)})`, true);
}

async function press(wc, name) {
  const keyCode = KEYS[String(name).toLowerCase()] ?? String(name);
  wc.sendInputEvent({ type: 'keyDown', keyCode });
  if (keyCode.length === 1 || keyCode === 'Space' || keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: keyCode === 'Space' ? ' ' : keyCode === 'Enter' ? '\r' : keyCode });
  wc.sendInputEvent({ type: 'keyUp', keyCode });
}

/**
 * Do something on screen. action: click | type | key | scroll.
 * click/type need an element id from inspect(); type replaces the field's text
 * (add submit to press Enter after); key presses a key (Enter, Escape, Down…);
 * scroll moves the page ("up" / "down").
 */
export async function act(wc, { id, action, text, submit }) {
  if (!wc || wc.isDestroyed()) return { error: 'That screen is not open.' };
  if (action === 'key') {
    await press(wc, text || 'Enter');
    return { ok: true, pressed: text || 'Enter' };
  }
  if (action === 'scroll') {
    const dir = String(text || 'down').toLowerCase() === 'up' ? -1 : 1;
    await wc.executeJavaScript(`window.scrollBy({ top: ${dir} * innerHeight * 0.8, behavior: 'instant' }); document.querySelector('main, #home, #search, #stage, #view')?.scrollBy?.({ top: ${dir} * innerHeight * 0.8 })`, true);
    return { ok: true, scrolled: dir < 0 ? 'up' : 'down' };
  }
  if (!id) return { error: 'Say which element (its id from see_app).' };
  const at = await wc.executeJavaScript(`(${locate.toString()})(${JSON.stringify(String(id))})`, true);
  if (!at) return { error: `No element ${id} on screen any more. Look at the app again for fresh ids.` };
  await sleep(120);
  wc.focus();
  wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
  wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  if (action === 'click') return { ok: true, clicked: id };
  if (action === 'type') {
    if (!at.field) return { error: `${id} is not a text field.` };
    await sleep(80);
    // replace what's there, then type like a keyboard would
    await wc.executeJavaScript(`(() => { const el = document.activeElement; if (el && 'select' in el) el.select(); else document.execCommand('selectAll'); })()`, true);
    await wc.insertText(String(text ?? ''));
    if (submit) {
      await sleep(80);
      await press(wc, 'Enter');
    }
    return { ok: true, typed: String(text ?? '').slice(0, 80), submitted: !!submit };
  }
  return { error: `Unknown action "${action}". Use click, type, key or scroll.` };
}
