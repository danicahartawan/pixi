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

create index if not exists notebooks_user_id_idx on public.notebooks(user_id);
create index if not exists pages_notebook_position_idx on public.pages(notebook_id, position);
create index if not exists pages_user_id_idx on public.pages(user_id);

alter table public.notebooks enable row level security;
alter table public.pages enable row level security;

create policy "Users can read their notebooks" on public.notebooks for select using (auth.uid() = user_id);
create policy "Users can create their notebooks" on public.notebooks for insert with check (auth.uid() = user_id);
create policy "Users can update their notebooks" on public.notebooks for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete their notebooks" on public.notebooks for delete using (auth.uid() = user_id);

create policy "Users can read their pages" on public.pages for select using (auth.uid() = user_id);
create policy "Users can create their pages" on public.pages for insert with check (
  auth.uid() = user_id and exists (
    select 1 from public.notebooks where notebooks.id = notebook_id and notebooks.user_id = auth.uid()
  )
);
create policy "Users can update their pages" on public.pages for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete their pages" on public.pages for delete using (auth.uid() = user_id);

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

create policy "Users can read their notebook images" on storage.objects for select using (
  bucket_id = 'notebook-pages' and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "Users can upload their notebook images" on storage.objects for insert with check (
  bucket_id = 'notebook-pages' and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "Users can update their notebook images" on storage.objects for update using (
  bucket_id = 'notebook-pages' and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "Users can delete their notebook images" on storage.objects for delete using (
  bucket_id = 'notebook-pages' and (storage.foldername(name))[1] = auth.uid()::text
);
