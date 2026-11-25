-- =====================================================================
-- Gym Manager 2.3: freeze requests + auto-resume, diet plans, refer & earn,
-- personal training, batches & slots, offers & coupons.
-- Run after upgrade_2_2.sql.
-- =====================================================================

-- ---------------------------------------------------------------- tables
create table if not exists public.batches (
  id bigint generated always as identity primary key,
  name text not null check (length(name) between 2 and 40),
  starts time, ends time,
  capacity int not null default 0 check (capacity between 0 and 1000),   -- 0 = no limit
  active boolean not null default true, is_demo boolean not null default false,
  created_at timestamptz not null default now());

create table if not exists public.diet_plans (
  id bigint generated always as identity primary key,
  name text not null check (length(name) between 2 and 60),
  goal text check (length(goal) <= 60),
  body text not null check (length(body) between 2 and 3000),
  is_demo boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz);

create table if not exists public.trainers (
  id bigint generated always as identity primary key,
  name text not null check (length(name) between 2 and 60),
  phone text check (phone ~ '^91[5-9][0-9]{9}$'),
  active boolean not null default true, is_demo boolean not null default false,
  created_at timestamptz not null default now());

create table if not exists public.pt_packages (
  id bigint generated always as identity primary key,
  member_id bigint not null references public.members(id) on delete cascade,
  trainer_id bigint references public.trainers(id) on delete set null,
  sessions int not null check (sessions between 1 and 200),
  used int not null default 0 check (used >= 0),
  amount int not null default 0 check (amount between 0 and 1000000),
  starts date not null, expires date not null,
  status text not null default 'active' check (status in ('active','done','cancelled')),
  note text check (length(note) <= 200),
  created_at timestamptz not null default now());
create index if not exists pt_packages_member_idx on public.pt_packages (member_id, status);

create table if not exists public.pt_sessions (
  id bigint generated always as identity primary key,
  package_id bigint not null references public.pt_packages(id) on delete cascade,
  at timestamptz not null default now());
create index if not exists pt_sessions_pkg_idx on public.pt_sessions (package_id);

create table if not exists public.coupons (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^[A-Z0-9]{3,20}$'),
  kind text not null check (kind in ('percent','flat')),
  value int not null check (value between 1 and 100000),
  applies text not null default 'both' check (applies in ('renewal','joining','both')),
  valid_till date, max_uses int check (max_uses between 1 and 100000),
  show_in_app boolean not null default false, active boolean not null default true,
  note text check (length(note) <= 100), is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  check (kind <> 'percent' or value <= 90));

create table if not exists public.freeze_requests (
  id bigint generated always as identity primary key,
  member_id bigint not null references public.members(id) on delete cascade,
  days int not null check (days between 1 and 365),
  reason text check (length(reason) <= 200),
  status text not null default 'waiting' check (status in ('waiting','approved','rejected')),
  created_at timestamptz not null default now(), decided_at timestamptz);

create table if not exists public.freeze_log (
  id bigint generated always as identity primary key,
  member_id bigint not null references public.members(id) on delete cascade,
  from_day date not null, days int not null check (days >= 0),
  created_at timestamptz not null default now());

create table if not exists public.referrals (
  id bigint generated always as identity primary key,
  referrer_id bigint not null references public.members(id) on delete cascade,
  new_member_id bigint not null unique references public.members(id) on delete cascade,
  days int not null default 0,
  created_at timestamptz not null default now());

alter table public.members add column if not exists batch_id bigint references public.batches(id) on delete set null;
alter table public.members add column if not exists diet_plan_id bigint references public.diet_plans(id) on delete set null;
alter table public.members add column if not exists freeze_until date;
alter table public.members add column if not exists referred_by bigint references public.members(id) on delete set null;
alter table public.leads add column if not exists ref_member_id bigint references public.members(id) on delete set null;
alter table public.payments add column if not exists pt_package_id bigint references public.pt_packages(id) on delete set null;
alter table public.payments add column if not exists coupon_id bigint references public.coupons(id) on delete set null;
alter table public.payments add column if not exists discount int not null default 0 check (discount >= 0);
alter table public.payments drop constraint if exists payments_kind_check;
alter table public.payments add constraint payments_kind_check check (kind in ('membership','shop','pt'));

alter table public.batches enable row level security;
alter table public.diet_plans enable row level security;
alter table public.trainers enable row level security;
alter table public.pt_packages enable row level security;
alter table public.pt_sessions enable row level security;
alter table public.coupons enable row level security;
alter table public.freeze_requests enable row level security;
alter table public.freeze_log enable row level security;
alter table public.referrals enable row level security;
revoke all on public.batches, public.diet_plans, public.trainers, public.pt_packages, public.pt_sessions,
  public.coupons, public.freeze_requests, public.freeze_log, public.referrals from public, anon, authenticated;

insert into public.settings (k, v) values ('referral_days', '7'), ('freeze_max_days', '30') on conflict (k) do nothing;

-- ---------------------------------------------------------------- helpers
create or replace function gymp.int_setting(key text, dflt int) returns int language sql stable as $$
  select coalesce(nullif(gymp.setting(key, dflt::text), '')::int, dflt) $$;

create or replace function gymp.batch_label(b_id bigint) returns text language sql stable as $$
  select b.name || case when b.starts is not null then ' · ' || to_char(b.starts, 'HH12:MI AM') || coalesce('–' || to_char(b.ends, 'HH12:MI AM'), '') else '' end
  from public.batches b where b.id = b_id $$;

-- member json now carries batch, diet, planned freeze end
create or replace function gymp.pm(m public.members, plan_name text) returns jsonb language sql stable as $$
  select jsonb_build_object('id', m.id, 'code', m.code, 'name', m.name, 'phone', m.phone, 'plan_id', m.plan_id, 'plan', plan_name,
    'fee', m.fee, 'start_date', gymp.d(m.start_date), 'expiry_date', gymp.d(m.expiry_date), 'days_left', m.expiry_date - gymp.today(),
    'dues', m.dues, 'status', gymp.mstatus(m), 'raw_status', m.status, 'frozen_on', gymp.d(m.frozen_on), 'notes', m.notes,
    'birthday', gymp.d(m.birthday), 'consent', m.consent, 'last_reminder', gymp.d(m.last_reminder), 'is_demo', m.is_demo,
    'freeze_until', gymp.d(m.freeze_until), 'batch_id', m.batch_id, 'batch', gymp.batch_label(m.batch_id),
    'diet_plan_id', m.diet_plan_id, 'diet', (select name from public.diet_plans where id = m.diet_plan_id)) $$;

