-- =====================================================================
-- Gym Manager 2.1: check-ins, streaks & badges, leaderboard, weight log,
-- weekly workout plan, owner insights. Safe to run on top of schema.sql.
-- =====================================================================

create table if not exists public.checkins (
  id bigint generated always as identity primary key,
  member_id bigint not null references public.members(id) on delete cascade,
  day date not null, at timestamptz not null default now(),
  by_owner boolean not null default false,
  unique (member_id, day));
create index if not exists checkins_day_idx on public.checkins (day);

create table if not exists public.weights (
  id bigint generated always as identity primary key,
  member_id bigint not null references public.members(id) on delete cascade,
  day date not null, kg numeric(5,1) not null check (kg between 20 and 300),
  unique (member_id, day));

alter table public.checkins enable row level security;
alter table public.weights enable row level security;
revoke all on public.checkins, public.weights from public, anon, authenticated;

-- secret part of the front-desk QR (owner can change it any time)
insert into public.settings (k, v) values ('checkin_code', upper(substr(encode(extensions.gen_random_bytes(6), 'hex'), 1, 8)))
  on conflict (k) do nothing;
insert into public.settings (k, v) values ('leaderboard', '1') on conflict (k) do nothing;

-- ---------------------------------------------------------------- stats helpers
-- current streak = consecutive days with a check-in, ending today (or yesterday, so it isn't lost before today's visit)
create or replace function gymp.streak(m_id bigint) returns int language sql stable as $$
  with d as (select day from public.checkins where member_id = m_id and day <= gymp.today()),
  g as (select day, day - (row_number() over (order by day))::int as grp from d),
  runs as (select min(day) s, max(day) e, count(*) n from g group by grp)
  select coalesce((select n::int from runs where e >= gymp.today() - 1 order by e desc limit 1), 0) $$;

create or replace function gymp.best_streak(m_id bigint) returns int language sql stable as $$
  with g as (select day - (row_number() over (order by day))::int as grp from public.checkins where member_id = m_id)
  select coalesce(max(n), 0)::int from (select count(*) n from g group by grp) x $$;

create or replace function gymp.short_name(full_name text) returns text language sql immutable as $$
  select split_part(btrim(full_name), ' ', 1) || coalesce(' ' || nullif(left(split_part(btrim(full_name), ' ', 2), 1), '') || '.', '') $$;

create or replace function gymp.badges(m_id bigint) returns jsonb language sql stable as $$
  with c as (select * from public.checkins where member_id = m_id),
  s as (select count(*) total,
               count(*) filter (where extract(hour from at at time zone 'Asia/Kolkata') < 7) early,
               count(*) filter (where extract(hour from at at time zone 'Asia/Kolkata') >= 20) late,
               count(*) filter (where to_char(day, 'YYYY-MM') = to_char(gymp.today(), 'YYYY-MM')) in_month,
               count(*) filter (where extract(isodow from day) in (6, 7)) weekend
        from c),
  b as (select gymp.best_streak(m_id) best)
  select jsonb_build_array(
    jsonb_build_object('id', 'first', 'name', 'First step', 'hint', 'Check in once', 'got', s.total >= 1),
    jsonb_build_object('id', 'week', 'name', '7-day streak', 'hint', 'Train 7 days in a row', 'got', b.best >= 7),
    jsonb_build_object('id', 'ten', 'name', '10 workouts', 'hint', 'Check in 10 times', 'got', s.total >= 10),
    jsonb_build_object('id', 'month12', 'name', 'Consistent', 'hint', '12 visits in one month', 'got', s.in_month >= 12),
    jsonb_build_object('id', 'early', 'name', 'Early bird', 'hint', '5 check-ins before 7 am', 'got', s.early >= 5),
    jsonb_build_object('id', 'night', 'name', 'Night owl', 'hint', '5 check-ins after 8 pm', 'got', s.late >= 5),
    jsonb_build_object('id', 'weekend', 'name', 'Weekend warrior', 'hint', '8 weekend workouts', 'got', s.weekend >= 8),
    jsonb_build_object('id', 'fifty', 'name', 'Half century', 'hint', 'Check in 50 times', 'got', s.total >= 50),
    jsonb_build_object('id', 'month30', 'name', 'Iron streak', 'hint', 'Train 30 days in a row', 'got', b.best >= 30))
  from s, b $$;

