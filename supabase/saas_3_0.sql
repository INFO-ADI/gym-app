-- =====================================================================
-- Gym SaaS 3.0 (kanpurgym.com): ONE database, MANY gyms.
-- Run after schema.sql, upgrade_2_1.sql, upgrade_2_2.sql, upgrade_2_3.sql.
--
-- How gyms are kept apart:
--  * every gym table gets a gym_id column (filled in automatically)
--  * all gym code runs as the role gym_runner, which can NOT bypass row level security,
--    and every gym table has a policy "gym_id = the gym of this request"
--  * public.gym_api(p_gym, ...) looks the gym up and pins it for the request
--    (set_config('gym.id', ..., true)), so a request only ever sees that one gym's rows
--  * platform.* holds the gyms list, subscriptions, payments to you, leads and super admins
--
-- WARNING: this removes all existing single-gym data (members, owners, payments...).
-- =====================================================================

-- ---------------------------------------------------------------- 0. start clean
truncate table public.announcements, public.batches, public.checkins, public.coupons, public.diet_plans, public.expenses,
  public.freeze_log, public.freeze_requests, public.leads, public.login_attempts, public.member_sessions, public.members,
  public.order_items, public.orders, public.owners, public.payments, public.plans, public.products, public.pt_packages,
  public.pt_sessions, public.referrals, public.settings, public.trainers, public.weights restart identity cascade;
delete from auth.users;

drop function if exists public.gym_setup(text, jsonb);
drop function if exists public.gym_installed();
drop function if exists public.gym_api(text, jsonb, text);
drop policy if exists "gym owner adds product photos" on storage.objects;
drop policy if exists "gym owner reads product photo list" on storage.objects;
drop policy if exists "gym owner replaces product photos" on storage.objects;
drop policy if exists "gym owner removes product photos" on storage.objects;

-- ---------------------------------------------------------------- 1. the role that runs all gym code
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'gym_runner') then
    create role gym_runner nologin noinherit nobypassrls;
  end if;
end $$;
grant gym_runner to postgres with set true;      -- lets the migration hand functions over to gym_runner

-- ---------------------------------------------------------------- 2. platform tables
create schema if not exists platform;
revoke all on schema platform from public, anon, authenticated;

