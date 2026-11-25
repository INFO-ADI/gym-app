-- =====================================================================
-- Gym Manager 2.2: enquiries (leads), expenses & profit, admission fee.
-- Run after schema.sql and upgrade_2_1.sql.
-- =====================================================================

create table if not exists public.leads (
  id bigint generated always as identity primary key,
  name text not null check (length(name) between 2 and 100),
  phone text not null check (phone ~ '^91[5-9][0-9]{9}$'),
  interest text check (length(interest) <= 200),
  source text check (length(source) <= 40),
  status text not null default 'new' check (status in ('new','following','joined','lost')),
  next_followup date, notes text check (length(notes) <= 500),
  member_id bigint references public.members(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz);
create index if not exists leads_status_idx on public.leads (status, next_followup);

create table if not exists public.expenses (
  id bigint generated always as identity primary key,
  day date not null,
  category text not null check (length(category) between 2 and 40),
  amount int not null check (amount between 1 and 10000000),
  note text check (length(note) <= 200),
  created_at timestamptz not null default now());
create index if not exists expenses_day_idx on public.expenses (day);

alter table public.leads enable row level security;
alter table public.expenses enable row level security;
revoke all on public.leads, public.expenses from public, anon, authenticated;

insert into public.settings (k, v) values ('admission_fee', '0') on conflict (k) do nothing;

-- ---------------------------------------------------------------- new member: optional admission fee
create or replace function gymp.o_member_save(p jsonb) returns jsonb language plpgsql as $$
declare v_id bigint := case when coalesce(p ->> 'id', '') = '' then 0 else gymp.j_id(p, 'id') end;
  nm text := gymp.j_text(p, 'name', 100); ph text := gymp.norm_phone(p ->> 'phone'); v_notes text := gymp.j_text(p, 'notes', 500);
  bday date := gymp.j_date(p, 'birthday', 'bad_birthday'); v_consent boolean := gymp.j_bool(p, 'consent');
  pl public.plans; st date; exp date; paid boolean; mode text; pin text; m_id bigint; rid bigint; adm int := 0; lead_id bigint;
begin
  if length(nm) < 2 then perform gymp.fail('name_required'); end if;
  if ph is null then perform gymp.fail('bad_phone'); end if;
  if exists (select 1 from public.members where phone = ph and id <> v_id) then perform gymp.fail('phone_exists'); end if;
  if v_id > 0 then
    if not exists (select 1 from public.members where id = v_id) then perform gymp.fail('not_found'); end if;
    update public.members set name = nm, phone = ph, notes = nullif(v_notes, ''), birthday = bday, consent = v_consent where id = v_id;
    if p ? 'expiry_date' then
      exp := gymp.j_date(p, 'expiry_date');
      if exp is null then perform gymp.fail('bad_date'); end if;
      update public.members set expiry_date = exp where id = v_id;
    end if;
    if p ? 'dues' then update public.members set dues = gymp.j_int(p, 'dues', 0, 1000000, 'bad_amount') where id = v_id; end if;
    if coalesce(p ->> 'plan_id', '') <> '' then
      select * into pl from public.plans where id = gymp.j_id(p, 'plan_id');
      if pl.id is null then perform gymp.fail('bad_plan'); end if;
      update public.members set plan_id = pl.id, fee = pl.fee where id = v_id;
    end if;
    return jsonb_build_object('id', v_id);
  end if;
  select * into pl from public.plans where id = gymp.j_id(p, 'plan_id') and active;
  if pl.id is null then perform gymp.fail('bad_plan'); end if;
  st := coalesce(gymp.j_date(p, 'start_date'), gymp.today());
  exp := (st + make_interval(months => pl.months))::date;
  paid := gymp.j_bool(p, 'paid_now');
  mode := case when p ->> 'mode' = 'upi' then 'upi' else 'cash' end;
  if gymp.j_bool(p, 'admission') then adm := coalesce(nullif(gymp.setting('admission_fee', '0'), '')::int, 0); end if;
  pin := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000))::text, 6, '0');
  insert into public.members (code, name, phone, pin_hash, plan_id, fee, start_date, expiry_date, dues, notes, birthday, consent)
    values (gymp.next_code(), nm, ph, extensions.crypt(pin, extensions.gen_salt('bf', 8)), pl.id, pl.fee, st, exp,
      case when paid then 0 else pl.fee + adm end, nullif(v_notes, ''), bday, v_consent)
    returning id into m_id;
  if paid then
    insert into public.payments (member_id, kind, plan_id, amount, mode, status, receipt_no, period_from, period_to, note, decided_at)
      values (m_id, 'membership', pl.id, pl.fee + adm, mode, 'confirmed', gymp.next_receipt(), st, exp,
        case when adm > 0 then 'Joining (includes admission fee ₹' || adm || ')' else 'Joining' end, now()) returning id into rid;
  end if;
  -- joined from an enquiry: link it
  if coalesce(p ->> 'lead_id', '') <> '' then
    lead_id := gymp.j_id(p, 'lead_id');
    update public.leads set status = 'joined', member_id = m_id, updated_at = now() where id = lead_id;
  end if;
  return jsonb_build_object('id', m_id, 'pin', pin, 'receipt_id', rid, 'admission', adm);