create or replace function gymp.workouts() returns jsonb language sql stable as $$
  select coalesce(nullif(gymp.setting('workouts'), '')::jsonb, jsonb_build_object(
    '1', 'Chest + Triceps', '2', 'Back + Biceps', '3', 'Legs', '4', 'Shoulders + Abs', '5', 'Chest + Back', '6', 'Arms + Cardio', '7', 'Rest day: walk, stretch, recover')) $$;

-- ---------------------------------------------------------------- member actions
create or replace function gymp.m_checkin(m public.members, p jsonb) returns jsonb language plpgsql as $$
declare code text := upper(btrim(coalesce(p ->> 'code', ''))); fresh boolean;
begin
  if code = '' or code <> gymp.setting('checkin_code') then perform gymp.fail('bad_checkin_code'); end if;
  if m.status = 'frozen' then perform gymp.fail('membership_frozen'); end if;
  if m.expiry_date < gymp.today() then perform gymp.fail('membership_expired'); end if;
  insert into public.checkins (member_id, day) values (m.id, gymp.today()) on conflict (member_id, day) do nothing;
  fresh := found;
  return jsonb_build_object('fresh', fresh, 'streak', gymp.streak(m.id),
    'month', (select count(*) from public.checkins where member_id = m.id and to_char(day, 'YYYY-MM') = to_char(gymp.today(), 'YYYY-MM')));
end $$;

create or replace function gymp.m_stats(m public.members) returns jsonb language plpgsql as $$
declare t date := gymp.today();
begin
  return jsonb_build_object(
    'checked_in_today', exists (select 1 from public.checkins where member_id = m.id and day = t),
    'streak', gymp.streak(m.id), 'best_streak', gymp.best_streak(m.id),
    'month', (select count(*) from public.checkins where member_id = m.id and to_char(day, 'YYYY-MM') = to_char(t, 'YYYY-MM')),
    'total', (select count(*) from public.checkins where member_id = m.id),
    'week', (select coalesce(jsonb_agg(gymp.d(day) order by day), '[]') from public.checkins where member_id = m.id and day > t - 7),
    'badges', gymp.badges(m.id),
    'weights', (select coalesce(jsonb_agg(jsonb_build_object('day', gymp.d(day), 'kg', kg) order by day), '[]')
      from (select * from public.weights where member_id = m.id order by day desc limit 60) w),
    'leaderboard', case when gymp.setting('leaderboard', '1') = '1' then (
      select coalesce(jsonb_agg(jsonb_build_object('name', gymp.short_name(mm.name), 'visits', x.n, 'me', mm.id = m.id) order by x.n desc, mm.name), '[]')
      from (select member_id, count(*) n from public.checkins where to_char(day, 'YYYY-MM') = to_char(t, 'YYYY-MM') group by member_id order by 2 desc limit 10) x
      join public.members mm on mm.id = x.member_id) else null end,
    'workout_today', gymp.workouts() ->> extract(isodow from t)::text,
    'workouts', gymp.workouts(),
    'plan_days', greatest(1, m.expiry_date - m.start_date));
end $$;

create or replace function gymp.m_weight(m public.members, p jsonb) returns jsonb language plpgsql as $$
declare s text := btrim(coalesce(p ->> 'kg', '')); kg numeric;
begin
  if s !~ '^\d{2,3}(\.\d)?$' then perform gymp.fail('bad_weight'); end if;
  kg := s::numeric;
  if kg < 20 or kg > 300 then perform gymp.fail('bad_weight'); end if;
  insert into public.weights (member_id, day, kg) values (m.id, gymp.today(), kg) on conflict (member_id, day) do update set kg = excluded.kg;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- owner actions
