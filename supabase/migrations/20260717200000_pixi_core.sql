create extension if not exists pgcrypto;

create table if not exists public.notebooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pages (
  id uuid primary key default gen_random_uuid(),
  notebook_id uuid not null references public.notebooks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled page',
  position integer not null default 0,
  status text not null default 'blank' check (status in ('blank', 'processing', 'review', 'confirmed', 'error')),
  image_path text,
  markdown text,
  spatial_data jsonb,
  confidence real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ocr_rate_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0)
);

create index if not exists notebooks_user_id_idx on public.notebooks(user_id);
create index if not exists pages_notebook_position_idx on public.pages(notebook_id, position);
create index if not exists pages_user_id_idx on public.pages(user_id);

alter table public.notebooks enable row level security;
alter table public.pages enable row level security;
alter table public.ocr_rate_limits enable row level security;

revoke all on table public.notebooks from anon;
revoke all on table public.pages from anon;
revoke all on table public.ocr_rate_limits from anon, authenticated;
grant select, insert, update, delete on table public.notebooks to authenticated;
grant select, insert, update, delete on table public.pages to authenticated;

create policy "Users can read their notebooks" on public.notebooks for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can create their notebooks" on public.notebooks for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update their notebooks" on public.notebooks for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete their notebooks" on public.notebooks for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users can read their pages" on public.pages for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can create their pages" on public.pages for insert to authenticated with check (
  (select auth.uid()) = user_id and exists (
    select 1 from public.notebooks where notebooks.id = notebook_id and notebooks.user_id = (select auth.uid())
  )
);
create policy "Users can update their pages" on public.pages for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete their pages" on public.pages for delete to authenticated using ((select auth.uid()) = user_id);

create or replace function public.consume_ocr_quota()
returns table (allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  current_window timestamptz;
  current_count integer;
begin
  if caller_id is null then
    raise insufficient_privilege using message = 'Authentication required';
  end if;

  insert into public.ocr_rate_limits as limits (user_id, window_started_at, request_count)
  values (caller_id, now(), 1)
  on conflict (user_id) do update
  set
    window_started_at = case
      when limits.window_started_at <= now() - interval '1 hour' then now()
      else limits.window_started_at
    end,
    request_count = case
      when limits.window_started_at <= now() - interval '1 hour' then 1
      else limits.request_count + 1
    end
  returning window_started_at, request_count into current_window, current_count;

  return query select
    current_count <= 10,
    greatest(0, 10 - current_count),
    current_window + interval '1 hour';
end;
$$;

revoke all on function public.consume_ocr_quota() from public, anon;
grant execute on function public.consume_ocr_quota() to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'notebook-pages',
  'notebook-pages',
  false,
  20971520,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "Users can read their notebook images" on storage.objects for select to authenticated using (
  bucket_id = 'notebook-pages' and (storage.foldername(name))[1] = (select auth.uid())::text
);
create policy "Users can upload their notebook images" on storage.objects for insert to authenticated with check (
  bucket_id = 'notebook-pages' and (storage.foldername(name))[1] = (select auth.uid())::text
);
create policy "Users can update their notebook images" on storage.objects for update to authenticated using (
  bucket_id = 'notebook-pages' and (storage.foldername(name))[1] = (select auth.uid())::text
  ) with check (
  bucket_id = 'notebook-pages' and (storage.foldername(name))[1] = (select auth.uid())::text
);
create policy "Users can delete their notebook images" on storage.objects for delete to authenticated using (
  bucket_id = 'notebook-pages' and (storage.foldername(name))[1] = (select auth.uid())::text
);