create table platform.gyms (
  id bigint generated always as identity primary key,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'),
  name text not null check (length(name) between 2 and 80),
  short_name text not null check (length(short_name) between 1 and 20),
  city text check (length(city) <= 60),
  owner_name text check (length(owner_name) <= 100),
  owner_phone text check (owner_phone ~ '^91[5-9][0-9]{9}$'),
  a1 text not null default '#ffb300' check (a1 ~ '^#[0-9a-f]{6}$'),
  a2 text not null default '#ff6a00' check (a2 ~ '^#[0-9a-f]{6}$'),
  a3 text not null default '#ff2e63' check (a3 ~ '^#[0-9a-f]{6}$'),
  accent text not null default '#ff8a00' check (accent ~ '^#[0-9a-f]{6}$'),
  bg text not null default '#0f1115' check (bg ~ '^#[0-9a-f]{6}$'),
  logo_version int not null default 0 check (logo_version >= 0),
  status text not null default 'active' check (status in ('active','suspended')),
  plan text not null default 'trial' check (plan in ('trial','monthly','yearly')),
  trial_ends date not null,
  paid_until date,
  setup_code_hash text,
  setup_code_expires timestamptz,
  claimed_at timestamptz,
  notes text check (length(notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz);

create table platform.super_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now());

create table platform.payments (
  id bigint generated always as identity primary key,
  gym_id bigint references platform.gyms(id) on delete set null,
  gym_slug text not null,
  gym_name text not null,
  plan text not null check (plan in ('monthly','yearly')),
  amount int not null check (amount between 0 and 1000000),
  mode text not null default 'upi' check (mode in ('upi','cash','bank')),
  paid_on date not null,
  period_from date not null,
  period_to date not null,
  note text check (length(note) <= 200),
  created_at timestamptz not null default now());

create table platform.leads (
  id bigint generated always as identity primary key,
  name text not null check (length(name) between 2 and 100),
  gym_name text check (length(gym_name) <= 100),
  phone text not null check (phone ~ '^91[5-9][0-9]{9}$'),
  city text check (length(city) <= 60),
  message text check (length(message) <= 500),
  status text not null default 'new' check (status in ('new','contacted','demo','won','lost')),
  notes text check (length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz);

create table platform.settings (k text primary key, v text not null);

create table platform.attempts (
  id bigint generated always as identity primary key,
  k text not null,
  at timestamptz not null default now());
create index attempts_k_at_idx on platform.attempts (k, at);

alter table platform.gyms enable row level security;
alter table platform.super_admins enable row level security;
alter table platform.payments enable row level security;
alter table platform.leads enable row level security;
alter table platform.settings enable row level security;
alter table platform.attempts enable row level security;
revoke all on all tables in schema platform from public, anon, authenticated;
-- gym code may read the gyms list and platform settings (nothing else)
create policy gym_runner_reads on platform.gyms for select to gym_runner using (true);
create policy gym_runner_reads on platform.settings for select to gym_runner using (true);
grant select on platform.gyms, platform.settings to gym_runner;

insert into platform.settings (k, v) values
  ('price_month', '800'), ('price_year', '4999'), ('trial_days', '30'), ('grace_days', '3'),
  ('whatsapp', ''), ('base_domain', 'kanpurgym.com'), ('demo_slug', 'demo'), ('url_style', 'subdomain'),
  ('admin_setup_hash', '0f3ee7cc312ee3e890fbe58418b8dbeeb4c6b714da295256b2e6ab2d1efdcbe4');

-- ---------------------------------------------------------------- 3. who is calling, which gym
create or replace function gymp.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
create or replace function gymp.jwt_email() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', '') $$;
create or replace function gymp.gym_id() returns bigint language sql stable as $$
  select nullif(current_setting('gym.id', true), '')::bigint $$;
create or replace function gymp.gym_slug() returns text language sql stable as $$
  select nullif(current_setting('gym.slug', true), '') $$;

-- ---------------------------------------------------------------- 4. every gym table: gym_id + "only this gym" policy
do $$
declare t text;
begin
  foreach t in array array['announcements','batches','checkins','coupons','diet_plans','expenses','freeze_log','freeze_requests',
    'leads','login_attempts','member_sessions','members','order_items','orders','owners','payments','plans','products',
    'pt_packages','pt_sessions','referrals','settings','trainers','weights'] loop
    execute format('alter table public.%I add column gym_id bigint not null default gymp.gym_id() references platform.gyms(id) on delete cascade', t);
    execute format('create index %I on public.%I (gym_id)', t || '_gym_idx', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy only_this_gym on public.%I for all to gym_runner using (gym_id = (select gymp.gym_id())) with check (gym_id = (select gymp.gym_id()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to gym_runner', t);
  end loop;
end $$;

-- uniqueness is now per gym (two gyms may both have a member with the same phone, a coupon FIT10 ...)
alter table public.settings drop constraint settings_pkey, add primary key (gym_id, k);
alter table public.owners drop constraint owners_pkey, add primary key (gym_id, user_id);
alter table public.members drop constraint members_code_key, drop constraint members_phone_key,
  add constraint members_gym_code_key unique (gym_id, code), add constraint members_gym_phone_key unique (gym_id, phone);
alter table public.coupons drop constraint coupons_code_key, add constraint coupons_gym_code_key unique (gym_id, code);
-- product photos live in a folder per gym: <slug>/<uuid>.jpg
alter table public.products drop constraint products_photo_check,
  add constraint products_photo_check check (photo ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]/[a-f0-9-]{36}\.jpg$');

grant usage on schema public, gymp, extensions, platform to gym_runner;
grant usage, select on all sequences in schema public to gym_runner;

-- ---------------------------------------------------------------- 5. gym helpers that change
create or replace function gymp.owner_id() returns uuid language sql stable as $$
  select user_id from public.owners where user_id = gymp.uid() $$;
create or replace function gymp.is_owner() returns boolean language sql stable as $$
  select exists (select 1 from public.owners where user_id = gymp.uid()) $$;
create or replace function gymp.set_setting(key text, val text) returns void language sql as $$
  insert into public.settings (k, v) values (key, val) on conflict (gym_id, k) do update set v = excluded.v $$;
create or replace function gymp.next_seq(key text) returns int language sql as $$
  insert into public.settings (k, v) values (key, '1')
  on conflict (gym_id, k) do update set v = ((public.settings.v)::int + 1)::text
  returning v::int $$;

-- subscription state of a gym (trial / active / grace / expired / suspended)
create or replace function gymp.gym_state(g platform.gyms) returns jsonb language sql stable as $$
  with x as (select greatest(coalesce(g.paid_until, g.trial_ends), g.trial_ends) as ends,
                    coalesce((select v from platform.settings where k = 'grace_days'), '3')::int as grace)
  select jsonb_build_object('plan', g.plan, 'ends', gymp.d(x.ends), 'days_left', x.ends - gymp.today(),
    'state', case when g.status = 'suspended' then 'suspended'
                  when gymp.today() > x.ends + x.grace then 'expired'
                  when gymp.today() > x.ends then 'grace'
                  when g.paid_until is null or g.paid_until <= g.trial_ends then 'trial'
                  else 'active' end,
    'locked', g.status = 'suspended' or gymp.today() > x.ends + x.grace)
  from x $$;

create or replace function gymp.brand_json(g platform.gyms) returns jsonb language sql stable as $$
  select jsonb_build_object('slug', g.slug, 'name', g.name, 'short_name', g.short_name,
    'colors', jsonb_build_object('a1', g.a1, 'a2', g.a2, 'a3', g.a3, 'accent', g.accent, 'bg', g.bg),
    'logo_version', g.logo_version) $$;

create or replace function gymp.act_info(p_token text) returns jsonb language plpgsql as $$
declare o public.owners; m public.members; who jsonb; g platform.gyms;
begin
  select * into g from platform.gyms where id = gymp.gym_id();
  select * into o from public.owners where user_id = gymp.uid();
  if o.user_id is not null then who := jsonb_build_object('role', 'owner', 'name', o.name, 'email', o.email);
  else
    m := gymp.member_from_token(p_token);
    if m.id is not null then who := jsonb_build_object('role', 'member', 'name', m.name, 'code', m.code, 'pin_must_change', m.pin_must_change); end if;
  end if;
  return jsonb_build_object('gym', jsonb_build_object('name', gymp.setting('gym_name', g.name)) || jsonb_build_object('brand', gymp.brand_json(g)),
    'me', who, 'installed', exists (select 1 from public.owners), 'version', '3.0.0',
    'sub', gymp.gym_state(g), 'contact', coalesce((select v from platform.settings where k = 'whatsapp'), ''));
end $$;

create or replace function gymp.o_settings() returns jsonb language plpgsql as $$
declare o public.owners;
begin
  select * into o from public.owners where user_id = gymp.uid();
  return jsonb_build_object('settings', jsonb_build_object('gym_name', gymp.setting('gym_name'), 'gym_address', gymp.setting('gym_address'),
      'gym_timings', gymp.setting('gym_timings'), 'gym_whatsapp', gymp.setting('gym_whatsapp'), 'gym_maps', gymp.setting('gym_maps'),
      'upi_id', gymp.setting('upi_id'), 'upi_name', gymp.setting('upi_name')),
    'templates', gymp.templates(), 'owner', jsonb_build_object('name', o.name, 'email', o.email), 'last_backup', gymp.setting('last_backup'));
end $$;

create or replace function gymp.o_product_save(p jsonb) returns jsonb language plpgsql as $$
declare v_id bigint := case when coalesce(p ->> 'id', '') = '' then 0 else gymp.j_id(p, 'id') end; nm text := gymp.j_text(p, 'name', 100);
  cat text := coalesce(nullif(gymp.j_text(p, 'category', 40), ''), 'Other'); v_price int := gymp.j_int(p, 'price', 0, 1000000, 'bad_amount');
  v_stock int := gymp.j_int(p, 'stock', 0, 100000, 'bad_stock'); vis boolean := gymp.j_bool(p, 'visible');
  v_photo text := nullif(p ->> 'photo', ''); old text;
begin
  if length(nm) < 2 then perform gymp.fail('name_required'); end if;
  -- a photo must sit in this gym's own folder
  if v_photo is not null and (v_photo !~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]/[a-f0-9-]{36}\.jpg$' or split_part(v_photo, '/', 1) <> gymp.gym_slug()) then
    perform gymp.fail('bad_photo');
  end if;
  if v_id > 0 then
    select products.photo into old from public.products where id = v_id;
    if not found then perform gymp.fail('not_found'); end if;
    update public.products set name = nm, category = cat, price = v_price, stock = v_stock, visible = vis,
      photo = coalesce(v_photo, products.photo) where id = v_id;
  else
    insert into public.products (name, category, price, stock, photo, visible) values (nm, cat, v_price, v_stock, v_photo, vis) returning id into v_id;
    old := null;
  end if;
  return jsonb_build_object('id', v_id, 'old_photo', case when v_photo is not null and old is distinct from v_photo then old end);
end $$;

-- first owner of a gym fills in its details (runs as gym_runner, inside one gym)
create or replace function gymp.setup_gym(p_data jsonb, p_uid uuid, p_email text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare nm text; gym text; upi text; wa text; pl jsonb; plans_added int := 0; demo jsonb;
begin
  if gymp.gym_id() is null then perform gymp.fail('gym_not_found'); end if;
  nm := gymp.j_text(p_data, 'owner_name', 100);
  gym := coalesce(nullif(gymp.j_text(p_data, 'gym_name', 80), ''), (select name from platform.gyms where id = gymp.gym_id()));
  upi := btrim(coalesce(p_data ->> 'upi_id', '')); wa := btrim(coalesce(p_data ->> 'gym_whatsapp', ''));
  if length(nm) < 2 then perform gymp.fail('owner_name_required'); end if;
  if length(gym) < 2 then perform gymp.fail('gym_name_required'); end if;
  if upi <> '' and upi !~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,30}$' then perform gymp.fail('bad_upi'); end if;
  if wa <> '' then wa := gymp.norm_phone(wa); if wa is null then perform gymp.fail('bad_phone'); end if; end if;
  insert into public.owners (user_id, name, email) values (p_uid, nm, coalesce(p_email, ''));
  perform gymp.set_setting('gym_name', gym);
  perform gymp.set_setting('gym_address', gymp.j_text(p_data, 'gym_address', 200));
  perform gymp.set_setting('gym_timings', gymp.j_text(p_data, 'gym_timings', 120));
  perform gymp.set_setting('gym_whatsapp', coalesce(wa, ''));
  perform gymp.set_setting('gym_maps', '');
  perform gymp.set_setting('upi_id', upi);
  perform gymp.set_setting('upi_name', coalesce(nullif(gymp.j_text(p_data, 'upi_name', 60), ''), gym));
  perform gymp.set_setting('last_backup', gymp.d(gymp.today()));
  perform gymp.set_setting('installed_at', gymp.ts(now()));
  if jsonb_typeof(p_data -> 'plans') = 'array' then
    for pl in select * from jsonb_array_elements(p_data -> 'plans') loop
      if gymp.j_text(pl, 'name', 60) = '' then continue; end if;
      insert into public.plans (name, months, fee, sort) values (gymp.j_text(pl, 'name', 60), gymp.j_int(pl, 'months', 1, 36, 'bad_plan_months'),
        gymp.j_int(pl, 'fee', 0, 1000000, 'bad_plan_fee'), plans_added);
      plans_added := plans_added + 1;
    end loop;
  end if;
  if plans_added = 0 then perform gymp.fail('add_at_least_one_plan'); end if;
  if gymp.j_bool(p_data, 'demo') then demo := gymp.install_demo(); end if;
  return jsonb_build_object('demo', demo, 'email', p_email);
end $$;

-- ---------------------------------------------------------------- 6. the door into a gym
create function public.gym_api(p_gym text, p_action text, p_in jsonb default '{}'::jsonb, p_token text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g platform.gyms; o_id uuid; m public.members; res jsonb; msg text; pre text; st jsonb;
begin
  p_in := coalesce(p_in, '{}'::jsonb);
  if jsonb_typeof(p_in) <> 'object' then return jsonb_build_object('ok', false, 'error', 'bad_json'); end if;
  if p_action is null or p_action !~ '^[a-z_]{2,40}$' then return jsonb_build_object('ok', false, 'error', 'bad_action'); end if;
  if p_gym is null or p_gym !~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$' then return jsonb_build_object('ok', false, 'error', 'gym_not_found'); end if;
  select * into g from platform.gyms where slug = p_gym;
  if g.id is null then return jsonb_build_object('ok', false, 'error', 'gym_not_found'); end if;
  perform set_config('gym.id', g.id::text, true);
  perform set_config('gym.slug', g.slug, true);
  if p_action <> 'info' and not exists (select 1 from public.owners) then return jsonb_build_object('ok', false, 'error', 'not_installed'); end if;
  st := gymp.gym_state(g);
  if (st ->> 'locked')::boolean and p_action not in ('info', 'logout') then
    return jsonb_build_object('ok', false, 'error', 'subscription_expired');
  end if;
  begin
    if p_action = 'info' then res := gymp.act_info(p_token);
    elsif p_action = 'login_member' then res := gymp.act_login_member(p_in);
    elsif p_action = 'logout' then res := coalesce(gymp.act_logout(p_token), jsonb_build_object('bye', true));
    elsif p_action = 'join_request' then res := gymp.act_join_request(p_in);
    else
      perform gymp.auto_unfreeze();
      o_id := gymp.owner_id();
      if o_id is null and p_token is not null then m := gymp.member_from_token(p_token); end if;
      pre := left(p_action, 2);
      if pre = 'o_' and o_id is null then
        if m.id is not null then perform gymp.fail('forbidden'); else perform gymp.fail('login_required'); end if;
      elsif pre = 'm_' and m.id is null then
        if o_id is not null then perform gymp.fail('forbidden'); else perform gymp.fail('login_required'); end if;
      elsif p_action = 'receipt' and o_id is null and m.id is null then perform gymp.fail('login_required');
      end if;
      if m.id is not null and m.pin_must_change and p_action not in ('m_home', 'm_change_pin') then perform gymp.fail('pin_change_required'); end if;

      res := case p_action
        when 'm_home' then gymp.m_home(m)
        when 'm_plans' then gymp.m_plans()
        when 'm_renew' then gymp.m_renew(m, p_in)
        when 'm_history' then gymp.m_history(m)
        when 'm_products' then gymp.m_products()
        when 'm_order' then gymp.m_order(m, p_in)
        when 'm_order_paid' then gymp.m_order_paid(m, p_in)
        when 'm_order_cancel' then gymp.m_order_cancel(m, p_in)
        when 'm_change_pin' then gymp.m_change_pin(m, p_in)
        when 'm_checkin' then gymp.m_checkin(m, p_in)
        when 'm_stats' then gymp.m_stats(m)
        when 'm_weight' then gymp.m_weight(m, p_in)
        when 'receipt' then gymp.receipt(p_in, case when o_id is null then m.id end)
        when 'o_dashboard' then gymp.o_dashboard()
        when 'o_members' then gymp.o_members(p_in)
        when 'o_member' then gymp.o_member(p_in)
        when 'o_member_save' then gymp.o_member_save(p_in)
        when 'o_member_action' then gymp.o_member_action(p_in)
        when 'o_plans' then gymp.o_plans()
        when 'o_plan_save' then gymp.o_plan_save(p_in)
        when 'o_reminders' then gymp.o_reminders()
        when 'o_mark_reminded' then gymp.o_mark_reminded(p_in)
        when 'o_payments' then gymp.o_payments(p_in)
        when 'o_payment_decide' then gymp.o_payment_decide(p_in)
        when 'o_payment_record' then gymp.o_payment_record(p_in)
        when 'o_products' then gymp.o_products()
        when 'o_product_save' then gymp.o_product_save(p_in)
        when 'o_product_delete' then gymp.o_product_delete(p_in)
        when 'o_orders' then gymp.o_orders(p_in)
        when 'o_order_status' then gymp.o_order_status(p_in)
        when 'o_announcements' then gymp.o_announcements()
        when 'o_announcement_save' then gymp.o_announcement_save(p_in)
        when 'o_announcement_delete' then gymp.o_announcement_delete(p_in)
        when 'o_report' then gymp.o_report(p_in)
        when 'o_export' then gymp.o_export(p_in)
        when 'o_settings' then gymp.o_settings()
        when 'o_settings_save' then gymp.o_settings_save(p_in)
        when 'o_import_members' then gymp.o_import_members(p_in)
        when 'o_remove_demo' then gymp.o_remove_demo()
        when 'o_checkins' then gymp.o_checkins()
        when 'o_checkin_member' then gymp.o_checkin_member(p_in)
        when 'o_checkin_settings' then gymp.o_checkin_settings(p_in)
        when 'o_workouts' then gymp.o_workouts(p_in)
        when 'o_insights' then gymp.o_insights()
        else gymp.extra_action(p_action, p_in, m, o_id) end;
      if res is null then perform gymp.fail('bad_action'); end if;
      if p_action = 'o_remove_demo' then perform gymp.o_remove_demo_extras(); end if;
    end if;
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg like 'GYM:%' then return jsonb_build_object('ok', false, 'error', substr(msg, 5)); end if;
    raise warning 'gym_api(%, %) failed: %', p_gym, p_action, msg;
    return jsonb_build_object('ok', false, 'error', 'server_error');
  end;
  if res ? '__err' then return jsonb_build_object('ok', false, 'error', res ->> '__err'); end if;
  return jsonb_build_object('ok', true, 'data', res);
end $$;

-- ---------------------------------------------------------------- 7. claiming a gym (its owner, with the setup code you gave them)
create or replace function platform.new_code() returns text language plpgsql as $$
declare alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; b bytea := extensions.gen_random_bytes(16); s text := ''; i int;
begin
  for i in 0 .. 15 loop
    s := s || substr(alphabet, (get_byte(b, i) % length(alphabet)) + 1, 1);
    if i in (3, 7, 11) then s := s || '-'; end if;
  end loop;
  return s;
end $$;
create or replace function platform.code_hash(code text) returns text language sql immutable as $$
  select encode(extensions.digest(upper(btrim(coalesce(code, ''))), 'sha256'), 'hex') $$;
create or replace function platform.setting(key text, dflt text default '') returns text language sql stable as $$
  select coalesce((select v from platform.settings where k = key), dflt) $$;
create or replace function platform.too_many(key text, max_n int, win interval) returns boolean language sql as $$
  delete from platform.attempts where at < now() - interval '2 days';
  select count(*) >= max_n from platform.attempts where k = key and at > now() - win $$;

create function public.gym_claim(p_gym text, p_code text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := gymp.uid(); em text := gymp.jwt_email(); g platform.gyms; res jsonb; msg text; v_key text;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not_logged_in'); end if;
  if p_gym is null or p_gym !~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$' then return jsonb_build_object('ok', false, 'error', 'gym_not_found'); end if;
  select * into g from platform.gyms where slug = p_gym for update;
  if g.id is null then return jsonb_build_object('ok', false, 'error', 'gym_not_found'); end if;
  v_key := 'claim:' || g.id;
  if platform.too_many(v_key, 10, interval '15 minutes') then return jsonb_build_object('ok', false, 'error', 'too_many_attempts'); end if;
  if g.setup_code_hash is null or g.setup_code_expires < now() or platform.code_hash(p_code) <> g.setup_code_hash then
    insert into platform.attempts (k) values (v_key);
    perform pg_sleep(1);
    return jsonb_build_object('ok', false, 'error', 'wrong_setup_code');
  end if;
  perform set_config('gym.id', g.id::text, true);
  perform set_config('gym.slug', g.slug, true);
  begin
    if exists (select 1 from public.owners where gym_id = g.id) then
      -- the gym is already set up: this code adds one more owner login (e.g. a partner)
      insert into public.owners (gym_id, user_id, name, email)
        values (g.id, uid, coalesce(nullif(gymp.j_text(p_data, 'owner_name', 100), ''), 'Owner'), coalesce(em, ''))
        on conflict do nothing;
      res := jsonb_build_object('added_owner', true);
    else
      res := gymp.setup_gym(p_data, uid, em);
    end if;
  exception when others then
    get stacked diagnostics msg = message_text;
    return jsonb_build_object('ok', false, 'error', case when msg like 'GYM:%' then substr(msg, 5) else 'setup_failed' end);
  end;
  update platform.gyms set setup_code_hash = null, setup_code_expires = null, claimed_at = coalesce(claimed_at, now()), updated_at = now() where id = g.id;
  return jsonb_build_object('ok', true, 'data', res);
end $$;

-- ---------------------------------------------------------------- 8. public website (landing page, branding)
create function public.site_api(p_action text, p_in jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g platform.gyms; ip text; v_name text; v_phone text; v_slug text;
begin
  p_in := coalesce(p_in, '{}'::jsonb);
  if jsonb_typeof(p_in) <> 'object' then return jsonb_build_object('ok', false, 'error', 'bad_json'); end if;
  if p_action = 'site' then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'price_month', platform.setting('price_month', '800')::int, 'price_year', platform.setting('price_year', '4999')::int,
      'trial_days', platform.setting('trial_days', '30')::int, 'whatsapp', platform.setting('whatsapp'),
      'demo_slug', platform.setting('demo_slug'), 'base_domain', platform.setting('base_domain'), 'url_style', platform.setting('url_style', 'subdomain'),
      'demo_ready', exists (select 1 from platform.gyms x where x.slug = platform.setting('demo_slug') and x.claimed_at is not null)));
  elsif p_action = 'brand' then
    v_slug := lower(coalesce(p_in ->> 'slug', ''));
    if v_slug !~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$' then return jsonb_build_object('ok', false, 'error', 'gym_not_found'); end if;
    select * into g from platform.gyms where slug = v_slug;
    if g.id is null then return jsonb_build_object('ok', false, 'error', 'gym_not_found'); end if;
    return jsonb_build_object('ok', true, 'data', gymp.brand_json(g) || jsonb_build_object(
      'claimed', g.claimed_at is not null, 'locked', (gymp.gym_state(g) ->> 'locked')::boolean));
  elsif p_action = 'lead' then
    ip := gymp.client_ip();
    if platform.too_many('lead:' || ip, 5, interval '1 hour') or platform.too_many('lead:all', 200, interval '1 day') then
      return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
    end if;
    insert into platform.attempts (k) values ('lead:' || ip), ('lead:all');
    v_name := gymp.clean(p_in ->> 'name', 100);
    v_phone := gymp.norm_phone(p_in ->> 'phone');
    if length(v_name) < 2 then return jsonb_build_object('ok', false, 'error', 'name_required'); end if;
    if v_phone is null then return jsonb_build_object('ok', false, 'error', 'bad_phone'); end if;
    if not exists (select 1 from platform.leads where phone = v_phone and created_at > now() - interval '1 day') then
      insert into platform.leads (name, gym_name, phone, city, message)
        values (v_name, nullif(gymp.clean(p_in ->> 'gym_name', 100), ''), v_phone, nullif(gymp.clean(p_in ->> 'city', 60), ''), nullif(gymp.clean(p_in ->> 'message', 500), ''));
    end if;
    return jsonb_build_object('ok', true, 'data', jsonb_build_object('received', true));
  end if;
  return jsonb_build_object('ok', false, 'error', 'bad_action');
end $$;

-- ---------------------------------------------------------------- 9. super admin
create or replace function platform.gym_json(g platform.gyms) returns jsonb language sql stable as $$
  select gymp.brand_json(g) || jsonb_build_object('id', g.id, 'city', g.city, 'owner_name', g.owner_name, 'owner_phone', g.owner_phone,
    'status', g.status, 'plan', g.plan, 'trial_ends', gymp.d(g.trial_ends), 'paid_until', gymp.d(g.paid_until),
    'claimed', g.claimed_at is not null, 'claimed_at', gymp.ts(g.claimed_at),
    'code_pending', g.setup_code_hash is not null and g.setup_code_expires > now(), 'code_expires', gymp.ts(g.setup_code_expires),
    'notes', g.notes, 'created_at', gymp.ts(g.created_at), 'sub', gymp.gym_state(g),
    'members', (select count(*) from public.members m where m.gym_id = g.id and m.status <> 'archived'),
    'active_members', (select count(*) from public.members m where m.gym_id = g.id and m.status = 'active' and m.expiry_date >= gymp.today()),
    'owners', (select coalesce(string_agg(o.email, ', '), '') from public.owners o where o.gym_id = g.id),
    'last_activity', (select gymp.ts(max(x.at)) from (
        select max(c.at) as at from public.checkins c where c.gym_id = g.id
        union all select max(p.created_at) from public.payments p where p.gym_id = g.id) x)) $$;

create or replace function platform.hex(p jsonb, k text, dflt text) returns text language plpgsql immutable as $$
declare v text := lower(btrim(coalesce(p ->> k, '')));
begin
  if v = '' then return dflt; end if;
  if v !~ '^#[0-9a-f]{6}$' then perform gymp.fail('bad_color'); end if;
  return v;
end $$;

create or replace function platform.a_gym_create(p jsonb) returns jsonb language plpgsql as $$
declare v_slug text := lower(btrim(coalesce(p ->> 'slug', ''))); nm text := gymp.clean(p ->> 'name', 80);
  short text; ph text; g platform.gyms; code text := platform.new_code(); c jsonb := coalesce(p -> 'colors', '{}'::jsonb);
begin
  if length(nm) < 2 then perform gymp.fail('name_required'); end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$' or v_slug ~ '--' then perform gymp.fail('bad_slug'); end if;
  if v_slug = any (array['www','admin','api','app','mail','email','smtp','imap','pop','ftp','cpanel','webmail','g','assets','static',
      'cdn','shell','setup','landing','kanpurgym','test','dev','staging','support','help','blog','ns1','ns2','status','billing','pay']) then
    perform gymp.fail('slug_reserved');
  end if;
  if exists (select 1 from platform.gyms where slug = v_slug) then perform gymp.fail('slug_taken'); end if;
  short := coalesce(nullif(gymp.clean(p ->> 'short_name', 20), ''), left(nm, 20));
  if coalesce(p ->> 'owner_phone', '') <> '' then
    ph := gymp.norm_phone(p ->> 'owner_phone');
    if ph is null then perform gymp.fail('bad_phone'); end if;
  end if;
  insert into platform.gyms (slug, name, short_name, city, owner_name, owner_phone, a1, a2, a3, accent, bg, notes,
      trial_ends, setup_code_hash, setup_code_expires)
    values (v_slug, nm, short, nullif(gymp.clean(p ->> 'city', 60), ''), nullif(gymp.clean(p ->> 'owner_name', 100), ''), ph,
      platform.hex(c, 'a1', '#ffb300'), platform.hex(c, 'a2', '#ff6a00'), platform.hex(c, 'a3', '#ff2e63'),
      platform.hex(c, 'accent', '#ff8a00'), platform.hex(c, 'bg', '#0f1115'), nullif(gymp.clean(p ->> 'notes', 1000), ''),
      gymp.today() + platform.setting('trial_days', '30')::int, platform.code_hash(code), now() + interval '30 days')
    returning * into g;
  -- the settings every new gym starts with
  insert into public.settings (gym_id, k, v) values
    (g.id, 'gym_name', nm), (g.id, 'checkin_code', upper(substr(encode(extensions.gen_random_bytes(6), 'hex'), 1, 8))),
    (g.id, 'leaderboard', '1'), (g.id, 'admission_fee', '0'), (g.id, 'referral_days', '7'), (g.id, 'freeze_max_days', '30');
  return jsonb_build_object('gym', platform.gym_json(g), 'code', code);
end $$;

create or replace function platform.a_gym_update(p jsonb) returns jsonb language plpgsql as $$
declare g platform.gyms; c jsonb := p -> 'colors'; ph text;
begin
  select * into g from platform.gyms where id = gymp.j_id(p, 'id') for update;
  if g.id is null then perform gymp.fail('not_found'); end if;
  if p ? 'name' then
    if length(gymp.clean(p ->> 'name', 80)) < 2 then perform gymp.fail('name_required'); end if;
    g.name := gymp.clean(p ->> 'name', 80);
  end if;
  if p ? 'short_name' then g.short_name := coalesce(nullif(gymp.clean(p ->> 'short_name', 20), ''), left(g.name, 20)); end if;
  if p ? 'city' then g.city := nullif(gymp.clean(p ->> 'city', 60), ''); end if;
  if p ? 'owner_name' then g.owner_name := nullif(gymp.clean(p ->> 'owner_name', 100), ''); end if;
  if p ? 'owner_phone' then
    ph := case when coalesce(p ->> 'owner_phone', '') = '' then null else gymp.norm_phone(p ->> 'owner_phone') end;
    if coalesce(p ->> 'owner_phone', '') <> '' and ph is null then perform gymp.fail('bad_phone'); end if;
    g.owner_phone := ph;
  end if;
  if p ? 'notes' then g.notes := nullif(gymp.clean(p ->> 'notes', 1000), ''); end if;
  if jsonb_typeof(c) = 'object' then
    g.a1 := platform.hex(c, 'a1', g.a1); g.a2 := platform.hex(c, 'a2', g.a2); g.a3 := platform.hex(c, 'a3', g.a3);
    g.accent := platform.hex(c, 'accent', g.accent); g.bg := platform.hex(c, 'bg', g.bg);
  end if;
  if gymp.j_bool(p, 'logo_bump') then g.logo_version := g.logo_version + 1; end if;
  if gymp.j_bool(p, 'logo_remove') then g.logo_version := 0; end if;
  update platform.gyms set name = g.name, short_name = g.short_name, city = g.city, owner_name = g.owner_name, owner_phone = g.owner_phone,
    notes = g.notes, a1 = g.a1, a2 = g.a2, a3 = g.a3, accent = g.accent, bg = g.bg, logo_version = g.logo_version, updated_at = now()
    where id = g.id returning * into g;
  return platform.gym_json(g);
end $$;

create or replace function platform.a_gym_code(p jsonb) returns jsonb language plpgsql as $$
declare code text := platform.new_code(); g platform.gyms;
begin
  update platform.gyms set setup_code_hash = platform.code_hash(code), setup_code_expires = now() + interval '30 days', updated_at = now()
    where id = gymp.j_id(p, 'id') returning * into g;
  if g.id is null then perform gymp.fail('not_found'); end if;
  return jsonb_build_object('gym', platform.gym_json(g), 'code', code);
end $$;

create or replace function platform.a_gym_payment(p jsonb) returns jsonb language plpgsql as $$
declare g platform.gyms; v_plan text := coalesce(p ->> 'plan', ''); amt int; v_mode text := coalesce(nullif(p ->> 'mode', ''), 'upi');
  v_from date; v_to date; v_on date := coalesce(gymp.j_date(p, 'paid_on'), gymp.today()); pay_id bigint;
begin
  select * into g from platform.gyms where id = gymp.j_id(p, 'id') for update;
  if g.id is null then perform gymp.fail('not_found'); end if;
  if v_plan not in ('monthly', 'yearly') then perform gymp.fail('bad_plan'); end if;
  if v_mode not in ('upi', 'cash', 'bank') then perform gymp.fail('bad_mode'); end if;
  amt := case when coalesce(p ->> 'amount', '') = '' then platform.setting(case when v_plan = 'monthly' then 'price_month' else 'price_year' end)::int
              else gymp.j_int(p, 'amount', 0, 1000000, 'bad_amount') end;
  -- a payment made during the trial starts after the trial; an early renewal starts after the paid period
  v_from := greatest(gymp.today(), g.trial_ends, coalesce(g.paid_until, g.trial_ends));
  v_to := (v_from + case when v_plan = 'monthly' then interval '1 month' else interval '1 year' end)::date;
  update platform.gyms set paid_until = v_to, plan = v_plan, status = 'active', updated_at = now() where id = g.id returning * into g;
  insert into platform.payments (gym_id, gym_slug, gym_name, plan, amount, mode, paid_on, period_from, period_to, note)
    values (g.id, g.slug, g.name, v_plan, amt, v_mode, v_on, v_from, v_to, nullif(gymp.clean(p ->> 'note', 200), '')) returning id into pay_id;
  return jsonb_build_object('gym', platform.gym_json(g), 'payment_id', pay_id, 'period_to', gymp.d(v_to));
end $$;

create or replace function platform.a_gym_trial(p jsonb) returns jsonb language plpgsql as $$
declare g platform.gyms; v_days int := gymp.j_int(p, 'days', 1, 90, 'bad_days');
begin
  update platform.gyms set trial_ends = greatest(trial_ends, gymp.today()) + v_days, updated_at = now()
    where id = gymp.j_id(p, 'id') returning * into g;
  if g.id is null then perform gymp.fail('not_found'); end if;
  return platform.gym_json(g);
end $$;

create or replace function platform.a_gym_status(p jsonb) returns jsonb language plpgsql as $$
declare g platform.gyms; v_status text := coalesce(p ->> 'status', '');
begin
  if v_status not in ('active', 'suspended') then perform gymp.fail('bad_status'); end if;
  update platform.gyms set status = v_status, updated_at = now() where id = gymp.j_id(p, 'id') returning * into g;
  if g.id is null then perform gymp.fail('not_found'); end if;
  return platform.gym_json(g);
end $$;

create or replace function platform.a_gym_delete(p jsonb) returns jsonb language plpgsql as $$
declare g platform.gyms; photos jsonb;
begin
  select * into g from platform.gyms where id = gymp.j_id(p, 'id') for update;
  if g.id is null then perform gymp.fail('not_found'); end if;
  if coalesce(p ->> 'confirm', '') <> g.slug then perform gymp.fail('confirm_slug'); end if;
  select coalesce(jsonb_agg(photo) filter (where photo is not null), '[]') into photos from public.products where gym_id = g.id;
  delete from platform.gyms where id = g.id;          -- every row of this gym goes with it (on delete cascade)
  return jsonb_build_object('deleted', g.slug, 'photos', photos, 'logo_version', g.logo_version);
end $$;

create or replace function platform.a_gym_detail(p jsonb) returns jsonb language plpgsql as $$
declare g platform.gyms;
begin
  select * into g from platform.gyms where id = gymp.j_id(p, 'id');
  if g.id is null then perform gymp.fail('not_found'); end if;
  return jsonb_build_object('gym', platform.gym_json(g),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'plan', x.plan, 'amount', x.amount, 'mode', x.mode, 'paid_on', gymp.d(x.paid_on),
        'period_from', gymp.d(x.period_from), 'period_to', gymp.d(x.period_to), 'note', x.note) order by x.id desc)
      from platform.payments x where x.gym_id = g.id), '[]'),
    'owner_list', coalesce((select jsonb_agg(jsonb_build_object('name', o.name, 'email', o.email)) from public.owners o where o.gym_id = g.id), '[]'));
end $$;

create or replace function platform.a_overview() returns jsonb language plpgsql as $$
declare gyms jsonb; pm int := platform.setting('price_month', '800')::int; py int := platform.setting('price_year', '4999')::int;
begin
  select coalesce(jsonb_agg(platform.gym_json(g) order by g.created_at desc), '[]') into gyms from platform.gyms g;
  return jsonb_build_object('gyms', gyms,
    'counts', jsonb_build_object(
      'total', jsonb_array_length(gyms),
      'trial', (select count(*) from jsonb_array_elements(gyms) e where e -> 'sub' ->> 'state' = 'trial'),
      'active', (select count(*) from jsonb_array_elements(gyms) e where e -> 'sub' ->> 'state' = 'active'),
      'grace', (select count(*) from jsonb_array_elements(gyms) e where e -> 'sub' ->> 'state' = 'grace'),
      'expired', (select count(*) from jsonb_array_elements(gyms) e where e -> 'sub' ->> 'state' in ('expired', 'suspended')),
      'members', (select coalesce(sum((e ->> 'members')::int), 0) from jsonb_array_elements(gyms) e)),
    'mrr', (select coalesce(sum(case when e ->> 'plan' = 'yearly' then round(py / 12.0) else pm end), 0)
            from jsonb_array_elements(gyms) e where e -> 'sub' ->> 'state' in ('active', 'grace')),
    'collected_month', (select coalesce(sum(amount), 0) from platform.payments where to_char(paid_on, 'YYYY-MM') = to_char(gymp.today(), 'YYYY-MM')),
    'collected_total', (select coalesce(sum(amount), 0) from platform.payments),
    'leads_new', (select count(*) from platform.leads where status = 'new'),
    'trials_ending', (select count(*) from jsonb_array_elements(gyms) e where e -> 'sub' ->> 'state' in ('trial', 'active') and (e -> 'sub' ->> 'days_left')::int between 0 and 5));
end $$;

create or replace function platform.a_leads(p jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('leads', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'gym_name', l.gym_name, 'phone', l.phone,
      'city', l.city, 'message', l.message, 'status', l.status, 'notes', l.notes, 'created_at', gymp.ts(l.created_at)) order by l.id desc)
    from platform.leads l where case coalesce(p ->> 'status', 'open') when 'open' then l.status in ('new', 'contacted', 'demo')
      when 'all' then true else l.status = p ->> 'status' end), '[]')) $$;

