// Xbox Live sign-in and data.
// Microsoft account (device code, so it works from the couch) -> Xbox user
// token -> XSTS token -> Xbox Live web APIs (profile, achievements, friends).
// Needs the user's own free Azure app registration ("client ID"); no secret.

const MSA = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'XboxLive.signin offline_access';

const form = (o) => new URLSearchParams(o);

async function postJson(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-xbl-contract-version': '1', ...headers }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${new URL(url).host} said ${r.status}${r.headers.get('x-err') ? ' (' + r.headers.get('x-err') + ')' : ''}`);
  return r.json();
}

async function msaToken(params) {
  const r = await fetch(`${MSA}/token`, { method: 'POST', body: form(params) });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error_description?.split('\r\n')[0] ?? j.error), { code: j.error });
  return j;
}

/** Start the device-code sign-in. Returns { code, url, expiresIn, wait() -> msa tokens }. */
export async function startSignIn(clientId, signal) {
  const r = await fetch(`${MSA}/devicecode`, { method: 'POST', body: form({ client_id: clientId, scope: SCOPE }) });
  const d = await r.json();
  if (d.error) throw new Error(friendly(d.error_description ?? d.error));
  return {
    code: d.user_code,
    url: d.verification_uri,
    expiresIn: d.expires_in,
    async wait() {
      let interval = (d.interval ?? 5) * 1000;
      const deadline = Date.now() + d.expires_in * 1000;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, interval));
        if (signal?.aborted) throw new Error('Cancelled');
        try {
          return await msaToken({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: d.device_code });
        } catch (e) {
          if (e.code === 'authorization_pending') continue;
          if (e.code === 'slow_down') {
            interval += 5000;
            continue;
          }
          throw new Error(friendly(e.message));
        }
      }
      throw new Error('The code expired. Try again.');
    },
  };
}

function friendly(msg) {
  if (/AADSTS700038|AADSTS700016|not a valid application|was not found in the directory/i.test(msg)) return 'That client ID isn’t a valid app registration. Copy the “Application (client) ID” from Azure.';
  if (/AADSTS7000218|AADSTS70002(?!\d)|public client|marked as 'mobile'/i.test(msg)) return 'One setting is off. In Azure, open your app → Authentication (in the left menu) → scroll to “Advanced settings” → set “Allow public client flows” to Yes → Save. Then try the QR code again.';
  if (/AADSTS70000|consumers|account type/i.test(msg)) return 'The app must allow personal Microsoft accounts. Recreate it with “Personal Microsoft accounts only”.';
  if (/declined|denied/i.test(msg)) return 'Sign-in was declined.';
  return msg;
}

/** Exchange a refresh token for a fresh Microsoft access token. */
export const refresh = (clientId, refreshToken) => msaToken({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, scope: SCOPE });

/** Microsoft access token -> Xbox Live session { auth, xuid, gamertag, expires }. */
export async function xboxSession(msaAccessToken) {
  const user = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + msaAccessToken },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  let xsts;
  try {
    xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [user.Token] },
      RelyingParty: 'http://xboxlive.com',
      TokenType: 'JWT',
    });
  } catch (e) {
    if (/401/.test(e.message)) throw new Error('This Microsoft account has no Xbox profile yet (or is a child account). Sign in once at xbox.com to create one.');
    throw e;
  }
  const xui = xsts.DisplayClaims?.xui?.[0] ?? {};
  return { auth: `XBL3.0 x=${xui.uhs};${xsts.Token}`, xuid: xui.xid, gamertag: xui.gtg, expires: Date.parse(xsts.NotAfter) || Date.now() + 12 * 3600e3 };
}

async function get(session, url, version = '2') {
  const r = await fetch(url, { headers: { authorization: session.auth, 'x-xbl-contract-version': version, 'accept-language': 'en-US', accept: 'application/json' } });
  if (!r.ok) throw new Error(`${new URL(url).host} said ${r.status}`);
  return r.json();
}

// Xbox hands out http:// image links; the app only loads https images, and the
// same hosts serve https, so upgrade them.
const secure = (u) => (u ? u.replace(/^http:\/\//i, 'https://') : null);

export async function profile(session) {
  const j = await get(session, `https://profile.xboxlive.com/users/xuid(${session.xuid})/profile/settings?settings=Gamertag,GameDisplayPicRaw,Gamerscore,AccountTier`);
  const s = Object.fromEntries((j.profileUsers?.[0]?.settings ?? []).map((x) => [x.id, x.value]));
  return { xuid: session.xuid, gamertag: s.Gamertag ?? session.gamertag, picture: secure(s.GameDisplayPicRaw), gamerscore: Number(s.Gamerscore ?? 0), tier: s.AccountTier ?? '' };
}

/** Recently played titles with achievement progress. */
export async function titles(session) {
  const j = await get(session, `https://titlehub.xboxlive.com/users/xuid(${session.xuid})/titles/titlehistory/decoration/achievement,image`);
  return (j.titles ?? []).map((t) => ({
    titleId: t.titleId,
    name: t.name,
    image: secure(t.displayImage),
    lastPlayed: Date.parse(t.titleHistory?.lastTimePlayed ?? '') || null,
    achievements: t.achievement
      ? { earned: t.achievement.currentAchievements, total: t.achievement.totalAchievements, score: t.achievement.currentGamerscore, maxScore: t.achievement.totalGamerscore, percent: t.achievement.progressPercentage }
      : null,
  }));
}

/** Friends with what they're doing right now. */
export async function friends(session) {
  const j = await get(session, 'https://peoplehub.xboxlive.com/users/me/people/social/decoration/presencedetail', '3');
  return (j.people ?? [])
    .map((p) => ({ gamertag: p.gamertag ?? p.displayName, picture: secure(p.displayPicRaw), online: p.presenceState === 'Online', status: p.presenceText ?? (p.presenceState === 'Online' ? 'Online' : 'Offline') }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.gamertag.localeCompare(b.gamertag));
}