create or replace function gymp.o_checkins() returns jsonb language plpgsql as $$
declare t date := gymp.today();
begin
  return jsonb_build_object(
    'code', gymp.setting('checkin_code'),
    'today', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'code', m.code, 'time', to_char(c.at at time zone 'Asia/Kolkata', 'HH24:MI'), 'by_owner', c.by_owner) order by c.at desc), '[]')
      from public.checkins c join public.members m on m.id = c.member_id where c.day = t),
    'days', (select jsonb_agg(jsonb_build_object('day', gymp.d(d::date), 'n', (select count(*) from public.checkins where day = d::date)) order by d)
      from generate_series(t - 13, t, interval '1 day') d),
    'hours', (select jsonb_agg(jsonb_build_object('h', h, 'n', (select count(*) from public.checkins where day > t - 30 and extract(hour from at at time zone 'Asia/Kolkata') = h)) order by h)
      from generate_series(5, 22) h),
    'leaderboard', gymp.setting('leaderboard', '1') = '1');
end $$;

create or replace function gymp.o_checkin_member(p jsonb) returns jsonb language plpgsql as $$
declare m public.members;
begin
  select * into m from public.members where id = gymp.j_id(p, 'id');
  if m.id is null then perform gymp.fail('not_found'); end if;
  insert into public.checkins (member_id, day, by_owner) values (m.id, gymp.today(), true) on conflict (member_id, day) do nothing;
  return jsonb_build_object('ok', true, 'fresh', found);
end $$;

create or replace function gymp.o_checkin_settings(p jsonb) returns jsonb language plpgsql as $$
begin
  if gymp.j_bool(p, 'new_code') then
    perform gymp.set_setting('checkin_code', upper(substr(encode(extensions.gen_random_bytes(6), 'hex'), 1, 8)));
  end if;
  if p ? 'leaderboard' then perform gymp.set_setting('leaderboard', case when gymp.j_bool(p, 'leaderboard') then '1' else '0' end); end if;
  return jsonb_build_object('code', gymp.setting('checkin_code'), 'leaderboard', gymp.setting('leaderboard', '1') = '1');
end $$;

create or replace function gymp.o_workouts(p jsonb) returns jsonb language plpgsql as $$
declare w jsonb := '{}'; i int;
begin
  if jsonb_typeof(p -> 'days') = 'object' then
    for i in 1..7 loop w := w || jsonb_build_object(i::text, gymp.clean(p -> 'days' ->> i::text, 200)); end loop;
    perform gymp.set_setting('workouts', w::text);
  end if;
  return jsonb_build_object('days', gymp.workouts());
end $$;

create or replace function gymp.o_insights() returns jsonb language plpgsql as $$
declare t date := gymp.today();
begin
  return jsonb_build_object(
    'revenue', (select jsonb_agg(jsonb_build_object('month', to_char(mo, 'YYYY-MM'), 'label', to_char(mo, 'Mon'),
        'membership', (select coalesce(sum(amount), 0) from public.payments where status = 'confirmed' and kind = 'membership' and to_char(decided_at at time zone 'Asia/Kolkata', 'YYYY-MM') = to_char(mo, 'YYYY-MM')),
        'shop', (select coalesce(sum(amount), 0) from public.payments where status = 'confirmed' and kind = 'shop' and to_char(decided_at at time zone 'Asia/Kolkata', 'YYYY-MM') = to_char(mo, 'YYYY-MM'))) order by mo)
      from generate_series(date_trunc('month', t) - interval '5 months', date_trunc('month', t), interval '1 month') mo),
    'joins', (select jsonb_agg(jsonb_build_object('label', to_char(mo, 'Mon'), 'n', (select count(*) from public.members where to_char(created_at at time zone 'Asia/Kolkata', 'YYYY-MM') = to_char(mo, 'YYYY-MM'))) order by mo)
      from generate_series(date_trunc('month', t) - interval '5 months', date_trunc('month', t), interval '1 month') mo),
    'checkins_today', (select count(*) from public.checkins where day = t),
    'checkins_week', (select count(*) from public.checkins where day > t - 7),
    'active_rate', (select case when count(*) = 0 then 0 else round(100.0 * count(*) filter (where exists (select 1 from public.checkins c where c.member_id = m.id and c.day > t - 14)) / count(*)) end
      from public.members m where m.status = 'active' and m.expiry_date >= t),
    'renewal_due_value', (select coalesce(sum(fee), 0) from public.members where status = 'active' and expiry_date between t and t + 7),
    'missing', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'phone', phone, 'last', gymp.d(last))), '[]') from (
      select m.id, m.name, m.phone, (select max(day) from public.checkins c where c.member_id = m.id) last from public.members m
      where m.status = 'active' and m.expiry_date >= t
        and exists (select 1 from public.checkins c where c.member_id = m.id)
        and not exists (select 1 from public.checkins c where c.member_id = m.id and c.day > t - 7)
      order by 4 asc limit 20) x));
