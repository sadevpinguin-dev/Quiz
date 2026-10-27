
create table if not exists public.rooms (
  pin text primary key check (pin ~ '^[0-9]{6}$'),
  host_token_hash text not null,
  status text not null default 'lobby'
    check (status in ('lobby','question','finished')),
  question_index integer not null default 0,
  question_started_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.players (
  id bigint generated always as identity primary key,
  pin text not null references public.rooms(pin) on delete cascade,
  name text not null check (char_length(name) between 1 and 20),
  token_hash text not null,
  score integer not null default 0,
  answered_index integer not null default -1,
  joined_at timestamptz not null default now(),
  unique(pin, name),
  unique(pin, token_hash)
);

create index if not exists players_pin_score_idx
on public.players(pin, score desc);

create table if not exists public.room_updates (
  id bigint generated always as identity primary key,
  pin text not null,
  updated_at timestamptz not null default now()
);

alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.room_updates enable row level security;

revoke all on public.rooms from anon, authenticated;
revoke all on public.players from anon, authenticated;
revoke all on public.room_updates from anon, authenticated;