end $$;

-- ---------------------------------------------------------------- owner preferences
create or replace function gymp.o_prefs(p jsonb) returns jsonb language plpgsql as $$
begin
  if p ? 'admission_fee' then perform gymp.set_setting('admission_fee', gymp.j_int(p, 'admission_fee', 0, 100000, 'bad_amount')::text); end if;
  return jsonb_build_object('admission_fee', coalesce(nullif(gymp.setting('admission_fee', '0'), '')::int, 0));
end $$;

-- ---------------------------------------------------------------- enquiries
create or replace function gymp.lead_json(l public.leads) returns jsonb language sql stable as $$
  select jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'interest', l.interest, 'source', l.source, 'status', l.status,
    'next_followup', gymp.d(l.next_followup), 'notes', l.notes, 'member_id', l.member_id, 'created_at', gymp.ts(l.created_at),
    'due', l.status in ('new','following') and l.next_followup is not null and l.next_followup <= gymp.today()) $$;

create or replace function gymp.o_leads(p jsonb) returns jsonb language plpgsql as $$
declare s text := coalesce(p ->> 'status', 'open');
begin
  if s not in ('open','joined','lost','all') then perform gymp.fail('bad_status'); end if;
  return jsonb_build_object('leads', coalesce((select jsonb_agg(gymp.lead_json(x.l) order by (x.l).next_followup nulls last, (x.l).id desc) from (
      select l from public.leads l where case s when 'open' then l.status in ('new','following') when 'all' then true else l.status = s end
      order by l.id desc limit 500) x), '[]'),
    'counts', jsonb_build_object(
      'open', (select count(*) from public.leads where status in ('new','following')),
      'due', (select count(*) from public.leads where status in ('new','following') and next_followup <= gymp.today()),
      'joined_month', (select count(*) from public.leads where status = 'joined' and to_char(updated_at at time zone 'Asia/Kolkata', 'YYYY-MM') = to_char(gymp.today(), 'YYYY-MM')),
      'total_month', (select count(*) from public.leads where to_char(created_at at time zone 'Asia/Kolkata', 'YYYY-MM') = to_char(gymp.today(), 'YYYY-MM'))));
end $$;

create or replace function gymp.o_lead_save(p jsonb) returns jsonb language plpgsql as $$
declare v_id bigint := case when coalesce(p ->> 'id', '') = '' then 0 else gymp.j_id(p, 'id') end;
  nm text := gymp.j_text(p, 'name', 100); ph text := gymp.norm_phone(p ->> 'phone'); st text := coalesce(nullif(p ->> 'status', ''), 'new');
  nf date := gymp.j_date(p, 'next_followup');
