-- NEON.ARC schema --
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