create or replace function platform.a_lead_update(p jsonb) returns jsonb language plpgsql as $$
declare v_status text := coalesce(p ->> 'status', '');
begin
  if v_status not in ('new', 'contacted', 'demo', 'won', 'lost') then perform gymp.fail('bad_status'); end if;
  update platform.leads set status = v_status, notes = nullif(gymp.clean(p ->> 'notes', 500), ''), updated_at = now() where id = gymp.j_id(p, 'id');
  if not found then perform gymp.fail('not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function platform.a_lead_delete(p jsonb) returns jsonb language sql as $$
  delete from platform.leads where id = gymp.j_id(p, 'id'); select jsonb_build_object('ok', true) $$;

create or replace function platform.a_payments() returns jsonb language sql stable as $$
  select jsonb_build_object('payments', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'gym_id', x.gym_id, 'gym_slug', x.gym_slug, 'gym_name', x.gym_name,
      'plan', x.plan, 'amount', x.amount, 'mode', x.mode, 'paid_on', gymp.d(x.paid_on), 'period_to', gymp.d(x.period_to), 'note', x.note) order by x.id desc)
    from (select * from platform.payments order by id desc limit 300) x), '[]')) $$;

create or replace function platform.a_settings(p jsonb) returns jsonb language plpgsql as $$
declare v_val text;
begin
  if p ? 'whatsapp' then
    v_val := case when coalesce(p ->> 'whatsapp', '') = '' then '' else gymp.norm_phone(p ->> 'whatsapp') end;
    if v_val is null then perform gymp.fail('bad_phone'); end if;
    update platform.settings set v = v_val where k = 'whatsapp';
  end if;
  if p ? 'price_month' then update platform.settings set v = gymp.j_int(p, 'price_month', 0, 100000, 'bad_amount')::text where k = 'price_month'; end if;
  if p ? 'price_year' then update platform.settings set v = gymp.j_int(p, 'price_year', 0, 1000000, 'bad_amount')::text where k = 'price_year'; end if;
  if p ? 'trial_days' then update platform.settings set v = gymp.j_int(p, 'trial_days', 0, 90, 'bad_days')::text where k = 'trial_days'; end if;
  if p ? 'grace_days' then update platform.settings set v = gymp.j_int(p, 'grace_days', 0, 30, 'bad_days')::text where k = 'grace_days'; end if;
  if p ? 'demo_slug' then
    v_val := lower(btrim(coalesce(p ->> 'demo_slug', '')));
    if v_val <> '' and v_val !~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$' then perform gymp.fail('bad_slug'); end if;
    update platform.settings set v = v_val where k = 'demo_slug';
  end if;
  if p ? 'url_style' then
    if p ->> 'url_style' not in ('subdomain', 'path') then perform gymp.fail('bad_action'); end if;
    update platform.settings set v = p ->> 'url_style' where k = 'url_style';
  end if;
  return (select jsonb_object_agg(k, v) from platform.settings where k <> 'admin_setup_hash');
