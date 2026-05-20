import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  User, Lock, LogIn, UserPlus, LogOut, Trophy, Home as HomeIcon,
  Eye, Palette, Music, Type, Flag, Zap, X, ChevronLeft, Play,
  RotateCcw, ArrowRight, Check, AlertCircle, Volume2, Sparkles,
  Loader2, Crown, Settings, Database, Copy, ExternalLink,
  ServerCrash, Wifi, Globe
} from 'lucide-react';

/* ============================================================
   UTILITIES
   ============================================================ */

const clamp = (n, mn, mx) => Math.max(mn, Math.min(mx, n));
const rand = (mn, mx) => Math.random() * (mx - mn) + mn;
const randInt = (mn, mx) => Math.floor(rand(mn, mx + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

async function safeGet(key) {
  try {
    const r = await window.storage.get(key);
    return r ? r.value : null;
  } catch { return null; }
}

/* ============================================================
   SUPABASE CLIENT (hand-rolled REST wrapper — no external deps)
   ============================================================ */

const FAKE_DOMAIN = 'neonarc.local';

function makeSupa(url, anonKey) {
  const headers = (token) => ({
    'apikey': anonKey,
    'Authorization': `Bearer ${token || anonKey}`,
    'Content-Type': 'application/json'
  });

  const api = {
    url, anonKey,

    async signUp(username, password) {
      const email = `${username.toLowerCase()}@${FAKE_DOMAIN}`;
      // Pre-check username availability (avoids orphaned auth.user if profile insert fails)
      const check = await fetch(
        `${url}/rest/v1/profiles?username=eq.${encodeURIComponent(username)}&select=id`,
        { headers: headers() }
      );
      if (!check.ok) throw new Error(`DB unreachable (${check.status})`);
      const checkBody = await check.json();
      if (checkBody.length > 0) throw new Error('Username taken');

      const r = await fetch(`${url}/auth/v1/signup`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          email, password,
          data: { username } // -> raw_user_meta_data, used by the trigger
        })
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.msg || body.error_description || body.error || 'Signup failed');
      // If email confirmation is on, session won't be present
      if (!body.access_token) {
        throw new Error('Email confirmation is enabled in this Supabase project. Disable it in Auth → Providers → Email.');
      }
      return body;
    },

    async signIn(username, password) {
      const email = `${username.toLowerCase()}@${FAKE_DOMAIN}`;
      const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ email, password })
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error_description || body.msg || 'Invalid credentials');
      return body;
    },

    async refresh(refreshToken) {
      const r = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ refresh_token: refreshToken })
      });
      if (!r.ok) throw new Error('Refresh failed');
      return await r.json();
    },

    async signOut(token) {
      try {
        await fetch(`${url}/auth/v1/logout`, {
          method: 'POST', headers: headers(token)
        });
      } catch {}
    },

    async getProfile(userId, token) {
      const r = await fetch(`${url}/rest/v1/profiles?id=eq.${userId}&select=*`,
        { headers: headers(token) });
      if (!r.ok) return null;
      const body = await r.json();
      return body[0] || null;
    },

    async getMyScores(userId, token) {
      const r = await fetch(`${url}/rest/v1/scores?user_id=eq.${userId}&select=*`,
        { headers: headers(token) });
      if (!r.ok) return {};
      const body = await r.json();
      const map = {};
      for (const s of body) map[s.game] = s;
      return map;
    },

    async upsertScore(userId, game, score, higherIsBetter, token) {
      // Need to read existing, decide if it's a new best, and write the row.
      const existing = await fetch(
        `${url}/rest/v1/scores?user_id=eq.${userId}&game=eq.${game}&select=*`,
        { headers: headers(token) }
      );
      let prev = null;
      if (existing.ok) {
        const b = await existing.json();
        prev = b[0] || null;
      }
      const best = prev
        ? (higherIsBetter ? Math.max(prev.best, score) : Math.min(prev.best, score))
        : score;
      const row = {
        user_id: userId, game, best, last: score,
        plays: (prev?.plays || 0) + 1,
        higher_is_better: higherIsBetter,
        updated_at: new Date().toISOString()
      };
      const r = await fetch(`${url}/rest/v1/scores`, {
        method: 'POST',
        headers: {
          ...headers(token),
          'Prefer': 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(row)
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Score save failed: ${t}`);
      }
      const body = await r.json();
      return body[0] || row;
    },

    async leaderboard(game, higherIsBetter, limit = 25) {
      const order = higherIsBetter ? 'best.desc,plays.desc' : 'best.asc,plays.desc';
      // 1) Top scores for this game (public read via RLS).
      const r = await fetch(
        `${url}/rest/v1/scores?game=eq.${game}&order=${order}&limit=${limit}&select=best,plays,user_id`,
        { headers: headers() }
      );
      if (!r.ok) {
        console.error('leaderboard scores fetch failed', r.status, await r.text());
        return [];
      }
      const rows = await r.json();
      if (!rows.length) return [];

      // 2) Resolve usernames in a second query, then stitch together.
      // (scores and profiles both FK to auth.users, so there's no direct
      // relationship for PostgREST to embed — we join manually instead.)
      const ids = [...new Set(rows.map(x => x.user_id))];
      const inList = ids.join(',');
      let nameMap = {};
      const pr = await fetch(
        `${url}/rest/v1/profiles?id=in.(${inList})&select=id,username`,
        { headers: headers() }
      );
      if (pr.ok) {
        const profs = await pr.json();
        for (const p of profs) nameMap[p.id] = p.username;
      } else {
        console.error('leaderboard profiles fetch failed', pr.status);
      }
      return rows.map(x => ({ ...x, profiles: { username: nameMap[x.user_id] || '???' } }));
    }
  };
  return api;
}

/* ============================================================
   SESSION (persisted in window.storage)
   ============================================================ */

const SESSION_KEY = 'arc:session';
const CONFIG_KEY = 'arc:config';

async function loadConfig() {
  const raw = await safeGet(CONFIG_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function saveConfig(c) {
  await window.storage.set(CONFIG_KEY, JSON.stringify(c));
}
async function clearConfig() {
  try { await window.storage.delete(CONFIG_KEY); } catch {}
}

async function loadSession() {
  const raw = await safeGet(SESSION_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function saveSession(s) { await window.storage.set(SESSION_KEY, JSON.stringify(s)); }
async function clearSession() { try { await window.storage.delete(SESSION_KEY); } catch {} }

/* ============================================================
   AUDIO (Web Audio API)
   ============================================================ */

let _ctx = null;
function ctx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (_ctx.state === 'suspended') _ctx.resume();
  return _ctx;
}
function tone(freq, dur = 0.1, type = 'sine', gain = 0.08, when = 0) {
  const c = ctx();
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type; o.frequency.value = freq;
  const t0 = c.currentTime + when;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(c.destination);
  o.start(t0); o.stop(t0 + dur);
}
const sfx = {
  click: () => tone(720, 0.04, 'square', 0.03),
  hover: () => tone(520, 0.025, 'sine', 0.018),
  pick:  () => { tone(660, 0.05, 'triangle', 0.05); tone(990, 0.08, 'triangle', 0.04, 0.04); },
  good:  () => { tone(523, 0.09, 'triangle', 0.08); tone(659, 0.09, 'triangle', 0.08, 0.07); tone(784, 0.18, 'triangle', 0.08, 0.14); },
  bad:   () => { tone(220, 0.12, 'sawtooth', 0.05); tone(140, 0.24, 'sawtooth', 0.05, 0.1); },
  win:   () => { tone(523, 0.1, 'triangle', 0.1); tone(659, 0.1, 'triangle', 0.1, 0.1); tone(784, 0.1, 'triangle', 0.1, 0.2); tone(1047, 0.35, 'triangle', 0.1, 0.3); },
  tick:  () => tone(900, 0.025, 'square', 0.02),
  warn:  () => tone(300, 0.05, 'square', 0.04)
};
function makeSustainedTone(initialFreq) {
  const c = ctx();
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'sine'; o.frequency.value = initialFreq; g.gain.value = 0;
  o.connect(g); g.connect(c.destination);
  o.start();
  return {
    setFreq: (f) => { o.frequency.setTargetAtTime(f, c.currentTime, 0.02); },
    on: () => { g.gain.cancelScheduledValues(c.currentTime); g.gain.linearRampToValueAtTime(0.1, c.currentTime + 0.02); },
    off: () => { g.gain.cancelScheduledValues(c.currentTime); g.gain.linearRampToValueAtTime(0, c.currentTime + 0.05); },
    destroy: () => { try { g.gain.linearRampToValueAtTime(0, c.currentTime + 0.05); o.stop(c.currentTime + 0.1); } catch {} }
  };
}

/* ============================================================
   THEME
   ============================================================ */

const C = {
  bg: '#0a0a0a', bg2: '#121212', bg3: '#1a1a1a',
  border: '#2a2a2a', borderLight: '#3a3a3a',
  text: '#f5f5f0', textDim: '#888', textDimmer: '#555',
  lime: '#c4f000', limeDim: '#7a9500',
  pink: '#ff2e93', cyan: '#00e0ff', amber: '#ffb800'
};
const FONT_DISPLAY = `'Bricolage Grotesque', system-ui, sans-serif`;
const FONT_MONO = `'JetBrains Mono', ui-monospace, 'Cascadia Code', monospace`;

/* ============================================================
   GAME REGISTRY
   ============================================================ */

const GAMES = [
  { id: 'colorhunt', name: 'COLOR HUNT', tag: 'PERCEPTION', icon: Eye, accent: C.lime,
    desc: 'Spot the odd tile in a grid of nearly-identical colors. Grid grows. Difference shrinks. 60 seconds.' },
  { id: 'recall',    name: 'CHROMATIC RECALL', tag: 'MEMORY', icon: Palette, accent: C.pink,
    desc: 'Stare at a color. It vanishes. Recreate it from memory with three sliders. Five rounds.' },
  { id: 'pitch',     name: 'PITCH PERFECT', tag: 'AUDIO', icon: Music, accent: C.cyan,
    desc: 'Listen to a frequency. Slide to match it. Your ears against pure sine waves. Five rounds.' },
  { id: 'wordlet',   name: 'WORDLET', tag: 'WORDS', icon: Type, accent: C.amber,
    desc: 'Five letters. Six guesses. Green if right, amber if close, black if not. You know how this works.' },
  { id: 'flag',      name: 'FLAG MASTER', tag: 'KNOWLEDGE', icon: Flag, accent: C.lime,
    desc: 'A flag flashes up. Four countries to choose from. Get ten right. Or don\'t.' },
  { id: 'reflex',    name: 'REFLEX', tag: 'SPEED', icon: Zap, accent: C.pink,
    desc: 'Wait for green. Click. Your reaction time in milliseconds. Average over five rounds — lower is better.' }
];

const HIGHER_BETTER = { colorhunt: true, recall: true, pitch: true, wordlet: true, flag: true, reflex: false };

const fmtScore = (game, v) => {
  if (v == null) return '—';
  if (game === 'reflex') return `${Math.round(v)}ms`;
  if (game === 'pitch' || game === 'recall') return `${v}%`;
  return v;
};

/* ============================================================
   SETUP SQL (shown on Setup screen)
   ============================================================ */

const SETUP_SQL = `-- NEON.ARC schema --
-- Run this in Supabase SQL Editor (project root)

-- 1. PROFILES (one per auth.user)
create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null check (char_length(username) between 3 and 24),
  created_at timestamptz default now()
);

alter table profiles enable row level security;

drop policy if exists "profiles read all" on profiles;
create policy "profiles read all"
  on profiles for select using (true);

drop policy if exists "profiles insert own" on profiles;
create policy "profiles insert own"
  on profiles for insert with check (auth.uid() = id);

drop policy if exists "profiles update own" on profiles;
create policy "profiles update own"
  on profiles for update using (auth.uid() = id);

-- 2. SCORES (one row per user per game; upserted on each play)
create table if not exists scores (
  user_id uuid not null references auth.users on delete cascade,
  game text not null,
  best numeric not null,
  last numeric not null,
  plays integer not null default 0,
  higher_is_better boolean not null default true,
  updated_at timestamptz default now(),
  primary key (user_id, game)
);

alter table scores enable row level security;

drop policy if exists "scores read all" on scores;
create policy "scores read all"
  on scores for select using (true);

drop policy if exists "scores insert own" on scores;
create policy "scores insert own"
  on scores for insert with check (auth.uid() = user_id);

drop policy if exists "scores update own" on scores;
create policy "scores update own"
  on scores for update using (auth.uid() = user_id);

-- 3. TRIGGER: auto-create profile when an auth.user signs up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data->>'username');
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
`;

/* ============================================================
   APP ROOT
   ============================================================ */

export default function App() {
  const [booted, setBooted] = useState(false);
  const [config, setConfig] = useState(null);
  const [supa, setSupa] = useState(null);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [scores, setScores] = useState({});
  const [route, setRoute] = useState('home');
  const [showSettings, setShowSettings] = useState(false);

  // Boot: load config + session
  useEffect(() => {
    (async () => {
      // Prefer build-time env vars (set in Vercel dashboard or .env.local).
      // Falls back to the setup screen / window.storage config for local-only mode.
      const envUrl = import.meta.env?.VITE_SUPABASE_URL;
      const envKey = import.meta.env?.VITE_SUPABASE_ANON_KEY;
      const cfg = (envUrl && envKey)
        ? { url: envUrl, anonKey: envKey, fromEnv: true }
        : await loadConfig();
      if (cfg) {
        const s = makeSupa(cfg.url, cfg.anonKey);
        setSupa(s); setConfig(cfg);
        const sess = await loadSession();
        if (sess && sess.access_token && sess.user) {
          // Try a profile fetch to validate token; if it fails, attempt refresh.
          let prof = null;
          try { prof = await s.getProfile(sess.user.id, sess.access_token); }
          catch { prof = null; }
          if (!prof && sess.refresh_token) {
            try {
              const refreshed = await s.refresh(sess.refresh_token);
              const merged = { ...sess, ...refreshed };
              await saveSession(merged);
              setSession(merged);
              prof = await s.getProfile(merged.user.id, merged.access_token);
            } catch { await clearSession(); }
          } else if (prof) {
            setSession(sess);
          }
          if (prof) {
            setProfile(prof);
            const sc = await s.getMyScores(sess.user.id, sess.access_token);
            setScores(sc);
          }
        }
      }
      setBooted(true);
    })();
  }, []);

  const onConfigured = (cfg) => {
    saveConfig(cfg);
    setConfig(cfg);
    setSupa(makeSupa(cfg.url, cfg.anonKey));
  };

  const onLogin = async (sess) => {
    await saveSession(sess);
    setSession(sess);
    const prof = await supa.getProfile(sess.user.id, sess.access_token);
    setProfile(prof);
    const sc = await supa.getMyScores(sess.user.id, sess.access_token);
    setScores(sc);
    setRoute('home');
  };

  const onLogout = async () => {
    if (supa && session) await supa.signOut(session.access_token);
    await clearSession();
    setSession(null); setProfile(null); setScores({});
    setRoute('home');
  };

  const handleScore = async (game, score) => {
    if (!supa || !session) return;
    try {
      const row = await supa.upsertScore(session.user.id, game, score, HIGHER_BETTER[game], session.access_token);
      setScores(s => ({ ...s, [game]: row }));
    } catch (e) {
      // Token may be stale — try refresh once
      if (session.refresh_token) {
        try {
          const r = await supa.refresh(session.refresh_token);
          const merged = { ...session, ...r };
          await saveSession(merged); setSession(merged);
          const row = await supa.upsertScore(merged.user.id, game, score, HIGHER_BETTER[game], merged.access_token);
          setScores(s => ({ ...s, [game]: row }));
        } catch (e2) { console.error('score save failed', e2); }
      } else { console.error('score save failed', e); }
    }
  };

  return (
    <>
      <GlobalStyle />
      <Background />
      <div style={{ position:'relative', minHeight:'100vh', color: C.text, fontFamily: FONT_MONO, zIndex: 1 }}>
        {!booted ? (
          <BootScreen />
        ) : !config ? (
          <SetupScreen onDone={onConfigured} />
        ) : !session || !profile ? (
          <AuthScreen supa={supa} onLogin={onLogin}
            showConfigUI={!config.fromEnv}
            onOpenSettings={() => setShowSettings(true)} />
        ) : route === 'leaderboard' ? (
          <Leaderboard supa={supa} profile={profile} onExit={() => setRoute('home')} />
        ) : route === 'home' ? (
          <HomeScreen
            profile={profile} scores={scores}
            onSelect={setRoute} onLogout={onLogout}
            onLeaderboard={() => setRoute('leaderboard')}
            showConfigUI={!config.fromEnv}
            onSettings={() => setShowSettings(true)}
          />
        ) : (
          <GameRouter route={route} scores={scores} onExit={() => setRoute('home')} onScore={handleScore} />
        )}

        {showSettings && !config.fromEnv && (
          <SettingsModal
            config={config}
            onClose={() => setShowSettings(false)}
            onReset={async () => { await clearConfig(); await clearSession(); window.location.reload(); }}
          />
        )}
      </div>
    </>
  );
}

/* ============================================================
   GLOBAL STYLES
   ============================================================ */

function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700;12..96,800&family=JetBrains+Mono:wght@300;400;500;700&display=swap');

      * { box-sizing: border-box; }
      html, body, #root { background: ${C.bg}; }
      body { margin: 0; }

      ::selection { background: ${C.lime}; color: ${C.bg}; }

      .scanlines::before {
        content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 2;
        background: repeating-linear-gradient(0deg,
          rgba(255,255,255,0.012) 0px, rgba(255,255,255,0.012) 1px,
          transparent 1px, transparent 3px);
      }
      .grain::after {
        content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 3; opacity: 0.6;
        background-image: url("data:image/svg+xml;utf8,<svg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='0.25'/></svg>");
        mix-blend-mode: overlay;
      }

      @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
      .blink { animation: blink 1s steps(2) infinite; }

      @keyframes slide-up {
        from { transform: translateY(8px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      .slide-up { animation: slide-up 0.4s cubic-bezier(.2,.7,.2,1) both; }

      @keyframes shake {
        0%,100% { transform: translateX(0); } 20% { transform: translateX(-6px); }
        40% { transform: translateX(6px); } 60% { transform: translateX(-3px); } 80% { transform: translateX(3px); }
      }
      .shake { animation: shake 0.4s; }

      @keyframes flip-in {
        0% { transform: rotateX(-90deg); } 100% { transform: rotateX(0); }
      }
      .flip-in { animation: flip-in 0.35s cubic-bezier(.2,.7,.2,1) both; }

      input, button, textarea { font-family: inherit; }
      button:active { transform: translateY(1px); }

      ::-webkit-scrollbar { width: 10px; height: 10px; }
      ::-webkit-scrollbar-track { background: ${C.bg}; }
      ::-webkit-scrollbar-thumb { background: ${C.border}; }
      ::-webkit-scrollbar-thumb:hover { background: ${C.borderLight}; }

      input[type=range].arc-slider {
        appearance: none; -webkit-appearance: none;
        height: 6px; background: ${C.bg3}; border: 1px solid ${C.border};
        outline: none; width: 100%; cursor: pointer;
      }
      input[type=range].arc-slider::-webkit-slider-thumb {
        appearance: none; -webkit-appearance: none;
        width: 22px; height: 22px; background: ${C.text};
        border: 2px solid ${C.bg}; cursor: grab; box-shadow: 0 0 0 1px ${C.text};
      }
      input[type=range].arc-slider::-moz-range-thumb {
        width: 22px; height: 22px; background: ${C.text};
        border: 2px solid ${C.bg}; cursor: grab; border-radius: 0; box-shadow: 0 0 0 1px ${C.text};
      }
    `}</style>
  );
}