-- days frozen this calendar year (finished freezes + the running one)
create or replace function gymp.freeze_used(m public.members) returns int language sql stable as $$
  select coalesce((select sum(days) from public.freeze_log where member_id = m.id and extract(year from from_day) = extract(year from gymp.today())), 0)::int
    + case when m.status = 'frozen' and m.frozen_on is not null then greatest(0, gymp.today() - m.frozen_on) else 0 end $$;

-- planned freezes end by themselves; called on every request (cheap: exits when nothing is due)
create or replace function gymp.auto_unfreeze() returns void language plpgsql as $$
declare t date := gymp.today();
begin
  if not exists (select 1 from public.members where status = 'frozen' and freeze_until is not null and freeze_until <= t) then return; end if;
  insert into public.freeze_log (member_id, from_day, days)
    select id, coalesce(frozen_on, freeze_until), greatest(0, freeze_until - coalesce(frozen_on, freeze_until))
    from public.members where status = 'frozen' and freeze_until is not null and freeze_until <= t;
  update public.members set status = 'active',
      expiry_date = case when expiry_date >= coalesce(frozen_on, freeze_until) then expiry_date + greatest(0, freeze_until - coalesce(frozen_on, freeze_until)) else expiry_date end,
      frozen_on = null, freeze_until = null
    where status = 'frozen' and freeze_until is not null and freeze_until <= t;
end $$;

create or replace function gymp.check_batch(b_id bigint, m_id bigint) returns void language plpgsql as $$
declare b public.batches;
begin
  if b_id is null then return; end if;
  select * into b from public.batches where id = b_id;
  if b.id is null then perform gymp.fail('bad_batch'); end if;
  if exists (select 1 from public.members where id = m_id and batch_id = b_id) then return; end if;   -- unchanged
  if b.capacity > 0 and (select count(*) from public.members where batch_id = b_id and status <> 'archived') >= b.capacity then perform gymp.fail('batch_full'); end if;
end $$;

create or replace function gymp.opt_id(p jsonb, k text) returns bigint language sql immutable as $$
  select case when coalesce(p ->> k, '') = '' then null else gymp.j_id(p, k) end $$;

-- ---------------------------------------------------------------- coupons
create or replace function gymp.coupon_use(v_code text, base int, for_what text, m_id bigint) returns jsonb language plpgsql as $$
declare c public.coupons; disc int;
begin
  select * into c from public.coupons where code = upper(trim(coalesce(v_code, ''))) and active;
  if c.id is null then perform gymp.fail('bad_coupon'); end if;
  if c.valid_till is not null and c.valid_till < gymp.today() then perform gymp.fail('coupon_expired'); end if;
  if c.applies not in (for_what, 'both') then perform gymp.fail(case when for_what = 'joining' then 'coupon_renewal_only' else 'coupon_joining_only' end); end if;
  if c.max_uses is not null and (select count(*) from public.payments where coupon_id = c.id and status <> 'rejected') >= c.max_uses then perform gymp.fail('coupon_used_up'); end if;
  if m_id is not null and exists (select 1 from public.payments where coupon_id = c.id and member_id = m_id and status <> 'rejected') then perform gymp.fail('coupon_already_used'); end if;
  disc := least(base, case when c.kind = 'percent' then round(base * c.value / 100.0)::int else c.value end);
  return jsonb_build_object('id', c.id, 'code', c.code, 'discount', disc, 'amount', base - disc);
end $$;

create or replace function gymp.coupon_json(c public.coupons) returns jsonb language sql stable as $$
  select jsonb_build_object('id', c.id, 'code', c.code, 'kind', c.kind, 'value', c.value, 'applies', c.applies,
    'valid_till', gymp.d(c.valid_till), 'max_uses', c.max_uses, 'show_in_app', c.show_in_app, 'active', c.active, 'note', c.note,
    'uses', (select count(*) from public.payments where coupon_id = c.id and status <> 'rejected'),
    'saved', (select coalesce(sum(discount), 0) from public.payments where coupon_id = c.id and status = 'confirmed'),
    'expired', c.valid_till is not null and c.valid_till < gymp.today(),
    'label', case when c.kind = 'percent' then c.value || '% off' else '₹' || c.value || ' off' end) $$;

create or replace function gymp.o_coupons() returns jsonb language sql stable as $$
  select jsonb_build_object('coupons', coalesce((select jsonb_agg(gymp.coupon_json(c) order by c.active desc, c.id desc) from public.coupons c), '[]')) $$;

create or replace function gymp.o_coupon_save(p jsonb) returns jsonb language plpgsql as $$
declare v_id bigint := gymp.opt_id(p, 'id'); v_code text := upper(regexp_replace(coalesce(p ->> 'code', ''), '\s', '', 'g'));
  v_kind text := case when p ->> 'kind' = 'flat' then 'flat' else 'percent' end; v_val int := gymp.j_int(p, 'value', 1, 100000, 'bad_amount');
  v_app text := coalesce(nullif(p ->> 'applies', ''), 'both'); v_max int := case when coalesce(p ->> 'max_uses', '') = '' then null else gymp.j_int(p, 'max_uses', 1, 100000, 'bad_amount') end;
begin
  if v_code !~ '^[A-Z0-9]{3,20}$' then perform gymp.fail('bad_coupon_code'); end if;
  if v_kind = 'percent' and v_val > 90 then perform gymp.fail('bad_percent'); end if;
  if v_app not in ('renewal','joining','both') then perform gymp.fail('bad_action'); end if;
  if exists (select 1 from public.coupons where code = v_code and id is distinct from v_id) then perform gymp.fail('coupon_exists'); end if;
  if v_id is not null then
    update public.coupons set code = v_code, kind = v_kind, value = v_val, applies = v_app, valid_till = gymp.j_date(p, 'valid_till'),
      max_uses = v_max, show_in_app = gymp.j_bool(p, 'show_in_app'), active = gymp.j_bool(p, 'active'), note = nullif(gymp.j_text(p, 'note', 100), '') where id = v_id;
    if not found then perform gymp.fail('not_found'); end if;
  else
    insert into public.coupons (code, kind, value, applies, valid_till, max_uses, show_in_app, active, note)
      values (v_code, v_kind, v_val, v_app, gymp.j_date(p, 'valid_till'), v_max, gymp.j_bool(p, 'show_in_app'), true, nullif(gymp.j_text(p, 'note', 100), '')) returning id into v_id;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function gymp.o_coupon_delete(p jsonb) returns jsonb language plpgsql as $$
declare v_id bigint := gymp.j_id(p, 'id');
begin
  if exists (select 1 from public.payments where coupon_id = v_id) then
    update public.coupons set active = false where id = v_id;     -- keep payment history meaningful
    return jsonb_build_object('hidden', true);
  end if;
  delete from public.coupons where id = v_id;
  return jsonb_build_object('deleted', true);
