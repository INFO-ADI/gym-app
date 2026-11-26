-- =====================================================================
-- Gym SaaS 3.4: Razorpay test and live details saved side by side, switch with one setting.
-- Run after saas_3_3.sql. Keeps all data; moves the single saved set into its test/live slot.
-- =====================================================================
insert into platform.settings (k, v) values ('rzp_mode', 'test'),
  ('rzp_test_key_id', ''), ('rzp_test_plan_monthly', ''), ('rzp_test_plan_yearly', ''),
  ('rzp_live_key_id', ''), ('rzp_live_plan_monthly', ''), ('rzp_live_plan_yearly', '')
on conflict (k) do nothing;

do $$
declare kid text := platform.setting('rzp_key_id'); m text;
begin
  m := case when kid like 'rzp_live_%' then 'live' when kid like 'rzp_test_%' then 'test' end;
  if m is not null then
    update platform.settings set v = kid where k = 'rzp_' || m || '_key_id' and v = '';
    update platform.settings set v = platform.setting('rzp_plan_monthly') where k = 'rzp_' || m || '_plan_monthly' and v = '';
    update platform.settings set v = platform.setting('rzp_plan_yearly') where k = 'rzp_' || m || '_plan_yearly' and v = '';
    insert into platform.secrets (k, v) select 'rzp_' || m || '_key_secret', v from platform.secrets where k = 'rzp_key_secret' on conflict (k) do nothing;
    insert into platform.secrets (k, v) select 'rzp_' || m || '_webhook_secret', v from platform.secrets where k = 'rzp_webhook_secret' on conflict (k) do nothing;
    update platform.settings set v = m where k = 'rzp_mode';
  end if;
end $$;

create or replace function platform.a_settings(p jsonb) returns jsonb language plpgsql as $$
declare v_val text; v_k text; m text;
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
  -- Razorpay: separate test and live details; rzp_mode picks which one is used
  if p ? 'rzp_mode' then
    if p ->> 'rzp_mode' not in ('test', 'live') then perform gymp.fail('bad_action'); end if;
    insert into platform.settings (k, v) values ('rzp_mode', p ->> 'rzp_mode') on conflict (k) do update set v = excluded.v;
  end if;
  foreach m in array array['test', 'live'] loop
    if p ? ('rzp_' || m || '_key_id') then
      v_val := btrim(coalesce(p ->> ('rzp_' || m || '_key_id'), ''));
      if v_val <> '' and v_val !~ ('^rzp_' || m || '_[A-Za-z0-9]{6,40}$') then perform gymp.fail('bad_rzp_key'); end if;
      insert into platform.settings (k, v) values ('rzp_' || m || '_key_id', v_val) on conflict (k) do update set v = excluded.v;
    end if;
    foreach v_k in array array['plan_monthly', 'plan_yearly'] loop
      if p ? ('rzp_' || m || '_' || v_k) then
        v_val := btrim(coalesce(p ->> ('rzp_' || m || '_' || v_k), ''));
        if v_val <> '' and v_val !~ '^plan_[A-Za-z0-9]{6,40}$' then perform gymp.fail('bad_rzp_plan'); end if;
        insert into platform.settings (k, v) values ('rzp_' || m || '_' || v_k, v_val) on conflict (k) do update set v = excluded.v;
      end if;
    end loop;
    foreach v_k in array array['key_secret', 'webhook_secret'] loop
      v_val := btrim(coalesce(p ->> ('rzp_' || m || '_' || v_k), ''));
      if v_val <> '' then
        if length(v_val) not between 8 and 100 then perform gymp.fail('bad_rzp_secret'); end if;
        insert into platform.secrets (k, v) values ('rzp_' || m || '_' || v_k, v_val) on conflict (k) do update set v = excluded.v, updated_at = now();
      end if;
    end loop;
  end loop;
  return (select jsonb_object_agg(k, v) from platform.settings where k <> 'admin_setup_hash')
    || jsonb_build_object(
      'rzp_test_secret_set', exists (select 1 from platform.secrets where k = 'rzp_test_key_secret' and v <> ''),
      'rzp_test_webhook_set', exists (select 1 from platform.secrets where k = 'rzp_test_webhook_secret' and v <> ''),
      'rzp_live_secret_set', exists (select 1 from platform.secrets where k = 'rzp_live_key_secret' and v <> ''),
      'rzp_live_webhook_set', exists (select 1 from platform.secrets where k = 'rzp_live_webhook_secret' and v <> ''));
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
    when 'config' then return (
      with m as (select platform.setting('rzp_mode', 'test') as mode)
      select jsonb_build_object('mode', m.mode,
        'key_id', platform.setting('rzp_' || m.mode || '_key_id'),
        'plan_monthly', platform.setting('rzp_' || m.mode || '_plan_monthly'),
        'plan_yearly', platform.setting('rzp_' || m.mode || '_plan_yearly'),
        'key_secret', coalesce((select v from platform.secrets where k = 'rzp_' || m.mode || '_key_secret'), ''),
        'webhook_secret', coalesce((select v from platform.secrets where k = 'rzp_' || m.mode || '_webhook_secret'), ''),
        -- webhooks from the other mode are still accepted (e.g. a late test webhook after switching to live)
        'webhook_secret_other', coalesce((select v from platform.secrets where k = 'rzp_' || case when m.mode = 'live' then 'test' else 'live' end || '_webhook_secret'), ''),
        'price_month', platform.setting('price_month', '800')::int, 'price_year', platform.setting('price_year', '4999')::int)
      from m);
    else return '{"ok":false,"error":"bad_action"}';
  end case;
end $$;
revoke all on function public.rzp_service(text, jsonb) from public, anon, authenticated;
grant execute on function public.rzp_service(text, jsonb) to service_role;
