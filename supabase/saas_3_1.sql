-- =====================================================================
-- Gym SaaS 3.1: renewal reminders, owner self-renewal by UPI, admin activity log,
-- notice to all gyms. Run after saas_3_0.sql. Keeps all data.
-- =====================================================================

-- ---------------------------------------------------------------- tables
create table if not exists platform.renewal_requests (
  id bigint generated always as identity primary key,
  gym_id bigint not null references platform.gyms(id) on delete cascade,
  plan text not null check (plan in ('monthly','yearly')),
  amount int not null check (amount between 0 and 1000000),
  utr text check (length(utr) <= 40),
  requested_by text,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz);
create index if not exists renewal_requests_gym_idx on platform.renewal_requests (gym_id, status);

create table if not exists platform.reminders (
  id bigint generated always as identity primary key,
  gym_id bigint not null references platform.gyms(id) on delete cascade,
  kind text not null check (length(kind) <= 30),
  sent_at timestamptz not null default now());
create index if not exists reminders_gym_idx on platform.reminders (gym_id, sent_at desc);

create table if not exists platform.audit (
  id bigint generated always as identity primary key,
  user_id uuid,
  email text,
  action text not null,
  detail jsonb,
  at timestamptz not null default now());
create index if not exists audit_at_idx on platform.audit (at desc);

alter table platform.renewal_requests enable row level security;
alter table platform.reminders enable row level security;
alter table platform.audit enable row level security;
revoke all on platform.renewal_requests, platform.reminders, platform.audit from public, anon, authenticated;

insert into platform.settings (k, v) values ('upi_id', ''), ('upi_name', 'KanpurGym'), ('remind_days', '2'), ('notice', '')
on conflict (k) do nothing;

-- ---------------------------------------------------------------- gym app: notice + renewal info for the owner
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
    'me', who, 'installed', exists (select 1 from public.owners), 'version', '3.1.0',
    'sub', gymp.gym_state(g), 'contact', coalesce((select v from platform.settings where k = 'whatsapp'), ''),
    'remind_days', coalesce((select v from platform.settings where k = 'remind_days'), '2')::int,
    -- the platform notice is for owners only
    'notice', case when o.user_id is not null then nullif((select v from platform.settings where k = 'notice'), '') end);
end $$;

-- the owner renews their own subscription: pay by UPI, then tell us (works even when the app is locked)
create or replace function public.gym_renew(p_gym text, p_action text, p_in jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := gymp.uid(); g platform.gyms; v_plan text; amt int; r platform.renewal_requests; v_key text;
begin
  p_in := coalesce(p_in, '{}'::jsonb);
  if uid is null then return jsonb_build_object('ok', false, 'error', 'login_required'); end if;
  if p_gym is null or p_gym !~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$' then return jsonb_build_object('ok', false, 'error', 'gym_not_found'); end if;
  select * into g from platform.gyms where slug = p_gym;
  if g.id is null then return jsonb_build_object('ok', false, 'error', 'gym_not_found'); end if;
  if not exists (select 1 from public.owners where gym_id = g.id and user_id = uid) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into r from platform.renewal_requests where gym_id = g.id and status = 'pending' order by id desc limit 1;
  if p_action = 'info' then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'sub', gymp.gym_state(g), 'price_month', platform.setting('price_month', '800')::int, 'price_year', platform.setting('price_year', '4999')::int,
      'upi_id', platform.setting('upi_id'), 'upi_name', platform.setting('upi_name', 'KanpurGym'), 'whatsapp', platform.setting('whatsapp'),
      'pending', case when r.id is not null then jsonb_build_object('plan', r.plan, 'amount', r.amount, 'at', gymp.ts(r.created_at)) end));
  elsif p_action = 'request' then
    v_key := 'renew:' || g.id;
    if platform.too_many(v_key, 5, interval '1 day') then return jsonb_build_object('ok', false, 'error', 'too_many_attempts'); end if;
    if r.id is not null then return jsonb_build_object('ok', false, 'error', 'already_requested'); end if;
    v_plan := coalesce(p_in ->> 'plan', '');
    if v_plan not in ('monthly', 'yearly') then return jsonb_build_object('ok', false, 'error', 'bad_plan'); end if;
    amt := platform.setting(case when v_plan = 'monthly' then 'price_month' else 'price_year' end)::int;
    insert into platform.attempts (k) values (v_key);
    insert into platform.renewal_requests (gym_id, plan, amount, utr, requested_by)
      values (g.id, v_plan, amt, nullif(left(regexp_replace(coalesce(p_in ->> 'utr', ''), '[^A-Za-z0-9]', '', 'g'), 40), ''), gymp.jwt_email());
    return jsonb_build_object('ok', true, 'data', jsonb_build_object('requested', true));
  end if;
  return jsonb_build_object('ok', false, 'error', 'bad_action');
