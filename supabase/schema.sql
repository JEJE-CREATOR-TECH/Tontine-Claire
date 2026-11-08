-- Tontine Claire : base de données (Supabase / PostgreSQL)
-- À coller une seule fois dans Supabase : SQL Editor > New query > Run.
-- Principe : chaque membre ne voit que les tontines dont il fait partie.
-- Toutes les modifications passent par des fonctions qui vérifient les droits.

create extension if not exists pgcrypto;

-- ---------- Tables ----------
create table if not exists public.tontines (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  amount numeric(10,2) not null check (amount > 0),
  start_month date not null,              -- 1er jour du mois du premier tour
  due_day int not null check (due_day between 1 and 28),
  created_by uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  tontine_id uuid not null references public.tontines(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  position int not null check (position >= 0),   -- 0 = reçoit au premier tour
  user_id uuid,                                   -- rempli quand le membre rejoint
  is_admin boolean not null default false,
  unique (tontine_id, position)
);
create unique index if not exists members_one_slot_per_user on public.members (tontine_id, user_id) where user_id is not null;

-- Liens d'invitation : visibles seulement par la gérante
create table if not exists public.invites (
  member_id uuid primary key references public.members(id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(18), 'hex')
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  tontine_id uuid not null references public.tontines(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  round int not null check (round >= 0),           -- numéro du tour (0 = premier mois)
  amount numeric(10,2) not null,
  method text not null default 'Autre' check (char_length(method) <= 40),
  status text not null default 'declared' check (status in ('declared', 'confirmed')),
  paid_on date not null default current_date,
  created_at timestamptz not null default now(),
  unique (member_id, round)
);

create table if not exists public.arrangements (
  id uuid primary key default gen_random_uuid(),
  tontine_id uuid not null references public.tontines(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  kind text not null check (kind in ('etaler', 'fin')),
  months int check (months between 1 and 12),
  debt numeric(10,2) not null check (debt >= 0),
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'cancelled')),
  created_at timestamptz not null default now()
);

-- ---------- Fonctions d'aide ----------
create or replace function public.is_member(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where tontine_id = t and user_id = auth.uid());
$$;

create or replace function public.is_admin(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where tontine_id = t and user_id = auth.uid() and is_admin);
$$;

-- ---------- Droits de lecture ----------
alter table public.tontines enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;
alter table public.payments enable row level security;
alter table public.arrangements enable row level security;

drop policy if exists "lecture membres" on public.tontines;
create policy "lecture membres" on public.tontines for select using (public.is_member(id));
drop policy if exists "lecture membres" on public.members;
create policy "lecture membres" on public.members for select using (public.is_member(tontine_id));
drop policy if exists "lecture gerante" on public.invites;
create policy "lecture gerante" on public.invites for select using (
  exists (select 1 from public.members m where m.id = member_id and public.is_admin(m.tontine_id)));
drop policy if exists "lecture membres" on public.payments;
create policy "lecture membres" on public.payments for select using (public.is_member(tontine_id));
drop policy if exists "lecture membres" on public.arrangements;
create policy "lecture membres" on public.arrangements for select using (public.is_member(tontine_id));
-- Aucune politique d'écriture : les modifications passent uniquement par les fonctions ci-dessous.

-- ---------- Actions ----------
create or replace function public.create_tontine(p_name text, p_amount numeric, p_start date, p_due int, p_members text[], p_me int)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid; i int; m uuid; n int := coalesce(array_length(p_members, 1), 0);
begin
  if auth.uid() is null then raise exception 'non_connecte'; end if;
  if n < 2 or n > 40 then raise exception 'membres_2_a_40'; end if;
  if p_me < 1 or p_me > n then raise exception 'position_invalide'; end if;
  insert into tontines(name, amount, start_month, due_day, created_by)
    values (trim(p_name), p_amount, date_trunc('month', p_start)::date, p_due, auth.uid()) returning id into t;
  for i in 1..n loop
    insert into members(tontine_id, name, position, user_id, is_admin)
      values (t, trim(p_members[i]), i - 1, case when i = p_me then auth.uid() end, i = p_me) returning id into m;
    insert into invites(member_id) values (m);  -- pour la gérante : lien de secours
  end loop;
  return t;
end $$;

create or replace function public.claim_invite(p_token text) returns uuid
language plpgsql security definer set search_path = public as $$
declare mem members;
begin
  if auth.uid() is null then raise exception 'non_connecte'; end if;
  select mm.* into mem from invites i join members mm on mm.id = i.member_id where i.token = p_token;
  if not found then raise exception 'invitation_inconnue'; end if;
  if mem.user_id = auth.uid() then return mem.tontine_id; end if;
  -- un lien déjà utilisé ne fonctionne plus, sauf le lien de secours de la gérante (changement de téléphone)
  if mem.user_id is not null and not mem.is_admin then raise exception 'invitation_deja_utilisee'; end if;
  if exists (select 1 from members where tontine_id = mem.tontine_id and user_id = auth.uid() and id <> mem.id) then raise exception 'deja_membre'; end if;
  update members set user_id = auth.uid() where id = mem.id;
  return mem.tontine_id;
end $$;

-- Aperçu d'une invitation avant de la rejoindre (nom de la tontine et du membre)
create or replace function public.invite_preview(p_token text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('tontine', t.name, 'member', m.name, 'amount', t.amount, 'members', (select count(*) from members where tontine_id = t.id), 'admin', m.is_admin, 'used', m.user_id is not null and not m.is_admin and m.user_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid))
  from invites i join members m on m.id = i.member_id join tontines t on t.id = m.tontine_id where i.token = p_token;
$$;

create or replace function public.declare_payment(p_tontine uuid, p_round int, p_method text, p_paid_on date default current_date) returns void
language plpgsql security definer set search_path = public as $$
declare me members; t tontines; n int;
begin
  select * into me from members where tontine_id = p_tontine and user_id = auth.uid();
  if not found then raise exception 'pas_membre'; end if;
  select * into t from tontines where id = p_tontine;
  select count(*) into n from members where tontine_id = p_tontine;
  if p_round < 0 or p_round >= n then raise exception 'tour_invalide'; end if;
  insert into payments(tontine_id, member_id, round, amount, method, status, paid_on)
    values (p_tontine, me.id, p_round, t.amount, coalesce(nullif(trim(p_method), ''), 'Autre'), case when me.is_admin then 'confirmed' else 'declared' end, least(coalesce(p_paid_on, current_date), current_date))
    on conflict (member_id, round) do nothing;
end $$;

create or replace function public.admin_record_payment(p_member uuid, p_round int, p_method text, p_paid_on date default current_date) returns void
language plpgsql security definer set search_path = public as $$
declare mem members; t tontines; n int;
begin
  select * into mem from members where id = p_member;
  if not found or not is_admin(mem.tontine_id) then raise exception 'reserve_gerante'; end if;
  select * into t from tontines where id = mem.tontine_id;
  select count(*) into n from members where tontine_id = mem.tontine_id;
  if p_round < 0 or p_round >= n then raise exception 'tour_invalide'; end if;
  insert into payments(tontine_id, member_id, round, amount, method, status, paid_on)
    values (mem.tontine_id, mem.id, p_round, t.amount, coalesce(nullif(trim(p_method), ''), 'Autre'), 'confirmed', least(coalesce(p_paid_on, current_date), current_date))
    on conflict (member_id, round) do update set status = 'confirmed';
end $$;

create or replace function public.confirm_payment(p_payment uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p payments;
begin
  select * into p from payments where id = p_payment;
  if not found or not is_admin(p.tontine_id) then raise exception 'reserve_gerante'; end if;
  update payments set status = 'confirmed' where id = p_payment;
end $$;

create or replace function public.delete_payment(p_payment uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p payments;
begin
  select * into p from payments where id = p_payment;
  if not found then return; end if;
  if is_admin(p.tontine_id)
     or (p.status = 'declared' and exists (select 1 from members where id = p.member_id and user_id = auth.uid())) then
    delete from payments where id = p_payment;
  else raise exception 'non_autorise'; end if;
end $$;

create or replace function public.propose_arrangement(p_member uuid, p_kind text, p_months int, p_debt numeric) returns void
language plpgsql security definer set search_path = public as $$
declare mem members;
begin
  select * into mem from members where id = p_member;
  if not found or not is_admin(mem.tontine_id) then raise exception 'reserve_gerante'; end if;
  update arrangements set status = 'cancelled' where member_id = p_member and status <> 'cancelled';
  insert into arrangements(tontine_id, member_id, kind, months, debt)
    values (mem.tontine_id, p_member, p_kind, case when p_kind = 'etaler' then p_months end, p_debt);
end $$;

create or replace function public.respond_arrangement(p_arrangement uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare a arrangements;
begin
  select * into a from arrangements where id = p_arrangement;
  if not found then raise exception 'introuvable'; end if;
  if not (is_admin(a.tontine_id) or exists (select 1 from members where id = a.member_id and user_id = auth.uid())) then
    raise exception 'non_autorise'; end if;
  update arrangements set status = case when p_accept then 'accepted' else 'cancelled' end where id = p_arrangement;
end $$;

create or replace function public.reset_invite(p_member uuid) returns text
language plpgsql security definer set search_path = public as $$
declare mem members; tok text;
begin
  select * into mem from members where id = p_member;
  if not found or not is_admin(mem.tontine_id) then raise exception 'reserve_gerante'; end if;
  if mem.is_admin then raise exception 'pas_pour_la_gerante'; end if;
  update members set user_id = null where id = p_member;
  tok := encode(gen_random_bytes(18), 'hex');
  insert into invites(member_id, token) values (p_member, tok) on conflict (member_id) do update set token = excluded.token;
  return tok;
end $$;

create or replace function public.delete_tontine(p_tontine uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(p_tontine) then raise exception 'reserve_gerante'; end if;
  delete from tontines where id = p_tontine;
end $$;

-- ---------- Droits d'exécution ----------
revoke all on function public.create_tontine(text, numeric, date, int, text[], int), public.claim_invite(text),
  public.invite_preview(text), public.declare_payment(uuid, int, text, date), public.admin_record_payment(uuid, int, text, date),
  public.confirm_payment(uuid), public.delete_payment(uuid), public.propose_arrangement(uuid, text, int, numeric),
  public.respond_arrangement(uuid, boolean), public.reset_invite(uuid), public.delete_tontine(uuid) from public, anon;
grant execute on function public.create_tontine(text, numeric, date, int, text[], int), public.claim_invite(text),
  public.invite_preview(text), public.declare_payment(uuid, int, text, date), public.admin_record_payment(uuid, int, text, date),
  public.confirm_payment(uuid), public.delete_payment(uuid), public.propose_arrangement(uuid, text, int, numeric),
  public.respond_arrangement(uuid, boolean), public.reset_invite(uuid), public.delete_tontine(uuid) to authenticated;
grant select on public.tontines, public.members, public.invites, public.payments, public.arrangements to authenticated;
