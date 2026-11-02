// Gamer: a console-style game library and launcher.
// The library lives in %APPDATA%/nexus-games/library.json so other tools (for
// example a J.A.R.V.I.S. plugin) can read it and launch games too.
import { app, BrowserWindow, ipcMain, protocol, dialog, shell, safeStorage } from 'electron';
import QRCode from 'qrcode';
import * as xboxlive from './xboxlive.mjs';
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import * as uiagent from './uiagent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(__dirname, 'renderer');
// Installed as "Gamer", Electron would keep data in a new folder; pin the original one so the
// library, playtime, Xbox sign-in and collections carry over (Jarvis reads the library here too).
app.setPath('userData', path.join(app.getPath('appData'), 'nexus-games'));
const data = (...p) => path.join(app.getPath('userData'), ...p);
const LIBRARY = () => data('library.json');

protocol.registerSchemesAsPrivileged([{ scheme: 'nexus', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

let win;
let library = { games: [] };

// ---------- library storage ----------

async function loadLibrary() {
  try {
    library = JSON.parse(await fsp.readFile(LIBRARY(), 'utf8'));
  } catch {
    library = { games: [] };
  }
  cleanLibrary();
}

const isIgnored = (g) => library.ignored?.includes(g.id) || library.ignoredTitles?.includes(norm(g.title));

/** Drop launchers and removed games, and merge copies of the same game (keeping art and history). */
function cleanLibrary() {
  const byTitle = new Map();
  for (const g of library.games) {
    if ((g.id === 'roblox-app' || g.id.startsWith('lnk-')) && LAUNCHERS.test(g.title)) continue;
    if (isIgnored(g)) continue;
    const key = norm(g.title);
    const prev = byTitle.get(key);
    if (!prev) {
      byTitle.set(key, g);
      continue;
    }
    const [keep, drop] = prev.cover || !g.cover ? [prev, g] : [g, prev];
    keep.playtime = (keep.playtime ?? 0) + (drop.playtime ?? 0);
    keep.lastPlayed = Math.max(keep.lastPlayed ?? 0, drop.lastPlayed ?? 0) || null;
    keep.favorite = keep.favorite || drop.favorite;
    byTitle.set(key, keep);
  }
  library.games = [...byTitle.values()];
}

let saveTimer;
function saveLibrary() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await fsp.mkdir(data(), { recursive: true });
    await fsp.writeFile(LIBRARY(), JSON.stringify(library, null, 2));
  }, 150);
  win?.webContents.send('library', library);
}

const newId = (seed) => crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);

function upsert(game) {
  if (isIgnored(game)) return { game, added: false };
  const existing = library.games.find((g) => g.id === game.id);
  if (existing) {
    // keep what the user chose (title, custom art) and the play history
    for (const [k, v] of Object.entries(game)) if (existing[k] == null && v != null) existing[k] = v;
    // automatic artwork is refreshed on every scan (fixes stale or broken art links)
    if (!existing.customArt) for (const k of ['cover', 'hero', 'header']) if (game[k]) existing[k] = game[k];
    return { game: existing, added: false };
  }
  library.games.push({ addedAt: Date.now(), lastPlayed: null, playtime: 0, ...game });
  return { game, added: true };
}

// ---------- artwork ----------

async function saveIcon(id, file) {
  try {
    const img = await app.getFileIcon(file, { size: 'large' });
    if (img.isEmpty()) return null;
    await fsp.mkdir(data('icons'), { recursive: true });
    await fsp.writeFile(data('icons', id + '.png'), img.toPNG());
    return `nexus://app/_data/icons/${id}.png`;
  } catch {
    return null;
  }
}

// Official Steam artwork (portrait cover, wide background, header) for any app
const STEAM_ASSETS = 'https://shared.akamai.steamstatic.com/store_item_assets/';
async function steamAssets(appid) {
  try {
    const input = { ids: [{ appid: Number(appid) }], context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true } };
    const r = await fetch('https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=' + encodeURIComponent(JSON.stringify(input)));
    const a = (await r.json()).response?.store_items?.[0]?.assets;
    if (!a?.asset_url_format) return null;
    const url = (f) => (f ? STEAM_ASSETS + a.asset_url_format.replace('${FILENAME}', f) : null);
    return { cover: url(a.library_capsule_2x ?? a.library_capsule), hero: url(a.library_hero_2x ?? a.library_hero), header: url(a.main_capsule_2x ?? a.header_2x ?? a.header) };
  } catch {
    return null;
  }
}