begin
  if length(nm) < 2 then perform gymp.fail('name_required'); end if;
  if ph is null then perform gymp.fail('bad_phone'); end if;
  if st not in ('new','following','joined','lost') then perform gymp.fail('bad_status'); end if;
  if v_id > 0 then
    update public.leads set name = nm, phone = ph, interest = nullif(gymp.j_text(p, 'interest', 200), ''), source = nullif(gymp.j_text(p, 'source', 40), ''),
      status = st, next_followup = nf, notes = nullif(gymp.j_text(p, 'notes', 500), ''), updated_at = now() where id = v_id;
    if not found then perform gymp.fail('not_found'); end if;
  else
    insert into public.leads (name, phone, interest, source, status, next_followup, notes)
      values (nm, ph, nullif(gymp.j_text(p, 'interest', 200), ''), nullif(gymp.j_text(p, 'source', 40), ''), st, coalesce(nf, gymp.today() + 1), nullif(gymp.j_text(p, 'notes', 500), ''))
      returning id into v_id;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function gymp.o_lead_delete(p jsonb) returns jsonb language plpgsql as $$
begin delete from public.leads where id = gymp.j_id(p, 'id'); return jsonb_build_object('ok', true); end $$;

-- ---------------------------------------------------------------- expenses & profit
create or replace function gymp.o_expenses(p jsonb) returns jsonb language plpgsql as $$
declare mon text := coalesce(nullif(p ->> 'month', ''), to_char(gymp.today(), 'YYYY-MM'));
begin
  if mon !~ '^\d{4}-(0[1-9]|1[0-2])$' then perform gymp.fail('bad_month'); end if;
  return jsonb_build_object('month', mon,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'day', gymp.d(day), 'category', category, 'amount', amount, 'note', note) order by day desc, id desc)
      from public.expenses where to_char(day, 'YYYY-MM') = mon), '[]'),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'amount', amt) order by amt desc)
      from (select category, sum(amount) amt from public.expenses where to_char(day, 'YYYY-MM') = mon group by category) x), '[]'),
    'total', (select coalesce(sum(amount), 0) from public.expenses where to_char(day, 'YYYY-MM') = mon),
    'income', (select coalesce(sum(amount), 0) from public.payments where status = 'confirmed' and to_char(decided_at at time zone 'Asia/Kolkata', 'YYYY-MM') = mon));
end $$;

create or replace function gymp.o_expense_save(p jsonb) returns jsonb language plpgsql as $$
declare v_id bigint := case when coalesce(p ->> 'id', '') = '' then 0 else gymp.j_id(p, 'id') end;
  cat text := gymp.j_text(p, 'category', 40); amt int := gymp.j_int(p, 'amount', 1, 10000000, 'bad_amount'); d date := coalesce(gymp.j_date(p, 'day'), gymp.today());
begin
  if length(cat) < 2 then perform gymp.fail('category_required'); end if;
  if d > gymp.today() + 31 then perform gymp.fail('bad_date'); end if;
  if v_id > 0 then
    update public.expenses set day = d, category = cat, amount = amt, note = nullif(gymp.j_text(p, 'note', 200), '') where id = v_id;
    if not found then perform gymp.fail('not_found'); end if;
  else
    insert into public.expenses (day, category, amount, note) values (d, cat, amt, nullif(gymp.j_text(p, 'note', 200), '')) returning id into v_id;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function gymp.o_expense_delete(p jsonb) returns jsonb language plpgsql as $$
begin delete from public.expenses where id = gymp.j_id(p, 'id'); return jsonb_build_object('ok', true); end $$;