end $$;

create or replace function gymp.offers_json() returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', c.code, 'label', case when c.kind = 'percent' then c.value || '% off' else '₹' || c.value || ' off' end,
      'note', c.note, 'valid_till', gymp.d(c.valid_till)) order by c.id desc), '[]')
  from public.coupons c where c.active and c.show_in_app and c.applies in ('renewal','both')
    and (c.valid_till is null or c.valid_till >= gymp.today())
    and (c.max_uses is null or (select count(*) from public.payments where coupon_id = c.id and status <> 'rejected') < c.max_uses) $$;

create or replace function gymp.m_plans() returns jsonb language sql stable as $$
  select jsonb_build_object('plans', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'months', months, 'fee', fee) order by sort, months) from public.plans where active), '[]'),
    'offers', gymp.offers_json()) $$;

create or replace function gymp.m_coupon_check(m public.members, p jsonb) returns jsonb language plpgsql as $$
declare keys text[] := array['cp:' || m.id]; pl public.plans; r jsonb; msg text;
begin
  if gymp.rl_blocked(keys, array[10]) then return gymp.err('too_many_attempts'); end if;
  select * into pl from public.plans where id = gymp.j_id(p, 'plan_id') and active;
  if pl.id is null then return gymp.err('bad_plan'); end if;
  begin
    r := gymp.coupon_use(p ->> 'code', pl.fee, 'renewal', m.id);
  exception when others then
    get stacked diagnostics msg = message_text;
    perform gymp.rl_fail(keys);
    return gymp.err(case when msg like 'GYM:%' then substr(msg, 5) else 'bad_coupon' end);
  end;
  return r - 'id';
end $$;

create or replace function gymp.m_renew(m public.members, p jsonb) returns jsonb language plpgsql as $$
declare utr text := gymp.j_text(p, 'utr', 40); pl public.plans; amt int; pl_id bigint; cp jsonb; v_note text;
begin
  if utr <> '' and utr !~ '^[A-Za-z0-9]{6,40}$' then perform gymp.fail('bad_utr'); end if;
  perform 1 from public.members where id = m.id for update;
  if exists (select 1 from public.payments where member_id = m.id and kind = 'membership' and status = 'waiting') then perform gymp.fail('already_waiting'); end if;
  if m.dues > 0 then amt := m.dues; pl_id := m.plan_id;
  else
    select * into pl from public.plans where id = gymp.j_id(p, 'plan_id') and active;
    if pl.id is null then perform gymp.fail('bad_plan'); end if;
    amt := pl.fee; pl_id := pl.id;
    if coalesce(p ->> 'coupon', '') <> '' then
      cp := gymp.coupon_use(p ->> 'coupon', pl.fee, 'renewal', m.id);
      amt := (cp ->> 'amount')::int;
      v_note := 'Coupon ' || (cp ->> 'code') || ' (−₹' || (cp ->> 'discount') || ')';
    end if;
  end if;
  insert into public.payments (member_id, kind, plan_id, amount, mode, status, utr, coupon_id, discount, note)
    values (m.id, 'membership', pl_id, amt, 'upi', 'waiting', nullif(utr, ''), (cp ->> 'id')::bigint, coalesce((cp ->> 'discount')::int, 0), v_note);
  return jsonb_build_object('amount', amt);
end $$;

create or replace function gymp.o_payment_record(p jsonb) returns jsonb language plpgsql as $$
declare m public.members; mode text := case when p ->> 'mode' = 'upi' then 'upi' else 'cash' end; amt int; pl_id bigint; per jsonb; rid bigint; cp jsonb; v_note text;
begin
  select * into m from public.members where id = gymp.j_id(p, 'member_id') for update;
  if m.id is null then perform gymp.fail('not_found'); end if;
  if m.dues > 0 then
    amt := case when p ? 'amount' then gymp.j_int(p, 'amount', 1, m.dues, 'bad_amount') else m.dues end;
    pl_id := m.plan_id;
  else
    select id, fee into pl_id, amt from public.plans where id = gymp.j_id(p, 'plan_id');
    if pl_id is null then perform gymp.fail('bad_plan'); end if;
    if coalesce(p ->> 'coupon', '') <> '' then
      cp := gymp.coupon_use(p ->> 'coupon', amt, 'renewal', m.id);
      amt := (cp ->> 'amount')::int;
      v_note := 'Coupon ' || (cp ->> 'code') || ' (−₹' || (cp ->> 'discount') || ')';
    end if;
  end if;
  per := gymp.apply_membership(m.id, pl_id, amt);
  insert into public.payments (member_id, kind, plan_id, amount, mode, status, receipt_no, period_from, period_to, decided_at, coupon_id, discount, note)
    values (m.id, 'membership', pl_id, amt, mode, 'confirmed', gymp.next_receipt(), (per ->> 'from')::date, (per ->> 'to')::date, now(),
      (cp ->> 'id')::bigint, coalesce((cp ->> 'discount')::int, 0), v_note) returning id into rid;
  return jsonb_build_object('receipt_id', rid, 'period', per);
end $$;

-- ---------------------------------------------------------------- new member: batch, diet, coupon, referral
create or replace function gymp.o_member_save(p jsonb) returns jsonb language plpgsql as $$
declare v_id bigint := case when coalesce(p ->> 'id', '') = '' then 0 else gymp.j_id(p, 'id') end;
  nm text := gymp.j_text(p, 'name', 100); ph text := gymp.norm_phone(p ->> 'phone'); v_notes text := gymp.j_text(p, 'notes', 500);
  bday date := gymp.j_date(p, 'birthday', 'bad_birthday'); v_consent boolean := gymp.j_bool(p, 'consent');
  pl public.plans; st date; exp date; paid boolean; mode text; pin text; m_id bigint; rid bigint; adm int := 0; v_lead public.leads;
  v_batch bigint := gymp.opt_id(p, 'batch_id'); v_diet bigint := gymp.opt_id(p, 'diet_plan_id'); total int; cp jsonb; v_note text;
  ref_id bigint; ref_days int := gymp.int_setting('referral_days', 7); ref_name text;