const norm = (s = '') => s.toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Find a non-Steam game on the Steam store by name, to borrow its artwork. */
async function steamSearch(title) {
  try {
    const r = await fetch('https://store.steampowered.com/api/storesearch/?cc=us&l=en&term=' + encodeURIComponent(title));
    const items = (await r.json()).items ?? [];
    const t = norm(title);
    const hit = items.find((i) => {
      const n = norm(i.name);
      return !/points|pack|soundtrack|dlc|pre purchase|bundle|upgrade/.test(n) && (n === t || n.includes(t) || t.includes(n));
    });
    return hit?.id ?? null;
  } catch {
    return null;
  }
}

const steamArt = (appid) => ({
  cover: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900_2x.jpg`,
  hero: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_hero.jpg`,
  header: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
});

async function robloxArt(placeId) {
  try {
    const r = await fetch(`https://thumbnails.roblox.com/v1/places/gameicons?placeIds=${placeId}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`);
    const j = await r.json();
    return j.data?.[0]?.imageUrl ?? null;
  } catch {
    return null;
  }
}

// ---------- detection ----------

const NOT_GAMES = /redistributable|steamworks|proton|steam linux runtime|steamvr|dedicated server|soundtrack|sdk|benchmark/i;
// launchers and helper shortcuts that aren't games themselves
const LAUNCHERS = /launcher|^steam$|^ea( app)?$|uninstall|setup|support|manual|website|readme|studio|^roblox( player)?$/i;
const GAME_PATHS = /steamapps\\common|epic games|riot games|battle\.net|ea games|ubisoft|roblox|minecraft|gog galaxy\\games|rockstar games|xboxgames/i;

function reg(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      resolve(out.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.*)`))?.[1]?.trim() ?? null);
    });
  });
}

async function scanSteam(found) {
  const steamPath = await reg('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  if (!steamPath) return;
  const libs = new Set([path.normalize(steamPath)]);
  try {
    const vdf = await fsp.readFile(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(path.normalize(m[1].replace(/\\\\/g, '\\')));
  } catch {
    /* single library */
  }
  for (const lib of libs) {
    let files = [];
    try {
      files = (await fsp.readdir(path.join(lib, 'steamapps'))).filter((f) => /^appmanifest_\d+\.acf$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const acf = await fsp.readFile(path.join(lib, 'steamapps', f), 'utf8').catch(() => '');
      const appid = acf.match(/"appid"\s+"(\d+)"/)?.[1];
      const name = acf.match(/"name"\s+"([^"]+)"/)?.[1];
      const dir = acf.match(/"installdir"\s+"([^"]+)"/)?.[1];
      if (!appid || !name || NOT_GAMES.test(name) || appid === '228980') continue;
      found.push({ id: 'steam-' + appid, title: name, source: 'steam', target: `steam://rungameid/${appid}`, steamAppId: appid, folder: dir ? path.join(lib, 'steamapps', 'common', dir) : null, ...steamArt(appid) });
    }
  }
}

async function scanEpic(found) {
  const dir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
  let files = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.item'));
  } catch {
    return;
  }
  for (const f of files) {
    try {
      const m = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
      if (!m.DisplayName || m.bIsApplication === false) continue;
      const exe = m.InstallLocation && m.LaunchExecutable ? path.join(m.InstallLocation, m.LaunchExecutable) : null;
      found.push({
        id: 'epic-' + m.AppName,
        title: m.DisplayName,
        source: 'epic',
        target: `com.epicgames.launcher://apps/${m.CatalogNamespace}%3A${m.CatalogItemId}%3A${m.AppName}?action=launch&silent=true`,
        folder: m.InstallLocation ?? null,
        iconFrom: exe,
      });
    } catch {
      /* broken manifest */
    }
  }
}

function readUrlFile(text) {
  return { url: text.match(/^URL=(.*)$/m)?.[1]?.trim(), icon: text.match(/^IconFile=(.*)$/m)?.[1]?.trim() };
}

const cleanTitle = (file) => path.basename(file, path.extname(file)).replace(/^\[[^\]]*\]\s*/, '').trim();