end $$;

create function public.platform_api(p_action text, p_in jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := gymp.uid(); res jsonb; msg text;
begin
  p_in := coalesce(p_in, '{}'::jsonb);
  if uid is null then return jsonb_build_object('ok', false, 'error', 'login_required'); end if;
  if jsonb_typeof(p_in) <> 'object' then return jsonb_build_object('ok', false, 'error', 'bad_json'); end if;
  if p_action = 'me' then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object('is_admin', exists (select 1 from platform.super_admins where user_id = uid),
      'needs_bootstrap', not exists (select 1 from platform.super_admins), 'email', gymp.jwt_email()));
  end if;
  if p_action = 'bootstrap' then
    perform pg_advisory_xact_lock(4243);
    if exists (select 1 from platform.super_admins) then return jsonb_build_object('ok', false, 'error', 'already_installed'); end if;
    if platform.too_many('boot:' || uid, 5, interval '15 minutes') then return jsonb_build_object('ok', false, 'error', 'too_many_attempts'); end if;
    if platform.code_hash(p_in ->> 'key') <> platform.setting('admin_setup_hash') then
      insert into platform.attempts (k) values ('boot:' || uid);
      perform pg_sleep(1);
      return jsonb_build_object('ok', false, 'error', 'wrong_setup_key');
    end if;
    insert into platform.super_admins (user_id, email) values (uid, gymp.jwt_email());
    return jsonb_build_object('ok', true, 'data', jsonb_build_object('is_admin', true));
  end if;
  if not exists (select 1 from platform.super_admins where user_id = uid) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  begin
    res := case p_action
      when 'overview' then platform.a_overview()
      when 'gym_create' then platform.a_gym_create(p_in)
      when 'gym_update' then platform.a_gym_update(p_in)
      when 'gym_code' then platform.a_gym_code(p_in)
      when 'gym_payment' then platform.a_gym_payment(p_in)
      when 'gym_trial' then platform.a_gym_trial(p_in)
      when 'gym_status' then platform.a_gym_status(p_in)
      when 'gym_delete' then platform.a_gym_delete(p_in)
      when 'gym_detail' then platform.a_gym_detail(p_in)
      when 'leads' then platform.a_leads(p_in)
      when 'lead_update' then platform.a_lead_update(p_in)
      when 'lead_delete' then platform.a_lead_delete(p_in)
      when 'payments' then platform.a_payments()
      when 'settings' then platform.a_settings(p_in)
      else null end;
    if res is null then perform gymp.fail('bad_action'); end if;
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg like 'GYM:%' then return jsonb_build_object('ok', false, 'error', substr(msg, 5)); end if;
    raise warning 'platform_api(%) failed: %', p_action, msg;
    return jsonb_build_object('ok', false, 'error', 'server_error');
  end;
  return jsonb_build_object('ok', true, 'data', res);
