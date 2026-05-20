# NEON.ARC

Six tiny browser games with shared global leaderboards. React + Vite frontend, Supabase for auth + Postgres.

## Local development

Requires Node 18+.

```bash
npm install
cp .env.example .env.local   # then fill in your Supabase URL + anon key
npm run dev
```

Visit http://localhost:5173.

If you skip the `.env.local` step, the app falls back to an in-browser setup screen that walks you through configuring Supabase. That works for local testing but for a public deploy you want the env-var path so visitors don't see the setup wizard.

## Supabase setup

1. Create a free project at supabase.com.
2. **Authentication → Providers → Email**: turn OFF "Confirm email" (the app uses usernames as fake emails, so there's no inbox).
3. **SQL Editor**: paste and run the schema from `supabase-schema.sql`.
4. **Project Settings → API**: grab the Project URL and the `anon public` key (NOT `service_role`).

## Deploy to Vercel

### 1. Push to GitHub

From this folder:

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
```

Create an empty repo on github.com (don't add a README — you already have one), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/neon-arc.git
git push -u origin main
```

### 2. Import to Vercel

1. Go to vercel.com, sign in with GitHub.
2. Click **Add New → Project**, pick your `neon-arc` repo, click **Import**.
3. Vercel auto-detects Vite. Leave all build settings at their defaults.
4. **Before clicking Deploy**, expand "Environment Variables" and add:
   - `VITE_SUPABASE_URL` = your Supabase URL
   - `VITE_SUPABASE_ANON_KEY` = your anon key
5. Hit **Deploy**. ~30 seconds later you have a live URL.

### Updating

Every `git push` to `main` triggers a fresh deploy automatically.

## How it works (briefly)

- `src/App.jsx` is the entire app — auth screen, six games, leaderboard, settings.
- `src/storage-shim.js` polyfills the Claude artifact's `window.storage` API onto regular `localStorage`. Don't remove this; the app references `window.storage` for session persistence.
- The app reads `import.meta.env.VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` at build time. If they're set, the setup wizard is skipped.
- Auth uses Supabase's email/password flow with synthesized `username@neonarc.local` addresses (which is why you have to disable email confirmation).
- Row Level Security in Postgres handles authorization. The anon key is safe to ship in the bundle because RLS gates everything: anyone can read scores (for leaderboards), but only the authenticated owner can write theirs.

## Why is `VITE_SUPABASE_ANON_KEY` safe to commit to client code?

It's designed to be public. The anon key only lets the client through to whatever Row Level Security policies allow. In this schema:

- `profiles`: SELECT is public; INSERT/UPDATE require `auth.uid() = id`
- `scores`: SELECT is public; INSERT/UPDATE require `auth.uid() = user_id`

So even with the key, nobody can write scores under someone else's name. The key you must NEVER ship is the `service_role` one, which bypasses RLS.