/** Turn one file (exe, shortcut or .url) into a game entry, or null if it isn't one. */
async function gameFromFile(file, { strict }) {
  const ext = path.extname(file).toLowerCase();
  const title = cleanTitle(file);
  if (ext === '.url') {
    const { url, icon } = readUrlFile(await fsp.readFile(file, 'utf8').catch(() => ''));
    if (!url) return null;
    const steam = url.match(/^steam:\/\/rungameid\/(\d+)/);
    if (steam) return { id: 'steam-' + steam[1], title, source: 'steam', target: url, steamAppId: steam[1], ...steamArt(steam[1]), iconFrom: icon };
    const place = url.match(/roblox:\/\/.*placeId=(\d+)/) ?? url.match(/roblox\.com\/games\/(\d+)/);
    if (place) return { id: 'roblox-' + place[1], title, source: 'roblox', target: url, placeId: place[1], iconFrom: icon };
    if (/^com\.epicgames\.launcher:/.test(url)) return { id: 'url-' + newId(url), title, source: 'epic', target: url, iconFrom: icon };
    return strict ? null : { id: 'url-' + newId(url), title, source: 'link', target: url, iconFrom: icon };
  }
  if (ext === '.lnk') {
    let target = '';
    try {
      target = shell.readShortcutLink(file).target;
    } catch {
      /* unreadable shortcut */
    }
    if (strict && (!GAME_PATHS.test(target) || /studio/i.test(file + target))) return null;
    if (strict && LAUNCHERS.test(title)) return null;
    // key shortcuts by what they point at, so desktop + Start Menu copies merge
    return { id: 'lnk-' + newId(target || file), title, source: /roblox/i.test(target) ? 'roblox' : 'pc', target: file, launch: 'open', folder: target ? path.dirname(target) : null, iconFrom: target || file };
  }
  if (['.exe', '.bat', '.cmd'].includes(ext)) {
    return { id: 'exe-' + newId(file), title, source: 'pc', target: file, launch: 'exe', folder: path.dirname(file), iconFrom: file };
  }
  return null;
}

async function scanShortcuts(found) {
  const home = os.homedir();
  const dirs = [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    'C:\\Users\\Public\\Desktop',
    path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
  ];
  const walk = async (dir, depth) => {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) await walk(p, depth - 1);
      else if (/\.(url|lnk)$/i.test(e.name)) {
        const g = await gameFromFile(p, { strict: true });
        if (g) found.push(g);
      }
    }
  };
  for (const d of dirs) await walk(d, d.includes('Start Menu') ? 2 : 0);
}

async function finishArt(game) {
  if (game.source === 'xbox') return xboxArt(game);
  if (game.source === 'roblox' && game.placeId && !game.cover) game.cover = await robloxArt(game.placeId);
  // Steam games: exact official art; other PC games: borrow art from their Steam store page
  if (game.source !== 'roblox' && game.source !== 'link') {
    const appid = game.steamAppId ?? (game.cover ? null : await steamSearch(game.title));
    const art = appid ? await steamAssets(appid) : null;
    if (art) for (const k of ['cover', 'hero', 'header']) if (art[k]) game[k] = art[k];
  }
  if (!game.icon && game.iconFrom) game.icon = await saveIcon(game.id, game.iconFrom);
  delete game.iconFrom;
}

async function scan() {
  const found = [];
  await scanSteam(found);
  await scanEpic(found);
  await scanXbox(found);
  await scanShortcuts(found);
  // the same game can be found twice (e.g. Steam library + desktop shortcut)
  const unique = [...new Map(found.map((g) => [g.id, g])).values()];
  const before = library.games.length;
  for (const g of unique) {
    if (isIgnored(g)) continue;
    await finishArt(g);
    upsert(g);
  }
  cleanLibrary();
  const added = Math.max(0, library.games.length - before);
  saveLibrary();
  return { found: unique.length, added };
}

// ---------- launching & playtime ----------

const running = new Map(); // gameId -> start time

function addPlaytime(game, seconds) {
  game.playtime = (game.playtime ?? 0) + Math.round(seconds);
  const day = new Date().toISOString().slice(0, 10);
  library.daily ??= {};
  library.daily[day] ??= {};
  library.daily[day][game.id] = (library.daily[day][game.id] ?? 0) + Math.round(seconds);
  saveLibrary();
}

// Steam reports the running game's appid in the registry, which lets us count
// playtime for Steam games even though Steam starts them itself.
let steamPoll = null;
function watchSteam(game) {
  clearInterval(steamPoll);
  let seen = false;
  let last = Date.now();
  let idle = 0;
  steamPoll = setInterval(async () => {
    const id = parseInt((await reg('HKCU\\Software\\Valve\\Steam', 'RunningAppID')) ?? '0', 16) || 0;
    const now = Date.now();
    if (String(id) === game.steamAppId) {
      if (seen) addPlaytime(game, (now - last) / 1000);
      seen = true;
      idle = 0;
    } else if (seen || ++idle > 20) {
      clearInterval(steamPoll); // game closed, or never started within ~5 min
      win?.webContents.send('running', null);
    }
    last = now;
  }, 15000);
}