begin
  if length(nm) < 2 then perform gymp.fail('name_required'); end if;
  if ph is null then perform gymp.fail('bad_phone'); end if;
  if exists (select 1 from public.members where phone = ph and id <> v_id) then perform gymp.fail('phone_exists'); end if;
  if v_diet is not null and not exists (select 1 from public.diet_plans where id = v_diet) then perform gymp.fail('not_found'); end if;
  if v_id > 0 then
    if not exists (select 1 from public.members where id = v_id) then perform gymp.fail('not_found'); end if;
    if p ? 'batch_id' then perform gymp.check_batch(v_batch, v_id); end if;
    update public.members set name = nm, phone = ph, notes = nullif(v_notes, ''), birthday = bday, consent = v_consent where id = v_id;
    if p ? 'batch_id' then update public.members set batch_id = v_batch where id = v_id; end if;
    if p ? 'diet_plan_id' then update public.members set diet_plan_id = v_diet where id = v_id; end if;
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
  perform gymp.check_batch(v_batch, 0);
  st := coalesce(gymp.j_date(p, 'start_date'), gymp.today());
  exp := (st + make_interval(months => pl.months))::date;
  paid := gymp.j_bool(p, 'paid_now');
  mode := case when p ->> 'mode' = 'upi' then 'upi' else 'cash' end;
  if gymp.j_bool(p, 'admission') then adm := gymp.int_setting('admission_fee', 0); end if;
  total := pl.fee + adm;
  v_note := case when adm > 0 then 'Joining (includes admission fee ₹' || adm || ')' else 'Joining' end;
  if coalesce(p ->> 'coupon', '') <> '' then
    cp := gymp.coupon_use(p ->> 'coupon', total, 'joining', null);
    total := (cp ->> 'amount')::int;
    v_note := v_note || ' · Coupon ' || (cp ->> 'code') || ' (−₹' || (cp ->> 'discount') || ')';
  end if;
  -- who referred them: the enquiry's referrer, or a member code typed by the owner
  if coalesce(p ->> 'lead_id', '') <> '' then
    select * into v_lead from public.leads where id = gymp.j_id(p, 'lead_id');
    ref_id := v_lead.ref_member_id;
  end if;
  if ref_id is null and coalesce(p ->> 'ref_code', '') <> '' then
    select id into ref_id from public.members where code = upper(trim(p ->> 'ref_code')) and status <> 'archived';
    if ref_id is null then perform gymp.fail('bad_ref_code'); end if;
  end if;
  pin := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000))::text, 6, '0');
  insert into public.members (code, name, phone, pin_hash, plan_id, fee, start_date, expiry_date, dues, notes, birthday, consent, batch_id, diet_plan_id, referred_by)
    values (gymp.next_code(), nm, ph, extensions.crypt(pin, extensions.gen_salt('bf', 8)), pl.id, pl.fee, st, exp,
      case when paid then 0 else total end, nullif(v_notes, ''), bday, v_consent, v_batch, v_diet, ref_id)
    returning id into m_id;
  if paid then
    insert into public.payments (member_id, kind, plan_id, amount, mode, status, receipt_no, period_from, period_to, note, decided_at, coupon_id, discount)
      values (m_id, 'membership', pl.id, total, mode, 'confirmed', gymp.next_receipt(), st, exp, v_note, now(),
        (cp ->> 'id')::bigint, coalesce((cp ->> 'discount')::int, 0)) returning id into rid;
  end if;
  if v_lead.id is not null then
    update public.leads set status = 'joined', member_id = m_id, updated_at = now() where id = v_lead.id;
  end if;
  if ref_id is not null then
    if ref_days > 0 then
      update public.members set expiry_date = greatest(expiry_date, gymp.today()) + ref_days where id = ref_id returning name into ref_name;
    else
      select name into ref_name from public.members where id = ref_id;
    end if;
    insert into public.referrals (referrer_id, new_member_id, days) values (ref_id, m_id, ref_days);
  end if;
  return jsonb_build_object('id', m_id, 'pin', pin, 'receipt_id', rid, 'admission', adm,
    'referral', case when ref_id is not null then jsonb_build_object('name', ref_name, 'days', ref_days) end);
end $$;

-- ---------------------------------------------------------------- members list: batch filter
create or replace function gymp.o_members(p jsonb) returns jsonb language plpgsql as $$
declare f text := coalesce(p ->> 'filter', 'all'); s text := gymp.j_text(p, 'q', 60); t date := gymp.today(); lk text; bid bigint := gymp.opt_id(p, 'batch');
begin
  lk := '%' || replace(replace(replace(s, '!', '!!'), '%', '!%'), '_', '!_') || '%';
  return jsonb_build_object('members', coalesce((
    select jsonb_agg(gymp.pm(x.m0, pl.name) order by (x.m0).expiry_date, (x.m0).name)
    from (select m0 from public.members m0 where
      case f when 'archived' then m0.status = 'archived' else m0.status <> 'archived' end
      and case f
        when 'active' then m0.status = 'active' and m0.expiry_date >= t
        when 'expiring' then m0.status = 'active' and m0.expiry_date between t and t + 3
        when 'expired' then m0.status = 'active' and m0.expiry_date < t
        when 'frozen' then m0.status = 'frozen'
        when 'dues' then m0.dues > 0
        else true end
      and (bid is null or m0.batch_id = bid)
      and (s = '' or m0.name ilike lk escape '!' or m0.phone like lk escape '!' or m0.code ilike lk escape '!')
      order by m0.expiry_date, m0.name limit 1000) x
    left join public.plans pl on pl.id = (x.m0).plan_id), '[]'));
end $$;

-- ---------------------------------------------------------------- freeze
create or replace function gymp.o_member_action(p jsonb) returns jsonb language plpgsql as $$
declare m public.members; act text := coalesce(p ->> 'action', ''); t date := gymp.today(); paused int; newexp date; pin text; v_days int;
begin
  select * into m from public.members where id = gymp.j_id(p, 'id') for update;
  if m.id is null then perform gymp.fail('not_found'); end if;
  if act = 'freeze' then
    if m.status <> 'active' then perform gymp.fail('not_active'); end if;
    v_days := case when coalesce(p ->> 'days', '') = '' then null else gymp.j_int(p, 'days', 1, 365, 'bad_days') end;
    update public.members set status = 'frozen', frozen_on = t, freeze_until = t + v_days where id = m.id;
    update public.freeze_requests set status = 'approved', decided_at = now() where member_id = m.id and status = 'waiting';
    return jsonb_build_object('ok', true, 'freeze_until', gymp.d(t + v_days));
  elsif act = 'unfreeze' then
    if m.status <> 'frozen' then perform gymp.fail('not_frozen'); end if;
    paused := greatest(0, t - coalesce(m.frozen_on, t));
    newexp := case when m.expiry_date >= coalesce(m.frozen_on, t) then m.expiry_date + paused else m.expiry_date end;
    insert into public.freeze_log (member_id, from_day, days) values (m.id, coalesce(m.frozen_on, t), paused);
    update public.members set status = 'active', frozen_on = null, freeze_until = null, expiry_date = newexp where id = m.id;
    return jsonb_build_object('expiry_date', gymp.d(newexp));
  elsif act = 'archive' then
    update public.members set status = 'archived', sess_ver = sess_ver + 1 where id = m.id;
    delete from public.member_sessions where member_id = m.id;
    return jsonb_build_object('ok', true);
  elsif act = 'restore' then
    if m.status <> 'archived' then perform gymp.fail('not_archived'); end if;
    update public.members set status = 'active' where id = m.id;
    return jsonb_build_object('ok', true);
  elsif act = 'reset_pin' then
    pin := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000))::text, 6, '0');
    update public.members set pin_hash = extensions.crypt(pin, extensions.gen_salt('bf', 8)), pin_must_change = true, sess_ver = sess_ver + 1 where id = m.id;
    delete from public.member_sessions where member_id = m.id;
    delete from public.login_attempts where k = 'm:' || m.phone or k like 'm:' || m.phone || '|%';
    return jsonb_build_object('pin', pin);
  end if;
  perform gymp.fail('bad_action');
