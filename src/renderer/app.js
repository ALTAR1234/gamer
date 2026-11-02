// Gamer renderer: a console-style dashboard (Home, My games, Game Pass,
// Captures, Stats) driven equally by mouse, keyboard or game controller.

const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
// fill the main view, skipping sections that are switched off (false / null / 0)
const fill = (...kids) => view.replaceChildren(...kids.flat().filter((k) => k != null && k !== false && k !== 0));
let library = { games: [] };
let tab = 'home';
let filter = 'all';
let query = '';
let runningId = null;
let focusedGame = null;
let gamePass = null; // catalog, loaded on first visit
let gpFilter = 'all';
let captures = null;
let capFilter = 'all';

const SOURCES = { steam: 'Steam', epic: 'Epic', roblox: 'Roblox', xbox: 'Xbox', pc: 'PC', link: 'Link' };
const pref = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem('nexus.' + k)) ?? d;
  } catch {
    return d;
  }
};
const setPref = (k, v) => {
  try {
    localStorage.setItem('nexus.' + k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

function h(tag, props, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (props != null && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    kids.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') Object.entries(v).forEach(([p, val]) => (p.startsWith('--') ? el.style.setProperty(p, val) : (el.style[p] = val)));
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const norm = (s = '') => s.toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function playtimeText(sec) {
  if (!sec) return '—';
  const hrs = sec / 3600;
  return hrs >= 1 ? `${hrs.toFixed(hrs < 10 ? 1 : 0)} hr` : `${Math.max(1, Math.round(sec / 60))} min`;
}
function agoText(t) {
  if (!t) return 'Never';
  const d = (Date.now() - t) / 1000;
  if (d < 90) return 'Just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} hr ago`;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 2800);
}
const errText = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---------- art & background ----------

function art(g, { installed } = {}) {
  const fallback = h('div.fallback', g.icon && h('img', { src: g.icon, alt: '' }), h('span', g.title));
  const box = h('div.tile-art', { style: { '--h': String(hue(g.title)) } });
  const candidates = (g.source === 'steam' && !g.customArt ? [g.header, g.cover] : [g.tile, g.cover, g.header]).filter(Boolean);
  if (!candidates.length) box.append(fallback);
  else {
    const img = h('img.cover', { alt: '', loading: 'lazy', src: candidates.shift() });
    img.onerror = () => (candidates.length ? (img.src = candidates.shift()) : img.replaceWith(fallback));
    box.append(img);
  }
  if (installed) box.append(h('span.badge.installed', 'Installed'));
  else if (g.source) box.append(h('span.badge', SOURCES[g.source] ?? 'PC'));
  if (runningId && runningId === g.id) box.append(h('span.dot-running', 'Playing'));
  return box;
}

let bgSlot = 0;
let bgUrl = null;
function setBackground(url) {
  if (url === bgUrl) return;
  bgUrl = url;
  const imgs = document.querySelectorAll('.bg-img');
  bgSlot = 1 - bgSlot;
  imgs[bgSlot].style.backgroundImage = url ? `url("${url}")` : 'none';
  imgs[bgSlot].classList.add('on');
  imgs[1 - bgSlot].classList.remove('on');
}
const bgFor = (g) => g && (g.hero || g.cover || g.header || g.tile);

// ---------- shared pieces ----------

const visibleGames = () =>
  library.games
    .filter((g) => !g.hidden)
    .filter((g) => filter === 'all' || g.source === filter || (filter === 'favorites' && g.favorite) || (filter.startsWith('col:') && g.collections?.includes(filter.slice(4))))
    .filter((g) => !query || norm(g.title).includes(norm(query)));

function tile(g, big = false) {
  return h('button.tile.nav' + (big ? '.big' : ''), {
    dataset: { id: g.id },
    onclick: () => openDetail(g),
    onfocus: () => focusGame(g),
    onmouseenter: () => focusGame(g),
  }, art(g), h('div.tile-title', g.title));
}

function focusGame(g) {
  focusedGame = g;
  setBackground(bgFor(g));
  const f = $('.feature');
  if (f) {
    f.replaceChildren(
      h('div.feature-kicker', g.lastPlayed ? 'Continue playing' : 'Ready to play'),
      h('div.feature-title', g.title),
      h('div.feature-meta',
        h('span.meta-pill', SOURCES[g.source] ?? 'PC'),
        g.playtime ? h('span', h('b', playtimeText(g.playtime)), ' played') : h('span', 'Not played yet'),
        g.lastPlayed && h('span', 'Last played ', h('b', agoText(g.lastPlayed)))),
      h('div.feature-actions',
        h('button.btn.go.hero-play.nav', { onclick: () => play(g) }, runningId === g.id ? 'Playing' : '▶  Play'),
        h('button.btn.glass.nav', { onclick: () => openDetail(g) }, 'Details'))
    );
  }
}

const ICON = {
  library: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
  pass: '<path d="M12 3 3 8l9 5 9-5-9-5zM3 16l9 5 9-5M3 12l9 5 9-5"/>',
  captures: '<rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  scan: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  xbox: '<circle cx="12" cy="12" r="9"/><path d="M7.5 6.5c2 1.2 3.4 3 4.5 4.7 1.1-1.7 2.5-3.5 4.5-4.7M7 17.5c1.4-2.6 3-4.7 5-6.3 2 1.6 3.6 3.7 5 6.3"/>',
};
const svg = (name) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.innerHTML = ICON[name];
  return el;
};

function action(icon, label, onclick) {
  return h('button.action.nav', { onclick }, h('span.glyph', svg(icon)), h('span.action-label', label));
}

// ---------- views ----------

function renderHome() {
  const games = library.games.filter((g) => !g.hidden);
  if (!games.length) {
    return fill(h('div.empty',
      h('h1', 'Welcome to Gamer'),
      h('p', 'Gamer finds games from the Xbox app, Steam, Epic and Roblox, plus game shortcuts on your desktop. You can also add any game’s .exe, shortcut or link file, or drop files on this window.'),
      h('div.actions', h('button.btn.primary.nav', { onclick: scan }, 'Scan for games'), h('button.btn.nav', { onclick: () => add() }, 'Add a game'))));
  }
  // the pinned game leads Home, then the most recently played or added
  const recent = [...games].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || (b.addedAt ?? 0) - (a.addedAt ?? 0)).slice(0, 10);
  const favorites = games.filter((g) => g.favorite);
  const cols = (library.collections ?? []).map((c) => [c, games.filter((g) => g.collections?.includes(c))]).filter(([, l]) => l.length);
  fill(
    h('section.feature'),
    h('section.row', h('div.strip', recent.map((g, i) => tile(g, i === 0)))),
    h('section.row', h('div.strip',
      action('library', 'My games', () => switchTab('library')),
      action('pass', 'Game Pass', () => switchTab('gamepass')),
      action('captures', 'Captures', () => switchTab('captures')),
      action('stats', 'Stats', () => switchTab('stats')),
      action('add', 'Add game', () => add()),
      action('scan', 'Scan', scan),
      action('xbox', 'Xbox app', () => window.nexus.openXbox()))),
    favorites.length > 0 && h('section.row', h('h2', 'Favorites'), h('div.strip', favorites.map((g) => tile(g)))),
    ...cols.map(([name, list]) => h('section.row', h('h2', name), h('div.strip', list.map((g) => tile(g)))))
  );
  focusGame(recent[0]);
}

function renderLibrary() {
  const sources = [...new Set(library.games.map((g) => g.source))];
  const games = visibleGames().sort((a, b) => a.title.localeCompare(b.title));
  const chip = (id, label) => h('button.chip.nav' + (filter === id ? '.on' : ''), { onclick: () => { filter = id; render(); } }, label);
  fill(
    h('h1.page-title', query ? `Results for “${query}”` : 'My games'),
    h('div.chips', chip('all', `All (${library.games.length})`), chip('favorites', '★ Favorites'),
      ...sources.map((s) => chip(s, SOURCES[s] ?? s)),
      ...(library.collections ?? []).map((c) => chip('col:' + c, c)),
      h('button.chip.nav', { onclick: () => add() }, '＋ Add game'),
      h('button.chip.nav', { onclick: scan }, '⟳ Scan')),
    games.length ? h('div.grid', games.map((g) => tile(g))) : h('p.note', 'No games match.')
  );
  setBackground(null);
}

async function renderGamePass() {
  const hasPass = pref('hasGamePass', true);
  if (!gamePass) {
    fill(h('h1.page-title', 'PC Game Pass'), h('p.note', 'Loading the PC Game Pass catalog…'));
    try {
      gamePass = await window.nexus.gamePass();
    } catch (e) {
      return fill(h('h1.page-title', 'PC Game Pass'), h('p.note', 'Couldn’t load the catalog: ' + errText(e)));
    }
    if (tab !== 'gamepass') return;
  }
  const installed = new Map(library.games.map((g) => [norm(g.title), g]));
  const owned = (p) => installed.get(norm(p.title));
  let list = gamePass;
  if (gpFilter === 'installed') list = list.filter(owned);
  if (gpFilter === 'new') list = list.filter((p) => !owned(p));
  if (query) list = list.filter((p) => norm(p.title).includes(norm(query)));
  const chip = (id, label) => h('button.chip.nav' + (gpFilter === id ? '.on' : ''), { onclick: () => { gpFilter = id; render(); } }, label);
  const toggle = h('button.chip.nav' + (hasPass ? '.on' : ''), { onclick: () => { setPref('hasGamePass', !hasPass); render(); } }, hasPass ? '✓ I have PC Game Pass' : 'I have PC Game Pass');
  fill(
    h('h1.page-title', 'PC Game Pass'),
    h('div.chips', chip('all', `All (${gamePass.length})`), chip('installed', 'Installed'), chip('new', 'Not installed'), toggle,
      h('button.chip.nav', { onclick: () => window.nexus.openXbox() }, 'Open Xbox app')),
    h('p.note', hasPass ? 'Everything here is included with your PC Game Pass. Pick a game, then Install opens it in the Xbox app.' : 'Pick a game to see it in the Xbox app.'),
    h('div.grid', list.slice(0, 240).map((p) => {
      const mine = owned(p);
      return h('button.tile.nav', { onclick: () => (mine ? openDetail(mine) : openGamePassDetail(p, hasPass)), onfocus: () => setBackground(p.hero), onmouseenter: () => setBackground(p.hero) },
        art({ title: p.title, tile: p.tile }, { installed: !!mine }), h('div.tile-title', p.title));
    })),
    list.length > 240 && h('p.note', `Showing 240 of ${list.length}. Search to find the rest.`)
  );
}

async function renderCaptures() {
  if (!captures) {
    fill(h('h1.page-title', 'Captures'), h('p.note', 'Loading…'));
    captures = await window.nexus.captures();
    if (tab !== 'captures') return;
  }
  const games = [...new Set(captures.items.map((c) => c.gameId).filter(Boolean))].map((id) => library.games.find((g) => g.id === id)).filter(Boolean);
  const items = captures.items.filter((c) => capFilter === 'all' || (capFilter === 'shots' ? !c.video : capFilter === 'clips' ? c.video : c.gameId === capFilter));
  const chip = (id, label) => h('button.chip.nav' + (capFilter === id ? '.on' : ''), { onclick: () => { capFilter = id; render(); } }, label);
  fill(
    h('h1.page-title', 'Captures'),
    h('div.chips', chip('all', `All (${captures.items.length})`), chip('shots', 'Screenshots'), chip('clips', 'Clips'),
      ...games.map((g) => chip(g.id, g.title)),
      h('button.chip.nav', { onclick: () => window.nexus.openCaptures() }, 'Open folder'),
      h('button.chip.nav', { onclick: () => { captures = null; render(); } }, '⟳ Refresh')),
    h('p.note', 'Capture while playing with ', h('kbd', 'Win'), ' + ', h('kbd', 'Alt'), ' + ', h('kbd', 'PrtScn'), ' (screenshot) or ', h('kbd', 'Win'), ' + ', h('kbd', 'Alt'), ' + ', h('kbd', 'G'), ' (record the last moments). They appear here automatically.'),
    items.length
      ? h('div.grid', items.map((c) => h('button.cap.nav', { onclick: () => openViewer(c) },
          c.video ? h('video', { src: c.url + '#t=1', muted: true, preload: 'metadata' }) : h('img', { src: c.url, alt: '', loading: 'lazy' }),
          c.video && h('span.play-mark', '▶'),
          h('span.cap-label', `${library.games.find((g) => g.id === c.gameId)?.title ?? 'Capture'} · ${agoText(c.time)}`))))
      : h('p.note', 'No captures yet.')
  );
  setBackground(null);
}

function renderStats() {
  const games = library.games;
  const total = games.reduce((a, g) => a + (g.playtime ?? 0), 0);
  const played = games.filter((g) => g.playtime).sort((a, b) => b.playtime - a.playtime);
  const days = [...Array(14)].map((_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86400e3);
    const key = d.toISOString().slice(0, 10);
    const secs = Object.values(library.daily?.[key] ?? {}).reduce((a, s) => a + s, 0);
    return { label: d.toLocaleDateString([], { weekday: 'short' }).slice(0, 2), secs };
  });
  const maxDay = Math.max(1, ...days.map((d) => d.secs));
  const week = days.slice(7).reduce((a, d) => a + d.secs, 0);
  const max = played[0]?.playtime ?? 1;
  fill(
    h('h1.page-title', 'Stats'),
    h('div.stat-row',
      h('div.stat', h('b', playtimeText(total)), h('span', 'Total playtime')),
      h('div.stat', h('b', playtimeText(week)), h('span', 'This week')),
      h('div.stat', h('b', String(games.length)), h('span', 'Games in library')),
      h('div.stat', h('b', played[0]?.title ?? '—'), h('span', 'Most played'))),
    h('section.row', h('h2', 'Last 14 days'),
      h('div.chart', days.map((d) => h('div.bar', { title: playtimeText(d.secs) }, h('i', { style: { height: (d.secs / maxDay) * 100 + '%' } }), h('span', d.label))))),
    h('section.row', h('h2', 'Most played'),
      played.length
        ? h('div.top-list', played.slice(0, 8).map((g) => h('div.top-item',
            h('img', { src: (g.source === 'steam' && !g.customArt ? g.header : g.cover) || g.header || g.icon || '', alt: '' }),
            h('div', h('b', g.title), h('small', `Last played ${agoText(g.lastPlayed)}`), h('div.meter', h('i', { style: { width: (g.playtime / max) * 100 + '%' } }))),
            h('b', playtimeText(g.playtime)))))
        : h('p.note', 'Play something from Gamer and your playtime shows up here. Steam, Xbox and .exe games are timed automatically.'))
  );
  setBackground(null);
}

function render() {
  document.body.classList.toggle('home', tab === 'home');
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  ({ home: renderHome, library: renderLibrary, gamepass: renderGamePass, captures: renderCaptures, stats: renderStats, xbox: renderXbox })[tab]();
  requestAnimationFrame(focusFirst);
}

// ---------- Xbox profile (sign-in, achievements, friends) ----------

let xbox = { status: null, data: null, code: null, busy: false, error: '' };
window.nexus.xbox.onCode((info) => {
  xbox.code = info;
  if (tab === 'xbox') render();
});

async function loadXbox(force = false) {
  if (!force && xbox.status) return;
  xbox.status = await window.nexus.xbox.status();
  if (xbox.status.signedIn) xbox.data = await window.nexus.xbox.data();
  paintAvatar();
}

function paintAvatar() {
  const a = $('.profile .avatar');
  const p = xbox.data?.profile ?? xbox.status?.profile;
  if (p?.picture) a.replaceChildren(h('img', { src: p.picture, alt: '' }));
  else a.textContent = p?.gamertag?.[0]?.toUpperCase() ?? 'N';
  a.title = p ? `${p.gamertag} · ${p.gamerscore} G` : 'Sign in to Xbox';
}

const step = (n, ...body) => h('li.step', h('span.step-n', String(n)), h('div', ...body));
const ext = (label, url) => h('button.link.nav', { onclick: () => window.nexus.openExternal(url) }, label);

function xboxSetup() {
  const input = h('input.text-in.nav', { placeholder: 'Application (client) ID, like 1a2b3c4d-…', spellcheck: false });
  const err = h('p.err');
  return h('div.glass-card.setup',
    h('h2', 'Connect your Xbox account'),
    h('p.note.flush', 'One-time setup (about 3 minutes, free). Microsoft only allows Xbox sign-in from registered apps, so you register Gamer as your own app. No secret or payment needed.'),
    h('ol.steps',
      step(1, ext('Open Azure app registrations', 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'), ' and sign in with any Microsoft account.'),
      step(2, 'Choose ', h('b', 'New registration'), '. Name it “Gamer”. Under account types pick ', h('b', 'Personal Microsoft accounts only'), '. Leave Redirect URI empty. Press ', h('b', 'Register'), '.'),
      step(3, 'Open ', h('b', 'Authentication'), ', set ', h('b', 'Allow public client flows'), ' to ', h('b', 'Yes'), ', and save.'),
      step(4, 'Copy the ', h('b', 'Application (client) ID'), ' from the Overview page and paste it here:')),
    h('div.row-inline', input, h('button.btn.go.nav', { onclick: async () => {
      const r = await window.nexus.xbox.setClient(input.value);
      if (!r.ok) return (err.textContent = r.error);
      xbox.status = null;
      render();
    } }, 'Save')),
    err);
}

function xboxSignIn() {
  if (xbox.code) {
    return h('div.glass-card.signin',
      h('img.qr', { src: xbox.code.qr, alt: 'QR code to sign in' }),
      h('div',
        h('h2', 'Scan to sign in'),
        h('ol.qr-steps',
          h('li', 'Scan with your phone camera, or go to ', h('b', xbox.code.url.replace(/^https?:\/\//, '')), '.'),
          h('li', 'Enter the code ', h('span.code', xbox.code.code), ' if asked.'),
          h('li', 'Sign in with the Microsoft account you use for Xbox and allow access.')),
        h('p.note.flush', 'Waiting for you to approve…'),
        h('button.btn.glass.nav', { onclick: () => window.nexus.xbox.cancel() }, 'Cancel')));
  }
  return h('div.glass-card.signin-start',
    h('h2', 'Sign in to Xbox'),
    h('p.note.flush', 'See your gamertag, Gamerscore, achievements for every game, and which friends are online.'),
    xbox.error && h('p.err', xbox.error),
    h('div.row-inline',
      h('button.btn.go.nav', { disabled: xbox.busy, onclick: async () => {
        Object.assign(xbox, { busy: true, error: '', code: null });
        render();
        const r = await window.nexus.xbox.signIn();
        Object.assign(xbox, { busy: false, code: null, error: r.error ?? '', status: null });
        if (r.signedIn) toast(`Signed in as ${r.profile?.gamertag}`);
        render();
      } }, xbox.busy ? 'Starting…' : 'Sign in with a QR code'),
      h('button.btn.glass.nav', { onclick: async () => { await window.nexus.xbox.clearClient(); xbox.status = null; render(); } }, 'Change app registration')));
}

async function renderXbox() {
  if (!xbox.status) {
    fill(h('h1.page-title', 'Profile'), h('p.note', 'Checking your Xbox account…'));
    await loadXbox(true);
    if (tab !== 'xbox') return;
  }
  const s = xbox.status;
  if (!s.setup) return fill(h('h1.page-title', 'Profile'), xboxSetup());
  if (!s.signedIn) return fill(h('h1.page-title', 'Profile'), s.error && h('p.err.pad', s.error), xboxSignIn());
  const d = xbox.data ?? {};
  const p = d.profile ?? s.profile;
  const played = (d.titles ?? []).filter((t) => t.achievements?.total);
  fill(
    h('div.profile-head.glass-card',
      p.picture ? h('img.gamerpic', { src: p.picture, alt: '' }) : h('div.gamerpic'),
      h('div', h('div.gamertag', p.gamertag), h('div.gscore', `${p.gamerscore.toLocaleString()} G`, p.tier && h('span.tier', p.tier))),
      h('div.head-actions',
        h('button.btn.glass.nav', { onclick: async () => { xbox.status = null; xbox.data = null; render(); } }, '⟳ Refresh'),
        h('button.btn.glass.nav', { onclick: async () => { await window.nexus.xbox.signOut(); xbox = { status: null, data: null, code: null, busy: false, error: '' }; paintAvatar(); render(); } }, 'Sign out'))),
    h('section.row', h('h2', `Friends (${(d.friends ?? []).filter((f) => f.online).length} online)`),
      (d.friends ?? []).length
        ? h('div.strip', d.friends.slice(0, 30).map((f) => h('div.friend.glass-card' + (f.online ? '.online' : ''),
            f.picture ? h('img', { src: f.picture, alt: '' }) : h('div.gamerpic.small'),
            h('div', h('b', f.gamertag), h('small', f.status)))))
        : h('p.note', 'No friends to show.')),
    h('section.row', h('h2', 'Achievements'),
      played.length
        ? h('div.ach-list', played.slice(0, 40).map((t) => h('div.ach.glass-card',
            t.image ? h('img', { src: t.image, alt: '' }) : h('div.ach-img'),
            h('div.ach-body', h('b', t.name), h('small', `${t.achievements.earned} of ${t.achievements.total} achievements · ${t.achievements.score} / ${t.achievements.maxScore} G`),
              h('div.meter', h('i', { style: { width: (t.achievements.percent ?? 0) + '%' } }))),
            h('span.pct', `${t.achievements.percent ?? 0}%`))))
        : h('p.note', 'No achievement progress yet.')),
    d.errors?.length && h('p.note', 'Some Xbox data couldn’t load: ' + d.errors.join('; '))
  );
}

/** Achievement progress for a library game, matched by name. */
const achievementsFor = (g) => (xbox.data?.titles ?? []).find((t) => norm(t.name) === norm(g.title))?.achievements ?? null;

// ---------- detail sheets ----------

function openDetail(g) {
  const sheet = $('#detail');
  const title = h('h1', g.title);
  const cols = new Set(g.collections ?? []);
  const newCol = h('input.new-col.nav', { placeholder: 'New collection…' });
  newCol.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && newCol.value.trim()) {
      await window.nexus.setCollections(g.id, [...cols, newCol.value.trim()]);
      toast(`Added to ${newCol.value.trim()}`);
    }
    if (e.key === 'Escape') e.stopPropagation();
  });
  sheet.replaceChildren(
    art(g),
    h('div',
      title,
      h('div.facts',
        h('span', h('b', playtimeText(g.playtime)), 'Playtime'),
        h('span', h('b', agoText(g.lastPlayed)), 'Last played'),
        h('span', h('b', SOURCES[g.source] ?? 'PC'), 'From'),
        achievementsFor(g) && h('span', h('b', `${achievementsFor(g).earned}/${achievementsFor(g).total}`), 'Achievements')),
      h('div.actions',
        h('button.btn.go.nav', { onclick: () => play(g) }, runningId === g.id ? 'Playing' : 'Play'),
        h('button.btn.nav', { onclick: closeSheets }, 'Back')),
      h('div.more',
        h('button.btn.small.nav', { onclick: () => window.nexus.update(g.id, { favorite: !g.favorite }) }, g.favorite ? '★ Unfavorite' : '☆ Favorite'),
        h('button.btn.small.nav', { onclick: () => window.nexus.update(g.id, { pinned: !g.pinned }) }, g.pinned ? '📌 Unpin from Home' : '📌 Pin to Home'),
        h('button.btn.small.nav', { onclick: () => rename(g, title) }, 'Rename'),
        h('button.btn.small.nav', { onclick: () => window.nexus.setCover(g.id, 'cover') }, 'Change art'),
        h('button.btn.small.nav', { onclick: () => window.nexus.reveal(g.id) }, 'Open folder'),
        g.source === 'xbox' && h('button.btn.small.nav', { onclick: () => window.nexus.openXbox() }, 'Xbox app'),
        h('button.btn.small.nav', { onclick: async () => { await window.nexus.remove(g.id); closeSheets(); toast(`Removed ${g.title}`); } }, 'Remove')),
      h('div.collections',
        h('h3', 'Collections'),
        h('div.chips',
          ...(library.collections ?? []).map((c) => h('button.chip.nav' + (cols.has(c) ? '.on' : ''), {
            onclick: async () => {
              cols.has(c) ? cols.delete(c) : cols.add(c);
              await window.nexus.setCollections(g.id, [...cols]);
            },
          }, (cols.has(c) ? '✓ ' : '') + c)),
          newCol)))
  );
  sheet.hidden = false;
  sheet.dataset.id = g.id;
  setBackground(bgFor(g));
  $('.btn.go', sheet).focus();
}

function openGamePassDetail(p, hasPass) {
  const sheet = $('#detail');
  sheet.replaceChildren(
    art({ title: p.title, tile: p.tile }),
    h('div',
      h('h1', p.title),
      h('div.sub', [p.publisher, p.category].filter(Boolean).join(' · ')),
      p.description && h('p.desc', p.description),
      h('div.actions',
        h('button.btn.go.nav', { onclick: () => { window.nexus.openGamePass(p.productId); toast('Opening in the Xbox app…'); } }, hasPass ? 'Install with Game Pass' : 'View in Xbox app'),
        h('button.btn.nav', { onclick: closeSheets }, 'Back')))
  );
  sheet.hidden = false;
  sheet.dataset.id = '';
  setBackground(p.hero);
  $('.btn.go', sheet).focus();
}

function openViewer(c) {
  const v = $('#viewer');
  v.replaceChildren(
    c.video ? h('video', { src: c.url, controls: true, autoplay: true }) : h('img', { src: c.url, alt: '' }),
    h('div.viewer-bar',
      h('button.btn.nav', { onclick: () => window.nexus.revealCapture(c.file) }, 'Show in folder'),
      h('button.btn.primary.nav', { onclick: closeSheets }, 'Close')));
  v.hidden = false;
  $('.btn.primary', v).focus();
}

function closeSheets() {
  const sheet = $('#detail');
  const viewer = $('#viewer');
  if (!viewer.hidden) {
    viewer.replaceChildren();
    viewer.hidden = true;
    return true;
  }
  if (sheet.hidden) return false;
  const id = sheet.dataset.id;
  sheet.hidden = true;
  (id && view.querySelector(`.tile[data-id="${id}"]`))?.focus();
  return true;
}

function rename(g, titleEl) {
  const input = h('input.rename.nav', { value: g.title });
  const done = async (save) => {
    if (save && input.value.trim()) await window.nexus.update(g.id, { title: input.value.trim() });
    else input.replaceWith(titleEl);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') { e.stopPropagation(); done(false); }
  });
  input.addEventListener('blur', () => done(true));
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

// ---------- actions ----------

async function play(g) {
  try {
    await window.nexus.launch(g.id);
    toast(`Starting ${g.title}`);
  } catch (e) {
    toast(errText(e));
  }
}

async function scan() {
  toast('Looking for games…');
  const r = await window.nexus.scan();
  toast(r.added ? `Found ${r.added} new game${r.added === 1 ? '' : 's'}` : 'No new games found');
}

async function add(files) {
  const r = await window.nexus.addFiles(files);
  if (r.added) toast(`Added ${r.added} game${r.added === 1 ? '' : 's'}`);
  else if (files) toast('Those files aren’t games Gamer can launch');
}

function switchTab(t) {
  tab = t;
  closeSheets();
  render();
}

// ---------- navigation: keyboard + controller ----------

const focusables = () => {
  const scope = !$('#viewer').hidden ? '#viewer .nav' : !$('#detail').hidden ? '#detail .nav' : '#top .nav, #view .nav';
  return [...document.querySelectorAll(scope)].filter((el) => el.offsetParent);
};

function focusFirst() {
  if (document.activeElement?.matches?.('input')) return;
  if (!$('#detail').hidden || !$('#viewer').hidden) return;
  (view.querySelector('.tile, .cap') ?? view.querySelector('.nav'))?.focus({ preventScroll: true });
}

function move(dir) {
  const cur = document.activeElement?.matches?.('.nav') ? document.activeElement : null;
  if (!cur) return focusFirst();
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const el of focusables()) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax;
    const dy = b.top + b.height / 2 - ay;
    if (!{ left: dx < -4, right: dx > 4, up: dy < -4, down: dy > 4 }[dir]) continue;
    const horiz = dir === 'left' || dir === 'right';
    const score = (horiz ? Math.abs(dx) : Math.abs(dy)) + (horiz ? Math.abs(dy) : Math.abs(dx)) * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (best) {
    best.focus({ preventScroll: true });
    best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}

function back() {
  if (closeSheets()) return;
  if (query) {
    $('#search').value = '';
    query = '';
    render();
  } else if (tab !== 'home') switchTab('home');
}

const TABS = ['home', 'library', 'gamepass', 'captures', 'stats', 'xbox'];
const nextTab = (d) => switchTab(TABS[(TABS.indexOf(tab) + d + TABS.length) % TABS.length]);

addEventListener('keydown', (e) => {
  const typing = e.target.matches('input');
  if (e.key === 'F11') return window.nexus.fullscreen();
  if (e.key === 'Escape') return back();
  if (typing && !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
  if (dir) {
    e.preventDefault();
    move(dir);
  } else if (e.key.toLowerCase() === 'y' && focusedGame && tab === 'home') openDetail(focusedGame);
});

const pad = { prev: {}, repeatAt: 0 };
function pollPad() {
  const gp = [...(navigator.getGamepads?.() ?? [])].find(Boolean);
  $('#pad').hidden = !gp;
  if (gp) {
    const now = performance.now();
    const b = (i) => gp.buttons[i]?.pressed;
    const pressed = (i) => b(i) && !pad.prev[i];
    const [lx, ly] = gp.axes;
    const dir = b(14) || lx < -0.6 ? 'left' : b(15) || lx > 0.6 ? 'right' : b(12) || ly < -0.6 ? 'up' : b(13) || ly > 0.6 ? 'down' : null;
    if (dir && now > pad.repeatAt) {
      move(dir);
      pad.repeatAt = now + (pad.dir === dir ? 120 : 320);
    }
    pad.dir = dir;
    if (!dir) pad.repeatAt = 0;
    if (pressed(0)) document.activeElement?.click(); // A
    if (pressed(1)) back(); // B
    if (pressed(3) && focusedGame && tab === 'home') openDetail(focusedGame); // Y
    if (pressed(9) && focusedGame) play(focusedGame); // Menu / Options
    if (pressed(4)) nextTab(-1); // LB
    if (pressed(5)) nextTab(1); // RB
    pad.prev = Object.fromEntries(gp.buttons.map((x, i) => [i, x.pressed]));
  }
  requestAnimationFrame(pollPad);
}
requestAnimationFrame(pollPad);

function renderHints(controller) {
  $('#hints').replaceChildren(...(controller
    ? [['a', 'A', 'Select'], ['b', 'B', 'Back'], ['y', 'Y', 'Details'], ['', 'LB  RB', 'Switch section']]
    : [['', '↑ ↓ ← →', 'Move'], ['', 'Enter', 'Select'], ['', 'Esc', 'Back'], ['', 'F11', 'Full screen']]
  ).map(([cls, key, label]) => h('span', h('kbd' + (cls ? '.' + cls : ''), key), label)));
}
addEventListener('gamepadconnected', () => { toast('Controller connected'); renderHints(true); });
addEventListener('gamepaddisconnected', () => renderHints(false));

// ---------- top bar ----------

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('#search').addEventListener('input', (e) => {
  query = e.target.value.trim();
  if (query && tab !== 'gamepass' && tab !== 'library') tab = 'library';
  render();
  e.target.focus();
});
function tickClock() {
  $('#clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
setInterval(tickClock, 10000);
tickClock();
navigator.getBattery?.().then((bat) => {
  const show = () => ($('#battery').textContent = bat.charging || bat.level >= 0.999 ? '' : `${Math.round(bat.level * 100)}%`);
  bat.addEventListener('levelchange', show);
  bat.addEventListener('chargingchange', show);
  show();
});

// ---------- drag & drop ----------

let depth = 0;
addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) return;
  depth++;
  $('#drop').hidden = false;
});
addEventListener('dragleave', () => {
  if (--depth <= 0) $('#drop').hidden = true;
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  depth = 0;
  $('#drop').hidden = true;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) add(files);
});

// ---------- boot ----------

window.nexus.onLibrary((lib) => {
  library = lib;
  const openId = $('#detail').hidden ? null : $('#detail').dataset.id;
  if (tab !== 'gamepass' || !openId) render();
  const g = openId && library.games.find((x) => x.id === openId);
  if (g) openDetail(g);
});
window.nexus.onRunning((id) => {
  runningId = id;
  render();
});
window.nexus.onScanned((r) => r.added && toast(`Found ${r.added} game${r.added === 1 ? '' : 's'} on this PC`));

$('.profile').addEventListener('click', () => switchTab('xbox'));
loadXbox().catch(() => {});
library = await window.nexus.library();
renderHints(!!(navigator.getGamepads?.() ?? []).find?.(Boolean));
render();