end $$;

-- demo: give the fake members some check-in history and weights so the new screens have something to show
create or replace function gymp.demo_activity() returns void language plpgsql as $$
declare m record; d int; t date := gymp.today();
begin
  for m in select id, row_number() over (order by id) rn from public.members where is_demo and status = 'active' loop
    for d in 0..40 loop
      if ((m.rn % 4 = 1 and d < 6 + m.rn) or (d * 7 + m.rn * 3) % 10 < 2 + (m.rn * 5) % 7) and (d > 0 or m.rn % 2 = 0 or m.rn % 4 = 1) then
        insert into public.checkins (member_id, day, at) values (m.id, t - d,
          ((t - d)::timestamp + make_interval(hours => ((5 + (m.rn * 5 + d) % 16))::int, mins => ((m.rn * 7 + d * 11) % 60)::int)) at time zone 'Asia/Kolkata')
        on conflict do nothing;
      end if;
    end loop;
    if m.rn = 1 then
      for d in 0..8 loop insert into public.weights (member_id, day, kg) values (m.id, t - d * 7, 82.4 - (8 - d) * 0.6) on conflict do nothing; end loop;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- the dispatcher, with the new actions
create or replace function public.gym_api(p_action text, p_in jsonb default '{}'::jsonb, p_token text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare o_id uuid; m public.members; res jsonb; msg text; pre text;
begin
  p_in := coalesce(p_in, '{}'::jsonb);
  if jsonb_typeof(p_in) <> 'object' then return jsonb_build_object('ok', false, 'error', 'bad_json'); end if;
  if p_action is null or p_action !~ '^[a-z_]{2,40}$' then return jsonb_build_object('ok', false, 'error', 'bad_action'); end if;
  if p_action <> 'info' and not exists (select 1 from public.owners) then return jsonb_build_object('ok', false, 'error', 'not_installed'); end if;
  begin
    if p_action = 'info' then res := gymp.act_info(p_token);
    elsif p_action = 'login_member' then res := gymp.act_login_member(p_in);
    elsif p_action = 'logout' then res := coalesce(gymp.act_logout(p_token), jsonb_build_object('bye', true));
    else
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
        else null end;
      if res is null then perform gymp.fail('bad_action'); end if;
    end if;
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg like 'GYM:%' then return jsonb_build_object('ok', false, 'error', substr(msg, 5)); end if;
    raise warning 'gym_api(%) failed: %', p_action, msg;
    return jsonb_build_object('ok', false, 'error', 'server_error');
  end;
  if res ? '__err' then return jsonb_build_object('ok', false, 'error', res ->> '__err'); end if;
  return jsonb_build_object('ok', true, 'data', res);
end $$;

-- demo installs now also get activity (setup calls gymp.install_demo by name)
do $$ begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'gymp' and p.proname = 'install_demo_base') then
    alter function gymp.install_demo() rename to install_demo_base;
  end if;
end $$;
create or replace function gymp.install_demo() returns jsonb language plpgsql as $$
declare r jsonb;
begin r := gymp.install_demo_base(); perform gymp.demo_activity(); return r; end $$;

-- keep the old demo data lively too (no-op when there are no demo members)
do $$ begin perform gymp.demo_activity(); end $$;

-- rights: new private functions are not callable from outside; gym_api keeps its grants
revoke all on all functions in schema gymp from public, anon, authenticated;
grant execute on function gymp.is_owner() to authenticated;
revoke all on function public.gym_api(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.gym_api(text, jsonb, text) to anon, authenticated;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'gymp' loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', f.sig);
  end loop;
end $$;