end $$;

-- ---------------------------------------------------------------- 10. pictures (Supabase Storage)
create or replace function platform.can_manage_product_photo(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.owners o join platform.gyms g on g.id = o.gym_id
    where g.slug = split_part(p_name, '/', 1) and o.user_id = gymp.uid()) $$;
create or replace function platform.is_super_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from platform.super_admins where user_id = gymp.uid()) $$;

create policy "owners add their gym's product photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'products' and name ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]/[a-f0-9-]{36}\.jpg$' and platform.can_manage_product_photo(name));
create policy "owners list their gym's product photos" on storage.objects for select to authenticated
  using (bucket_id = 'products' and platform.can_manage_product_photo(name));
create policy "owners replace their gym's product photos" on storage.objects for update to authenticated
  using (bucket_id = 'products' and platform.can_manage_product_photo(name));
create policy "owners remove their gym's product photos" on storage.objects for delete to authenticated
  using (bucket_id = 'products' and (platform.can_manage_product_photo(name) or platform.is_super_admin()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand', 'brand', true, 1048576, array['image/png'])
on conflict (id) do update set public = true, file_size_limit = 1048576, allowed_mime_types = array['image/png'];
create policy "super admin adds gym logos" on storage.objects for insert to authenticated
  with check (bucket_id = 'brand' and name ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]/v[0-9]{1,6}/(icon-192|icon-512|maskable-512|apple-touch-icon)\.png$' and platform.is_super_admin());
create policy "super admin lists gym logos" on storage.objects for select to authenticated
  using (bucket_id = 'brand' and platform.is_super_admin());
create policy "super admin replaces gym logos" on storage.objects for update to authenticated
  using (bucket_id = 'brand' and platform.is_super_admin());
create policy "super admin removes gym logos" on storage.objects for delete to authenticated
  using (bucket_id = 'brand' and platform.is_super_admin());

-- ---------------------------------------------------------------- 11. who may call what
revoke all on all functions in schema gymp from public, anon, authenticated;
revoke all on all functions in schema platform from public, anon, authenticated;
revoke usage on schema gymp from authenticated;
grant usage on schema platform to authenticated;     -- only for the two storage checks below
grant execute on function platform.can_manage_product_photo(text), platform.is_super_admin() to authenticated;
grant execute on all functions in schema gymp to gym_runner;
alter default privileges in schema gymp revoke execute on functions from public;
alter default privileges in schema platform revoke execute on functions from public;

revoke all on function public.gym_api(text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.gym_claim(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.site_api(text, jsonb) from public, anon, authenticated;
revoke all on function public.platform_api(text, jsonb) from public, anon, authenticated;
grant execute on function public.gym_api(text, text, jsonb, text) to anon, authenticated;
grant execute on function public.site_api(text, jsonb) to anon, authenticated;
grant execute on function public.gym_claim(text, text, jsonb) to authenticated;
grant execute on function public.platform_api(text, jsonb) to authenticated;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('gymp', 'platform') loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', f.sig);
  end loop;
end $$;

-- gym code runs as gym_runner (row level security applies); platform code stays with the owner
grant create on schema public, gymp to gym_runner;      -- needed only while handing the functions over
alter function public.gym_api(text, text, jsonb, text) owner to gym_runner;
alter function gymp.setup_gym(jsonb, uuid, text) owner to gym_runner;
revoke create on schema public, gymp from gym_runner;
