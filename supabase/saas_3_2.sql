-- =====================================================================
-- Gym SaaS 3.2: Razorpay auto-pay subscriptions. Run after saas_3_1.sql. Keeps all data.
-- The Razorpay secret key never touches the database or the website: the
-- 'razorpay' Supabase Edge Function holds it and calls these functions.
-- =====================================================================
alter table platform.gyms
  add column if not exists rzp_sub_id text,
  add column if not exists rzp_plan text check (rzp_plan in ('monthly','yearly')),
  add column if not exists rzp_status text,
  add column if not exists rzp_updated timestamptz;
create unique index if not exists gyms_rzp_sub_idx on platform.gyms (rzp_sub_id) where rzp_sub_id is not null;

-- each Razorpay payment is counted once even if Razorpay sends the webhook twice
create table if not exists platform.rzp_payments (
  payment_id text primary key,
  gym_id bigint references platform.gyms(id) on delete set null,
  subscription_id text,
  amount int,
  created_at timestamptz not null default now());
alter table platform.rzp_payments enable row level security;
revoke all on platform.rzp_payments from public, anon, authenticated;

-- who is asking, for the edge function: is this user an owner of this gym (or the platform admin)?
create or replace function platform.rzp_gym_for(p_slug text, p_uid uuid) returns jsonb
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select jsonb_build_object('id', g.id, 'slug', g.slug, 'name', g.name, 'owner_phone', g.owner_phone,
      'trial_ends', g.trial_ends, 'paid_until', g.paid_until, 'rzp_sub_id', g.rzp_sub_id, 'rzp_status', g.rzp_status, 'rzp_plan', g.rzp_plan,
      'owner_email', (select o.email from public.owners o where o.gym_id = g.id and o.user_id = p_uid),
      'is_owner', exists (select 1 from public.owners o where o.gym_id = g.id and o.user_id = p_uid),
      'is_admin', exists (select 1 from platform.super_admins a where a.user_id = p_uid))
  from platform.gyms g where g.slug = p_slug $$;

create or replace function platform.rzp_set_sub(p_gym_id bigint, p_sub_id text, p_plan text, p_status text) returns void
language sql security definer set search_path = public, extensions, pg_temp as $$
  update platform.gyms set rzp_sub_id = p_sub_id, rzp_plan = coalesce(p_plan, rzp_plan), rzp_status = p_status, rzp_updated = now(), updated_at = now()
  where id = p_gym_id $$;

create or replace function platform.rzp_status(p_sub_id text, p_status text) returns void
language sql security definer set search_path = public, extensions, pg_temp as $$
  update platform.gyms set rzp_status = p_status, rzp_updated = now() where rzp_sub_id = p_sub_id $$;

-- a successful automatic charge: record the payment and extend the paid period to Razorpay's period end
create or replace function platform.rzp_charged(p_sub_id text, p_payment_id text, p_amount int, p_period_end timestamptz) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g platform.gyms; v_to date; v_from date;
begin
  select * into g from platform.gyms where rzp_sub_id = p_sub_id for update;
  if g.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_subscription'); end if;
  insert into platform.rzp_payments (payment_id, gym_id, subscription_id, amount) values (p_payment_id, g.id, p_sub_id, p_amount)
    on conflict (payment_id) do nothing;
  if not found then return jsonb_build_object('ok', true, 'duplicate', true); end if;
  v_from := greatest(gymp.today(), g.trial_ends, coalesce(g.paid_until, g.trial_ends));
  -- Razorpay's own period end decides the new paid-till date; never move it backwards
  v_to := greatest(coalesce((p_period_end at time zone 'Asia/Kolkata')::date,
                            (v_from + case when g.rzp_plan = 'yearly' then interval '1 year' else interval '1 month' end)::date),
                   coalesce(g.paid_until, g.trial_ends));
  update platform.gyms set paid_until = v_to, plan = coalesce(g.rzp_plan, 'monthly'), status = 'active', rzp_status = 'active', rzp_updated = now(), updated_at = now()
    where id = g.id;
  insert into platform.payments (gym_id, gym_slug, gym_name, plan, amount, mode, paid_on, period_from, period_to, note)
    values (g.id, g.slug, g.name, coalesce(g.rzp_plan, 'monthly'), p_amount, 'upi', gymp.today(), v_from, v_to, 'Razorpay auto-pay ' || p_payment_id);
  return jsonb_build_object('ok', true, 'paid_until', gymp.d(v_to));
end $$;