create or replace function gymp.o_finance() returns jsonb language plpgsql as $$
declare t date := gymp.today();
begin
  return jsonb_build_object(
    'months', (select jsonb_agg(jsonb_build_object('label', to_char(mo, 'Mon'), 'month', to_char(mo, 'YYYY-MM'),
        'income', (select coalesce(sum(amount), 0) from public.payments where status = 'confirmed' and to_char(decided_at at time zone 'Asia/Kolkata', 'YYYY-MM') = to_char(mo, 'YYYY-MM')),
        'expenses', (select coalesce(sum(amount), 0) from public.expenses where to_char(day, 'YYYY-MM') = to_char(mo, 'YYYY-MM'))) order by mo)
      from generate_series(date_trunc('month', t) - interval '5 months', date_trunc('month', t), interval '1 month') mo),
    'leads_due', (select count(*) from public.leads where status in ('new','following') and next_followup <= t),
    'admission_fee', coalesce(nullif(gymp.setting('admission_fee', '0'), '')::int, 0));
end $$;

-- demo data for the new screens
create or replace function gymp.demo_extras() returns void language plpgsql as $$
declare t date := gymp.today(); i int;
begin
  insert into public.leads (name, phone, interest, source, status, next_followup, notes) values
    ('Manish Tiwari', '919000000051', 'Weight loss, evening batch', 'Walk-in', 'new', t, '[Demo] Asked about quarterly fee'),
    ('Kavya Rao', '919000000052', 'Zumba + gym', 'Instagram', 'following', t - 1, '[Demo] Will come with a friend'),
    ('Imran Sheikh', '919000000053', 'Personal training', 'Referral', 'following', t + 3, '[Demo] Budget around 3000/month'),
    ('Ritu Malhotra', '919000000054', 'Morning batch', 'Walk-in', 'lost', null, '[Demo] Joined another gym');
  for i in 0..5 loop
    insert into public.expenses (day, category, amount, note) values
      ((date_trunc('month', t) - make_interval(months => i))::date + 1, 'Rent', 3000, '[Demo]'),
      ((date_trunc('month', t) - make_interval(months => i))::date + 4, 'Salaries', 2500, '[Demo] Cleaner'),
      ((date_trunc('month', t) - make_interval(months => i))::date + 9, 'Electricity', 900 + i * 60, '[Demo]');
  end loop;
  insert into public.expenses (day, category, amount, note) values (t - 2, 'Equipment repair', 600, '[Demo] Treadmill belt');
end $$;

create or replace function gymp.o_remove_demo_extras() returns void language sql as $$
  delete from public.leads where notes like '[Demo]%';
  delete from public.expenses where note like '[Demo]%' $$;

-- ---------------------------------------------------------------- new actions are routed here, so future upgrades never need to touch gym_api again
create or replace function gymp.extra_action(p_action text, p_in jsonb, m public.members, o_id uuid) returns jsonb language plpgsql as $$
begin
  if left(p_action, 2) = 'o_' and o_id is not null then
    return case p_action
      when 'o_prefs' then gymp.o_prefs(p_in)
      when 'o_leads' then gymp.o_leads(p_in)
      when 'o_lead_save' then gymp.o_lead_save(p_in)
      when 'o_lead_delete' then gymp.o_lead_delete(p_in)
      when 'o_expenses' then gymp.o_expenses(p_in)
      when 'o_expense_save' then gymp.o_expense_save(p_in)
      when 'o_expense_delete' then gymp.o_expense_delete(p_in)
      when 'o_finance' then gymp.o_finance()
      else null end;
  end if;
  return null;
end $$;

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
        else gymp.extra_action(p_action, p_in, m, o_id) end;
      if res is null then perform gymp.fail('bad_action'); end if;
      if p_action = 'o_remove_demo' then perform gymp.o_remove_demo_extras(); end if;
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

-- demo installs also get enquiries and expenses
create or replace function gymp.install_demo() returns jsonb language plpgsql as $$
declare r jsonb;
begin r := gymp.install_demo_base(); perform gymp.demo_activity(); perform gymp.demo_extras(); return r; end $$;

-- rights
revoke all on all functions in schema gymp from public, anon, authenticated;
grant execute on function gymp.is_owner() to authenticated;
revoke all on function public.gym_api(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.gym_api(text, jsonb, text) to anon, authenticated;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'gymp' loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', f.sig);
  end loop;
end $$;