end $$;

create or replace function gymp.m_freeze_request(m public.members, p jsonb) returns jsonb language plpgsql as $$
declare v_days int := gymp.j_int(p, 'days', 1, 365, 'bad_days'); mx int := gymp.int_setting('freeze_max_days', 30);
begin
  perform 1 from public.members where id = m.id for update;
  if m.status <> 'active' or m.expiry_date < gymp.today() then perform gymp.fail('not_active'); end if;
  if v_days < 3 then perform gymp.fail('freeze_min_days'); end if;
  if exists (select 1 from public.freeze_requests where member_id = m.id and status = 'waiting') then perform gymp.fail('already_waiting'); end if;
  if mx > 0 and gymp.freeze_used(m) + v_days > mx then perform gymp.fail('freeze_limit'); end if;
  insert into public.freeze_requests (member_id, days, reason) values (m.id, v_days, nullif(gymp.j_text(p, 'reason', 200), ''));
  return jsonb_build_object('ok', true);
end $$;

create or replace function gymp.m_freeze_cancel(m public.members) returns jsonb language sql as $$
  update public.freeze_requests set status = 'rejected', decided_at = now() where member_id = m.id and status = 'waiting';
  select jsonb_build_object('ok', true) $$;

create or replace function gymp.o_freeze_requests() returns jsonb language sql stable as $$
  select jsonb_build_object('requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'member_id', m.id, 'name', m.name, 'code', m.code, 'phone', m.phone,
      'days', r.days, 'reason', r.reason, 'created_at', gymp.ts(r.created_at), 'used', gymp.freeze_used(m), 'expiry_date', gymp.d(m.expiry_date)) order by r.id)
    from public.freeze_requests r join public.members m on m.id = r.member_id where r.status = 'waiting'), '[]'),
    'max_days', gymp.int_setting('freeze_max_days', 30)) $$;

create or replace function gymp.o_freeze_decide(p jsonb) returns jsonb language plpgsql as $$
declare r public.freeze_requests; m public.members; dec text := coalesce(p ->> 'decision', ''); t date := gymp.today();
begin
  if dec not in ('approve','reject') then perform gymp.fail('bad_decision'); end if;
  update public.freeze_requests set status = case when dec = 'approve' then 'approved' else 'rejected' end, decided_at = now()
    where id = gymp.j_id(p, 'id') and status = 'waiting' returning * into r;
  if r.id is null then perform gymp.fail('already_decided'); end if;
  if dec = 'approve' then
    select * into m from public.members where id = r.member_id for update;
    if m.status <> 'active' then perform gymp.fail('not_active'); end if;
    update public.members set status = 'frozen', frozen_on = t, freeze_until = t + r.days where id = m.id;
    return jsonb_build_object('status', 'approved', 'freeze_until', gymp.d(t + r.days));
  end if;
  return jsonb_build_object('status', 'rejected');
end $$;

-- ---------------------------------------------------------------- diet plans
create or replace function gymp.o_diets() returns jsonb language sql stable as $$
  select jsonb_build_object('diets', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'goal', d.goal, 'body', d.body,
      'members', (select count(*) from public.members where diet_plan_id = d.id and status <> 'archived')) order by d.name) from public.diet_plans d), '[]')) $$;

create or replace function gymp.o_diet_save(p jsonb) returns jsonb language plpgsql as $$
declare v_id bigint := gymp.opt_id(p, 'id'); nm text := gymp.j_text(p, 'name', 60); v_body text := left(trim(coalesce(p ->> 'body', '')), 3000);
begin
  if length(nm) < 2 then perform gymp.fail('name_required'); end if;
  if length(v_body) < 2 then perform gymp.fail('diet_required'); end if;
  if v_id is not null then
    update public.diet_plans set name = nm, goal = nullif(gymp.j_text(p, 'goal', 60), ''), body = v_body, updated_at = now() where id = v_id;
    if not found then perform gymp.fail('not_found'); end if;
  else
    insert into public.diet_plans (name, goal, body) values (nm, nullif(gymp.j_text(p, 'goal', 60), ''), v_body) returning id into v_id;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function gymp.o_diet_delete(p jsonb) returns jsonb language sql as $$
  delete from public.diet_plans where id = gymp.j_id(p, 'id'); select jsonb_build_object('ok', true) $$;

create or replace function gymp.m_diet(m public.members) returns jsonb language sql stable as $$
  select jsonb_build_object('diet', (select jsonb_build_object('name', d.name, 'goal', d.goal, 'body', d.body, 'updated', gymp.ts(coalesce(d.updated_at, d.created_at)))
    from public.diet_plans d where d.id = m.diet_plan_id)) $$;

-- ---------------------------------------------------------------- batches
create or replace function gymp.o_batches() returns jsonb language sql stable as $$
  select jsonb_build_object('batches', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name,
      'starts', to_char(b.starts, 'HH24:MI'), 'ends', to_char(b.ends, 'HH24:MI'), 'label', gymp.batch_label(b.id), 'capacity', b.capacity, 'active', b.active,
      'members', (select count(*) from public.members where batch_id = b.id and status <> 'archived')) order by b.active desc, b.starts nulls last, b.name) from public.batches b), '[]'),
    'unassigned', (select count(*) from public.members where batch_id is null and status <> 'archived')) $$;

create or replace function gymp.o_batch_save(p jsonb) returns jsonb language plpgsql as $$
declare v_id bigint := gymp.opt_id(p, 'id'); nm text := gymp.j_text(p, 'name', 40); s time; e time;
  cap int := case when coalesce(p ->> 'capacity', '') = '' then 0 else gymp.j_int(p, 'capacity', 0, 1000, 'bad_capacity') end;