async function launch(id) {
  const game = library.games.find((g) => g.id === id);
  if (!game) throw new Error('Game not found');
  game.lastPlayed = Date.now();
  saveLibrary();
  if (game.launch === 'exe') {
    if (!fs.existsSync(game.target)) throw new Error('The game file is missing: ' + game.target);
    const child = spawn(game.target, game.args ?? [], { cwd: path.dirname(game.target), detached: true, stdio: 'ignore', windowsHide: false });
    running.set(id, Date.now());
    child.on('exit', () => {
      addPlaytime(game, (Date.now() - running.get(id)) / 1000);
      running.delete(id);
      win?.webContents.send('running', null);
    });
    child.unref();
  } else if (game.launch === 'shell') {
    spawn('explorer.exe', [game.target], { detached: true, stdio: 'ignore' }).unref();
    watchProcess(game);
  } else if (game.launch === 'open') {
    const err = await shell.openPath(game.target);
    if (err) throw new Error(err);
  } else {
    await shell.openExternal(game.target);
    if (game.steamAppId) watchSteam(game);
  }
  win?.webContents.send('running', id);
  return true;
}

// ---------- nexus:// protocol ----------

// ---------- Xbox / Game Pass (games installed by the Xbox app) ----------

const XBOX_APP = 'shell:AppsFolder\\Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App';

function powershellJson(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      try {
        const v = JSON.parse(out || '[]');
        resolve(Array.isArray(v) ? v : [v]);
      } catch {
        resolve([]);
      }
    });
  });
}

const attr = (tag, name) => tag?.match(new RegExp(`\\b${name}="([^"]*)"`, 's'))?.[1] ?? null;

async function scanXbox(found) {
  // package family names (needed to launch) for every installed Store package
  const pkgs = await powershellJson('Get-AppxPackage | Where-Object { -not $_.IsFramework } | Select-Object Name, PackageFamilyName | ConvertTo-Json -Compress');
  const pfnByName = new Map(pkgs.map((p) => [p.Name, p.PackageFamilyName]));
  const roots = [];
  for (const letter of 'CDEFGHIJ') {
    const r = `${letter}:\\XboxGames`;
    if (fs.existsSync(r)) roots.push(r);
  }
  for (const root of roots) {
    for (const dir of await fsp.readdir(root).catch(() => [])) {
      const content = path.join(root, dir, 'Content');
      const cfg = await fsp.readFile(path.join(content, 'MicrosoftGame.config'), 'utf8').catch(() => null);
      if (!cfg) continue;
      const identity = cfg.match(/<Identity\b[^>]*>/s)?.[0];
      const visuals = cfg.match(/<ShellVisuals\b[^>]*>/s)?.[0];
      const exe = [...cfg.matchAll(/<Executable\b[^>]*>/gs)].map((m) => m[0]).find((t) => !/IsDevOnly="true"/i.test(t));
      const pkgName = attr(identity, 'Name');
      const pfn = pfnByName.get(pkgName);
      const appId = attr(exe, 'Id');
      if (!pfn || !appId) continue;
      const clean = (s) => (s && !s.startsWith('ms-resource') ? s : null);
      const title = clean(attr(exe, 'OverrideDisplayName')) ?? clean(attr(visuals, 'DefaultDisplayName')) ?? dir;
      if (LAUNCHERS.test(title) || /^roblox$/i.test(title)) continue;
      const storeId = cfg.match(/<StoreId>\s*([A-Z0-9]{12})\s*<\/StoreId>/i)?.[1] ?? null;
      const splash = attr(visuals, 'SplashScreenImage');
      const logo = attr(visuals, 'Square150x150Logo') ?? attr(visuals, 'StoreLogo');
      found.push({
        id: 'xbox-' + pkgName,
        title,
        source: 'xbox',
        target: `shell:AppsFolder\\${pfn}!${appId}`,
        launch: 'shell',
        exeName: attr(exe, 'Name') ? path.basename(attr(exe, 'Name')) : null,
        storeId,
        folder: content,
        splashFile: splash ? path.join(content, splash) : null,
        iconFile: logo ? path.join(content, logo) : null,
      });
    }
  }
}