end $$;

-- ---------------------------------------------------------------- super admin: reminders, renewal requests, activity log
create or replace function platform.a_reminders() returns jsonb language plpgsql as $$
declare days int := platform.setting('remind_days', '2')::int; gyms jsonb;
begin
  select coalesce(jsonb_agg(x.j order by x.ord, x.ends), '[]') into gyms from (
    select platform.gym_json(g) || jsonb_build_object(
        'reason', case when not (g.claimed_at is not null) then 'not_setup'
                       when s ->> 'state' = 'suspended' then 'paused'
                       when s ->> 'state' = 'expired' then 'expired'
                       when s ->> 'state' = 'grace' then 'grace'
                       when s ->> 'state' = 'trial' then 'trial_ending' else 'plan_ending' end,
        'last_reminded', (select gymp.ts(max(r.sent_at)) from platform.reminders r where r.gym_id = g.id),
        'reminded_today', exists (select 1 from platform.reminders r where r.gym_id = g.id and (r.sent_at at time zone 'Asia/Kolkata')::date = gymp.today())) as j,
      case when s ->> 'state' in ('grace', 'expired') then 0 when g.claimed_at is null then 2 else 1 end as ord,
      (s ->> 'ends') as ends
    from platform.gyms g cross join lateral (select gymp.gym_state(g) as s) st
    where g.status = 'active' and (
         (s ->> 'state' in ('trial', 'active') and (s ->> 'days_left')::int between 0 and days)
      or s ->> 'state' = 'grace'
      or (s ->> 'state' = 'expired' and (s ->> 'days_left')::int >= -30)
      or (g.claimed_at is null and g.created_at < now() - interval '2 days'))
  ) x;
  return jsonb_build_object('gyms', gyms, 'remind_days', days,
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'gym_id', r.gym_id, 'gym_name', g.name, 'slug', g.slug, 'plan', r.plan,
        'amount', r.amount, 'utr', r.utr, 'by', r.requested_by, 'at', gymp.ts(r.created_at)) order by r.id)
      from platform.renewal_requests r join platform.gyms g on g.id = r.gym_id where r.status = 'pending'), '[]'));
end $$;

create or replace function platform.a_reminded(p jsonb) returns jsonb language plpgsql as $$
begin
  if not exists (select 1 from platform.gyms where id = gymp.j_id(p, 'id')) then perform gymp.fail('not_found'); end if;
  insert into platform.reminders (gym_id, kind) values (gymp.j_id(p, 'id'), left(coalesce(nullif(p ->> 'kind', ''), 'whatsapp'), 30));
  return jsonb_build_object('ok', true);
end $$;

create or replace function platform.a_request_decide(p jsonb) returns jsonb language plpgsql as $$
declare r platform.renewal_requests; res jsonb;
begin
  select * into r from platform.renewal_requests where id = gymp.j_id(p, 'id') for update;
  if r.id is null or r.status <> 'pending' then perform gymp.fail('not_found'); end if;
  if gymp.j_bool(p, 'confirm') then
    res := platform.a_gym_payment(jsonb_build_object('id', r.gym_id, 'plan', r.plan, 'amount', coalesce(nullif(p ->> 'amount', ''), r.amount::text),
      'mode', 'upi', 'note', 'Owner renewal' || coalesce(' · UTR ' || r.utr, '')));
    update platform.renewal_requests set status = 'confirmed', decided_at = now() where id = r.id;
    return res;
  end if;
  update platform.renewal_requests set status = 'rejected', decided_at = now() where id = r.id;
  return jsonb_build_object('rejected', true);
end $$;