begin
  if length(nm) < 2 then perform gymp.fail('name_required'); end if;
  begin
    s := nullif(p ->> 'starts', '')::time; e := nullif(p ->> 'ends', '')::time;
  exception when others then perform gymp.fail('bad_time'); end;
  if v_id is not null then
    update public.batches set name = nm, starts = s, ends = e, capacity = cap, active = case when p ? 'active' then gymp.j_bool(p, 'active') else true end where id = v_id;
    if not found then perform gymp.fail('not_found'); end if;
  else
    insert into public.batches (name, starts, ends, capacity) values (nm, s, e, cap) returning id into v_id;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function gymp.o_batch_delete(p jsonb) returns jsonb language sql as $$
  delete from public.batches where id = gymp.j_id(p, 'id'); select jsonb_build_object('ok', true) $$;

-- ---------------------------------------------------------------- personal training
create or replace function gymp.pt_json(k public.pt_packages) returns jsonb language sql stable as $$
  select jsonb_build_object('id', k.id, 'member_id', k.member_id, 'member_name', m.name, 'member_code', m.code, 'member_phone', m.phone,
    'trainer_id', k.trainer_id, 'trainer', t.name, 'sessions', k.sessions, 'used', k.used, 'left', k.sessions - k.used,
    'amount', k.amount, 'starts', gymp.d(k.starts), 'expires', gymp.d(k.expires), 'status', k.status, 'note', k.note,
    'expired', k.expires < gymp.today(),
    'last_session', (select gymp.ts(max(at)) from public.pt_sessions where package_id = k.id),
    'today', exists (select 1 from public.pt_sessions where package_id = k.id and (at at time zone 'Asia/Kolkata')::date = gymp.today()))
  from public.members m left join public.trainers t on t.id = k.trainer_id where m.id = k.member_id $$;

create or replace function gymp.o_pt(p jsonb) returns jsonb language plpgsql as $$
declare s text := coalesce(nullif(p ->> 'status', ''), 'active'); mid bigint := gymp.opt_id(p, 'member_id');
begin
  if s not in ('active','done','all') then perform gymp.fail('bad_status'); end if;
  return jsonb_build_object(
    'trainers', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'phone', t.phone, 'active', t.active,
        'clients', (select count(*) from public.pt_packages where trainer_id = t.id and status = 'active'),
        'sessions_month', (select count(*) from public.pt_sessions ss join public.pt_packages k on k.id = ss.package_id
           where k.trainer_id = t.id and to_char(ss.at at time zone 'Asia/Kolkata', 'YYYY-MM') = to_char(gymp.today(), 'YYYY-MM'))) order by t.active desc, t.name) from public.trainers t), '[]'),
    'packages', coalesce((select jsonb_agg(gymp.pt_json(x.k) order by (x.k).status, (x.k).expires) from (
        select k from public.pt_packages k where (mid is null or k.member_id = mid)
          and case s when 'active' then k.status = 'active' when 'done' then k.status <> 'active' else true end
        order by k.id desc limit 300) x), '[]'),
    'sessions_today', (select count(*) from public.pt_sessions where (at at time zone 'Asia/Kolkata')::date = gymp.today()));
end $$;

create or replace function gymp.o_trainer_save(p jsonb) returns jsonb language plpgsql as $$
declare v_id bigint := gymp.opt_id(p, 'id'); nm text := gymp.j_text(p, 'name', 60); ph text := case when coalesce(p ->> 'phone', '') = '' then null else gymp.norm_phone(p ->> 'phone') end;
begin
  if length(nm) < 2 then perform gymp.fail('name_required'); end if;
  if coalesce(p ->> 'phone', '') <> '' and ph is null then perform gymp.fail('bad_phone'); end if;
  if v_id is not null then
    update public.trainers set name = nm, phone = ph, active = case when p ? 'active' then gymp.j_bool(p, 'active') else true end where id = v_id;
    if not found then perform gymp.fail('not_found'); end if;
  else
    insert into public.trainers (name, phone) values (nm, ph) returning id into v_id;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function gymp.o_pt_save(p jsonb) returns jsonb language plpgsql as $$
declare m public.members; tr bigint := gymp.opt_id(p, 'trainer_id'); n int := gymp.j_int(p, 'sessions', 1, 200, 'bad_sessions');
  amt int := gymp.j_int(p, 'amount', 0, 1000000, 'bad_amount'); vd int := case when coalesce(p ->> 'valid_days', '') = '' then 60 else gymp.j_int(p, 'valid_days', 7, 730, 'bad_days') end;
  st date := coalesce(gymp.j_date(p, 'starts'), gymp.today()); k_id bigint; rid bigint; tname text;
  mode text := case when p ->> 'mode' = 'upi' then 'upi' else 'cash' end;
begin
  select * into m from public.members where id = gymp.j_id(p, 'member_id') for update;
  if m.id is null or m.status = 'archived' then perform gymp.fail('not_found'); end if;
  if tr is not null then
    select name into tname from public.trainers where id = tr;
    if tname is null then perform gymp.fail('bad_trainer'); end if;
  end if;
  insert into public.pt_packages (member_id, trainer_id, sessions, amount, starts, expires, note)
    values (m.id, tr, n, amt, st, st + vd, nullif(gymp.j_text(p, 'note', 200), '')) returning id into k_id;
  if amt > 0 then
    if gymp.j_bool(p, 'paid_now') then
      insert into public.payments (member_id, kind, amount, mode, status, receipt_no, period_from, period_to, note, decided_at, pt_package_id)
        values (m.id, 'pt', amt, mode, 'confirmed', gymp.next_receipt(), st, st + vd,
          'Personal training · ' || n || ' sessions' || coalesce(' with ' || tname, ''), now(), k_id) returning id into rid;
    else
      update public.members set dues = least(1000000, dues + amt) where id = m.id;
    end if;
  end if;
  return jsonb_build_object('id', k_id, 'receipt_id', rid);
end $$;

create or replace function gymp.o_pt_session(p jsonb) returns jsonb language plpgsql as $$
declare k public.pt_packages; undo boolean := gymp.j_bool(p, 'undo'); s_id bigint;
begin
  select * into k from public.pt_packages where id = gymp.j_id(p, 'id') for update;
  if k.id is null then perform gymp.fail('not_found'); end if;
  if undo then
    select id into s_id from public.pt_sessions where package_id = k.id order by at desc, id desc limit 1;
    if s_id is null then perform gymp.fail('nothing_to_undo'); end if;
    delete from public.pt_sessions where id = s_id;
    update public.pt_packages set used = greatest(0, used - 1), status = case when status = 'done' then 'active' else status end where id = k.id;
  else
    if k.status <> 'active' then perform gymp.fail('pt_not_active'); end if;
    if k.expires < gymp.today() then perform gymp.fail('pt_expired'); end if;
    if k.used >= k.sessions then perform gymp.fail('pt_no_sessions'); end if;
    insert into public.pt_sessions (package_id) values (k.id);
    update public.pt_packages set used = used + 1, status = case when used + 1 >= sessions then 'done' else 'active' end where id = k.id;
  end if;
  select * into k from public.pt_packages where id = k.id;
  return gymp.pt_json(k);
