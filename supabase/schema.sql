-- ===========================================================================
--  AI Ad Studio — Supabase schema
--  Run this once in your project's SQL Editor (Dashboard → SQL Editor → New
--  query). Safe to re-run: every statement is idempotent.
--
--  Three tables, all owner-only via Row Level Security, plus one private
--  Storage bucket for image bytes (uploads, AI-generated images, mockup PNGs):
--      projects   one row per ad/conversation
--      assets     metadata for every image (bytes live in the `assets` bucket)
--      messages   persisted chat transcript per project
-- ===========================================================================

-- Keeps updated_at fresh on every UPDATE.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
--  projects: an ad + its scene (the JSON engine.js renders).
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null default 'Untitled',
  scene       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists projects_user_idx on public.projects (user_id, updated_at desc);

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

alter table public.projects enable row level security;

drop policy if exists "projects_select_own" on public.projects;
create policy "projects_select_own" on public.projects
  for select using (auth.uid() = user_id);
drop policy if exists "projects_insert_own" on public.projects;
create policy "projects_insert_own" on public.projects
  for insert with check (auth.uid() = user_id);
drop policy if exists "projects_update_own" on public.projects;
create policy "projects_update_own" on public.projects
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "projects_delete_own" on public.projects;
create policy "projects_delete_own" on public.projects
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
--  assets: one row per image used by a project. The bytes live in Storage at
--  `path`; we keep name + pixel dimensions here so the editor and the AI can
--  reason about images without downloading them.
--    kind ∈ upload | example | ai_image | mockup
-- ---------------------------------------------------------------------------
create table if not exists public.assets (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,                       -- logical name referenced by layers
  path        text not null,                       -- object path in the `assets` bucket
  kind        text not null default 'upload',
  width       int,
  height      int,
  created_at  timestamptz not null default now(),
  unique (project_id, name)
);
create index if not exists assets_project_idx on public.assets (project_id, created_at);

alter table public.assets enable row level security;

drop policy if exists "assets_select_own" on public.assets;
create policy "assets_select_own" on public.assets
  for select using (auth.uid() = user_id);
drop policy if exists "assets_insert_own" on public.assets;
create policy "assets_insert_own" on public.assets
  for insert with check (auth.uid() = user_id);
drop policy if exists "assets_update_own" on public.assets;
create policy "assets_update_own" on public.assets
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "assets_delete_own" on public.assets;
create policy "assets_delete_own" on public.assets
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
--  messages: the chat transcript. `content` is a JSON blob so we can store
--  rich turns (text + image refs + tool activity) without schema churn.
--    role ∈ user | assistant | system | tool
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null,
  content     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists messages_project_idx on public.messages (project_id, created_at);

alter table public.messages enable row level security;

drop policy if exists "messages_select_own" on public.messages;
create policy "messages_select_own" on public.messages
  for select using (auth.uid() = user_id);
drop policy if exists "messages_insert_own" on public.messages;
create policy "messages_insert_own" on public.messages
  for insert with check (auth.uid() = user_id);
drop policy if exists "messages_delete_own" on public.messages;
create policy "messages_delete_own" on public.messages
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
--  Storage: private bucket for image bytes. Files are stored per-user under
--  "<user_id>/<project_id>/<name>" so the folder-prefix RLS below applies.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('assets', 'assets', false)
on conflict (id) do nothing;

drop policy if exists "asset_files_select_own" on storage.objects;
create policy "asset_files_select_own" on storage.objects
  for select using (
    bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "asset_files_insert_own" on storage.objects;
create policy "asset_files_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "asset_files_update_own" on storage.objects;
create policy "asset_files_update_own" on storage.objects
  for update using (
    bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "asset_files_delete_own" on storage.objects;
create policy "asset_files_delete_own" on storage.objects
  for delete using (
    bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text
  );