function Background() {
  return (
    <>
      <div style={{
        position:'fixed', inset:0, zIndex:0, background:`
          radial-gradient(ellipse at 20% 0%, ${C.pink}11, transparent 50%),
          radial-gradient(ellipse at 80% 100%, ${C.cyan}10, transparent 50%),
          radial-gradient(ellipse at 50% 50%, ${C.lime}08, transparent 70%),
          ${C.bg}`
      }}/>
      <div className="scanlines"/>
      <div className="grain"/>
    </>
  );
}

function BootScreen() {
  return (
    <div style={{ minHeight:'100vh', display:'grid', placeItems:'center', fontFamily:FONT_MONO, color:C.lime }}>
      <div style={{ fontSize:12, letterSpacing:2 }}>
        CONNECTING<span className="blink">_</span>
      </div>
    </div>
  );
}

/* ============================================================
   PRIMITIVES
   ============================================================ */

function Btn({ children, onClick, kind='primary', icon:Icon, disabled, full, type='button' }) {
  const base = {
    display:'inline-flex', alignItems:'center', justifyContent:'center', gap:8,
    padding:'12px 18px', fontFamily:FONT_MONO, fontSize:12, letterSpacing:1.5,
    textTransform:'uppercase', cursor: disabled ? 'not-allowed' : 'pointer',
    border:`1px solid`, transition:'transform 60ms, background 120ms, color 120ms',
    opacity: disabled ? 0.4 : 1, width: full ? '100%' : 'auto', fontWeight:600
  };
  const styles = {
    primary: { ...base, background: C.lime, color: C.bg, borderColor: C.lime },
    ghost:   { ...base, background: 'transparent', color: C.text, borderColor: C.border },
    danger:  { ...base, background: 'transparent', color: C.pink, borderColor: C.pink },
    cyan:    { ...base, background: C.cyan, color: C.bg, borderColor: C.cyan }
  };
  return (
    <button type={type} disabled={disabled} style={styles[kind]}
      onMouseEnter={() => !disabled && sfx.hover()}
      onClick={() => { if (!disabled) { sfx.click(); onClick && onClick(); } }}>
      {Icon && <Icon size={14} strokeWidth={2.5}/>}
      {children}
    </button>
  );
}

function Tag({ children, color = C.lime }) {
  return (
    <span style={{
      display:'inline-block', padding:'3px 7px', fontSize:10, letterSpacing:1.5,
      border:`1px solid ${color}`, color, fontFamily:FONT_MONO, fontWeight:500
    }}>{children}</span>
  );
}

function Field({ label, icon:Icon, ...inputProps }) {
  return (
    <label style={{ display:'block' }}>
      <div style={{ fontSize:10, letterSpacing:2, color:C.textDim, marginBottom:6, display:'flex', alignItems:'center', gap:6 }}>
        {Icon && <Icon size={11}/>} {label}
      </div>
      <input
        {...inputProps}
        style={{
          width:'100%', background:C.bg2, border:`1px solid ${C.border}`,
          color: C.text, padding:'12px 14px', fontFamily:FONT_MONO, fontSize:14,
          outline:'none', transition:'border-color 120ms'
        }}
        onFocus={(e) => e.target.style.borderColor = C.lime}
        onBlur={(e) => e.target.style.borderColor = C.border}
      />
    </label>
  );
}

/* ============================================================
   SETUP SCREEN (first run — configure Supabase)
   ============================================================ */