end $$;

create or replace function gymp.o_pt_cancel(p jsonb) returns jsonb language sql as $$
  update public.pt_packages set status = 'cancelled' where id = gymp.j_id(p, 'id') and status = 'active';
  select jsonb_build_object('ok', true) $$;

-- ---------------------------------------------------------------- referrals & public join form
create or replace function gymp.m_referrals(m public.members) returns jsonb language sql stable as $$
  select jsonb_build_object('code', m.code, 'days', gymp.int_setting('referral_days', 7),
    'friends', coalesce((select jsonb_agg(jsonb_build_object('name', split_part(n.name, ' ', 1), 'date', gymp.ts(r.created_at), 'days', r.days) order by r.id desc)
      from public.referrals r join public.members n on n.id = r.new_member_id where r.referrer_id = m.id), '[]'),
    'pending', (select count(*) from public.leads where ref_member_id = m.id and status in ('new','following')),
    'total_days', (select coalesce(sum(days), 0) from public.referrals where referrer_id = m.id)) $$;

-- Anyone can send "I want to join" from a shared link. Rate limited; never says whether a phone is already known.
create or replace function gymp.act_join_request(p jsonb) returns jsonb language plpgsql as $$
declare ip text := gymp.client_ip(); ph text := gymp.norm_phone(p ->> 'phone'); nm text := gymp.j_text(p, 'name', 100);
  keys text[]; ref_id bigint; v_ref text := upper(trim(coalesce(p ->> 'ref', '')));
begin
  keys := array['j:' || ip, 'j:' || coalesce(ph, 'x')];
  if gymp.rl_blocked(keys, array[5, 2]) then return gymp.err('too_many_attempts'); end if;
  perform gymp.rl_fail(keys);                 -- every request counts, not only failures
  if length(nm) < 2 then return gymp.err('name_required'); end if;
  if ph is null then return gymp.err('bad_phone'); end if;
  if v_ref ~ '^GYM-\d{4,6}$' then select id into ref_id from public.members where code = v_ref and status <> 'archived'; end if;
  if not exists (select 1 from public.members where phone = ph) and not exists (select 1 from public.leads where phone = ph and status in ('new','following')) then
    insert into public.leads (name, phone, interest, source, status, next_followup, notes, ref_member_id)
      values (nm, ph, nullif(gymp.j_text(p, 'interest', 200), ''), case when ref_id is not null then 'Referral' else 'App link' end, 'new', gymp.today(),
        'Sent from the app join link', ref_id);
  end if;
  return jsonb_build_object('ok', true, 'gym', gymp.setting('gym_name', 'Gym'));
end $$;

create or replace function gymp.lead_json(l public.leads) returns jsonb language sql stable as $$
  select jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'interest', l.interest, 'source', l.source, 'status', l.status,
    'next_followup', gymp.d(l.next_followup), 'notes', l.notes, 'member_id', l.member_id, 'created_at', gymp.ts(l.created_at),
    'due', l.status in ('new','following') and l.next_followup is not null and l.next_followup <= gymp.today(),
    'ref_member_id', l.ref_member_id, 'ref_name', (select name || ' (' || code || ')' from public.members where id = l.ref_member_id)) $$;

-- ---------------------------------------------------------------- owner preferences: + referral days, freeze limit
create or replace function gymp.o_prefs(p jsonb) returns jsonb language plpgsql as $$
begin
  if p ? 'admission_fee' then perform gymp.set_setting('admission_fee', gymp.j_int(p, 'admission_fee', 0, 100000, 'bad_amount')::text); end if;
  if p ? 'referral_days' then perform gymp.set_setting('referral_days', gymp.j_int(p, 'referral_days', 0, 90, 'bad_days')::text); end if;
  if p ? 'freeze_max_days' then perform gymp.set_setting('freeze_max_days', gymp.j_int(p, 'freeze_max_days', 0, 365, 'bad_days')::text); end if;
  return jsonb_build_object('admission_fee', gymp.int_setting('admission_fee', 0), 'referral_days', gymp.int_setting('referral_days', 7),
    'freeze_max_days', gymp.int_setting('freeze_max_days', 30));
end $$;

-- dashboard extras ride on o_finance (already loaded by the owner home)
create or replace function gymp.o_finance() returns jsonb language plpgsql as $$
declare t date := gymp.today();
begin
  return jsonb_build_object(
    'months', (select jsonb_agg(jsonb_build_object('label', to_char(mo, 'Mon'), 'month', to_char(mo, 'YYYY-MM'),
        'income', (select coalesce(sum(amount), 0) from public.payments where status = 'confirmed' and to_char(decided_at at time zone 'Asia/Kolkata', 'YYYY-MM') = to_char(mo, 'YYYY-MM')),
        'pt', (select coalesce(sum(amount), 0) from public.payments where status = 'confirmed' and kind = 'pt' and to_char(decided_at at time zone 'Asia/Kolkata', 'YYYY-MM') = to_char(mo, 'YYYY-MM')),
        'expenses', (select coalesce(sum(amount), 0) from public.expenses where to_char(day, 'YYYY-MM') = to_char(mo, 'YYYY-MM'))) order by mo)
      from generate_series(date_trunc('month', t) - interval '5 months', date_trunc('month', t), interval '1 month') mo),
    'leads_due', (select count(*) from public.leads where status in ('new','following') and next_followup <= t),
    'freeze_waiting', (select count(*) from public.freeze_requests where status = 'waiting'),
    'pt_expiring', (select count(*) from public.pt_packages where status = 'active' and (expires <= t + 3 or sessions - used <= 1)),
    'admission_fee', gymp.int_setting('admission_fee', 0));
end $$;

-- ---------------------------------------------------------------- member: one call for the extra home cards
create or replace function gymp.m_extra(m public.members) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'batch', gymp.batch_label(m.batch_id),
    'diet', (select name from public.diet_plans where id = m.diet_plan_id),
    'pt', (select gymp.pt_json(k) from public.pt_packages k where k.member_id = m.id and k.status = 'active' order by k.id desc limit 1),
    'freeze', jsonb_build_object('max_days', gymp.int_setting('freeze_max_days', 30), 'used', gymp.freeze_used(m),
      'until', gymp.d(m.freeze_until), 'since', gymp.d(m.frozen_on),
      'waiting', (select jsonb_build_object('days', days, 'created_at', gymp.ts(created_at)) from public.freeze_requests where member_id = m.id and status = 'waiting' limit 1)),
    'referral_days', gymp.int_setting('referral_days', 7),
    'offers', gymp.offers_json()) $$;