/** Copy a game's own splash/logo into Gamer so it can be shown (Xbox games ship their art). */
async function xboxArt(game) {
  const copy = async (file, kind) => {
    if (!file || !fs.existsSync(file)) return null;
    await fsp.mkdir(data('covers'), { recursive: true });
    const name = `${game.id}-${kind}${path.extname(file).toLowerCase()}`;
    await fsp.copyFile(file, data('covers', name)).catch(() => {});
    return fs.existsSync(data('covers', name)) ? `nexus://app/_data/covers/${name}` : null;
  };
  const splash = await copy(game.splashFile, 'splash');
  const icon = await copy(game.iconFile, 'logo');
  if (icon) game.icon = icon;
  delete game.splashFile;
  delete game.iconFile;
  // Microsoft's own 1920x1080 key art (with the game's logo), found by the game's Store ID
  if (game.storeId) {
    try {
      const r = await fetch(`https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${game.storeId}&market=US&languages=en-us`);
      const imgs = (await r.json()).Products?.[0]?.LocalizedProperties?.[0]?.Images ?? [];
      const pick = (...ps) => ps.map((p) => imgs.find((i) => i.ImagePurpose === p)).find(Boolean);
      const titled = pick('TitledHeroArt', 'SuperHeroArt', 'BoxArt');
      const hero = pick('SuperHeroArt', 'TitledHeroArt');
      const https = (u) => (u?.startsWith('//') ? 'https:' + u : u);
      if (titled) return Object.assign(game, { cover: https(titled.Uri), header: https(titled.Uri), hero: https(hero?.Uri ?? titled.Uri) });
    } catch {
      /* fall through to other sources */
    }
  }
  // otherwise the Steam store's key art, then the game's own splash screen
  const appid = await steamSearch(game.title);
  const art = appid ? await steamAssets(appid) : null;
  if (art?.header) Object.assign(game, { cover: art.header, hero: art.hero ?? splash, header: art.header });
  else if (splash) Object.assign(game, { cover: splash, hero: splash });
}

// ---------- playtime by watching the game's process ----------

function isRunning(exeName) {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH'], { windowsHide: true }, (err, out) => resolve(!err && out.toLowerCase().includes(exeName.toLowerCase())));
  });
}

const watchers = new Map();
function watchProcess(game) {
  if (!game.exeName || watchers.has(game.id)) return;
  let seen = false;
  let idle = 0;
  let last = Date.now();
  const timer = setInterval(async () => {
    const now = Date.now();
    if (await isRunning(game.exeName)) {
      if (seen) addPlaytime(game, (now - last) / 1000);
      seen = true;
      idle = 0;
    } else if (seen || ++idle > 20) {
      clearInterval(timer);
      watchers.delete(game.id);
      win?.webContents.send('running', null);
    }
    last = now;
  }, 15000);
  watchers.set(game.id, timer);
}

// ---------- captures (Xbox Game Bar screenshots & clips) ----------

const CAPTURE_EXT = /\.(png|jpe?g|mp4|webm|gif)$/i;
const capturesDir = () => library.capturesDir ?? path.join(os.homedir(), 'Videos', 'Captures');

async function listCaptures() {
  const dir = capturesDir();
  const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => CAPTURE_EXT.test(f));
  const out = [];
  for (const f of files) {
    const st = await fsp.stat(path.join(dir, f)).catch(() => null);
    if (!st) continue;
    // Game Bar names captures "<Game title> <date> <time>.png"
    const game = library.games.find((g) => norm(f).startsWith(norm(g.title)));
    out.push({ file: f, url: `nexus://app/_captures/${encodeURIComponent(f)}`, video: /\.(mp4|webm)$/i.test(f), time: st.mtimeMs, size: st.size, gameId: game?.id ?? null });
  }
  return { dir, items: out.sort((a, b) => b.time - a.time) };
}


// ---------- PC Game Pass catalog (public Microsoft catalog, no sign-in) ----------

const GAMEPASS_LIST = 'https://catalog.gamepass.com/sigls/v2?id=fdd9e2a7-0fee-49f6-ad69-4354098401ff&language=en-us&market=US';
const img = (u) => (u ? (u.startsWith('//') ? 'https:' + u : u) : null);