function SetupScreen({ onDone }) {
  const [step, setStep] = useState(1); // 1 instructions, 2 sql, 3 keys
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async (txt) => {
    try {
      await navigator.clipboard.writeText(txt);
      setCopied(true); sfx.pick();
      setTimeout(() => setCopied(false), 1400);
    } catch {}
  };

  const finish = async () => {
    setErr(''); setBusy(true);
    try {
      const cleanUrl = url.trim().replace(/\/+$/, '');
      if (!/^https:\/\/[^.]+\.supabase\.co$/.test(cleanUrl)) {
        throw new Error('URL should look like https://xxxxx.supabase.co');
      }
      if (!key.trim() || key.trim().length < 40) {
        throw new Error('anon key looks too short');
      }
      // Validate by pinging the profiles table (read should be public per RLS).
      const probe = await fetch(`${cleanUrl}/rest/v1/profiles?select=id&limit=1`, {
        headers: { apikey: key.trim(), Authorization: `Bearer ${key.trim()}` }
      });
      if (!probe.ok) {
        const txt = await probe.text();
        throw new Error(`Couldn't reach the profiles table (HTTP ${probe.status}). Did the SQL run? ${txt.slice(0,120)}`);
      }
      sfx.good();
      onDone({ url: cleanUrl, anonKey: key.trim() });
    } catch (e) {
      sfx.bad();
      setErr(e.message);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ minHeight:'100vh', padding:'40px 24px', display:'grid', placeItems:'start center' }}>
      <div style={{ width:'100%', maxWidth: 760 }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:32 }}>
          <div style={{ width:38, height:38, background:C.lime, display:'grid', placeItems:'center' }}>
            <Database size={20} color={C.bg} strokeWidth={3}/>
          </div>
          <div>
            <div style={{ fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:26, letterSpacing:-1, lineHeight:1 }}>
              NEON<span style={{ color:C.lime }}>.ARC</span> SETUP
            </div>
            <div style={{ fontSize:11, color:C.textDim, letterSpacing:1.5, marginTop:4 }}>
              ONE-TIME · ~3 MINUTES · NO BACKEND DEPLOY
            </div>
          </div>
        </div>

        {/* Stepper */}
        <div style={{ display:'flex', gap:0, marginBottom:28, border:`1px solid ${C.border}` }}>
          {[
            [1, 'CREATE PROJECT'],
            [2, 'RUN SCHEMA SQL'],
            [3, 'PASTE CREDENTIALS']
          ].map(([n, lbl]) => (
            <button key={n} onClick={() => { sfx.click(); setStep(n); }}
              style={{
                flex:1, padding:'14px 10px', background: step === n ? C.text : 'transparent',
                color: step === n ? C.bg : C.textDim, border:'none',
                fontFamily:FONT_MONO, fontSize:11, letterSpacing:1.5, cursor:'pointer',
                borderRight: n < 3 ? `1px solid ${C.border}` : 'none', fontWeight:600
              }}>
              {String(n).padStart(2,'0')} · {lbl}
            </button>
          ))}
        </div>

        {/* Step 1 */}
        {step === 1 && (
          <div className="slide-up" style={{ background:C.bg2, border:`1px solid ${C.border}`, padding:28 }}>
            <h2 style={{ fontFamily:FONT_DISPLAY, fontSize:28, fontWeight:800, letterSpacing:-1, margin:'0 0 18px' }}>
              CREATE A SUPABASE PROJECT
            </h2>
            <ol style={{ paddingLeft:0, listStyle:'none', display:'flex', flexDirection:'column', gap:14 }}>
              {[
                <>Sign up at <a href="https://supabase.com" target="_blank" rel="noreferrer" style={{ color:C.lime }}>supabase.com</a> (free tier is plenty).</>,
                <>Click <b style={{ color:C.text }}>New project</b>. Pick a name, generate a strong DB password, choose a region near you.</>,
                <>Wait ~1 minute while it provisions.</>,
                <>While that's happening: go to <b style={{ color:C.text }}>Authentication → Providers → Email</b> and turn <b style={{ color:C.pink }}>OFF</b> "Confirm email". (We use usernames, not real emails.)</>
              ].map((it, i) => (
                <li key={i} style={{ display:'flex', gap:14, color:C.textDim, fontSize:13, lineHeight:1.6 }}>
                  <span style={{ color:C.lime, fontFamily:FONT_MONO, fontWeight:700, minWidth:24 }}>{String(i+1).padStart(2,'0')}</span>
                  <span>{it}</span>
                </li>
              ))}
            </ol>
            <div style={{ marginTop:28, display:'flex', gap:10, justifyContent:'space-between', alignItems:'center' }}>
              <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer"
                 style={{ color:C.cyan, fontSize:11, letterSpacing:2, display:'inline-flex', alignItems:'center', gap:6, textDecoration:'none' }}
                 onClick={sfx.click}>
                OPEN SUPABASE <ExternalLink size={12}/>
              </a>
              <Btn icon={ArrowRight} onClick={() => setStep(2)}>RAN THAT — NEXT</Btn>
            </div>
          </div>
        )}

        {/* Step 2 */}
        {step === 2 && (
          <div className="slide-up" style={{ background:C.bg2, border:`1px solid ${C.border}`, padding:28 }}>
            <h2 style={{ fontFamily:FONT_DISPLAY, fontSize:28, fontWeight:800, letterSpacing:-1, margin:'0 0 8px' }}>
              RUN THE SCHEMA
            </h2>
            <p style={{ color:C.textDim, fontSize:13, lineHeight:1.6, margin:'0 0 18px' }}>
              In your project, open <b style={{ color:C.text }}>SQL Editor → New query</b>, paste this, hit <b style={{ color:C.text }}>Run</b>.
              Creates two tables, RLS policies, and a trigger that auto-creates profiles on signup.
            </p>
            <div style={{ position:'relative', border:`1px solid ${C.border}`, background:C.bg }}>
              <pre style={{
                margin:0, padding:'18px 18px 18px 18px', fontFamily:FONT_MONO, fontSize:11,
                color:C.text, maxHeight:340, overflow:'auto', lineHeight:1.55
              }}>{SETUP_SQL}</pre>
              <button onClick={() => copy(SETUP_SQL)} onMouseEnter={sfx.hover}
                style={{
                  position:'absolute', top:8, right:8,
                  background: copied ? C.lime : C.bg2, color: copied ? C.bg : C.text,
                  border:`1px solid ${copied ? C.lime : C.border}`, padding:'6px 10px',
                  fontFamily:FONT_MONO, fontSize:10, letterSpacing:1.5, cursor:'pointer',
                  display:'inline-flex', alignItems:'center', gap:6, fontWeight:600
                }}>
                {copied ? <><Check size={11}/> COPIED</> : <><Copy size={11}/> COPY</>}
              </button>
            </div>
            <div style={{ marginTop:24, display:'flex', gap:10, justifyContent:'space-between' }}>
              <Btn kind="ghost" icon={ChevronLeft} onClick={() => setStep(1)}>BACK</Btn>
              <Btn icon={ArrowRight} onClick={() => setStep(3)}>RAN IT — NEXT</Btn>
            </div>
          </div>
        )}

        {/* Step 3 */}
        {step === 3 && (
          <div className="slide-up" style={{ background:C.bg2, border:`1px solid ${C.border}`, padding:28 }}>
            <h2 style={{ fontFamily:FONT_DISPLAY, fontSize:28, fontWeight:800, letterSpacing:-1, margin:'0 0 8px' }}>
              PASTE YOUR KEYS
            </h2>
            <p style={{ color:C.textDim, fontSize:13, lineHeight:1.6, margin:'0 0 22px' }}>
              In your project sidebar: <b style={{ color:C.text }}>Project Settings → API</b>. You want the
              <b style={{ color:C.text }}> Project URL</b> and the <b style={{ color:C.text }}>anon public</b> key
              (NOT the service_role — that one is secret and stays on your server).
            </p>

            <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
              <Field label="PROJECT URL" icon={Globe}
                placeholder="https://xxxxxxxx.supabase.co"
                value={url} onChange={e => setUrl(e.target.value)}/>
              <Field label="ANON PUBLIC KEY" icon={Lock}
                placeholder="eyJhbGc..."
                value={key} onChange={e => setKey(e.target.value)}/>
            </div>

            {err && (
              <div className="shake" style={{
                marginTop:18, padding:'10px 12px', border:`1px solid ${C.pink}`, color:C.pink,
                fontSize:11, letterSpacing:1, display:'flex', alignItems:'center', gap:8
              }}>
                <AlertCircle size={14}/> {err.toUpperCase()}
              </div>
            )}

            <div style={{ marginTop:24, display:'flex', gap:10, justifyContent:'space-between' }}>
              <Btn kind="ghost" icon={ChevronLeft} onClick={() => setStep(2)}>BACK</Btn>
              <Btn icon={busy ? Loader2 : Check} onClick={finish} disabled={busy}>
                {busy ? 'TESTING...' : 'CONNECT'}
              </Btn>
            </div>

            <div style={{ marginTop:24, paddingTop:18, borderTop:`1px solid ${C.border}`, fontSize:10, color:C.textDimmer, lineHeight:1.7 }}>
              The anon key is designed to be public — it only lets through what your RLS policies allow.
              Both values stay in this browser's local storage; you can change them anytime via Settings.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   SETTINGS MODAL
   ============================================================ */

function SettingsModal({ config, onClose, onReset }) {
  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:10,
      display:'grid', placeItems:'center', padding:20
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background:C.bg2, border:`1px solid ${C.border}`, width:'100%', maxWidth:520 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'18px 20px', borderBottom:`1px solid ${C.border}` }}>
          <div style={{ fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:18, letterSpacing:-0.5 }}>SETTINGS</div>
          <button onClick={() => { sfx.click(); onClose(); }} style={{ background:'none', border:'none', color:C.text, cursor:'pointer' }}>
            <X size={20}/>
          </button>
        </div>
        <div style={{ padding:'20px' }}>
          <div style={{ fontSize:10, letterSpacing:2, color:C.textDim, marginBottom:6 }}>SUPABASE URL</div>
          <div style={{ fontFamily:FONT_MONO, fontSize:12, padding:'10px 12px', background:C.bg, border:`1px solid ${C.border}`, marginBottom:16, wordBreak:'break-all' }}>
            {config?.url}
          </div>
          <div style={{ fontSize:10, letterSpacing:2, color:C.textDim, marginBottom:6 }}>ANON KEY</div>
          <div style={{ fontFamily:FONT_MONO, fontSize:12, padding:'10px 12px', background:C.bg, border:`1px solid ${C.border}`, marginBottom:20, wordBreak:'break-all' }}>
            {config?.anonKey?.slice(0, 24)}…{config?.anonKey?.slice(-8)}
          </div>
          <div style={{ fontSize:11, color:C.textDim, lineHeight:1.6, marginBottom:16 }}>
            Resetting wipes your local Supabase config and signs you out. Your data in Supabase is untouched.
          </div>
          <Btn kind="danger" icon={ServerCrash} onClick={onReset} full>
            RESET CONFIG & SIGN OUT
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   AUTH SCREEN
   ============================================================ */

function AuthScreen({ supa, onLogin, onOpenSettings, showConfigUI }) {
  const [mode, setMode] = useState('login');
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setErr(''); setBusy(true);
    try {
      const trimmed = u.trim();
      if (trimmed.length < 3) throw new Error('Username must be 3+ chars');
      if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) throw new Error('Letters / numbers / _ only');
      if (p.length < 6) throw new Error('Password must be 6+ chars (Supabase requirement)');

      const sess = mode === 'login'
        ? await supa.signIn(trimmed, p)
        : await supa.signUp(trimmed, p);
      sfx.good();
      onLogin(sess);
    } catch (e) {
      sfx.bad();
      setErr(e.message);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ minHeight:'100vh', display:'grid', placeItems:'center', padding:'24px' }}>
      <div style={{ width:'100%', maxWidth: 880, display:'grid', gridTemplateColumns:'1.1fr 1fr', gap:0, border:`1px solid ${C.border}` }}>

        <div style={{
          padding:'40px 36px', background:C.bg2, borderRight:`1px solid ${C.border}`,
          display:'flex', flexDirection:'column', justifyContent:'space-between', minHeight:520
        }}>
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:32 }}>
              <div style={{ width:34, height:34, background:C.lime, display:'grid', placeItems:'center' }}>
                <Sparkles size={18} color={C.bg} strokeWidth={3}/>
              </div>
              <div style={{ fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:24, letterSpacing:-1 }}>
                NEON<span style={{ color:C.lime }}>.ARC</span>
              </div>
            </div>
            <h1 style={{ fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:46, lineHeight:0.95, margin:'24px 0', letterSpacing:-2 }}>
              SIX&nbsp;TINY GAMES.<br/>
              <span style={{ color:C.lime }}>ONE</span> LEADERBOARD.
            </h1>
            <p style={{ color:C.textDim, fontSize:13, lineHeight:1.6, maxWidth: 340 }}>
              Perception. Memory. Reflex. Ears. Words. Flags. Sign in to put your best on the global board.
            </p>
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', borderTop:`1px solid ${C.border}`, paddingTop:18, marginTop:24, fontSize:10, color:C.textDimmer, letterSpacing:2 }}>
            <span><span className="blink" style={{ color:C.lime }}>●</span> &nbsp; LIVE &nbsp; / &nbsp; V2.0</span>
            {showConfigUI && (
              <button onClick={() => { sfx.click(); onOpenSettings(); }}
                onMouseEnter={sfx.hover}
                style={{ background:'none', border:'none', color:C.textDimmer, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:5 }}>
                <Settings size={12}/> CONFIG
              </button>
            )}
          </div>
        </div>

        <div style={{ padding:'40px 36px', background:C.bg }}>
          <div style={{ display:'flex', gap:0, marginBottom:28, border:`1px solid ${C.border}` }}>
            {['login','signup'].map(m => (
              <button key={m}
                onClick={() => { sfx.click(); setMode(m); setErr(''); }}
                onMouseEnter={sfx.hover}
                style={{
                  flex:1, padding:'11px', fontFamily:FONT_MONO, fontSize:11, letterSpacing:2,
                  background: mode === m ? C.text : 'transparent',
                  color: mode === m ? C.bg : C.text, border:'none', cursor:'pointer'
                }}>
                {m === 'login' ? 'LOG IN' : 'CREATE'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:16 }}>
            <Field label="USERNAME" icon={User} value={u} onChange={e => setU(e.target.value)} placeholder="player_one" autoFocus/>
            <Field label="PASSWORD" icon={Lock} type="password" value={p} onChange={e => setP(e.target.value)} placeholder="6+ characters"/>

            {err && (
              <div className="shake" style={{
                padding:'10px 12px', border:`1px solid ${C.pink}`, color:C.pink,
                fontSize:11, letterSpacing:1, display:'flex', alignItems:'flex-start', gap:8
              }}>
                <AlertCircle size={14} style={{ flexShrink:0, marginTop:1 }}/> {err.toUpperCase()}
              </div>
            )}

            <Btn type="submit" full icon={busy ? Loader2 : (mode === 'login' ? LogIn : UserPlus)} disabled={busy}>
              {busy ? 'WAIT...' : (mode === 'login' ? 'ENTER' : 'CREATE ACCOUNT')}
            </Btn>
          </form>

          <div style={{ marginTop:24, paddingTop:18, borderTop:`1px solid ${C.border}`, fontSize:10, color:C.textDimmer, lineHeight:1.6, display:'flex', alignItems:'center', gap:6 }}>
            <Wifi size={11} style={{ flexShrink:0 }}/> Auth handled by Supabase. Username is your public handle.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   HOME SCREEN
   ============================================================ */

function HomeScreen({ profile, scores, onSelect, onLogout, onLeaderboard, onSettings, showConfigUI }) {
  const totalPlays = Object.values(scores).reduce((s, x) => s + (x?.plays || 0), 0);
  const gamesPlayed = Object.keys(scores).length;

  return (
    <div style={{ maxWidth: 1200, margin:'0 auto', padding:'28px 28px 80px' }}>
      <header style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        paddingBottom:18, borderBottom:`1px solid ${C.border}`, marginBottom:36, flexWrap:'wrap', gap:12
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <div style={{ width:34, height:34, background:C.lime, display:'grid', placeItems:'center' }}>
            <Sparkles size={18} color={C.bg} strokeWidth={3}/>
          </div>
          <div style={{ fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:22, letterSpacing:-1 }}>
            NEON<span style={{ color:C.lime }}>.ARC</span>
          </div>
        </div>

        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <div style={{ fontSize:11, letterSpacing:1.5, color:C.textDim }}>
            <span style={{ color:C.text, fontWeight:700 }}>{profile.username.toUpperCase()}</span>
          </div>
          <Btn kind="ghost" icon={Trophy} onClick={onLeaderboard}>Leaderboard</Btn>
          {showConfigUI && (
            <button onClick={() => { sfx.click(); onSettings(); }} onMouseEnter={sfx.hover}
              style={{ background:'transparent', border:`1px solid ${C.border}`, color:C.text, padding:'10px', cursor:'pointer' }}>
              <Settings size={14}/>
            </button>
          )}
          <Btn kind="ghost" icon={LogOut} onClick={onLogout}>Out</Btn>
        </div>
      </header>

      <section className="slide-up" style={{ marginBottom:48 }}>
        <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', flexWrap:'wrap', gap:16 }}>
          <h1 style={{ fontFamily: FONT_DISPLAY, fontWeight:800, fontSize:64, letterSpacing:-3, lineHeight:0.95, margin:0 }}>
            PICK YOUR<br/>
            <span style={{ color: C.lime }}>POISON</span><span style={{ color: C.pink }}>.</span>
          </h1>
          <div style={{ display:'flex', gap:12, padding:'14px 18px', border:`1px solid ${C.border}`, background: C.bg2 }}>
            <Stat label="GAMES" value={GAMES.length}/>
            <Sep/>
            <Stat label="PLAYED" value={gamesPlayed} accent={C.lime}/>
            <Sep/>
            <Stat label="ROUNDS" value={totalPlays} accent={C.cyan}/>
          </div>
        </div>
      </section>

      <section style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(320px, 1fr))', gap:16 }}>
        {GAMES.map((g, i) => (
          <GameCard key={g.id} game={g} delay={i*40} score={scores[g.id]}
            onClick={() => onSelect(g.id)}/>
        ))}
      </section>

      <footer style={{ marginTop:64, paddingTop:24, borderTop:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between', fontSize:10, letterSpacing:2, color:C.textDimmer }}>
        <span>NEON.ARC // V2.0 // SUPABASE</span>
        <span>{new Date().toLocaleString()}</span>
      </footer>
    </div>
  );
}

function Stat({ label, value, accent = C.text }) {
  return (
    <div>
      <div style={{ fontSize:9, letterSpacing:2, color:C.textDimmer }}>{label}</div>
      <div style={{ fontFamily:FONT_MONO, fontSize:22, fontWeight:700, color:accent, lineHeight:1.1 }}>
        {String(value).padStart(2,'0')}
      </div>
    </div>
  );
}
function Sep() { return <div style={{ width:1, alignSelf:'stretch', background:C.border }}/>; }

function GameCard({ game, score, onClick, delay = 0 }) {
  const [hover, setHover] = useState(false);
  const Icon = game.icon;
  return (
    <div className="slide-up"
      onClick={() => { sfx.pick(); onClick(); }}
      onMouseEnter={() => { setHover(true); sfx.hover(); }}
      onMouseLeave={() => setHover(false)}
      style={{
        background: C.bg2, border:`1px solid ${hover ? game.accent : C.border}`,
        padding:'22px', cursor:'pointer', position:'relative', overflow:'hidden',
        transition:'border-color 160ms, transform 160ms',
        transform: hover ? 'translateY(-2px)' : 'translateY(0)',
        animationDelay: `${delay}ms`
      }}>
      <Corner color={game.accent}/>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
        <Tag color={game.accent}>{game.tag}</Tag>
        <Icon size={20} color={game.accent} strokeWidth={2.5}/>
      </div>
      <h3 style={{ fontFamily: FONT_DISPLAY, fontWeight:800, fontSize:24, letterSpacing:-0.5, margin:'0 0 10px' }}>{game.name}</h3>
      <p style={{ color: C.textDim, fontSize:12, lineHeight:1.55, margin:'0 0 22px', minHeight:60 }}>{game.desc}</p>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-end', paddingTop:14, borderTop:`1px dashed ${C.border}` }}>
        <div>
          <div style={{ fontSize:9, letterSpacing:2, color:C.textDimmer }}>BEST</div>
          <div style={{ fontFamily:FONT_MONO, fontSize:18, fontWeight:700, color: score ? game.accent : C.textDimmer }}>
            {fmtScore(game.id, score?.best)}
          </div>
        </div>
        <div style={{ textAlign:'right' }}>
          <div style={{ fontSize:9, letterSpacing:2, color:C.textDimmer }}>PLAYS</div>
          <div style={{ fontFamily:FONT_MONO, fontSize:18, fontWeight:700 }}>{String(score?.plays || 0).padStart(2,'0')}</div>
        </div>
        <div style={{ fontSize:11, letterSpacing:2, color:hover?game.accent:C.textDim, display:'flex', alignItems:'center', gap:6 }}>
          PLAY <ArrowRight size={14}/>
        </div>
      </div>
    </div>
  );
}

function Corner({ color }) {
  return (
    <>
      <span style={{ position:'absolute', top:0, left:0, width:10, height:1, background:color }}/>
      <span style={{ position:'absolute', top:0, left:0, width:1, height:10, background:color }}/>
      <span style={{ position:'absolute', top:0, right:0, width:10, height:1, background:color }}/>
      <span style={{ position:'absolute', top:0, right:0, width:1, height:10, background:color }}/>
      <span style={{ position:'absolute', bottom:0, left:0, width:10, height:1, background:color }}/>
      <span style={{ position:'absolute', bottom:0, left:0, width:1, height:10, background:color }}/>
      <span style={{ position:'absolute', bottom:0, right:0, width:10, height:1, background:color }}/>
      <span style={{ position:'absolute', bottom:0, right:0, width:1, height:10, background:color }}/>
    </>
  );
}

/* ============================================================
   LEADERBOARD SCREEN
   ============================================================ */

function Leaderboard({ supa, profile, onExit }) {
  const [active, setActive] = useState(GAMES[0].id);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    setLoading(true); setErr('');
    (async () => {
      try {
        const list = await supa.leaderboard(active, HIGHER_BETTER[active], 25);
        setRows(list);
      } catch (e) { setErr(e.message); }
      finally { setLoading(false); }
    })();
  }, [active, supa]);

  const game = GAMES.find(g => g.id === active);

  return (
    <div style={{ maxWidth: 900, margin:'0 auto', padding:'28px 28px 80px' }}>
      <header style={{ display:'flex', alignItems:'center', justifyContent:'space-between', paddingBottom:18, borderBottom:`1px solid ${C.border}`, marginBottom:32 }}>
        <Btn kind="ghost" icon={ChevronLeft} onClick={onExit}>HOME</Btn>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <Trophy size={20} color={C.lime} strokeWidth={2.5}/>
          <div style={{ fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:22, letterSpacing:-0.5 }}>LEADERBOARD</div>
        </div>
        <div style={{ fontSize:11, letterSpacing:1.5, color:C.textDim }}>GLOBAL · LIVE</div>
      </header>

      {/* Tabs */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:0, marginBottom:24, border:`1px solid ${C.border}` }}>
        {GAMES.map((g, i) => {
          const isActive = g.id === active;
          const Icon = g.icon;
          return (
            <button key={g.id} onClick={() => { sfx.click(); setActive(g.id); }} onMouseEnter={sfx.hover}
              style={{
                flex:'1 1 130px', padding:'13px 8px', border:'none',
                borderLeft: i ? `1px solid ${C.border}` : 'none',
                background: isActive ? g.accent : 'transparent',
                color: isActive ? C.bg : C.text, cursor:'pointer',
                display:'flex', alignItems:'center', justifyContent:'center', gap:8,
                fontFamily:FONT_MONO, fontSize:10, fontWeight:600, letterSpacing:1.5
              }}>
              <Icon size={13}/>{g.name}
            </button>
          );
        })}
      </div>

      <div style={{
        background:C.bg2, border:`1px solid ${C.border}`, padding:'8px 0', minHeight: 200
      }}>
        {loading && (
          <div style={{ padding:'32px', textAlign:'center', color:C.textDim, fontSize:12, letterSpacing:2 }}>
            LOADING<span className="blink">_</span>
          </div>
        )}
        {!loading && err && (
          <div style={{ padding:'32px', textAlign:'center', color:C.pink, fontSize:12, letterSpacing:1 }}>
            <AlertCircle size={16} style={{ verticalAlign:'middle' }}/> {err}
          </div>
        )}
        {!loading && !err && rows.length === 0 && (
          <div style={{ padding:'32px', textAlign:'center', color:C.textDim, fontSize:12, letterSpacing:1 }}>
            NO RUNS YET. BE FIRST.
          </div>
        )}
        {!loading && !err && rows.map((r, i) => {
          const isMe = r.user_id === profile.id;
          const uname = r.profiles?.username || '???';
          return (
            <div key={`${r.user_id}-${i}`} className="slide-up" style={{
              display:'grid', gridTemplateColumns:'48px 1fr auto auto', alignItems:'center',
              gap:14, padding:'12px 18px',
              borderBottom: i < rows.length - 1 ? `1px solid ${C.border}` : 'none',
              background: isMe ? `${game.accent}11` : 'transparent',
              animationDelay: `${i * 30}ms`
            }}>
              <div style={{
                fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:20,
                color: i === 0 ? C.lime : i === 1 ? C.cyan : i === 2 ? C.amber : C.textDim,
                letterSpacing:-1
              }}>
                {String(i+1).padStart(2,'0')}
              </div>
              <div style={{ fontFamily:FONT_MONO, fontSize:13, fontWeight: isMe ? 700 : 500, color: isMe ? game.accent : C.text }}>
                {uname.toUpperCase()}{isMe && <span style={{ color:C.textDim, marginLeft:8, fontSize:10, letterSpacing:1.5 }}>· YOU</span>}
              </div>
              <div style={{ fontSize:10, letterSpacing:1.5, color:C.textDimmer }}>{r.plays} {r.plays === 1 ? 'PLAY' : 'PLAYS'}</div>
              <div style={{ fontFamily:FONT_MONO, fontSize:18, fontWeight:700, color: game.accent }}>
                {fmtScore(active, r.best)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
   GAME ROUTER + SHELL
   ============================================================ */

function GameRouter({ route, onExit, onScore, scores }) {
  const g = GAMES.find(x => x.id === route);
  if (!g) return null;
  const props = {
    onExit, onScore: (s) => onScore(route, s),
    best: scores[route]?.best, accent: g.accent
  };
  const Comp = {
    colorhunt: ColorHunt, recall: ChromaticRecall, pitch: PitchPerfect,
    wordlet: Wordlet, flag: FlagMaster, reflex: Reflex
  }[route];
  return (
    <GameShell game={g} onExit={onExit} best={scores[route]?.best}>
      <Comp {...props}/>
    </GameShell>
  );
}

function GameShell({ game, onExit, best, children }) {
  const Icon = game.icon;
  return (
    <div style={{ maxWidth: 1100, margin:'0 auto', padding:'28px 28px 80px' }}>
      <header style={{ display:'flex', alignItems:'center', justifyContent:'space-between', paddingBottom:18, borderBottom:`1px solid ${C.border}`, marginBottom:32 }}>
        <Btn kind="ghost" icon={ChevronLeft} onClick={onExit}>HOME</Btn>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <Icon size={18} color={game.accent} strokeWidth={2.5}/>
          <div style={{ fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:22, letterSpacing:-0.5 }}>{game.name}</div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:11, letterSpacing:1.5, color:C.textDim }}>
          <Trophy size={14} color={game.accent}/> BEST <span style={{ color:game.accent, fontWeight:700 }}>{fmtScore(game.id, best)}</span>
        </div>
      </header>
      {children}
    </div>
  );
}

/* ============================================================
   GAME 1: COLOR HUNT
   ============================================================ */

const CH_LIVES = 3;

function ColorHunt({ onScore, accent }) {
  const [phase, setPhase] = useState('idle');
  const [round, setRound] = useState(0);
  const [time, setTime] = useState(60);
  const [grid, setGrid] = useState(null);
  const [finalScore, setFinalScore] = useState(0);
  const [lives, setLives] = useState(CH_LIVES);
  const [reason, setReason] = useState('');
  const [shakeN, setShakeN] = useState(0);
  const tref = useRef(null);

  const buildRound = (r) => {
    // Steeper ramp: grid grows faster (caps at 7x7) and the color gap shrinks
    // hard, bottoming out near the threshold of human discrimination.
    const size = clamp(3 + Math.floor(r / 1.8), 3, 7);
    const baseHue = randInt(0, 359);
    const baseSat = randInt(45, 80);
    const baseLight = randInt(38, 66);
    const diff = clamp(36 - r * 2.6, 2.5, 36);
    const axis = pick(['l', 's', 'h']);
    let base = `hsl(${baseHue} ${baseSat}% ${baseLight}%)`;
    let tgt;
    if (axis === 'l') tgt = `hsl(${baseHue} ${baseSat}% ${clamp(baseLight + (Math.random() < 0.5 ? -diff/2.6 : diff/2.6), 8, 92)}%)`;
    else if (axis === 's') tgt = `hsl(${baseHue} ${clamp(baseSat + (Math.random() < 0.5 ? -diff : diff), 8, 96)}% ${baseLight}%)`;
    else tgt = `hsl(${(baseHue + (Math.random() < 0.5 ? -diff/2 : diff/2) + 360) % 360} ${baseSat}% ${baseLight}%)`;
    const idx = randInt(0, size * size - 1);
    return { size, base, target: tgt, idx };
  };

  const start = () => {
    setRound(0); setTime(60); setFinalScore(0); setLives(CH_LIVES); setReason('');
    setGrid(buildRound(0));
    setPhase('playing');
  };

  const end = (r, why) => {
    setFinalScore(r); setReason(why); onScore(r); setPhase('over');
  };

  useEffect(() => {
    if (phase !== 'playing') return;
    tref.current = setInterval(() => {
      setTime(t => {
        if (t <= 1) { clearInterval(tref.current); return 0; }
        if (t <= 6) sfx.tick();
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(tref.current);
  }, [phase]);

  useEffect(() => {
    if (phase === 'playing' && time === 0) { sfx.bad(); end(round, 'TIME UP'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, phase]);

  const onTile = (i) => {
    if (phase !== 'playing') return;
    if (i === grid.idx) {
      sfx.pick();
      const nr = round + 1;
      setRound(nr); setGrid(buildRound(nr));
    } else {
      const nl = lives - 1;
      setLives(nl);
      setShakeN(n => n + 1);
      if (nl <= 0) { sfx.bad(); end(round, 'OUT OF LIVES'); }
      else sfx.warn();
    }
  };

  if (phase === 'idle') {
    return <PrePlay accent={accent} icon={Eye} how={[
      'A grid of tiles. One is a slightly different shade.',
      'Click it. Click it fast.',
      'Each correct pick: bigger grid, smaller difference. It ramps quickly.',
      `You have 60 seconds and ${CH_LIVES} lives. A wrong click costs a life.`
    ]} onStart={start}/>;
  }
  if (phase === 'over') {
    return <Result accent={accent} title={reason || 'RUN OVER'} lines={[['ROUNDS CLEARED', finalScore]]} onRetry={start}/>;
  }

  return (
    <div>
      <Hud accent={accent} items={[
        ['ROUND', round + 1],
        ['TIME', `${time}s`, time <= 6 ? C.pink : null],
        ['LIVES', <LifePips key="lp" lives={lives} max={CH_LIVES}/>, lives === 1 ? C.pink : null],
        ['GRID', `${grid.size}×${grid.size}`]
      ]}/>
      <div key={shakeN} className={shakeN ? 'shake' : ''} style={{
        display:'grid', gridTemplateColumns:`repeat(${grid.size}, 1fr)`,
        gap: clamp(10 - grid.size, 3, 8), maxWidth: 560, margin:'24px auto 0', aspectRatio:'1 / 1'
      }}>
        {Array.from({ length: grid.size * grid.size }).map((_, i) => (
          <button key={i} onClick={() => onTile(i)}
            style={{
              background: i === grid.idx ? grid.target : grid.base,
              border:'none', cursor:'pointer', aspectRatio:'1 / 1', transition:'transform 80ms'
            }}
            onMouseEnter={e => e.currentTarget.style.transform = 'scale(0.97)'}
            onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}/>
        ))}
      </div>
    </div>
  );
}

function LifePips({ lives, max }) {
  return (
    <span style={{ display:'inline-flex', gap:5, justifyContent:'center' }}>
      {Array.from({ length: max }).map((_, i) => (
        <span key={i} style={{
          width:12, height:12, borderRadius:'50%',
          background: i < lives ? 'currentColor' : 'transparent',
          border: `1.5px solid ${i < lives ? 'currentColor' : C.textDimmer}`
        }}/>
      ))}
    </span>
  );
}

function Hud({ accent, items }) {
  return (
    <div style={{ display:'flex', justifyContent:'center', gap:0, border:`1px solid ${C.border}`, background: C.bg2, maxWidth: 560, margin:'0 auto' }}>
      {items.map(([k, v, col], i) => (
        <div key={k} style={{ flex:1, padding:'14px 18px', textAlign:'center', borderLeft: i ? `1px solid ${C.border}` : 'none' }}>
          <div style={{ fontSize:9, letterSpacing:2, color:C.textDimmer }}>{k}</div>
          <div style={{ fontFamily:FONT_MONO, fontSize:22, fontWeight:700, color: col || accent }}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function PrePlay({ accent, icon: Icon, how, onStart }) {
  return (
    <div className="slide-up" style={{ maxWidth: 600, margin:'40px auto', textAlign:'center' }}>
      <div style={{ display:'inline-grid', placeItems:'center', width:72, height:72, border:`1px solid ${accent}`, color:accent, marginBottom:24 }}>
        <Icon size={32} strokeWidth={2.5}/>
      </div>
      <h2 style={{ fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:36, letterSpacing:-1, margin:'0 0 24px' }}>READY?</h2>
      <ol style={{ listStyle:'none', padding:0, margin:'0 0 32px', textAlign:'left', maxWidth:440, marginLeft:'auto', marginRight:'auto' }}>
        {how.map((h, i) => (
          <li key={i} style={{ display:'flex', gap:14, padding:'10px 0', borderBottom:`1px dashed ${C.border}`, color:C.textDim, fontSize:13 }}>
            <span style={{ color: accent, fontWeight:700, fontFamily:FONT_MONO }}>{String(i+1).padStart(2,'0')}</span>
            <span>{h}</span>
          </li>
        ))}
      </ol>
      <Btn icon={Play} onClick={onStart}>BEGIN</Btn>
    </div>
  );
}

function Result({ accent, title, lines, onRetry }) {
  useEffect(() => { sfx.win(); }, []);
  return (
    <div className="slide-up" style={{ maxWidth: 520, margin:'40px auto', textAlign:'center' }}>
      <div style={{ display:'inline-grid', placeItems:'center', width:72, height:72, border:`1px solid ${accent}`, color:accent, marginBottom:18 }}>
        <Crown size={32} strokeWidth={2.5}/>
      </div>
      <h2 style={{ fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:40, letterSpacing:-1, margin:'0 0 28px' }}>{title}</h2>
      <div style={{ display:'flex', flexDirection:'column', gap:0, border:`1px solid ${C.border}`, marginBottom:28 }}>
        {lines.map(([k, v]) => (
          <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'14px 18px', borderBottom:`1px solid ${C.border}`, background:C.bg2 }}>
            <span style={{ fontSize:11, letterSpacing:2, color:C.textDim }}>{k}</span>
            <span style={{ fontFamily:FONT_MONO, fontSize:18, fontWeight:700, color:accent }}>{v}</span>
          </div>
        ))}
      </div>
      <Btn icon={RotateCcw} onClick={onRetry}>PLAY AGAIN</Btn>
    </div>
  );
}

/* ============================================================
   GAME 2: CHROMATIC RECALL
   ============================================================ */

function ChromaticRecall({ onScore, accent }) {
  const [phase, setPhase] = useState('idle');
  const [round, setRound] = useState(0);
  const [target, setTarget] = useState({ r:0, g:0, b:0 });
  const [guess, setGuess] = useState({ r:128, g:128, b:128 });
  const [scores, setScores] = useState([]);
  const [memCount, setMemCount] = useState(3);
  const ROUNDS = 5;
  const MEM_SECONDS = 3;

  const newTarget = () => {
    const t = { r: randInt(20,235), g: randInt(20,235), b: randInt(20,235) };
    setTarget(t); setGuess({ r:128, g:128, b:128 });
    setMemCount(MEM_SECONDS);
    setPhase('show');
  };

  // Countdown while memorizing, then flip to the guess phase.
  useEffect(() => {
    if (phase !== 'show') return;
    setMemCount(MEM_SECONDS);
    const iv = setInterval(() => {
      setMemCount(c => {
        if (c <= 1) { clearInterval(iv); return 0; }
        sfx.tick();
        return c - 1;
      });
    }, 1000);
    const to = setTimeout(() => setPhase('guess'), MEM_SECONDS * 1000);
    return () => { clearInterval(iv); clearTimeout(to); };
  }, [phase]);

  const start = () => { setScores([]); setRound(0); newTarget(); };

  const submit = () => {
    const d = Math.sqrt((target.r - guess.r)**2 + (target.g - guess.g)**2 + (target.b - guess.b)**2);
    const maxD = Math.sqrt(255*255*3);
    const acc = Math.round(100 - (d / maxD) * 100);
    sfx.good(); setScores(s => [...s, acc]); setPhase('reveal');
  };

  const next = () => {
    const nr = round + 1;
    if (nr >= ROUNDS) {
      const avg = Math.round(scores.reduce((s,x) => s+x, 0) / scores.length);
      onScore(avg); setPhase('over');
    } else { setRound(nr); newTarget(); }
  };

  if (phase === 'idle') {
    return <PrePlay accent={accent} icon={Palette} how={[
      'A random color appears for ~3 seconds.',
      'It disappears. You recreate it with three sliders: R, G, B.',
      'Score is based on RGB distance.',
      'Five rounds. Final score is your average accuracy.'
    ]} onStart={start}/>;
  }
  if (phase === 'over') {
    const avg = Math.round(scores.reduce((s,x) => s+x, 0) / scores.length);
    return <Result accent={accent} title="ROUND COMPLETE" lines={[
      ['AVG ACCURACY', `${avg}%`],
      ['BEST ROUND', `${Math.max(...scores)}%`],
      ['WORST ROUND', `${Math.min(...scores)}%`]
    ]} onRetry={start}/>;
  }

  const targetCss = `rgb(${target.r},${target.g},${target.b})`;
  const guessCss = `rgb(${guess.r},${guess.g},${guess.b})`;
  const lastAcc = scores[scores.length - 1];

  return (
    <div>
      <Hud accent={accent} items={[
        ['ROUND', `${round+1}/${ROUNDS}`],
        ['PHASE', phase.toUpperCase()],
        ['AVG', scores.length ? `${Math.round(scores.reduce((s,x)=>s+x,0)/scores.length)}%` : '—']
      ]}/>

      <div style={{ display:'grid', gridTemplateColumns: phase === 'reveal' ? '1fr 1fr' : '1fr', gap:18, maxWidth:560, margin:'24px auto 0' }}>
        <div>
          <Lbl>{phase === 'reveal' ? 'TARGET' : (phase === 'show' ? 'MEMORIZE' : 'TARGET HIDDEN')}</Lbl>
          <div style={{
            aspectRatio:'1 / 1',
            background: (phase === 'show' || phase === 'reveal') ? targetCss : C.bg3,
            border:`1px solid ${C.border}`,
            display:'grid', placeItems:'center', position:'relative'
          }}>
            {phase === 'show' && (
              <div style={{
                fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:72, lineHeight:1,
                color:'rgba(0,0,0,0.55)', textShadow:'0 1px 12px rgba(255,255,255,0.35)'
              }}>
                {memCount}
              </div>
            )}
            {phase === 'guess' && <span style={{ color:C.textDimmer, letterSpacing:2, fontSize:11 }}>FROM MEMORY</span>}
          </div>
        </div>
        {phase === 'reveal' && (
          <div>
            <Lbl>YOUR GUESS</Lbl>
            <div style={{ aspectRatio:'1 / 1', background: guessCss, border:`1px solid ${C.border}` }}/>
          </div>
        )}
      </div>

      {phase === 'guess' && (
        <div style={{ maxWidth: 560, margin:'24px auto 0', display:'flex', flexDirection:'column', gap:16 }}>
          {[['R','r',C.pink],['G','g',C.lime],['B','b',C.cyan]].map(([lbl, k, col]) => {
            const { r, g, b } = guess;
            const grad = k === 'r' ? `linear-gradient(90deg, rgb(0,${g},${b}), rgb(255,${g},${b}))`
              : k === 'g' ? `linear-gradient(90deg, rgb(${r},0,${b}), rgb(${r},255,${b}))`
              : `linear-gradient(90deg, rgb(${r},${g},0), rgb(${r},${g},255))`;
            return (
              <div key={k}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                  <span style={{ fontSize:11, letterSpacing:2, color:col, fontWeight:700 }}>{lbl}</span>
                  <span style={{ fontFamily:FONT_MONO, fontSize:12, color:C.text }}>{guess[k]}</span>
                </div>
                <input className="arc-slider" type="range" min={0} max={255} value={guess[k]}
                  style={{ background: grad, height:14 }}
                  onChange={e => setGuess(g => ({ ...g, [k]: +e.target.value }))}/>
              </div>
            );
          })}
          <div style={{ aspectRatio:'4 / 1', background: guessCss, border:`1px solid ${C.border}`, marginTop:6 }}/>
          <Btn icon={Check} onClick={submit}>LOCK IN</Btn>
        </div>
      )}

      {phase === 'reveal' && (
        <div style={{ maxWidth:560, margin:'24px auto 0', textAlign:'center' }}>
          <div style={{ fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:48, color:accent, letterSpacing:-1 }}>
            {lastAcc}%
          </div>
          <div style={{ fontSize:11, letterSpacing:2, color:C.textDim, marginBottom:18 }}>ACCURACY</div>
          <Btn icon={ArrowRight} onClick={next}>
            {round + 1 >= ROUNDS ? 'SEE RESULTS' : 'NEXT ROUND'}
          </Btn>
        </div>
      )}
    </div>
  );
}
function Lbl({ children }) {
  return <div style={{ fontSize:10, letterSpacing:2, color:C.textDim, marginBottom:8 }}>{children}</div>;
}

/* ============================================================
   GAME 3: PITCH PERFECT
   ============================================================ */

function PitchPerfect({ onScore, accent }) {
  const [phase, setPhase] = useState('idle');
  const [round, setRound] = useState(0);
  const [target, setTarget] = useState(440);
  const [guess, setGuess] = useState(440);
  const [scores, setScores] = useState([]);
  const ROUNDS = 5;
  const MIN = 200, MAX = 900;
  const oscRef = useRef(null);

  useEffect(() => () => { if (oscRef.current) oscRef.current.destroy(); }, []);

  const playTarget = (f) => {
    if (oscRef.current) oscRef.current.destroy();
    oscRef.current = makeSustainedTone(f);
    oscRef.current.on();
    setTimeout(() => { if (oscRef.current) oscRef.current.off(); }, 2200);
  };

  const newRound = () => {
    const f = randInt(MIN+20, MAX-20);
    setTarget(f); setGuess(randInt(MIN, MAX));
    setPhase('listen');
    setTimeout(() => playTarget(f), 250);
    setTimeout(() => setPhase('guess'), 2600);
  };

  const start = () => { setScores([]); setRound(0); newRound(); };

  const onSlide = (v) => {
    setGuess(v);
    if (!oscRef.current) oscRef.current = makeSustainedTone(v);
    oscRef.current.setFreq(v); oscRef.current.on();
  };
  const stopSlide = () => { if (oscRef.current) oscRef.current.off(); };
  const replay = () => playTarget(target);

  const submit = () => {
    const cents = Math.abs(1200 * Math.log2(guess / target));
    const acc = Math.round(clamp(100 - cents / 12, 0, 100));
    setScores(s => [...s, acc]); sfx.good();
    setPhase('reveal');
    if (oscRef.current) oscRef.current.off();
  };

  const next = () => {
    const nr = round + 1;
    if (nr >= ROUNDS) {
      const avg = Math.round(scores.reduce((s,x) => s+x, 0) / scores.length);
      onScore(avg); setPhase('over');
      if (oscRef.current) { oscRef.current.destroy(); oscRef.current = null; }
    } else { setRound(nr); newRound(); }
  };

  if (phase === 'idle') {
    return <PrePlay accent={accent} icon={Music} how={[
      'You hear a pure tone for ~2 seconds.',
      'Slide. Match the pitch. The slider plays the tone live.',
      'Score is measured in cents (1200 = an octave off).',
      'Five rounds. Final score is your average accuracy.'
    ]} onStart={start}/>;
  }
  if (phase === 'over') {
    const avg = Math.round(scores.reduce((s,x) => s+x, 0) / scores.length);
    return <Result accent={accent} title="EARS RATED" lines={[
      ['AVG ACCURACY', `${avg}%`],
      ['BEST', `${Math.max(...scores)}%`]
    ]} onRetry={start}/>;
  }

  const lastAcc = scores[scores.length - 1];
  const cents = phase === 'reveal' ? Math.round(Math.abs(1200 * Math.log2(guess / target))) : 0;

  return (
    <div>
      <Hud accent={accent} items={[
        ['ROUND', `${round+1}/${ROUNDS}`],
        ['PHASE', phase.toUpperCase()],
        ['AVG', scores.length ? `${Math.round(scores.reduce((s,x)=>s+x,0)/scores.length)}%` : '—']
      ]}/>

      <div style={{ maxWidth:560, margin:'40px auto 0', textAlign:'center' }}>
        <div style={{ border:`1px solid ${C.border}`, background:C.bg2, padding:'32px 24px', marginBottom:24, position:'relative', overflow:'hidden' }}>
          <WaveViz freq={phase === 'reveal' ? target : (phase === 'guess' ? guess : 540)} accent={accent}/>
          <div style={{ position:'relative', zIndex:1 }}>
            <div style={{ fontSize:10, letterSpacing:2, color:C.textDim, marginBottom:6 }}>
              {phase === 'listen' ? 'LISTEN CAREFULLY' : phase === 'guess' ? 'YOUR GUESS' : 'TARGET'}
            </div>
            <div style={{ fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:58, letterSpacing:-2, color:accent, lineHeight:1 }}>
              {phase === 'listen'
                ? <span className="blink" style={{ letterSpacing:6 }}>· · ·</span>
                : <>{phase === 'guess' ? guess : target}<span style={{ color:C.textDim, fontSize:24 }}> Hz</span></>}
            </div>
            {phase === 'reveal' && (
              <div style={{ marginTop:16, color:C.textDim, fontSize:12, letterSpacing:1 }}>
                YOU GUESSED <span style={{ color:C.text }}>{guess} Hz</span> · OFF BY <span style={{ color:C.pink }}>{cents}¢</span>
              </div>
            )}
          </div>
        </div>

        {phase === 'guess' && (
          <>
            <input className="arc-slider" type="range" min={MIN} max={MAX} value={guess}
              onChange={e => onSlide(+e.target.value)}
              onMouseUp={stopSlide} onTouchEnd={stopSlide} onBlur={stopSlide}/>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:C.textDimmer, marginTop:8, letterSpacing:1.5 }}>
              <span>{MIN} Hz</span><span>{MAX} Hz</span>
            </div>
            <div style={{ display:'flex', gap:10, justifyContent:'center', marginTop:24 }}>
              <Btn kind="ghost" icon={Volume2} onClick={replay}>HEAR TARGET</Btn>
              <Btn icon={Check} onClick={submit}>LOCK IN</Btn>
            </div>
          </>
        )}

        {phase === 'listen' && (
          <div style={{ color:C.textDim, fontSize:12, letterSpacing:2 }}>
            LISTENING<span className="blink">_</span>
          </div>
        )}

        {phase === 'reveal' && (
          <>
            <div style={{ fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:48, color:accent, letterSpacing:-1, marginTop:8 }}>
              {lastAcc}%
            </div>
            <div style={{ fontSize:11, letterSpacing:2, color:C.textDim, marginBottom:18 }}>ACCURACY</div>
            <Btn icon={ArrowRight} onClick={next}>
              {round + 1 >= ROUNDS ? 'SEE RESULTS' : 'NEXT ROUND'}
            </Btn>
          </>
        )}
      </div>
    </div>
  );
}

function WaveViz({ freq, accent }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    let raf;
    const tick = () => { setPhase(p => p + 0.05); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const k = (freq - 200) / 700;
  const cycles = 2 + k * 8;
  const pts = [];
  for (let x = 0; x <= 600; x += 4) {
    const y = 60 + Math.sin((x / 600) * Math.PI * 2 * cycles + phase) * 22;
    pts.push(`${x},${y}`);
  }
  return (
    <svg viewBox="0 0 600 120" style={{ position:'absolute', inset:0, width:'100%', height:'100%', opacity:0.25 }}>
      <polyline points={pts.join(' ')} fill="none" stroke={accent} strokeWidth="1.5"/>
    </svg>
  );
}

/* ============================================================
   GAME 4: WORDLET
   ============================================================ */

const WORDS = [
  'about','above','abuse','actor','acute','admit','adopt','adult','after','again',
  'agent','agree','ahead','alarm','album','alert','alike','alive','allow','alone',
  'along','alter','among','anger','angle','angry','apart','apple','apply','arena',
  'argue','arise','array','aside','asset','audio','audit','avoid','award','aware',
  'badge','bagel','baker','bases','basic','beach','began','begin','being','below',
  'bench','billy','birth','black','blade','blame','blank','blast','blaze','bleed',
  'blend','bless','blind','block','blood','bloom','blown','board','boast','bonus',
  'boost','booth','bound','brain','brand','brass','brave','bread','break','breed',
  'brick','brief','bring','broad','broke','brown','brush','build','built','burst',
  'cabin','cable','candy','carry','catch','cause','chain','chair','chalk','chant',
  'chaos','charm','chart','chase','cheap','check','cheer','chess','chest','chief',
  'child','chill','china','chose','civic','claim','clash','class','clean','clear',
  'clerk','click','cliff','climb','clock','close','cloud','coach','coast','color',
  'corny','could','count','court','cover','craft','crash','crazy','cream','creek',
  'crest','crime','cross','crowd','crown','crude','crush','curse','curve','cycle',
  'daily','dance','dated','dealt','death','debut','delay','depth','diary','dirty',
  'dozen','draft','drain','drama','drank','dream','dress','drink','drive','drove',
  'drunk','dwell','dying','eager','eagle','early','earth','eaten','eight','elite',
  'empty','enemy','enjoy','enter','entry','equal','error','event','every','exact','ideal',
  'exist','extra','faith','false','fancy','fault','fiber','field','fifth','fight',
  'final','first','fixed','flair','flame','flash','flesh','float','flood','floor',
  'flour','focus','force','forge','forty','found','frame','fraud','fresh','front',
  'frost','fruit','funny','gauge','ghost','giant','given','glass','glide','globe',
  'gloom','gloss','glove','grade','grain','grand','grant','grape','graph','grasp',
  'grass','grave','great','greed','green','greet','grief','grill','gripe','groan',
  'grown','guard','guess','guest','guide','guild','habit','happy','harsh','heart',
  'heavy','hedge','hello','horse','hotel','house','human','humid','hurry','idler',
  'image','imply','index','inner','input','irony','issue','ivory','joint','judge',
  'juice','knees','knife','known','label','large','laser','later','laugh','layer',
  'learn','leash','least','leave','legal','lemon','level','light','limit','linen',
  'links','liver','loamy','local','logic','loose','loyal','lucky','lunar','lunch',
  'lungs','lurch','lying','lyric','macho','magic','major','maker','march','match',
  'maybe','mayor','meant','medal','media','metal','might','minor','minus','mixed',
  'model','money','month','moral','motor','mount','mouse','mouth','movie','music',
  'naive','nasty','needy','never','newly','night','noble','noise','north','novel',
  'nurse','nymph','occur','ocean','offer','often','olive','onion','opera','order',
  'organ','other','ought','ounce','outer','owner','panel','paper','party','pause',
  'peace','peach','penny','phase','phone','photo','piano','pilot','pitch','pixel',
  'plain','plane','plant','plate','plead','poach','point','pound','power','press',
  'price','pride','prime','print','prior','prize','proof','proud','prove','pulse',
  'queen','query','quest','quick','quiet','quote','radar','radio','raise','rally',
  'range','rapid','ratio','reach','react','ready','realm','rebel','refer','relax',
  'reply','rider','ridge','rifle','right','rigid','rival','river','roast','robot',
  'rocky','rogue','rough','round','route','royal','rural','sadly','salon','sandy',
  'sauce','scale','scene','scope','score','scrap','sense','sever','shade','shake',
  'shall','shape','share','sharp','sheep','sheet','shelf','shell','shift','shine',
  'shiny','shirt','shock','shoot','shore','short','shown','sight','silly','since',
  'sixth','sixty','sized','skill','sleep','slept','slice','slide','slope','small',
  'smart','smell','smile','smoke','snake','solid','solve','sorry','sound','south',
  'space','spare','spark','speak','speed','spell','spend','spent','spice','spike',
  'spine','split','spoke','sport','staff','stage','stake','stand','stark','start',
  'state','stays','steam','steel','steep','steer','stern','stick','stiff','still',
  'stock','stone','stood','store','storm','story','stove','straw','strip','study',
  'stuff','style','sugar','sunny','super','sweet','swept','sword','table','taken',
  'tasty','teach','tease','teeth','tempo','tense','terms','testy','thank','theft',
  'their','theme','there','these','thick','thing','think','third','those','three',
  'threw','throw','thumb','tidal','tiger','tight','timer','timid','title','today',
  'token','topic','total','touch','tough','tower','toxic','trace','track','trade',
  'trail','train','trait','trash','treat','trend','trial','tribe','trick','tried',
  'tripe','troop','truck','truly','trump','trunk','trust','truth','tweed','tweet',
  'twice','twist','tying','ultra','uncle','under','undue','union','unite','unity',
  'until','upper','upset','urban','usage','usual','vague','valid','valor','value',
  'vapor','vault','venue','video','virus','visit','vital','vivid','vocal','vodka',
  'voice','vowel','wagon','waist','waltz','waste','watch','water','wedge','wheat',
  'wheel','where','which','while','white','whole','whose','widen','width','willy',
  'wired','wires','witch','wives','woken','woman','women','world','worry','worse',
  'worst','worth','would','wound','woven','wrath','wreck','wrist','write','wrong',
  'wrote','yacht','yards','yeast','yield','young','youth','zebra','zonal','zones'
];

function Wordlet({ onScore, accent }) {
  const [target, setTarget] = useState(() => pick(WORDS).toUpperCase());
  const [guesses, setGuesses] = useState([]);
  const [cur, setCur] = useState('');
  const [phase, setPhase] = useState('play');
  const MAX = 6;
  const submittedRef = useRef(false);

  const reset = () => {
    setTarget(pick(WORDS).toUpperCase()); setGuesses([]); setCur('');
    setPhase('play'); submittedRef.current = false;
  };

  const submit = useCallback(() => {
    if (cur.length !== 5) { sfx.warn(); return; }
    if (!/^[A-Z]{5}$/.test(cur)) { sfx.warn(); return; }
    const newGuesses = [...guesses, cur];
    setGuesses(newGuesses); setCur('');
    if (cur === target) {
      sfx.win(); setPhase('win');
      if (!submittedRef.current) { submittedRef.current = true; onScore(MAX - newGuesses.length + 1); }
    } else if (newGuesses.length >= MAX) {
      sfx.bad(); setPhase('lose');
      if (!submittedRef.current) { submittedRef.current = true; onScore(0); }
    } else { sfx.click(); }
  }, [cur, guesses, target, onScore]);

  useEffect(() => {
    const onKey = (e) => {
      if (phase !== 'play') return;
      const k = e.key;
      if (k === 'Enter') return submit();
      if (k === 'Backspace') return setCur(c => c.slice(0, -1));
      if (/^[a-zA-Z]$/.test(k)) setCur(c => c.length < 5 ? c + k.toUpperCase() : c);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit, phase]);

  const tile = (ch, i, row) => {
    if (!row) return { color: C.text, bg: C.bg2, border: ch ? C.borderLight : C.border };
    const t = target[i];
    if (ch === t) return { color: C.bg, bg: C.lime, border: C.lime };
    if (target.includes(ch)) return { color: C.bg, bg: C.amber, border: C.amber };
    return { color: C.text, bg: C.bg3, border: C.border };
  };

  const keyState = useMemo(() => {
    const m = {};
    for (const g of guesses) {
      for (let i = 0; i < 5; i++) {
        const ch = g[i];
        if (ch === target[i]) m[ch] = 'green';
        else if (target.includes(ch)) m[ch] = m[ch] === 'green' ? 'green' : 'amber';
        else m[ch] = m[ch] || 'gray';
      }
    }
    return m;
  }, [guesses, target]);

  const rows = ['QWERTYUIOP','ASDFGHJKL','ZXCVBNM'];

  const press = (k) => {
    if (phase !== 'play') return;
    if (k === 'ENT') submit();
    else if (k === 'DEL') setCur(c => c.slice(0, -1));
    else setCur(c => c.length < 5 ? c + k : c);
  };

  return (
    <div style={{ maxWidth:520, margin:'0 auto' }}>
      <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:24, alignItems:'center' }}>
        {Array.from({ length: MAX }).map((_, ri) => {
          const isCurrent = ri === guesses.length && phase === 'play';
          const row = ri < guesses.length ? guesses[ri] : null;
          const text = row || (isCurrent ? cur.padEnd(5, ' ') : '     ');
          return (
            <div key={ri} style={{ display:'flex', gap:6 }}>
              {Array.from(text).map((ch, i) => {
                const s = tile(ch.trim() || '', i, row);
                return (
                  <div key={i} className={row ? 'flip-in' : ''}
                    style={{
                      width:54, height:54, display:'grid', placeItems:'center',
                      background:s.bg, color:s.color, border:`1.5px solid ${s.border}`,
                      fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:24, letterSpacing:-0.5,
                      animationDelay: row ? `${i * 0.08}s` : '0s'
                    }}>
                    {ch !== ' ' ? ch : ''}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {phase === 'play' && (
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          {rows.map((r, ri) => (
            <div key={ri} style={{ display:'flex', gap:5, justifyContent:'center' }}>
              {ri === 2 && (
                <button onClick={() => press('ENT')} onMouseEnter={sfx.hover} style={kbBtnStyle({}, 'wide')}>ENTR</button>
              )}
              {Array.from(r).map(k => {
                const st = keyState[k];
                return (
                  <button key={k} onClick={() => press(k)} onMouseEnter={sfx.hover}
                    style={kbBtnStyle({
                      bg: st === 'green' ? C.lime : st === 'amber' ? C.amber : st === 'gray' ? C.bg3 : C.bg2,
                      color: (st === 'green' || st === 'amber') ? C.bg : C.text
                    })}>{k}</button>
                );
              })}
              {ri === 2 && (
                <button onClick={() => press('DEL')} onMouseEnter={sfx.hover} style={kbBtnStyle({}, 'wide')}>DEL</button>
              )}
            </div>
          ))}
        </div>
      )}

      {phase === 'win' && (
        <div className="slide-up" style={{ textAlign:'center', marginTop:18 }}>
          <div style={{ fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:40, color:accent }}>NICE.</div>
          <div style={{ fontSize:12, color:C.textDim, letterSpacing:2, marginBottom:18 }}>
            SOLVED IN {guesses.length} {guesses.length === 1 ? 'GUESS' : 'GUESSES'}
          </div>
          <Btn icon={RotateCcw} onClick={reset}>NEW WORD</Btn>
        </div>
      )}
      {phase === 'lose' && (
        <div className="slide-up" style={{ textAlign:'center', marginTop:18 }}>
          <div style={{ fontFamily:FONT_DISPLAY, fontWeight:800, fontSize:36, color:C.pink }}>OUT OF GUESSES</div>
          <div style={{ fontSize:12, color:C.textDim, letterSpacing:2, marginBottom:18 }}>
            WORD WAS <span style={{ color:C.text, fontWeight:700 }}>{target}</span>
          </div>
          <Btn icon={RotateCcw} onClick={reset}>NEW WORD</Btn>
        </div>
      )}
    </div>
  );
}

function kbBtnStyle({ bg = C.bg2, color = C.text }, variant) {
  return {
    minWidth: variant === 'wide' ? 56 : 34, height: 44, padding:'0 8px',
    background: bg, color, border:`1px solid ${C.border}`, cursor:'pointer',
    fontFamily: FONT_MONO, fontSize:13, fontWeight:600, letterSpacing:1
  };
}

/* ============================================================
   GAME 5: FLAG MASTER
   ============================================================ */

const COUNTRIES = [
  ['jp','Japan'],['fr','France'],['de','Germany'],['gb','United Kingdom'],['us','United States'],
  ['ca','Canada'],['mx','Mexico'],['br','Brazil'],['ar','Argentina'],['it','Italy'],
  ['es','Spain'],['pt','Portugal'],['nl','Netherlands'],['be','Belgium'],['ch','Switzerland'],
  ['at','Austria'],['se','Sweden'],['no','Norway'],['fi','Finland'],['dk','Denmark'],
  ['ie','Ireland'],['pl','Poland'],['cz','Czechia'],['gr','Greece'],['tr','Turkey'],
  ['ru','Russia'],['ua','Ukraine'],['eg','Egypt'],['za','South Africa'],['ng','Nigeria'],
  ['ke','Kenya'],['ma','Morocco'],['gh','Ghana'],['et','Ethiopia'],['sa','Saudi Arabia'],
  ['ae','UAE'],['il','Israel'],['ir','Iran'],['iq','Iraq'],['in','India'],
  ['pk','Pakistan'],['bd','Bangladesh'],['th','Thailand'],['vn','Vietnam'],['ph','Philippines'],
  ['id','Indonesia'],['my','Malaysia'],['sg','Singapore'],['kr','South Korea'],['cn','China'],
  ['tw','Taiwan'],['au','Australia'],['nz','New Zealand'],['cl','Chile'],['pe','Peru'],
  ['co','Colombia'],['ve','Venezuela'],['cu','Cuba'],['is','Iceland'],['lt','Lithuania'],
  ['lv','Latvia'],['ee','Estonia'],['ro','Romania'],['bg','Bulgaria'],['hu','Hungary'],
  ['rs','Serbia'],['hr','Croatia'],['si','Slovenia'],['sk','Slovakia'],['by','Belarus']
];

function FlagMaster({ onScore, accent }) {
  const ROUNDS = 10;
  const [gen, setGen] = useState(0);
  const [round, setRound] = useState(0);
  const [picks, setPicks] = useState([]);
  const [phase, setPhase] = useState('play');
  const [score, setScore] = useState(0);
  const submittedRef = useRef(false);

  const order = useMemo(() => {
    const a = [...COUNTRIES].sort(() => Math.random() - 0.5).slice(0, ROUNDS);
    return a.map(q => {
      const others = COUNTRIES.filter(c => c[0] !== q[0]).sort(() => Math.random() - 0.5).slice(0, 3);
      const choices = [...others, q].sort(() => Math.random() - 0.5);
      return { q, choices };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen]);

  const reset = () => {
    setRound(0); setPicks([]); setScore(0); setPhase('play');
    submittedRef.current = false; setGen(g => g + 1);
  };

  const cur = order[round];

  const pick_ = (c) => {
    if (picks[round]) return;
    const correct = c[0] === cur.q[0];
    if (correct) { sfx.good(); setScore(s => s + 1); } else sfx.bad();
    const next = [...picks];
    next[round] = { picked: c, correct };
    setPicks(next);
    setTimeout(() => {
      if (round + 1 >= ROUNDS) {
        const final = score + (correct ? 1 : 0);
        if (!submittedRef.current) { submittedRef.current = true; onScore(final); }
        setPhase('over');
      } else { setRound(r => r + 1); }
    }, 900);
  };

  if (phase === 'over') {
    return <Result accent={accent} title="GEOGRAPHY GRADED" lines={[
      ['CORRECT', `${score} / ${ROUNDS}`],
      ['ACCURACY', `${Math.round(score/ROUNDS*100)}%`]
    ]} onRetry={reset}/>;
  }

  const cp = picks[round];

  return (
    <div style={{ maxWidth:640, margin:'0 auto' }}>
      <Hud accent={accent} items={[
        ['ROUND', `${round+1}/${ROUNDS}`],
        ['CORRECT', score],
        ['LEFT', ROUNDS - round]
      ]}/>
      <div style={{ marginTop:32, textAlign:'center' }}>
        <div style={{ fontSize:11, letterSpacing:2, color:C.textDim, marginBottom:14 }}>WHICH COUNTRY?</div>
        <div style={{ display:'inline-block', padding:18, background:C.bg2, border:`1px solid ${C.border}` }}>
          <img src={`https://flagcdn.com/w320/${cur.q[0]}.png`} alt="flag"
            style={{ display:'block', width:280, height:'auto' }}
            onError={(e) => { e.target.style.opacity = 0.2; }}/>
        </div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginTop:28 }}>
        {cur.choices.map(c => {
          const isPicked = cp && cp.picked[0] === c[0];
          const isCorrect = cp && c[0] === cur.q[0];
          let bg = C.bg2, border = C.border, color = C.text;
          if (cp) {
            if (isCorrect) { bg = C.lime; border = C.lime; color = C.bg; }
            else if (isPicked) { bg = C.pink; border = C.pink; color = C.bg; }
            else { color = C.textDim; }
          }
          return (
            <button key={c[0]} disabled={!!cp} onClick={() => pick_(c)}
              onMouseEnter={() => !cp && sfx.hover()}
              style={{
                padding:'18px', background:bg, border:`1px solid ${border}`, color,
                cursor: cp ? 'default' : 'pointer', fontFamily:FONT_MONO, fontSize:13,
                fontWeight:600, letterSpacing:1, textAlign:'left',
                transition: 'background 160ms, border 160ms'
              }}>
              {c[1].toUpperCase()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
   GAME 6: REFLEX
   ============================================================ */

function Reflex({ onScore, accent }) {
  const [phase, setPhase] = useState('idle');
  const [round, setRound] = useState(0);
  const [times, setTimes] = useState([]);
  const ROUNDS = 5;
  const startRef = useRef(0);
  const timeoutRef = useRef(null);
  const submittedRef = useRef(false);

  const startRun = () => {
    setRound(0); setTimes([]); setPhase('wait'); submittedRef.current = false;
    armNext();
  };

  const armNext = () => {
    const delay = randInt(1200, 4500);
    timeoutRef.current = setTimeout(() => {
      setPhase('go');
      startRef.current = performance.now();
    }, delay);
  };

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const onTap = () => {
    if (phase === 'wait') {
      clearTimeout(timeoutRef.current); sfx.bad(); setPhase('early');
    } else if (phase === 'go') {
      const dt = performance.now() - startRef.current;
      sfx.pick();
      const newTimes = [...times, dt];
      setTimes(newTimes);
      if (newTimes.length >= ROUNDS) {
        const avg = newTimes.reduce((s,x) => s+x, 0) / newTimes.length;
        if (!submittedRef.current) { submittedRef.current = true; onScore(avg); }
        setPhase('done');
      } else { setRound(r => r + 1); setPhase('wait'); armNext(); }
    } else if (phase === 'early') {
      setPhase('wait'); armNext();
    }
  };

  if (phase === 'idle') {
    return <PrePlay accent={accent} icon={Zap} how={[
      'Tap "READY". Stare at the box.',
      'When it turns green, click as fast as you can.',
      'Don\'t click early — you\'ll have to redo that round.',
      'Five rounds. Average reaction time wins. Lower is better.'
    ]} onStart={startRun}/>;
  }
  if (phase === 'done') {
    const avg = times.reduce((s,x) => s+x, 0) / times.length;
    const best = Math.min(...times);
    return <Result accent={accent} title="REFLEX MEASURED" lines={[
      ['AVG TIME', `${Math.round(avg)}ms`],
      ['BEST', `${Math.round(best)}ms`],
      ['WORST', `${Math.round(Math.max(...times))}ms`]
    ]} onRetry={startRun}/>;
  }

  const colors = {
    wait:  { bg: C.pink,  text: 'WAIT...' },
    go:    { bg: C.lime,  text: 'CLICK!' },
    early: { bg: C.bg3,   text: 'TOO EARLY — CLICK TO RETRY' }
  };
  const s = colors[phase];

  return (
    <div>
      <Hud accent={accent} items={[
        ['ROUND', `${round+1}/${ROUNDS}`],
        ['LAST', times.length ? `${Math.round(times[times.length-1])}ms` : '—'],
        ['AVG', times.length ? `${Math.round(times.reduce((a,b)=>a+b,0)/times.length)}ms` : '—']
      ]}/>
      <button onClick={onTap}
        style={{
          marginTop:24, width:'100%', maxWidth:560, marginLeft:'auto', marginRight:'auto',
          display:'block', aspectRatio:'16 / 9', background:s.bg,
          border:`1px solid ${phase==='early' ? C.border : 'transparent'}`,
          color: phase === 'early' ? C.text : C.bg, fontFamily:FONT_DISPLAY, fontWeight:800,
          fontSize: 48, letterSpacing:-1, cursor:'pointer', transition:'background 60ms'
        }}>
        {s.text}
      </button>
    </div>
  );
}