-- ---------------------------------------------------------------- demo data for 2.3
create or replace function gymp.demo_extras_23() returns void language plpgsql as $$
declare b1 bigint; b2 bigint; b3 bigint; d1 bigint; d2 bigint; t1 bigint; t2 bigint; k_id bigint; mm record; i int := 0;
begin
  insert into public.batches (name, starts, ends, capacity, is_demo) values ('Morning', '06:00', '08:00', 30, true) returning id into b1;
  insert into public.batches (name, starts, ends, capacity, is_demo) values ('Evening', '18:00', '20:00', 35, true) returning id into b2;
  insert into public.batches (name, starts, ends, capacity, is_demo) values ('Ladies', '10:00', '11:30', 15, true) returning id into b3;
  insert into public.diet_plans (name, goal, body, is_demo) values ('Fat loss (veg)', 'Weight loss',
    E'Early morning: Warm water + lemon, 5 soaked almonds\nBreakfast: Poha or 2 besan chillas + green chutney\nMid-morning: 1 fruit (apple / guava)\nLunch: 2 rotis, dal, sabzi, salad, curd\nEvening: Green tea + roasted chana\nDinner: Paneer bhurji or moong dal khichdi, salad\nNotes: 3–4 litres water. No sugar drinks. Walk 8,000 steps.', true) returning id into d1;
  insert into public.diet_plans (name, goal, body, is_demo) values ('Muscle gain', 'Bulking',
    E'Breakfast: 4 egg whites + 2 whole eggs, 2 toast, banana\nMid-morning: Peanut butter sandwich + milk\nLunch: Rice, chicken / rajma, sabzi, curd\nPre-workout: Banana + black coffee\nPost-workout: Whey protein or paneer 100g\nDinner: 3 rotis, chicken / soya chunks, salad\nNotes: Eat every 3 hours. Sleep 7–8 hours.', true) returning id into d2;
  insert into public.trainers (name, phone, is_demo) values ('Vikram Singh', '919000000071', true) returning id into t1;
  insert into public.trainers (name, phone, is_demo) values ('Neha Kapoor', '919000000072', true) returning id into t2;
  for mm in select id, name from public.members where is_demo and status <> 'archived' order by id loop
    i := i + 1;
    update public.members set batch_id = case when i % 5 = 0 then b3 when i % 2 = 0 then b2 else b1 end,
      diet_plan_id = case when i % 3 = 0 then d1 when i % 3 = 2 then d2 end where id = mm.id;
    if i in (2, 5) then
      insert into public.pt_packages (member_id, trainer_id, sessions, used, amount, starts, expires)
        values (mm.id, case when i = 2 then t1 else t2 end, 12, case when i = 2 then 7 else 11 end, 6000, gymp.today() - 20, gymp.today() + 40) returning id into k_id;
      insert into public.pt_sessions (package_id, at) select k_id, now() - make_interval(days => g * 2) from generate_series(1, case when i = 2 then 7 else 11 end) g;
      insert into public.payments (member_id, kind, amount, mode, status, receipt_no, note, decided_at, pt_package_id)
        values (mm.id, 'pt', 6000, 'upi', 'confirmed', gymp.next_receipt(), 'Personal training · 12 sessions', now() - interval '20 days', k_id);
    end if;
  end loop;
  insert into public.coupons (code, kind, value, applies, valid_till, show_in_app, note, is_demo)
    values ('FIT10', 'percent', 10, 'renewal', gymp.today() + 30, true, 'Renew early and save', true),
           ('JOIN500', 'flat', 500, 'joining', null, false, 'For walk-in offers', true);
end $$;

create or replace function gymp.o_remove_demo_extras() returns void language plpgsql as $$
begin
  delete from public.leads where notes like '[Demo]%';
  delete from public.expenses where note like '[Demo]%';
  delete from public.coupons where is_demo and not exists (select 1 from public.payments where coupon_id = coupons.id);
  delete from public.batches where is_demo;
  delete from public.diet_plans where is_demo;
  delete from public.trainers where is_demo;
end $$;

create or replace function gymp.install_demo() returns jsonb language plpgsql as $$
declare r jsonb;
begin r := gymp.install_demo_base(); perform gymp.demo_activity(); perform gymp.demo_extras(); perform gymp.demo_extras_23(); return r; end $$;

-- ---------------------------------------------------------------- routing
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
      when 'o_coupons' then gymp.o_coupons()
      when 'o_coupon_save' then gymp.o_coupon_save(p_in)
      when 'o_coupon_delete' then gymp.o_coupon_delete(p_in)
      when 'o_freeze_requests' then gymp.o_freeze_requests()
      when 'o_freeze_decide' then gymp.o_freeze_decide(p_in)
      when 'o_diets' then gymp.o_diets()
      when 'o_diet_save' then gymp.o_diet_save(p_in)
      when 'o_diet_delete' then gymp.o_diet_delete(p_in)
      when 'o_batches' then gymp.o_batches()
      when 'o_batch_save' then gymp.o_batch_save(p_in)
      when 'o_batch_delete' then gymp.o_batch_delete(p_in)
      when 'o_pt' then gymp.o_pt(p_in)
      when 'o_trainer_save' then gymp.o_trainer_save(p_in)
      when 'o_pt_save' then gymp.o_pt_save(p_in)
      when 'o_pt_session' then gymp.o_pt_session(p_in)
      when 'o_pt_cancel' then gymp.o_pt_cancel(p_in)
      else null end;
  end if;
  if left(p_action, 2) = 'm_' and m.id is not null then
    return case p_action
      when 'm_extra' then gymp.m_extra(m)
      when 'm_diet' then gymp.m_diet(m)
      when 'm_referrals' then gymp.m_referrals(m)
      when 'm_freeze_request' then gymp.m_freeze_request(m, p_in)
      when 'm_freeze_cancel' then gymp.m_freeze_cancel(m)
      when 'm_coupon_check' then gymp.m_coupon_check(m, p_in)
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
    raise warning 'gym_api(%) failed: %', p_action, msg;
    return jsonb_build_object('ok', false, 'error', 'server_error');
  end;
  if res ? '__err' then return jsonb_build_object('ok', false, 'error', res ->> '__err'); end if;
  return jsonb_build_object('ok', true, 'data', res);
end $$;

-- ---------------------------------------------------------------- rights
revoke all on all functions in schema gymp from public, anon, authenticated;
grant execute on function gymp.is_owner() to authenticated;
revoke all on function public.gym_api(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.gym_api(text, jsonb, text) to anon, authenticated;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'gymp' loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', f.sig);
  end loop;
end $$;