async function gamePass(force = false) {
  const cacheFile = data('gamepass.json');
  if (!force) {
    const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8').catch(() => 'null'));
    if (cached && Date.now() - cached.at < 24 * 3600e3) return cached.games;
  }
  const ids = (await (await fetch(GAMEPASS_LIST)).json()).filter((x) => x.id).map((x) => x.id);
  const games = [];
  for (let i = 0; i < ids.length; i += 20) {
    const r = await fetch(`https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${ids.slice(i, i + 20).join(',')}&market=US&languages=en-us`);
    const j = await r.json().catch(() => ({ Products: [] }));
    for (const p of j.Products ?? []) {
      const lp = p.LocalizedProperties?.[0];
      if (!lp) continue;
      const pick = (...purposes) => {
        for (const purpose of purposes) {
          const im = lp.Images?.find((x) => x.ImagePurpose === purpose);
          if (im) return img(im.Uri);
        }
        return null;
      };
      games.push({
        productId: p.ProductId,
        title: lp.ProductTitle,
        publisher: lp.PublisherName ?? '',
        tile: pick('TitledHeroArt', 'SuperHeroArt', 'BoxArt'),
        hero: pick('SuperHeroArt', 'TitledHeroArt'),
        description: (lp.ShortDescription || lp.ProductDescription || '').slice(0, 400),
        category: p.Properties?.Category ?? '',
      });
    }
  }
  games.sort((a, b) => a.title.localeCompare(b.title));
  await fsp.mkdir(data(), { recursive: true });
  await fsp.writeFile(cacheFile, JSON.stringify({ at: Date.now(), games }));
  return games;
}

