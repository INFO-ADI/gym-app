-- =====================================================================
-- Gym SaaS 3.3: undo a wrongly recorded payment. Run after saas_3_2.sql. Keeps all data.
-- =====================================================================
create or replace function platform.a_payment_delete(p jsonb) returns jsonb language plpgsql as $$
declare pay platform.payments; last platform.payments; g platform.gyms;
begin
  select * into pay from platform.payments where id = gymp.j_id(p, 'id') for update;
  if pay.id is null then perform gymp.fail('not_found'); end if;
  if pay.note like 'Razorpay %' then perform gymp.fail('autopay_payment'); end if;
  delete from platform.payments where id = pay.id;
  if pay.gym_id is not null then
    -- the paid-till date goes back to what the remaining payments cover
    select * into last from platform.payments where gym_id = pay.gym_id order by period_to desc, id desc limit 1;
    update platform.gyms set paid_until = last.period_to, plan = coalesce(last.plan, 'trial'), updated_at = now()
      where id = pay.gym_id returning * into g;
  end if;
  return jsonb_build_object('deleted', pay.id, 'gym', case when g.id is not null then platform.gym_json(g) end);
end $$;
revoke all on function platform.a_payment_delete(jsonb) from public, anon, authenticated;
alter function platform.a_payment_delete(jsonb) set search_path = public, extensions, pg_temp;

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
      when 'payment_delete' then platform.a_payment_delete(p_in)
      else null end;
    if res is null then perform gymp.fail('bad_action'); end if;
    -- keep a record of every change an admin makes
    if p_action in ('gym_create', 'gym_update', 'gym_code', 'gym_payment', 'gym_trial', 'gym_status', 'gym_delete', 'lead_update',
                    'lead_delete', 'request_decide', 'payment_delete') or (p_action = 'settings' and p_in <> '{}'::jsonb) then
      insert into platform.audit (user_id, email, action, detail)
        values (uid, gymp.jwt_email(), p_action, (p_in - 'notes' - 'colors' - 'rzp_key_secret' - 'rzp_webhook_secret') || jsonb_build_object('gym', coalesce(res #>> '{gym,slug}', res ->> 'slug', res ->> 'deleted')));
    end if;
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg like 'GYM:%' then return jsonb_build_object('ok', false, 'error', substr(msg, 5)); end if;
    raise warning 'platform_api(%) failed: %', p_action, msg;
    return jsonb_build_object('ok', false, 'error', 'server_error');
  end;
  return jsonb_build_object('ok', true, 'data', res);
end $$;


-- ---------------------------------------------------------------- one-time Razorpay payment (no auto-pay)
create or replace function platform.rzp_paid_once(p_gym_id bigint, p_payment_id text, p_amount int, p_plan text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g platform.gyms; v_from date; v_to date;
begin
  if p_plan not in ('monthly', 'yearly') then return jsonb_build_object('ok', false, 'error', 'bad_plan'); end if;
  select * into g from platform.gyms where id = p_gym_id for update;
  if g.id is null then return jsonb_build_object('ok', false, 'error', 'gym_not_found'); end if;
  insert into platform.rzp_payments (payment_id, gym_id, amount) values (p_payment_id, g.id, p_amount) on conflict (payment_id) do nothing;
  if not found then return jsonb_build_object('ok', true, 'duplicate', true, 'paid_until', gymp.d(g.paid_until)); end if;
  v_from := greatest(gymp.today(), g.trial_ends, coalesce(g.paid_until, g.trial_ends));
  v_to := (v_from + case when p_plan = 'yearly' then interval '1 year' else interval '1 month' end)::date;
  update platform.gyms set paid_until = v_to, plan = p_plan, status = 'active', updated_at = now() where id = g.id;
  insert into platform.payments (gym_id, gym_slug, gym_name, plan, amount, mode, paid_on, period_from, period_to, note)
    values (g.id, g.slug, g.name, p_plan, p_amount, 'upi', gymp.today(), v_from, v_to, 'Razorpay one-time ' || p_payment_id);
  return jsonb_build_object('ok', true, 'paid_until', gymp.d(v_to));
end $$;
revoke all on function platform.rzp_paid_once(bigint, text, int, text) from public, anon, authenticated;
grant execute on function platform.rzp_paid_once(bigint, text, int, text) to service_role;

-- ---------------------------------------------------------------- Razorpay settings from the admin panel
create table if not exists platform.secrets (k text primary key, v text not null, updated_at timestamptz not null default now());
alter table platform.secrets enable row level security;
revoke all on platform.secrets from public, anon, authenticated;
insert into platform.settings (k, v) values ('rzp_key_id', ''), ('rzp_plan_monthly', ''), ('rzp_plan_yearly', '') on conflict (k) do nothing;

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
  -- Razorpay connection (key ID and plan IDs are not secret; the key secret and webhook secret are write-only)
  if p ? 'rzp_key_id' then
    v_val := btrim(coalesce(p ->> 'rzp_key_id', ''));
    if v_val <> '' and v_val !~ '^rzp_(test|live)_[A-Za-z0-9]{6,40}$' then perform gymp.fail('bad_rzp_key'); end if;
    insert into platform.settings (k, v) values ('rzp_key_id', v_val) on conflict (k) do update set v = excluded.v;
  end if;
  if p ? 'rzp_plan_monthly' or p ? 'rzp_plan_yearly' then
    foreach v_val in array array['rzp_plan_monthly', 'rzp_plan_yearly'] loop
      if p ? v_val then
        if btrim(coalesce(p ->> v_val, '')) <> '' and btrim(p ->> v_val) !~ '^plan_[A-Za-z0-9]{6,40}$' then perform gymp.fail('bad_rzp_plan'); end if;
        insert into platform.settings (k, v) values (v_val, btrim(coalesce(p ->> v_val, ''))) on conflict (k) do update set v = excluded.v;
      end if;
    end loop;
  end if;
  if coalesce(p ->> 'rzp_key_secret', '') <> '' then
    if length(p ->> 'rzp_key_secret') not between 10 and 100 then perform gymp.fail('bad_rzp_secret'); end if;
    insert into platform.secrets (k, v) values ('rzp_key_secret', btrim(p ->> 'rzp_key_secret')) on conflict (k) do update set v = excluded.v, updated_at = now();
  end if;
  if coalesce(p ->> 'rzp_webhook_secret', '') <> '' then
    if length(p ->> 'rzp_webhook_secret') not between 8 and 100 then perform gymp.fail('bad_rzp_secret'); end if;
    insert into platform.secrets (k, v) values ('rzp_webhook_secret', btrim(p ->> 'rzp_webhook_secret')) on conflict (k) do update set v = excluded.v, updated_at = now();
  end if;
  return (select jsonb_object_agg(k, v) from platform.settings where k <> 'admin_setup_hash')
    || jsonb_build_object('rzp_secret_set', exists (select 1 from platform.secrets where k = 'rzp_key_secret' and v <> ''),
                          'rzp_webhook_set', exists (select 1 from platform.secrets where k = 'rzp_webhook_secret' and v <> ''));
end $$;
alter function platform.a_settings(jsonb) set search_path = public, extensions, pg_temp;

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
    when 'paid_once' then return platform.rzp_paid_once((p_in ->> 'gym_id')::bigint, p_in ->> 'payment_id', (p_in ->> 'amount')::int, p_in ->> 'plan');
    when 'config' then return jsonb_build_object('key_id', platform.setting('rzp_key_id'),
      'price_month', platform.setting('price_month', '800')::int, 'price_year', platform.setting('price_year', '4999')::int, 'plan_monthly', platform.setting('rzp_plan_monthly'),
      'plan_yearly', platform.setting('rzp_plan_yearly'),
      'key_secret', coalesce((select v from platform.secrets where k = 'rzp_key_secret'), ''),
      'webhook_secret', coalesce((select v from platform.secrets where k = 'rzp_webhook_secret'), ''));
    else return '{"ok":false,"error":"bad_action"}';
  end case;
end $$;
revoke all on function public.rzp_service(text, jsonb) from public, anon, authenticated;
grant execute on function public.rzp_service(text, jsonb) to service_role;