create or replace function platform.a_audit() returns jsonb language sql stable as $$
  select jsonb_build_object('audit', coalesce((select jsonb_agg(jsonb_build_object('email', a.email, 'action', a.action, 'detail', a.detail, 'at', gymp.ts(a.at)) order by a.id desc)
    from (select * from platform.audit order by id desc limit 200) a), '[]')) $$;

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
  if p ? 'remind_days' then update platform.settings set v = gymp.j_int(p, 'remind_days', 1, 15, 'bad_days')::text where k = 'remind_days'; end if;
  if p ? 'demo_slug' then
    v_val := lower(btrim(coalesce(p ->> 'demo_slug', '')));
    if v_val <> '' and v_val !~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$' then perform gymp.fail('bad_slug'); end if;
    update platform.settings set v = v_val where k = 'demo_slug';
  end if;
  if p ? 'url_style' then
    if p ->> 'url_style' not in ('subdomain', 'path') then perform gymp.fail('bad_action'); end if;
    update platform.settings set v = p ->> 'url_style' where k = 'url_style';
  end if;
  if p ? 'upi_id' then
    v_val := btrim(coalesce(p ->> 'upi_id', ''));
    if v_val <> '' and v_val !~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,30}$' then perform gymp.fail('bad_upi'); end if;
    update platform.settings set v = v_val where k = 'upi_id';
  end if;
  if p ? 'upi_name' then update platform.settings set v = coalesce(nullif(gymp.clean(p ->> 'upi_name', 60), ''), 'KanpurGym') where k = 'upi_name'; end if;
  if p ? 'notice' then update platform.settings set v = gymp.clean(p ->> 'notice', 300) where k = 'notice'; end if;
  return (select jsonb_object_agg(k, v) from platform.settings where k <> 'admin_setup_hash');
end $$;

create or replace function public.platform_api(p_action text, p_in jsonb default '{}'::jsonb) returns jsonb
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
    if platform.too_many('boot:' || uid, 5, interval '15 minutes') or platform.too_many('boot:all', 20, interval '1 hour') then
      return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
    end if;
    if platform.code_hash(p_in ->> 'key') <> platform.setting('admin_setup_hash') then
      insert into platform.attempts (k) values ('boot:' || uid), ('boot:all');
      perform pg_sleep(1);
      return jsonb_build_object('ok', false, 'error', 'wrong_setup_key');
    end if;
    insert into platform.super_admins (user_id, email) values (uid, gymp.jwt_email());
    insert into platform.audit (user_id, email, action) values (uid, gymp.jwt_email(), 'bootstrap');
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
      when 'reminders' then platform.a_reminders()
      when 'reminded' then platform.a_reminded(p_in)
      when 'request_decide' then platform.a_request_decide(p_in)
      when 'audit' then platform.a_audit()
      else null end;
    if res is null then perform gymp.fail('bad_action'); end if;
    -- keep a record of every change an admin makes
    if p_action in ('gym_create', 'gym_update', 'gym_code', 'gym_payment', 'gym_trial', 'gym_status', 'gym_delete', 'lead_update',
                    'lead_delete', 'request_decide') or (p_action = 'settings' and p_in <> '{}'::jsonb) then
      insert into platform.audit (user_id, email, action, detail)
        values (uid, gymp.jwt_email(), p_action, (p_in - 'notes' - 'colors') || jsonb_build_object('gym', coalesce(res #>> '{gym,slug}', res ->> 'slug', res ->> 'deleted')));
    end if;
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg like 'GYM:%' then return jsonb_build_object('ok', false, 'error', substr(msg, 5)); end if;
    raise warning 'platform_api(%) failed: %', p_action, msg;
    return jsonb_build_object('ok', false, 'error', 'server_error');
  end;
  return jsonb_build_object('ok', true, 'data', res);
end $$;

-- ---------------------------------------------------------------- permissions
revoke all on function platform.a_reminders(), platform.a_reminded(jsonb), platform.a_request_decide(jsonb), platform.a_audit(), platform.a_settings(jsonb)
  from public, anon, authenticated;
revoke all on function public.gym_renew(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.gym_renew(text, text, jsonb) to authenticated;
grant execute on function gymp.act_info(text) to gym_runner;
-- a Supabase helper that should not be callable from the website
do $$ begin
  if exists (select 1 from pg_proc where proname = 'rls_auto_enable' and pronamespace = 'public'::regnamespace) then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'platform' and p.proname in ('a_reminders', 'a_reminded', 'a_request_decide', 'a_audit', 'a_settings') loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', f.sig);
  end loop;
end $$;
alter function gymp.act_info(text) set search_path = public, extensions, pg_temp;