revoke all on function platform.rzp_gym_for(text, uuid), platform.rzp_set_sub(bigint, text, text, text), platform.rzp_status(text, text),
  platform.rzp_charged(text, text, int, timestamptz) from public, anon, authenticated;
grant usage on schema platform to service_role;
grant execute on function platform.rzp_gym_for(text, uuid), platform.rzp_set_sub(bigint, text, text, text), platform.rzp_status(text, text),
  platform.rzp_charged(text, text, int, timestamptz) to service_role;

-- show auto-pay state to the owner and the admin
create or replace function platform.gym_json(g platform.gyms) returns jsonb language sql stable as $$
  select gymp.brand_json(g) || jsonb_build_object('id', g.id, 'city', g.city, 'owner_name', g.owner_name, 'owner_phone', g.owner_phone,
    'status', g.status, 'plan', g.plan, 'trial_ends', gymp.d(g.trial_ends), 'paid_until', gymp.d(g.paid_until),
    'claimed', g.claimed_at is not null, 'claimed_at', gymp.ts(g.claimed_at),
    'code_pending', g.setup_code_hash is not null and g.setup_code_expires > now(), 'code_expires', gymp.ts(g.setup_code_expires),
    'notes', g.notes, 'created_at', gymp.ts(g.created_at), 'sub', gymp.gym_state(g),
    'autopay', case when g.rzp_sub_id is not null then jsonb_build_object('status', g.rzp_status, 'plan', g.rzp_plan, 'id', g.rzp_sub_id) end,
    'members', (select count(*) from public.members m where m.gym_id = g.id and m.status <> 'archived'),
    'active_members', (select count(*) from public.members m where m.gym_id = g.id and m.status = 'active' and m.expiry_date >= gymp.today()),
    'owners', (select coalesce(string_agg(o.email, ', '), '') from public.owners o where o.gym_id = g.id),
    'last_activity', (select gymp.ts(max(x.at)) from (
        select max(c.at) as at from public.checkins c where c.gym_id = g.id
        union all select max(p.created_at) from public.payments p where p.gym_id = g.id) x)) $$;
alter function platform.gym_json(platform.gyms) set search_path = public, extensions, pg_temp;

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
      'autopay_on', platform.setting('autopay', 'off') = 'on',
      'autopay', case when g.rzp_sub_id is not null then jsonb_build_object('status', g.rzp_status, 'plan', g.rzp_plan) end,
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

-- the admin switches auto-pay on once Razorpay is connected
insert into platform.settings (k, v) values ('autopay', 'off') on conflict (k) do nothing;
create or replace function platform.a_settings_autopay(p jsonb) returns void language plpgsql as $$
begin
  if p ? 'autopay' then
    if p ->> 'autopay' not in ('on', 'off') then perform gymp.fail('bad_action'); end if;
    update platform.settings set v = p ->> 'autopay' where k = 'autopay';
  end if;
end $$;
revoke all on function platform.a_settings_autopay(jsonb) from public, anon, authenticated;
alter function platform.a_settings_autopay(jsonb) set search_path = public, extensions, pg_temp;

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
  perform platform.a_settings_autopay(p);
  return (select jsonb_object_agg(k, v) from platform.settings where k <> 'admin_setup_hash');
end $$;
alter function platform.a_settings(jsonb) set search_path = public, extensions, pg_temp;

-- one door for the 'razorpay' edge function (service key only; the website cannot call it)
create or replace function public.rzp_service(p_action text, p_in jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  p_in := coalesce(p_in, '{}'::jsonb);
  case p_action
    when 'gym_for' then return platform.rzp_gym_for(p_in ->> 'slug', (p_in ->> 'uid')::uuid);
    when 'set_sub' then perform platform.rzp_set_sub((p_in ->> 'gym_id')::bigint, p_in ->> 'sub_id', p_in ->> 'plan', p_in ->> 'status'); return '{"ok":true}';
    when 'status' then perform platform.rzp_status(p_in ->> 'sub_id', left(p_in ->> 'status', 20)); return '{"ok":true}';
    when 'charged' then return platform.rzp_charged(p_in ->> 'sub_id', p_in ->> 'payment_id', (p_in ->> 'amount')::int, to_timestamp((p_in ->> 'period_end')::bigint));
    when 'autopay_on' then return to_jsonb(platform.setting('autopay', 'off') = 'on');
    else return '{"ok":false,"error":"bad_action"}';
  end case;
end $$;
revoke all on function public.rzp_service(text, jsonb) from public, anon, authenticated;
grant execute on function public.rzp_service(text, jsonb) to service_role;