async function serveCapture(name, req) {
  const dir = capturesDir();
  const file = path.normalize(path.join(dir, name));
  if (!file.startsWith(dir) || !CAPTURE_EXT.test(file)) return new Response('Forbidden', { status: 403 });
  const st = await fsp.stat(file).catch(() => null);
  if (!st) return new Response('Not found', { status: 404 });
  const type = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' }[path.extname(file).toLowerCase()];
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '');
  if (!m) return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { 'content-type': type, 'content-length': String(st.size), 'accept-ranges': 'bytes' } });
  const start = Number(m[1] || 0);
  const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
    status: 206,
    headers: { 'content-type': type, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes' },
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

function registerProtocol() {
  protocol.handle('nexus', async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname);
    if (rel.startsWith('/_captures/')) return serveCapture(rel.slice(11), req);
    const [root, base] = rel.startsWith('/_data/') ? [data(), rel.slice(7)] : [RENDERER, rel === '/' ? 'index.html' : rel.slice(1)];
    const file = path.normalize(path.join(root, base));
    if (!file.startsWith(root)) return new Response('Forbidden', { status: 403 });
    try {
      return new Response(await fsp.readFile(file), { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('library', () => library);
  ipcMain.handle('scan', () => scan());
  ipcMain.handle('launch', (_e, id) => launch(id));
  ipcMain.handle('add-files', async (_e, files) => {
    if (!files?.length) {
      const r = await dialog.showOpenDialog(win, {
        title: 'Add games',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Games and shortcuts', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] }],
      });
      if (r.canceled) return { added: 0 };
      files = r.filePaths;
    }
    let added = 0;
    for (const f of files) {
      const g = await gameFromFile(f, { strict: false });
      if (!g) continue;
      await finishArt(g);
      if (upsert(g).added) added++;
    }
    saveLibrary();
    return { added };
  });
  ipcMain.handle('update', (_e, id, patch) => {
    const g = library.games.find((x) => x.id === id);
    if (!g) return false;
    for (const k of ['title', 'favorite', 'hidden']) if (k in patch) g[k] = patch[k];
    // one game leads the Home screen
    if ('pinned' in patch) for (const x of library.games) x.pinned = patch.pinned && x.id === id;
    saveLibrary();
    return true;
  });
  ipcMain.handle('remove', (_e, id) => {
    const gone = library.games.find((g) => g.id === id);
    library.games = library.games.filter((g) => g.id !== id);
    // remember it (by id and by name) so a later scan doesn't add it back
    library.ignored = [...new Set([...(library.ignored ?? []), id])];
    if (gone) library.ignoredTitles = [...new Set([...(library.ignoredTitles ?? []), norm(gone.title)])];
    saveLibrary();
    return true;
  });
  ipcMain.handle('set-cover', async (_e, id, kind = 'cover') => {
    const g = library.games.find((x) => x.id === id);
    const r = await dialog.showOpenDialog(win, { title: kind === 'hero' ? 'Choose background art' : 'Choose cover art', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }] });
    if (!g || r.canceled) return false;
    await fsp.mkdir(data('covers'), { recursive: true });
    const name = `${id}-${kind}-${Date.now()}${path.extname(r.filePaths[0]).toLowerCase()}`;
    await fsp.copyFile(r.filePaths[0], data('covers', name));
    g[kind] = `nexus://app/_data/covers/${name}`;
    g.customArt = true;
    saveLibrary();
    return true;
  });
  // use an image already on this PC (e.g. the EA app's artwork) as a game's cover + background
  ipcMain.handle('import-art', async (_e, id, file, pos) => {
    const g = library.games.find((x) => x.id === id);
    if (!g || !/\.(jpe?g|png|webp)$/i.test(file) || !fs.existsSync(file)) return false;
    await fsp.mkdir(data('covers'), { recursive: true });
    const name = `${id}-art-${Date.now()}${path.extname(file).toLowerCase()}`;
    await fsp.copyFile(file, data('covers', name));
    g.cover = g.hero = `nexus://app/_data/covers/${name}`;
    g.coverPos = pos ?? null;
    g.customArt = true;
    saveLibrary();
    return true;
  });
  ipcMain.handle('reveal', (_e, id) => {
    const g = library.games.find((x) => x.id === id);
    if (g?.folder && fs.existsSync(g.folder)) shell.openPath(g.folder);
    else if (g?.launch && fs.existsSync(g.target)) shell.showItemInFolder(g.target);
  });
  ipcMain.on('fullscreen', () => win.setFullScreen(!win.isFullScreen()));
  ipcMain.handle('open-external', (_e, url) => /^https:\/\/(portal\.azure\.com|www\.microsoft\.com|microsoft\.com|aka\.ms)\//.test(url) && shell.openExternal(url));
  ipcMain.handle('captures', () => listCaptures());
  ipcMain.handle('captures:open', () => shell.openPath(capturesDir()));
  ipcMain.handle('captures:reveal', (_e, f) => shell.showItemInFolder(path.join(capturesDir(), path.basename(f))));
  ipcMain.handle('xbox:open', () => spawn('explorer.exe', [XBOX_APP], { detached: true, stdio: 'ignore' }).unref());
  // ---------- Xbox account (sign-in, profile, achievements, friends) ----------
  const secretFile = (n) => data(n);
  const readSecret = (n) => {
    try {
      const buf = fs.readFileSync(secretFile(n));
      return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8'));
    } catch {
      return null;
    }
  };
  const writeSecret = (n, v) => {
    const json = JSON.stringify(v);
    fs.mkdirSync(data(), { recursive: true });
    fs.writeFileSync(secretFile(n), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json));
  };
  let xbl = null; // live Xbox session
  let signInAbort = null;

  async function xblSession() {
    if (xbl && xbl.expires > Date.now() + 60e3) return xbl;
    const client = readSecret('xbox-client.bin');
    const tokens = readSecret('xbox-tokens.bin');
    if (!client || !tokens?.refresh_token) return null;
    const fresh = await xboxlive.refresh(client.id, tokens.refresh_token);
    writeSecret('xbox-tokens.bin', { refresh_token: fresh.refresh_token ?? tokens.refresh_token });
    xbl = await xboxlive.xboxSession(fresh.access_token);
    return xbl;
  }

  ipcMain.handle('xbl:status', async () => {
    const client = readSecret('xbox-client.bin');
    if (!client) return { setup: false, signedIn: false };
    try {
      const s = await xblSession();
      return s ? { setup: true, signedIn: true, profile: await xboxlive.profile(s) } : { setup: true, signedIn: false };
    } catch (e) {
      return { setup: true, signedIn: false, error: e.message };
    }
  });
  ipcMain.handle('xbl:set-client', (_e, id) => {
    id = String(id ?? '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return { ok: false, error: 'That doesn’t look like an Application (client) ID. It has the form xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.' };
    writeSecret('xbox-client.bin', { id });
    return { ok: true };
  });
  ipcMain.handle('xbl:clear-client', () => {
    for (const f of ['xbox-client.bin', 'xbox-tokens.bin']) fs.rmSync(secretFile(f), { force: true });
    xbl = null;
  });
  ipcMain.handle('xbl:sign-in', async () => {
    const client = readSecret('xbox-client.bin');
    if (!client) return { signedIn: false, error: 'Set up your app registration first.' };
    signInAbort?.abort();
    const abort = (signInAbort = new AbortController());
    try {
      const flow = await xboxlive.startSignIn(client.id, abort.signal);
      const link = `${flow.url}?otc=${encodeURIComponent(flow.code)}`;
      const qr = await QRCode.toDataURL(link, { margin: 1, width: 320 });
      win.webContents.send('xbl:code', { qr, code: flow.code, url: flow.url });
      const tokens = await flow.wait();
      writeSecret('xbox-tokens.bin', { refresh_token: tokens.refresh_token });
      xbl = await xboxlive.xboxSession(tokens.access_token);
      return { signedIn: true, profile: await xboxlive.profile(xbl) };
    } catch (e) {
      return { signedIn: false, error: e.message === 'Cancelled' ? null : e.message };
    }
  });
  ipcMain.handle('xbl:cancel', () => signInAbort?.abort());
  ipcMain.handle('xbl:sign-out', () => {
    fs.rmSync(secretFile('xbox-tokens.bin'), { force: true });
    xbl = null;
  });
  ipcMain.handle('xbl:data', async () => {
    const s = await xblSession();
    if (!s) return null;
    const [p, t, f] = await Promise.allSettled([xboxlive.profile(s), xboxlive.titles(s), xboxlive.friends(s)]);
    return { profile: p.value ?? null, titles: t.value ?? [], friends: f.value ?? [], errors: [p, t, f].filter((x) => x.status === 'rejected').map((x) => x.reason.message) };
  });
  ipcMain.handle('gamepass', (_e, force) => gamePass(force));
  // opens the game's page in the Xbox app, where it can be installed with Game Pass
  ipcMain.handle('gamepass:open', (_e, productId) => /^[A-Z0-9]{12}$/.test(productId) && shell.openExternal(`msxbox://game/?productId=${productId}`));
  ipcMain.handle('collections:set', (_e, id, names) => {
    const g = library.games.find((x) => x.id === id);
    if (!g) return false;
    g.collections = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
    library.collections = [...new Set([...(library.collections ?? []), ...g.collections])];
    saveLibrary();
    return true;
  });
  ipcMain.handle('collections:delete', (_e, name) => {
    library.collections = (library.collections ?? []).filter((c) => c !== name);
    for (const g of library.games) g.collections = (g.collections ?? []).filter((c) => c !== name);
    saveLibrary();
    return true;
  });
  ipcMain.on('quit', () => app.quit());
}

// ---------- window ----------

// One copy only: opening it again (from Jarvis, the Start menu, a shortcut)
// brings the open window forward instead of starting a second copy.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  app.setAppUserModelId('com.gamer.app');
  await loadLibrary();
  registerProtocol();
  registerIpc();
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Gamer',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    backgroundColor: '#05060a',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 48 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.loadURL('nexus://app/index.html');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // first run: look for games automatically
  if (!library.games.length) win.webContents.once('did-finish-load', () => scan().then((r) => win.webContents.send('scanned', r)));
  startControl();
});

// ---------- control channel (lets J.A.R.V.I.S. see and use Gamer's window) ----------
// Listens on 127.0.0.1 only, on a random port, and only accepts commands that
// carry the per-launch secret written to control.json in this app's data folder.
const controlFile = () => data('control.json');
function startControl() {
  const token = crypto.randomBytes(24).toString('hex');
  const run = {
    see: async () => ({ app: await uiagent.inspect(win.webContents, 'a') }),
    act: (cmd) => uiagent.act(win.webContents, { id: String(cmd.id ?? '').slice(0, 12), action: String(cmd.op ?? ''), text: String(cmd.text ?? '').slice(0, 2000), submit: !!cmd.submit }),
    show: () => {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return { shown: true };
    },
  };
  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    if (req.method !== 'POST' || req.url !== '/command') return send(404, { error: 'not found' });
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 10_000) return send(413, { error: 'too large' });
    }
    let cmd;
    try {
      cmd = JSON.parse(body);
    } catch {
      return send(400, { error: 'bad json' });
    }
    if (typeof cmd.token !== 'string' || !crypto.timingSafeEqual(Buffer.from(cmd.token.padEnd(48).slice(0, 48)), Buffer.from(token))) return send(403, { error: 'forbidden' });
    const fn = Object.hasOwn(run, cmd.action) && run[cmd.action];
    if (!fn) return send(400, { error: 'unknown action' });
    try {
      send(200, await fn(cmd));
    } catch (e) {
      send(500, { error: e.message });
    }
  });
  server.listen(0, '127.0.0.1', () => fs.writeFileSync(controlFile(), JSON.stringify({ port: server.address().port, token })));
}

app.on('will-quit', () => fs.rmSync(controlFile(), { force: true }));
app.on('window-all-closed', () => app.quit());
