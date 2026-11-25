-- =====================================================================
-- Gym Manager for Supabase
-- Paste this whole file into Supabase -> SQL Editor -> New query -> Run.
--
-- Security model:
--   * Every table has Row Level Security ON and NO policies, and all table
--     rights are revoked from the public API roles. Nobody can read or write
--     a table directly through the API.
--   * The app talks to the database only through public.gym_api(), which
--     checks who is calling (owner = Supabase Auth user listed in "owners",
--     member = random session token from a PIN login) before every action.
--   * Prices, totals and expiry dates are always calculated here, never
--     trusted from the phone.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create schema if not exists gymp;              -- private helpers, not exposed by the API
revoke all on schema gymp from public, anon, authenticated;

-- ---------------------------------------------------------------- tables
create table public.settings (k text primary key, v text not null default '');

create table public.owners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null, email text not null, created_at timestamptz not null default now());

create table public.plans (
  id bigint generated always as identity primary key,
  name text not null check (length(name) between 2 and 60),
  months int not null check (months between 1 and 36),
  fee int not null check (fee between 0 and 1000000),
  active boolean not null default true, sort int not null default 0);

create table public.members (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null check (length(name) between 2 and 100),
  phone text not null unique check (phone ~ '^91[5-9][0-9]{9}$'),
  pin_hash text not null,
  pin_must_change boolean not null default true,
  sess_ver int not null default 1,
  plan_id bigint references public.plans(id),
  fee int not null default 0 check (fee >= 0),
  start_date date not null, expiry_date date not null,
  dues int not null default 0 check (dues between 0 and 1000000),
  status text not null default 'active' check (status in ('active','frozen','archived')),
  frozen_on date, notes text check (length(notes) <= 500), birthday date,
  consent boolean not null default true, last_reminder date,
  is_demo boolean not null default false,
  created_at timestamptz not null default now());
create index members_expiry_idx on public.members (expiry_date);

create table public.member_sessions (
  token_hash text primary key,
  member_id bigint not null references public.members(id) on delete cascade,
  sess_ver int not null, expires_at timestamptz not null, created_at timestamptz not null default now());
create index member_sessions_member_idx on public.member_sessions (member_id);

create table public.products (
  id bigint generated always as identity primary key,
  name text not null check (length(name) between 2 and 100),
  category text not null check (length(category) between 1 and 40),
  price int not null check (price between 0 and 1000000),
  stock int not null default 0 check (stock between 0 and 100000),
  photo text check (photo ~ '^[a-f0-9-]{36}\.jpg$'),
  visible boolean not null default true, is_demo boolean not null default false,
  created_at timestamptz not null default now());

create table public.orders (
  id bigint generated always as identity primary key,
  member_id bigint not null references public.members(id) on delete cascade,
  total int not null check (total >= 0),
  status text not null default 'new' check (status in ('new','paid','handed','cancelled')),
  pay_mode text not null check (pay_mode in ('upi','counter')),
  created_at timestamptz not null default now(), updated_at timestamptz);
create index orders_member_idx on public.orders (member_id);

create table public.order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders(id) on delete cascade,
  product_id bigint not null references public.products(id),
  name text not null, price int not null check (price >= 0), qty int not null check (qty between 1 and 10));
create index order_items_order_idx on public.order_items (order_id);

create table public.payments (
  id bigint generated always as identity primary key,
  member_id bigint not null references public.members(id) on delete cascade,
  kind text not null check (kind in ('membership','shop')),
  plan_id bigint references public.plans(id),
  order_id bigint references public.orders(id) on delete cascade,
  amount int not null check (amount between 0 and 10000000),
  mode text not null check (mode in ('upi','cash')),
  status text not null check (status in ('waiting','confirmed','rejected')),
  utr text check (utr ~ '^[A-Za-z0-9]{6,40}$'),
  receipt_no text, period_from date, period_to date, note text,
  created_at timestamptz not null default now(), decided_at timestamptz);
create index payments_member_idx on public.payments (member_id);
create index payments_status_idx on public.payments (status);

create table public.announcements (
  id bigint generated always as identity primary key,
  body text not null check (length(body) between 2 and 500),
  pinned boolean not null default false, created_at timestamptz not null default now());

create table public.login_attempts (
  id bigint generated always as identity primary key, k text not null, at timestamptz not null default now());
create index login_attempts_k_idx on public.login_attempts (k, at);

-- lock every table: RLS on, no policies, no direct rights for API roles
do $$ declare t text; begin
  foreach t in array array['settings','owners','plans','members','member_sessions','products','orders','order_items','payments','announcements','login_attempts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on all sequences in schema public from public, anon, authenticated;

-- ---------------------------------------------------------------- small helpers
create function gymp.fail(code text) returns void language plpgsql as $$
begin raise exception using message = 'GYM:' || code, errcode = 'P0001'; end $$;

create function gymp.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
create function gymp.ts(t timestamptz) returns text language sql stable as $$ select to_char(t at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') $$;
create function gymp.d(x date) returns text language sql immutable as $$ select to_char(x, 'YYYY-MM-DD') $$;

create function gymp.setting(key text, dflt text default '') returns text language sql stable as $$
  select coalesce((select v from public.settings where k = key), dflt) $$;
create function gymp.set_setting(key text, val text) returns void language sql as $$
  insert into public.settings (k, v) values (key, val) on conflict (k) do update set v = excluded.v $$;

create function gymp.next_seq(key text) returns int language sql as $$
  insert into public.settings (k, v) values (key, '1')
  on conflict (k) do update set v = ((public.settings.v)::int + 1)::text
  returning v::int $$;
create function gymp.next_receipt() returns text language sql as $$
  select 'R' || to_char(gymp.today(), 'YYMM') || '-' || lpad(gymp.next_seq('receipt_seq')::text, 4, '0') $$;
create function gymp.next_code() returns text language sql as $$
  select 'GYM-' || lpad(gymp.next_seq('member_seq')::text, 4, '0') $$;

create function gymp.clean(t text, maxlen int) returns text language sql immutable as $$
  select left(btrim(regexp_replace(coalesce(t, ''), '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), maxlen) $$;

create function gymp.norm_phone(p text) returns text language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if length(d) = 11 and left(d, 1) = '0' then d := substr(d, 2); end if;
  if length(d) = 10 then d := '91' || d; end if;
  if d ~ '^91[5-9][0-9]{9}$' then return d; end if;
  return null;
end $$;

-- JSON input readers: they reject anything that isn't the expected shape
create function gymp.j_text(p jsonb, k text, maxlen int) returns text language sql immutable as $$
  select gymp.clean(case when jsonb_typeof(p -> k) in ('string','number') then p ->> k else '' end, maxlen) $$;

create function gymp.j_int(p jsonb, k text, lo bigint, hi bigint, err text) returns bigint language plpgsql immutable as $$
declare s text := case when jsonb_typeof(p -> k) in ('string','number') then btrim(p ->> k) else null end; v bigint;
begin
  if s is null or s !~ '^-?[0-9]{1,12}$' then perform gymp.fail(err); end if;
  v := s::bigint;
  if v < lo or v > hi then perform gymp.fail(err); end if;
  return v;
end $$;

create function gymp.j_id(p jsonb, k text) returns bigint language sql immutable as $$ select gymp.j_int(p, k, 1, 9000000000000, 'bad_id') $$;

create function gymp.j_bool(p jsonb, k text) returns boolean language sql immutable as $$
  select coalesce(case jsonb_typeof(p -> k) when 'boolean' then (p -> k)::boolean
    when 'string' then lower(p ->> k) in ('1','true','on','yes') when 'number' then (p ->> k) <> '0' else false end, false) $$;

create function gymp.j_date(p jsonb, k text, err text default 'bad_date') returns date language plpgsql immutable as $$
declare s text := p ->> k; v date;
begin
  if s is null or s = '' then return null; end if;
  if s !~ '^\d{4}-\d{2}-\d{2}$' then perform gymp.fail(err); end if;
  begin v := s::date; exception when others then perform gymp.fail(err); end;
  if v < date '2000-01-01' or v > date '2100-12-31' then perform gymp.fail(err); end if;
  return v;
end $$;

create function gymp.err(code text) returns jsonb language sql immutable as $$ select jsonb_build_object('__err', code) $$;

-- caller identity
create function gymp.owner_id() returns uuid language sql stable security definer set search_path = public as $$
  select user_id from public.owners where user_id = auth.uid() $$;
create function gymp.is_owner() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.owners where user_id = auth.uid()) $$;

create function gymp.client_ip() returns text language plpgsql stable as $$
declare h json;
begin
  begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then h := null; end;
  return coalesce(left(h ->> 'cf-connecting-ip', 45), 'unknown');
end $$;

create function gymp.token_hash(t text) returns text language sql immutable as $$
  select encode(extensions.digest(coalesce(t, ''), 'sha256'), 'hex') $$;

create function gymp.member_from_token(p_token text) returns public.members language plpgsql as $$
declare m public.members; s public.member_sessions;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then return null; end if;
  select * into s from public.member_sessions where token_hash = gymp.token_hash(p_token) and expires_at > now();
  if s.token_hash is null then return null; end if;
  select * into m from public.members where id = s.member_id;
  if m.id is null or m.status = 'archived' or m.sess_ver <> s.sess_ver then return null; end if;
  if s.expires_at < now() + interval '29 days' then
    update public.member_sessions set expires_at = now() + interval '30 days' where token_hash = s.token_hash;
  end if;
  return m;
end $$;

create function gymp.new_session(m_id bigint, ver int) returns text language plpgsql as $$
declare tok text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  delete from public.member_sessions where expires_at < now();
  insert into public.member_sessions (token_hash, member_id, sess_ver, expires_at) values (gymp.token_hash(tok), m_id, ver, now() + interval '30 days');
  return tok;
end $$;

-- login rate limiting (5 wrong tries per account+device, 30 per account, 50 per device, per 15 minutes)
create function gymp.rl_blocked(keys text[], maxes int[]) returns boolean language plpgsql as $$
declare i int;
begin
  delete from public.login_attempts where at < now() - interval '1 day';
  for i in 1 .. array_length(keys, 1) loop
    if (select count(*) from public.login_attempts where k = keys[i] and at > now() - interval '15 minutes') >= maxes[i] then return true; end if;
  end loop;
  return false;
end $$;
create function gymp.rl_fail(keys text[]) returns void language sql as $$
  insert into public.login_attempts (k) select unnest(keys) $$;

-- json shapes
create function gymp.mstatus(m public.members) returns text language sql stable as $$
  select case when m.status = 'archived' then 'archived' when m.status = 'frozen' then 'frozen'
    when m.expiry_date < gymp.today() then 'expired' when m.expiry_date - gymp.today() <= 3 then 'expiring' else 'active' end $$;

create function gymp.pm(m public.members, plan_name text) returns jsonb language sql stable as $$
  select jsonb_build_object('id', m.id, 'code', m.code, 'name', m.name, 'phone', m.phone, 'plan_id', m.plan_id, 'plan', plan_name,
    'fee', m.fee, 'start_date', gymp.d(m.start_date), 'expiry_date', gymp.d(m.expiry_date), 'days_left', m.expiry_date - gymp.today(),
    'dues', m.dues, 'status', gymp.mstatus(m), 'raw_status', m.status, 'frozen_on', gymp.d(m.frozen_on), 'notes', m.notes,
    'birthday', gymp.d(m.birthday), 'consent', m.consent, 'last_reminder', gymp.d(m.last_reminder), 'is_demo', m.is_demo) $$;

create function gymp.items_json(o_id bigint) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'price', price, 'qty', qty) order by id), '[]'::jsonb)
  from public.order_items where order_id = o_id $$;

create function gymp.pay_json(p public.payments) returns jsonb language sql stable as $$
  select jsonb_build_object('id', p.id, 'member_id', p.member_id, 'kind', p.kind, 'plan_id', p.plan_id, 'order_id', p.order_id,
    'amount', p.amount, 'mode', p.mode, 'status', p.status, 'utr', p.utr, 'receipt_no', p.receipt_no,
    'period_from', gymp.d(p.period_from), 'period_to', gymp.d(p.period_to), 'note', p.note,
    'created_at', gymp.ts(p.created_at), 'decided_at', gymp.ts(p.decided_at),
    'member_name', m.name, 'member_phone', m.phone, 'member_code', m.code, 'plan_name', pl.name,
    'items', case when p.order_id is not null then gymp.items_json(p.order_id) else '[]'::jsonb end)
  from public.members m left join public.plans pl on pl.id = p.plan_id where m.id = p.member_id $$;

create function gymp.order_json(o public.orders) returns jsonb language sql stable as $$
  select jsonb_build_object('id', o.id, 'member_id', o.member_id, 'total', o.total, 'status', o.status, 'pay_mode', o.pay_mode,
    'created_at', gymp.ts(o.created_at), 'updated_at', gymp.ts(o.updated_at), 'member_name', m.name, 'member_phone', m.phone,
    'items', gymp.items_json(o.id),
    'waiting_payment', exists (select 1 from public.payments where order_id = o.id and status = 'waiting'))
  from public.members m where m.id = o.member_id $$;

create function gymp.product_json(p public.products) returns jsonb language sql stable as $$
  select jsonb_build_object('id', p.id, 'name', p.name, 'category', p.category, 'price', p.price, 'stock', p.stock,
    'photo', p.photo, 'visible', p.visible) $$;

create function gymp.gym_public() returns jsonb language sql stable as $$
  select jsonb_build_object('name', gymp.setting('gym_name'), 'address', gymp.setting('gym_address'), 'timings', gymp.setting('gym_timings'),
    'whatsapp', gymp.setting('gym_whatsapp'), 'maps', gymp.setting('gym_maps')) $$;
create function gymp.upi_info() returns jsonb language sql stable as $$
  select jsonb_build_object('id', gymp.setting('upi_id'), 'name', coalesce(nullif(gymp.setting('upi_name'), ''), gymp.setting('gym_name'))) $$;

create function gymp.default_templates() returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'soon', E'Namaste {name}! {gym} me aapki membership {expiry} ko khatam ho rahi hai. Renew karne ke liye app kholein: {link}\nYa gym par aakar renew karein. Dhanyavaad!',
    'today', 'Namaste {name}! {gym} me aapki membership aaj ({expiry}) khatam ho rahi hai. Aaj hi renew karein: {link}',
    'expired', 'Namaste {name}! {gym} me aapki membership {expiry} ko khatam ho gayi hai. Workout continue rakhne ke liye renew karein: {link}',
    'winback', 'Namaste {name}! {gym} aapko miss kar raha hai. Wapas aaiye, hum aapka intezaar kar rahe hain! Renew: {link}',
    'dues', 'Namaste {name}! {gym} me aapka Rs {amount} baaki hai. App se pay karein: {link}',
    'birthday', 'Happy Birthday {name}! {gym} ki taraf se aapko dher saari shubhkamnayein. Stay strong!') $$;
create function gymp.templates() returns jsonb language sql stable as $$
  select jsonb_object_agg(key, coalesce((select v from public.settings where k = 'msg_' || key), value #>> '{}'))
  from jsonb_each(gymp.default_templates()) $$;

-- ---------------------------------------------------------------- business rules
-- A confirmed membership payment first clears any amount owed for the current period;
-- otherwise it extends the membership from the later of (current expiry, today).
create function gymp.apply_membership(m_id bigint, pl_id bigint, amount int) returns jsonb language plpgsql as $$
declare m public.members; pl public.plans; base date; newexp date; st date;
begin
  select * into m from public.members where id = m_id for update;
  if m.dues > 0 then
    update public.members set dues = greatest(0, dues - amount) where id = m_id;
    return jsonb_build_object('from', gymp.d(m.start_date), 'to', gymp.d(m.expiry_date));
  end if;
  select * into pl from public.plans where id = pl_id;
  if pl.id is null then perform gymp.fail('bad_plan'); end if;
  base := greatest(m.expiry_date, gymp.today());
  newexp := (base + make_interval(months => pl.months))::date;   -- Postgres clamps to month end: 31 Jan + 1 month = 28 Feb
  st := case when m.expiry_date >= gymp.today() then m.start_date else gymp.today() end;
  update public.members set plan_id = pl.id, fee = pl.fee, expiry_date = newexp, start_date = st,
    status = case when status = 'archived' then 'active' else status end where id = m_id;
  return jsonb_build_object('from', gymp.d(base), 'to', gymp.d(newexp));
end $$;

create function gymp.take_stock(o_id bigint) returns void language sql as $$
  update public.products p set stock = greatest(0, p.stock - i.qty)
  from (select product_id, sum(qty) as qty from public.order_items where order_id = o_id group by product_id) i
  where p.id = i.product_id $$;

-- ================================================================= actions
-- ---------- public
create function gymp.act_info(p_token text) returns jsonb language plpgsql as $$
declare o public.owners; m public.members; who jsonb;
begin
  select * into o from public.owners where user_id = auth.uid();
  if o.user_id is not null then who := jsonb_build_object('role', 'owner', 'name', o.name, 'email', o.email);
  else
    m := gymp.member_from_token(p_token);
    if m.id is not null then who := jsonb_build_object('role', 'member', 'name', m.name, 'code', m.code, 'pin_must_change', m.pin_must_change); end if;
  end if;
  return jsonb_build_object('gym', jsonb_build_object('name', gymp.setting('gym_name', 'Gym')), 'me', who, 'installed', exists (select 1 from public.owners), 'version', '2.0.0');
end $$;

create function gymp.act_login_member(p jsonb) returns jsonb language plpgsql as $$
declare ph text := gymp.norm_phone(p ->> 'phone'); pin text := coalesce(p ->> 'pin', ''); m public.members; ok boolean;
  keys text[]; ip text := gymp.client_ip();
begin
  keys := array['m:' || coalesce(ph, 'x') || '|' || ip, 'm:' || coalesce(ph, 'x'), 'ip:' || ip];
  if gymp.rl_blocked(keys, array[5, 30, 50]) then return gymp.err('too_many_attempts'); end if;
  if ph is not null then select * into m from public.members where phone = ph; end if;
  -- compare against a dummy hash when the phone is unknown, so timing doesn't reveal which phones exist
  ok := extensions.crypt(pin, coalesce(m.pin_hash, '$2a$08$72lnUXExUUaHds8lO1d56.JxwgX7c5EuGsKR3etvgtAo/81U8AVJq')) = coalesce(m.pin_hash, '-') and m.id is not null;
  if not ok then perform gymp.rl_fail(keys); return gymp.err('wrong_login'); end if;
  if m.status = 'archived' then return gymp.err('account_inactive'); end if;
  delete from public.login_attempts where k = keys[1];
  return jsonb_build_object('token', gymp.new_session(m.id, m.sess_ver), 'me',
    jsonb_build_object('role', 'member', 'name', m.name, 'code', m.code, 'pin_must_change', m.pin_must_change), 'gym', jsonb_build_object('name', gymp.setting('gym_name', 'Gym')));
end $$;

create function gymp.act_logout(p_token text) returns jsonb language sql as $$
  delete from public.member_sessions where token_hash = gymp.token_hash(p_token) returning jsonb_build_object('bye', true) $$;

-- ---------- member
create function gymp.m_home(m public.members) returns jsonb language plpgsql as $$
declare pm jsonb;
begin
  pm := gymp.pm(m, (select name from public.plans where id = m.plan_id)) - 'notes' - 'last_reminder' - 'is_demo' - 'consent';
  return jsonb_build_object('member', pm, 'pin_must_change', m.pin_must_change,
    'waiting', coalesce((select jsonb_agg(gymp.pay_json(p) order by p.id desc) from public.payments p where p.member_id = m.id and p.status = 'waiting'), '[]'),
    'notices', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'body', body, 'pinned', pinned, 'created_at', gymp.ts(created_at)) order by pinned desc, id desc)
      from (select * from public.announcements order by pinned desc, id desc limit 10) a), '[]'),
    'gym', gymp.gym_public(), 'upi', gymp.upi_info());
end $$;

create function gymp.m_plans() returns jsonb language sql stable as $$
  select jsonb_build_object('plans', coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'months', months, 'fee', fee) order by sort, months), '[]'))
  from public.plans where active $$;

create function gymp.m_renew(m public.members, p jsonb) returns jsonb language plpgsql as $$
declare utr text := gymp.j_text(p, 'utr', 40); pl public.plans; amt int; pl_id bigint;
begin
  if utr <> '' and utr !~ '^[A-Za-z0-9]{6,40}$' then perform gymp.fail('bad_utr'); end if;
  perform 1 from public.members where id = m.id for update;
  if exists (select 1 from public.payments where member_id = m.id and kind = 'membership' and status = 'waiting') then perform gymp.fail('already_waiting'); end if;
  if m.dues > 0 then amt := m.dues; pl_id := m.plan_id;
  else
    select * into pl from public.plans where id = gymp.j_id(p, 'plan_id') and active;
    if pl.id is null then perform gymp.fail('bad_plan'); end if;
    amt := pl.fee; pl_id := pl.id;
  end if;
  insert into public.payments (member_id, kind, plan_id, amount, mode, status, utr) values (m.id, 'membership', pl_id, amt, 'upi', 'waiting', nullif(utr, ''));
  return jsonb_build_object('amount', amt);
end $$;

create function gymp.m_history(m public.members) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'payments', coalesce((select jsonb_agg(gymp.pay_json(x.r) order by (x.r).id desc) from (select r from public.payments r where r.member_id = m.id order by r.id desc limit 100) x), '[]'),
    'orders', coalesce((select jsonb_agg(gymp.order_json(x.r) order by (x.r).id desc) from (select r from public.orders r where r.member_id = m.id order by r.id desc limit 100) x), '[]')) $$;

create function gymp.m_products() returns jsonb language sql stable as $$
  select jsonb_build_object('products', coalesce((select jsonb_agg(gymp.product_json(p) order by p.category, p.name) from public.products p where p.visible), '[]'), 'upi', gymp.upi_info()) $$;

create function gymp.m_order(m public.members, p jsonb) returns jsonb language plpgsql as $$
declare items jsonb := p -> 'items'; it jsonb; pid bigint; qty int; pr public.products; v_total int := 0; o_id bigint;
  mode text := case when p ->> 'pay_mode' = 'counter' then 'counter' else 'upi' end; seen bigint[] := '{}';
begin
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 or jsonb_array_length(items) > 20 then perform gymp.fail('bad_items'); end if;
  perform 1 from public.members where id = m.id for update;
  if (select count(*) from public.orders where member_id = m.id and status = 'new') >= 3 then perform gymp.fail('too_many_open_orders'); end if;
  insert into public.orders (member_id, total, status, pay_mode) values (m.id, 0, 'new', mode) returning id into o_id;
  for it in select * from jsonb_array_elements(items) loop
    if jsonb_typeof(it) <> 'object' then perform gymp.fail('bad_items'); end if;
    pid := gymp.j_id(it, 'id');
    if pid = any(seen) then perform gymp.fail('bad_items'); end if;
    seen := seen || pid;
    qty := gymp.j_int(it, 'qty', 1, 10, 'bad_qty');
    select * into pr from public.products where id = pid and visible;
    if pr.id is null then perform gymp.fail('product_unavailable'); end if;
    if pr.stock < qty then perform gymp.fail('out_of_stock'); end if;
    insert into public.order_items (order_id, product_id, name, price, qty) values (o_id, pr.id, pr.name, pr.price, qty);
    v_total := v_total + pr.price * qty;
  end loop;
  update public.orders set total = v_total where id = o_id;
  return jsonb_build_object('order_id', o_id, 'total', v_total, 'pay_mode', mode);
end $$;

create function gymp.m_order_paid(m public.members, p jsonb) returns jsonb language plpgsql as $$
declare o public.orders; utr text := gymp.j_text(p, 'utr', 40);
begin
  if utr <> '' and utr !~ '^[A-Za-z0-9]{6,40}$' then perform gymp.fail('bad_utr'); end if;
  select * into o from public.orders where id = gymp.j_id(p, 'order_id') and member_id = m.id for update;
  if o.id is null or o.status <> 'new' then perform gymp.fail('order_not_open'); end if;
  if exists (select 1 from public.payments where order_id = o.id and status in ('waiting','confirmed')) then perform gymp.fail('already_waiting'); end if;
  update public.orders set pay_mode = 'upi' where id = o.id;
  insert into public.payments (member_id, kind, order_id, amount, mode, status, utr) values (m.id, 'shop', o.id, o.total, 'upi', 'waiting', nullif(utr, ''));
  return jsonb_build_object('ok', true);
end $$;

create function gymp.m_order_cancel(m public.members, p jsonb) returns jsonb language plpgsql as $$
declare o public.orders;
begin
  select * into o from public.orders where id = gymp.j_id(p, 'order_id') and member_id = m.id for update;
  if o.id is null or o.status <> 'new' then perform gymp.fail('order_not_open'); end if;
  if exists (select 1 from public.payments where order_id = o.id and status = 'waiting') then perform gymp.fail('payment_waiting'); end if;
  update public.orders set status = 'cancelled', updated_at = now() where id = o.id;
  return jsonb_build_object('ok', true);
end $$;

create function gymp.m_change_pin(m public.members, p jsonb) returns jsonb language plpgsql as $$
declare v_old text := coalesce(p ->> 'old_pin', ''); v_new text := coalesce(p ->> 'new_pin', ''); keys text[] := array['pin:' || m.id];
begin
  if v_new !~ '^\d{6}$' then return gymp.err('pin_must_be_6_digits'); end if;
  if v_new ~ '^(\d)\1{5}$' or v_new = any(array['123456','654321','012345','234567','121212']) then return gymp.err('pin_too_simple'); end if;
  if gymp.rl_blocked(keys, array[5]) then return gymp.err('too_many_attempts'); end if;
  if extensions.crypt(v_old, m.pin_hash) <> m.pin_hash then perform gymp.rl_fail(keys); return gymp.err('wrong_old_pin'); end if;
  if v_old = v_new then return gymp.err('pin_same'); end if;
  update public.members set pin_hash = extensions.crypt(v_new, extensions.gen_salt('bf', 8)), pin_must_change = false, sess_ver = sess_ver + 1 where id = m.id;
  delete from public.member_sessions where member_id = m.id;      -- every phone is logged out...
  return jsonb_build_object('token', gymp.new_session(m.id, m.sess_ver + 1),  -- ...except this one
    'me', jsonb_build_object('role', 'member', 'name', m.name, 'code', m.code, 'pin_must_change', false));
end $$;

create function gymp.receipt(p jsonb, p_member bigint) returns jsonb language plpgsql as $$
declare pay public.payments;
begin
  select * into pay from public.payments where id = gymp.j_id(p, 'id') and status = 'confirmed' and (p_member is null or payments.member_id = p_member);
  if pay.id is null then perform gymp.fail('not_found'); end if;
  return jsonb_build_object('payment', gymp.pay_json(pay), 'gym', gymp.gym_public());
end $$;

-- ---------- owner
create function gymp.o_dashboard() returns jsonb language plpgsql as $$
declare t date := gymp.today(); mon text := to_char(gymp.today(), 'YYYY-MM');
begin
  return jsonb_build_object(
    'gym', gymp.setting('gym_name'),
    'counts', jsonb_build_object(
      'active', (select count(*) from public.members where status = 'active' and expiry_date >= t),
      'expiring', (select count(*) from public.members where status = 'active' and expiry_date between t and t + 3),
      'expired', (select count(*) from public.members where status = 'active' and expiry_date < t),
      'frozen', (select count(*) from public.members where status = 'frozen'),
      'dues', (select count(*) from public.members where status <> 'archived' and dues > 0),
      'waiting', (select count(*) from public.payments where status = 'waiting'),
      'new_orders', (select count(*) from public.orders where status in ('new','paid')),
      'to_remind', (select count(*) from public.members where status = 'active' and consent and expiry_date between t - 7 and t + 3 and last_reminder is distinct from t),
      'birthdays', (select count(*) from public.members where status <> 'archived' and to_char(birthday, 'MM-DD') = to_char(t, 'MM-DD'))),
    'month', jsonb_build_object('label', trim(to_char(t, 'Month')) || ' ' || to_char(t, 'YYYY'),
      'membership', (select coalesce(sum(amount), 0) from public.payments where status = 'confirmed' and kind = 'membership' and to_char(decided_at at time zone 'Asia/Kolkata', 'YYYY-MM') = mon),
      'shop', (select coalesce(sum(amount), 0) from public.payments where status = 'confirmed' and kind = 'shop' and to_char(decided_at at time zone 'Asia/Kolkata', 'YYYY-MM') = mon)),
    'backup_due', coalesce(nullif(gymp.setting('last_backup'), '')::date, date '2000-01-01') < t - 30,
    'has_demo', exists (select 1 from public.members where is_demo) or exists (select 1 from public.products where is_demo),
    'upi_set', gymp.setting('upi_id') <> '');
end $$;

create function gymp.o_members(p jsonb) returns jsonb language plpgsql as $$
declare f text := coalesce(p ->> 'filter', 'all'); s text := gymp.j_text(p, 'q', 60); t date := gymp.today(); lk text;
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
      and (s = '' or m0.name ilike lk escape '!' or m0.phone like lk escape '!' or m0.code ilike lk escape '!')
      order by m0.expiry_date, m0.name limit 1000) x
    left join public.plans pl on pl.id = (x.m0).plan_id), '[]'));
end $$;

create function gymp.o_member(p jsonb) returns jsonb language plpgsql as $$
declare m public.members;
begin
  select * into m from public.members where id = gymp.j_id(p, 'id');
  if m.id is null then perform gymp.fail('not_found'); end if;
  return jsonb_build_object('member', gymp.pm(m, (select name from public.plans where id = m.plan_id)),
    'payments', coalesce((select jsonb_agg(gymp.pay_json(x.r) order by (x.r).id desc) from (select r from public.payments r where r.member_id = m.id order by r.id desc limit 100) x), '[]'),
    'orders', coalesce((select jsonb_agg(gymp.order_json(x.r) order by (x.r).id desc) from (select r from public.orders r where r.member_id = m.id order by r.id desc limit 100) x), '[]'));
end $$;

create function gymp.o_member_save(p jsonb) returns jsonb language plpgsql as $$
declare v_id bigint := case when coalesce(p ->> 'id', '') = '' then 0 else gymp.j_id(p, 'id') end;
  nm text := gymp.j_text(p, 'name', 100); ph text := gymp.norm_phone(p ->> 'phone'); v_notes text := gymp.j_text(p, 'notes', 500);
  bday date := gymp.j_date(p, 'birthday', 'bad_birthday'); v_consent boolean := gymp.j_bool(p, 'consent');
  pl public.plans; st date; exp date; paid boolean; mode text; pin text; m_id bigint; rid bigint;
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
  pin := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000))::text, 6, '0');
  insert into public.members (code, name, phone, pin_hash, plan_id, fee, start_date, expiry_date, dues, notes, birthday, consent)
    values (gymp.next_code(), nm, ph, extensions.crypt(pin, extensions.gen_salt('bf', 8)), pl.id, pl.fee, st, exp, case when paid then 0 else pl.fee end, nullif(v_notes, ''), bday, v_consent)
    returning id into m_id;
  if paid then
    insert into public.payments (member_id, kind, plan_id, amount, mode, status, receipt_no, period_from, period_to, note, decided_at)
      values (m_id, 'membership', pl.id, pl.fee, mode, 'confirmed', gymp.next_receipt(), st, exp, 'Joining', now()) returning id into rid;
  end if;
  return jsonb_build_object('id', m_id, 'pin', pin, 'receipt_id', rid);
end $$;

create function gymp.o_member_action(p jsonb) returns jsonb language plpgsql as $$
declare m public.members; act text := coalesce(p ->> 'action', ''); t date := gymp.today(); paused int; newexp date; pin text;
begin
  select * into m from public.members where id = gymp.j_id(p, 'id') for update;
  if m.id is null then perform gymp.fail('not_found'); end if;
  if act = 'freeze' then
    if m.status <> 'active' then perform gymp.fail('not_active'); end if;
    update public.members set status = 'frozen', frozen_on = t where id = m.id;
    return jsonb_build_object('ok', true);
  elsif act = 'unfreeze' then
    if m.status <> 'frozen' then perform gymp.fail('not_frozen'); end if;
    paused := greatest(0, t - coalesce(m.frozen_on, t));
    newexp := case when m.expiry_date >= coalesce(m.frozen_on, t) then m.expiry_date + paused else m.expiry_date end;
    update public.members set status = 'active', frozen_on = null, expiry_date = newexp where id = m.id;
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

create function gymp.o_plans() returns jsonb language sql stable as $$
  select jsonb_build_object('plans', coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'months', months, 'fee', fee, 'active', case when active then 1 else 0 end, 'sort', sort) order by sort, months), '[]'))
  from public.plans $$;

create function gymp.o_plan_save(p jsonb) returns jsonb language plpgsql as $$
declare v_id bigint := case when coalesce(p ->> 'id', '') = '' then 0 else gymp.j_id(p, 'id') end; nm text := gymp.j_text(p, 'name', 60);
  mo int := gymp.j_int(p, 'months', 1, 36, 'bad_months'); v_fee int := gymp.j_int(p, 'fee', 0, 1000000, 'bad_amount'); act boolean := gymp.j_bool(p, 'active');
begin
  if length(nm) < 2 then perform gymp.fail('name_required'); end if;
  if v_id > 0 then
    update public.plans set name = nm, months = mo, fee = v_fee, active = act where id = v_id;
    if not found then perform gymp.fail('not_found'); end if;
  else
    insert into public.plans (name, months, fee, active, sort) values (nm, mo, v_fee, act, mo) returning id into v_id;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

create function gymp.o_reminders() returns jsonb language plpgsql as $$
declare t date := gymp.today();
begin
  return jsonb_build_object(
    'soon', coalesce((select jsonb_agg(gymp.pm(m, pl.name) order by m.expiry_date) from public.members m left join public.plans pl on pl.id = m.plan_id where m.status = 'active' and m.expiry_date > t and m.expiry_date <= t + 3), '[]'),
    'today', coalesce((select jsonb_agg(gymp.pm(m, pl.name) order by m.name) from public.members m left join public.plans pl on pl.id = m.plan_id where m.status = 'active' and m.expiry_date = t), '[]'),
    'expired', coalesce((select jsonb_agg(gymp.pm(m, pl.name) order by m.expiry_date desc) from public.members m left join public.plans pl on pl.id = m.plan_id where m.status = 'active' and m.expiry_date < t and m.expiry_date >= t - 30), '[]'),
    'winback', coalesce((select jsonb_agg(gymp.pm(x.m0, pl.name) order by (x.m0).expiry_date desc) from (select m0 from public.members m0 where m0.status = 'active' and m0.expiry_date < t - 30 order by m0.expiry_date desc limit 200) x left join public.plans pl on pl.id = (x.m0).plan_id), '[]'),
    'dues', coalesce((select jsonb_agg(gymp.pm(m, pl.name) order by m.name) from public.members m left join public.plans pl on pl.id = m.plan_id where m.status <> 'archived' and m.dues > 0), '[]'),
    'birthdays', coalesce((select jsonb_agg(gymp.pm(m, pl.name)) from public.members m left join public.plans pl on pl.id = m.plan_id where m.status <> 'archived' and to_char(m.birthday, 'MM-DD') = to_char(t, 'MM-DD')), '[]'),
    'templates', gymp.templates(), 'gym', gymp.gym_public(), 'upi', gymp.upi_info(), 'date', gymp.d(t));
end $$;

create function gymp.o_mark_reminded(p jsonb) returns jsonb language sql as $$
  update public.members set last_reminder = gymp.today() where id = gymp.j_id(p, 'id') returning jsonb_build_object('ok', true) $$;

create function gymp.o_payments(p jsonb) returns jsonb language plpgsql as $$
declare s text := coalesce(p ->> 'status', 'waiting');
begin
  if s not in ('waiting','confirmed','rejected') then perform gymp.fail('bad_status'); end if;
  return jsonb_build_object('payments', coalesce((select jsonb_agg(gymp.pay_json(x.r) order by (x.r).id desc) from (select r from public.payments r where r.status = s order by r.id desc limit 300) x), '[]'));
end $$;

create function gymp.o_payment_decide(p jsonb) returns jsonb language plpgsql as $$
declare v_id bigint := gymp.j_id(p, 'id'); dec text := coalesce(p ->> 'decision', ''); pay public.payments; o public.orders; per jsonb;
begin
  if dec not in ('confirm','reject') then perform gymp.fail('bad_decision'); end if;
  -- "where status = 'waiting'" makes double taps harmless
  update public.payments set status = case when dec = 'confirm' then 'confirmed' else 'rejected' end, decided_at = now()
    where id = v_id and status = 'waiting' returning * into pay;
  if pay.id is null then perform gymp.fail('already_decided'); end if;
  if dec = 'reject' then return jsonb_build_object('status', 'rejected'); end if;
  if pay.kind = 'membership' then
    per := gymp.apply_membership(pay.member_id, pay.plan_id, pay.amount);
    update public.payments set receipt_no = gymp.next_receipt(), period_from = (per ->> 'from')::date, period_to = (per ->> 'to')::date where id = v_id;
  else
    select * into o from public.orders where id = pay.order_id for update;
    if o.id is null or o.status <> 'new' then perform gymp.fail('order_not_open'); end if;
    update public.orders set status = 'paid', updated_at = now() where id = o.id;
    perform gymp.take_stock(o.id);
    update public.payments set receipt_no = gymp.next_receipt() where id = v_id;
  end if;
  return jsonb_build_object('status', 'confirmed', 'receipt_id', v_id);
end $$;

create function gymp.o_payment_record(p jsonb) returns jsonb language plpgsql as $$
declare m public.members; mode text := case when p ->> 'mode' = 'upi' then 'upi' else 'cash' end; amt int; pl_id bigint; per jsonb; rid bigint;
begin
  select * into m from public.members where id = gymp.j_id(p, 'member_id') for update;
  if m.id is null then perform gymp.fail('not_found'); end if;
  if m.dues > 0 then
    amt := case when p ? 'amount' then gymp.j_int(p, 'amount', 1, m.dues, 'bad_amount') else m.dues end;
    pl_id := m.plan_id;
  else
    select id, fee into pl_id, amt from public.plans where id = gymp.j_id(p, 'plan_id');
    if pl_id is null then perform gymp.fail('bad_plan'); end if;
  end if;
  per := gymp.apply_membership(m.id, pl_id, amt);
  insert into public.payments (member_id, kind, plan_id, amount, mode, status, receipt_no, period_from, period_to, decided_at)
    values (m.id, 'membership', pl_id, amt, mode, 'confirmed', gymp.next_receipt(), (per ->> 'from')::date, (per ->> 'to')::date, now()) returning id into rid;
  return jsonb_build_object('receipt_id', rid, 'period', per);
end $$;

create function gymp.o_products() returns jsonb language sql stable as $$
  select jsonb_build_object('products', coalesce(jsonb_agg(gymp.product_json(p) order by p.visible desc, p.category, p.name), '[]')) from public.products p $$;

create function gymp.o_product_save(p jsonb) returns jsonb language plpgsql as $$
declare v_id bigint := case when coalesce(p ->> 'id', '') = '' then 0 else gymp.j_id(p, 'id') end; nm text := gymp.j_text(p, 'name', 100);
  cat text := coalesce(nullif(gymp.j_text(p, 'category', 40), ''), 'Other'); v_price int := gymp.j_int(p, 'price', 0, 1000000, 'bad_amount');
  v_stock int := gymp.j_int(p, 'stock', 0, 100000, 'bad_stock'); vis boolean := gymp.j_bool(p, 'visible');
  v_photo text := nullif(p ->> 'photo', ''); old text;
begin
  if length(nm) < 2 then perform gymp.fail('name_required'); end if;
  if v_photo is not null and v_photo !~ '^[a-f0-9-]{36}\.jpg$' then perform gymp.fail('bad_photo'); end if;
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

create function gymp.o_product_delete(p jsonb) returns jsonb language plpgsql as $$
declare pr public.products;
begin
  select * into pr from public.products where id = gymp.j_id(p, 'id');
  if pr.id is null then perform gymp.fail('not_found'); end if;
  if exists (select 1 from public.order_items where product_id = pr.id) then
    update public.products set visible = false where id = pr.id;   -- keep order history correct
    return jsonb_build_object('hidden', true);
  end if;
  delete from public.products where id = pr.id;
  return jsonb_build_object('deleted', true, 'photo', pr.photo);
end $$;

create function gymp.o_orders(p jsonb) returns jsonb language plpgsql as $$
declare s text := coalesce(p ->> 'status', 'open');
begin
  if s not in ('open','handed','cancelled') then perform gymp.fail('bad_status'); end if;
  return jsonb_build_object('orders', coalesce((select jsonb_agg(gymp.order_json(x.r) order by (x.r).id desc) from (select r from public.orders r where
    case s when 'open' then r.status in ('new','paid') else r.status = s end order by r.id desc limit 200) x), '[]'));
end $$;

create function gymp.o_order_status(p jsonb) returns jsonb language plpgsql as $$
declare o public.orders; target text := coalesce(p ->> 'status', ''); mode text := case when p ->> 'mode' = 'upi' then 'upi' else 'cash' end; rid bigint;
begin
  select * into o from public.orders where id = gymp.j_id(p, 'id') for update;
  if o.id is null then perform gymp.fail('not_found'); end if;
  if target = 'paid_counter' then
    if o.status <> 'new' then perform gymp.fail('order_not_open'); end if;
    if exists (select 1 from public.payments where order_id = o.id and status = 'waiting') then perform gymp.fail('payment_waiting'); end if;
    update public.orders set status = 'paid', updated_at = now() where id = o.id;
    perform gymp.take_stock(o.id);
    insert into public.payments (member_id, kind, order_id, amount, mode, status, receipt_no, decided_at)
      values (o.member_id, 'shop', o.id, o.total, mode, 'confirmed', gymp.next_receipt(), now()) returning id into rid;
    return jsonb_build_object('receipt_id', rid);
  elsif target = 'handed' then
    if o.status <> 'paid' then perform gymp.fail('not_paid_yet'); end if;
    update public.orders set status = 'handed', updated_at = now() where id = o.id;
    return jsonb_build_object('ok', true);
  elsif target = 'cancelled' then
    if o.status <> 'new' then perform gymp.fail('only_unpaid_can_cancel'); end if;
    update public.payments set status = 'rejected', decided_at = now() where order_id = o.id and status = 'waiting';
    update public.orders set status = 'cancelled', updated_at = now() where id = o.id;
    return jsonb_build_object('ok', true);
  end if;
  perform gymp.fail('bad_status');
end $$;

create function gymp.o_announcements() returns jsonb language sql stable as $$
  select jsonb_build_object('notices', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'body', body, 'pinned', pinned, 'created_at', gymp.ts(created_at)) order by pinned desc, id desc)
    from (select * from public.announcements order by pinned desc, id desc limit 100) a), '[]')) $$;

create function gymp.o_announcement_save(p jsonb) returns jsonb language plpgsql as $$
declare b text := gymp.j_text(p, 'body', 500); pin boolean := gymp.j_bool(p, 'pinned');
begin
  if length(b) < 2 then perform gymp.fail('text_required'); end if;
  if coalesce(p ->> 'id', '') <> '' then update public.announcements set body = b, pinned = pin where id = gymp.j_id(p, 'id');
  else insert into public.announcements (body, pinned) values (b, pin); end if;
  return jsonb_build_object('ok', true);
end $$;

create function gymp.o_announcement_delete(p jsonb) returns jsonb language plpgsql as $$
begin delete from public.announcements where id = gymp.j_id(p, 'id'); return jsonb_build_object('ok', true); end $$;

create function gymp.o_report(p jsonb) returns jsonb language plpgsql as $$
declare mon text := coalesce(p ->> 'month', to_char(gymp.today(), 'YYYY-MM'));
begin
  if mon !~ '^\d{4}-(0[1-9]|1[0-2])$' then perform gymp.fail('bad_month'); end if;
  return jsonb_build_object('month', mon,
    'joined', (select count(*) from public.members where to_char(created_at at time zone 'Asia/Kolkata', 'YYYY-MM') = mon),
    'renewals', (select count(*) from public.payments where status = 'confirmed' and kind = 'membership' and to_char(decided_at at time zone 'Asia/Kolkata', 'YYYY-MM') = mon),
    'membership', (select coalesce(sum(amount), 0) from public.payments where status = 'confirmed' and kind = 'membership' and to_char(decided_at at time zone 'Asia/Kolkata', 'YYYY-MM') = mon),
    'shop', (select coalesce(sum(amount), 0) from public.payments where status = 'confirmed' and kind = 'shop' and to_char(decided_at at time zone 'Asia/Kolkata', 'YYYY-MM') = mon),
    'by_mode', coalesce((select jsonb_agg(jsonb_build_object('mode', mode, 'amount', amt)) from (select mode, sum(amount) amt from public.payments
      where status = 'confirmed' and to_char(decided_at at time zone 'Asia/Kolkata', 'YYYY-MM') = mon group by mode) x), '[]'),
    'best', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'amount', amount) order by qty desc) from (
      select oi.name, sum(oi.qty) qty, sum(oi.qty * oi.price) amount from public.order_items oi join public.orders o on o.id = oi.order_id
      where o.status in ('paid','handed') and to_char(o.updated_at at time zone 'Asia/Kolkata', 'YYYY-MM') = mon group by oi.name order by 2 desc limit 5) b), '[]'),
    'by_plan', coalesce((select jsonb_agg(jsonb_build_object('plan', plan, 'members', n) order by n desc) from (
      select coalesce(pl.name, 'No plan') plan, count(*) n from public.members m left join public.plans pl on pl.id = m.plan_id
      where m.status = 'active' and m.expiry_date >= gymp.today() group by pl.name) x), '[]'));
end $$;

create function gymp.o_export(p jsonb) returns jsonb language plpgsql as $$
declare typ text := coalesce(p ->> 'type', '');
begin
  if typ = 'members' then
    return jsonb_build_object('rows', coalesce((select jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'phone', m.phone, 'plan', pl.name, 'fee', m.fee,
      'start_date', gymp.d(m.start_date), 'expiry_date', gymp.d(m.expiry_date), 'dues', m.dues, 'status', m.status, 'birthday', gymp.d(m.birthday), 'notes', m.notes) order by m.id)
      from public.members m left join public.plans pl on pl.id = m.plan_id), '[]'));
  elsif typ = 'payments' then
    return jsonb_build_object('rows', coalesce((select jsonb_agg(gymp.pay_json(x) - 'items' order by x.id desc) from public.payments x), '[]'));
  elsif typ = 'backup' then
    perform gymp.set_setting('last_backup', gymp.d(gymp.today()));
    return jsonb_build_object('version', '2.0.0', 'exported_at', gymp.ts(now()),
      'settings', (select coalesce(jsonb_agg(to_jsonb(s)), '[]') from public.settings s),
      'plans', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.plans x),
      'members', (select coalesce(jsonb_agg(to_jsonb(x) - 'pin_hash'), '[]') from public.members x),
      'products', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.products x),
      'orders', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.orders x),
      'order_items', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.order_items x),
      'payments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.payments x),
      'announcements', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.announcements x));
  end if;
  perform gymp.fail('bad_type');
end $$;

create function gymp.o_settings() returns jsonb language plpgsql as $$
declare o public.owners;
begin
  select * into o from public.owners where user_id = auth.uid();
  return jsonb_build_object('settings', jsonb_build_object('gym_name', gymp.setting('gym_name'), 'gym_address', gymp.setting('gym_address'),
      'gym_timings', gymp.setting('gym_timings'), 'gym_whatsapp', gymp.setting('gym_whatsapp'), 'gym_maps', gymp.setting('gym_maps'),
      'upi_id', gymp.setting('upi_id'), 'upi_name', gymp.setting('upi_name')),
    'templates', gymp.templates(), 'owner', jsonb_build_object('name', o.name, 'email', o.email), 'last_backup', gymp.setting('last_backup'));
end $$;

create function gymp.o_settings_save(p jsonb) returns jsonb language plpgsql as $$
declare nm text := gymp.j_text(p, 'gym_name', 80); upi text := btrim(coalesce(p ->> 'upi_id', '')); wa text := btrim(coalesce(p ->> 'gym_whatsapp', ''));
  maps text := btrim(coalesce(p ->> 'gym_maps', '')); k text;
begin
  if length(nm) < 2 then perform gymp.fail('name_required'); end if;
  if upi <> '' and upi !~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,30}$' then perform gymp.fail('bad_upi'); end if;
  if wa <> '' then wa := gymp.norm_phone(wa); if wa is null then perform gymp.fail('bad_phone'); end if; end if;
  if maps <> '' and (maps !~* '^https://[^\s<>"]+$' or length(maps) > 300) then perform gymp.fail('bad_link'); end if;
  perform gymp.set_setting('gym_name', nm);
  perform gymp.set_setting('gym_address', gymp.j_text(p, 'gym_address', 200));
  perform gymp.set_setting('gym_timings', gymp.j_text(p, 'gym_timings', 120));
  perform gymp.set_setting('gym_whatsapp', coalesce(wa, ''));
  perform gymp.set_setting('gym_maps', maps);
  perform gymp.set_setting('upi_id', upi);
  perform gymp.set_setting('upi_name', gymp.j_text(p, 'upi_name', 60));
  if jsonb_typeof(p -> 'templates') = 'object' then
    for k in select jsonb_object_keys(gymp.default_templates()) loop
      if p -> 'templates' ? k then perform gymp.set_setting('msg_' || k, gymp.clean(p -> 'templates' ->> k, 600)); end if;
    end loop;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- rows: [{name, phone, plan, start_date?, expiry_date, dues?}] (the phone parses the CSV, the database checks every value)
create function gymp.o_import_members(p jsonb) returns jsonb language plpgsql as $$
declare r jsonb; n int := 1; nm text; ph text; pl public.plans; exp date; st date; dues int; pin text; created jsonb := '[]'; errors jsonb := '[]';
begin
  if jsonb_typeof(p -> 'rows') <> 'array' or jsonb_array_length(p -> 'rows') = 0 then perform gymp.fail('empty_file'); end if;
  if jsonb_array_length(p -> 'rows') > 2000 then perform gymp.fail('file_too_big'); end if;
  for r in select * from jsonb_array_elements(p -> 'rows') loop
    n := n + 1;
    begin
      if jsonb_typeof(r) <> 'object' then perform gymp.fail('bad row'); end if;
      nm := gymp.j_text(r, 'name', 100); ph := gymp.norm_phone(r ->> 'phone');
      select * into pl from public.plans where lower(name) = lower(btrim(coalesce(r ->> 'plan', '')));
      if length(nm) < 2 then errors := errors || to_jsonb('Row ' || n || ': name missing'); continue; end if;
      if ph is null then errors := errors || to_jsonb('Row ' || n || ': bad phone'); continue; end if;
      if pl.id is null then errors := errors || to_jsonb('Row ' || n || ': plan not found'); continue; end if;
      exp := gymp.j_date(r, 'expiry_date');
      if exp is null then errors := errors || to_jsonb('Row ' || n || ': expiry_date must be YYYY-MM-DD'); continue; end if;
      st := gymp.j_date(r, 'start_date');
      if exists (select 1 from public.members where phone = ph) then errors := errors || to_jsonb('Row ' || n || ': phone already exists'); continue; end if;
      dues := least(coalesce(nullif(regexp_replace(coalesce(r ->> 'dues', ''), '\D', '', 'g'), '')::bigint, 0), 1000000);
      pin := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000))::text, 6, '0');
      insert into public.members (code, name, phone, pin_hash, plan_id, fee, start_date, expiry_date, dues)
        values (gymp.next_code(), nm, ph, extensions.crypt(pin, extensions.gen_salt('bf', 8)), pl.id, pl.fee,
          coalesce(st, (exp - make_interval(months => pl.months))::date), exp, dues);
      created := created || jsonb_build_object('name', nm, 'phone', ph, 'pin', pin);
    exception when others then
      errors := errors || to_jsonb('Row ' || n || ': ' || case when sqlerrm like 'GYM:%' then substr(sqlerrm, 5) else 'invalid' end);
    end;
  end loop;
  return jsonb_build_object('created', created, 'errors', errors);
end $$;

create function gymp.o_remove_demo() returns jsonb language plpgsql as $$
declare photos jsonb;
begin
  delete from public.members where is_demo;   -- cascades to their orders and payments
  select coalesce(jsonb_agg(photo) filter (where photo is not null), '[]') into photos from public.products where is_demo and not exists (select 1 from public.order_items i where i.product_id = products.id);
  update public.products set visible = false, is_demo = false where is_demo and exists (select 1 from public.order_items i where i.product_id = products.id);
  delete from public.products where is_demo;
  delete from public.announcements where body like '[Demo]%';
  return jsonb_build_object('ok', true, 'photos', photos);
end $$;

-- ================================================================= the one door into the database
create function public.gym_api(p_action text, p_in jsonb default '{}'::jsonb, p_token text default null)
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
        else null end;
      if res is null then perform gymp.fail('bad_action'); end if;
    end if;
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg like 'GYM:%' then return jsonb_build_object('ok', false, 'error', substr(msg, 5)); end if;
    raise warning 'gym_api(%) failed: %', p_action, msg;
    return jsonb_build_object('ok', false, 'error', 'server_error');
  end;
  -- errors that must keep their side effects (e.g. counting a wrong PIN) are returned, not raised
  if res ? '__err' then return jsonb_build_object('ok', false, 'error', res ->> '__err'); end if;
  return jsonb_build_object('ok', true, 'data', res);
end $$;

-- ================================================================= first-run setup (locks itself after the first owner)
create function gymp.install_demo() returns jsonb language plpgsql as $$
declare t date := gymp.today(); r record; pl public.plans; exp date; st date; m_id bigint; i int := 0; ids jsonb := '{}';
  pin_hash text := extensions.crypt('246810', extensions.gen_salt('bf', 8)); p_whey bigint; p_shaker bigint; o_id bigint;
begin
  for r in select * from (values ('Rohit Kumar',1,12,false),('Neha Singh',3,45,false),('Amit Verma',1,2,false),('Priya Sharma',1,0,false),
      ('Karan Mehta',3,3,false),('Sneha Patel',12,200,false),('Vikas Yadav',1,-5,false),('Anjali Gupta',1,-12,false),('Rahul Joshi',6,80,false),
      ('Pooja Nair',1,20,false),('Arjun Reddy',1,-45,false),('Meera Iyer',3,60,false),('Sahil Khan',1,25,true),('Divya Bansal',12,150,false))
      as x(nm, mo, days_left, owes) loop
    i := i + 1;
    select * into pl from public.plans where months = r.mo order by sort limit 1;
    if pl.id is null then select * into pl from public.plans order by months limit 1; end if;
    exp := t + r.days_left;
    st := (exp - make_interval(months => pl.months))::date;
    insert into public.members (code, name, phone, pin_hash, pin_must_change, plan_id, fee, start_date, expiry_date, dues, status, frozen_on, notes, birthday, is_demo, created_at)
      values (gymp.next_code(), r.nm, '9190000000' || lpad(i::text, 2, '0'), pin_hash, false, pl.id, pl.fee, st, exp,
        case when r.owes then pl.fee else 0 end, case when r.nm = 'Meera Iyer' then 'frozen' else 'active' end,
        case when r.nm = 'Meera Iyer' then t - 4 end, case when r.nm = 'Karan Mehta' then 'Knee injury - no heavy squats' end,
        case when r.nm = 'Pooja Nair' then make_date(extract(year from t)::int - 24, extract(month from t)::int, extract(day from t)::int) end,
        true, case when i <= 3 then now() else (st::timestamp + interval '10 hours') at time zone 'Asia/Kolkata' end)
      returning id into m_id;
    ids := ids || jsonb_build_object(r.nm, m_id);
    if not r.owes then
      insert into public.payments (member_id, kind, plan_id, amount, mode, status, receipt_no, period_from, period_to, created_at, decided_at)
        values (m_id, 'membership', pl.id, pl.fee, case when i % 3 = 0 then 'cash' else 'upi' end, 'confirmed',
          'R' || to_char(st, 'YYMM') || '-' || lpad(gymp.next_seq('receipt_seq')::text, 4, '0'), st, exp,
          (st::timestamp + interval '18 hours 30 minutes') at time zone 'Asia/Kolkata', (st::timestamp + interval '18 hours 30 minutes') at time zone 'Asia/Kolkata');
    end if;
  end loop;
  insert into public.payments (member_id, kind, plan_id, amount, mode, status, utr)
    select (ids ->> 'Amit Verma')::bigint, 'membership', id, fee, 'upi', 'waiting', 'T2611251234AB' from public.plans where months = 1 order by sort limit 1;
  insert into public.payments (member_id, kind, plan_id, amount, mode, status)
    select (ids ->> 'Vikas Yadav')::bigint, 'membership', id, fee, 'upi', 'waiting' from public.plans order by abs(months - 3), sort limit 1;
  insert into public.products (name, category, price, stock, is_demo) values
    ('Whey Protein 1 kg (Chocolate)', 'Supplements', 2499, 8, true), ('Creatine Monohydrate 250 g', 'Supplements', 899, 12, true),
    ('BCAA 300 g (Watermelon)', 'Supplements', 1199, 5, true), ('Shaker Bottle 700 ml', 'Accessories', 299, 20, true),
    ('Lifting Gloves', 'Accessories', 449, 6, true), ('Gym T-shirt (Black)', 'Clothing', 599, 10, true), ('Resistance Band Set', 'Accessories', 699, 0, true);
  select id into p_whey from public.products where name like 'Whey%';
  select id into p_shaker from public.products where name like 'Shaker%';
  insert into public.orders (member_id, total, status, pay_mode) values ((ids ->> 'Rohit Kumar')::bigint, 2798, 'new', 'upi') returning id into o_id;
  insert into public.order_items (order_id, product_id, name, price, qty) values (o_id, p_whey, 'Whey Protein 1 kg (Chocolate)', 2499, 1), (o_id, p_shaker, 'Shaker Bottle 700 ml', 299, 1);
  insert into public.payments (member_id, kind, order_id, amount, mode, status, utr) values ((ids ->> 'Rohit Kumar')::bigint, 'shop', o_id, 2798, 'upi', 'waiting', 'T2611259876CD');
  insert into public.announcements (body, pinned) values ('[Demo] Gym will be closed this Sunday for maintenance.', true),
    ('[Demo] New Zumba batch starting Monday at 7 pm. Talk to the front desk to join!', false);
  return jsonb_build_object('phone', '9000000001', 'pin', '246810', 'name', 'Rohit Kumar');
end $$;

create function public.gym_setup(p_key text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := auth.uid(); em text; nm text; gym text; upi text; wa text; pl jsonb; plans_added int := 0; demo jsonb; msg text;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not_logged_in'); end if;
  perform pg_advisory_xact_lock(4242);
  if exists (select 1 from public.owners) then return jsonb_build_object('ok', false, 'error', 'already_installed'); end if;
  if encode(extensions.digest(upper(btrim(coalesce(p_key, ''))), 'sha256'), 'hex') <> '9714e40c11c947f6c4947a9579cc6e30bbcf36343521a379ecd15efb830859d7' then
    perform pg_sleep(2);
    return jsonb_build_object('ok', false, 'error', 'wrong_setup_key');
  end if;
  begin
    select email into em from auth.users where id = uid;
    nm := gymp.j_text(p_data, 'owner_name', 100); gym := gymp.j_text(p_data, 'gym_name', 80);
    upi := btrim(coalesce(p_data ->> 'upi_id', '')); wa := btrim(coalesce(p_data ->> 'gym_whatsapp', ''));
    if length(nm) < 2 then perform gymp.fail('owner_name_required'); end if;
    if length(gym) < 2 then perform gymp.fail('gym_name_required'); end if;
    if upi <> '' and upi !~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,30}$' then perform gymp.fail('bad_upi'); end if;
    if wa <> '' then wa := gymp.norm_phone(wa); if wa is null then perform gymp.fail('bad_phone'); end if; end if;
    insert into public.owners (user_id, name, email) values (uid, nm, coalesce(em, ''));
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
  exception when others then
    get stacked diagnostics msg = message_text;
    return jsonb_build_object('ok', false, 'error', case when msg like 'GYM:%' then substr(msg, 5) else 'setup_failed: ' || msg end);
  end;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('demo', demo, 'email', em));
end $$;

create function public.gym_installed() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.owners) $$;

-- ================================================================= who may call what
revoke all on all functions in schema gymp from public, anon, authenticated;
revoke all on function public.gym_api(text, jsonb, text) from public, anon, authenticated;
revoke all on function public.gym_setup(text, jsonb) from public, anon, authenticated;
revoke all on function public.gym_installed() from public, anon, authenticated;
grant execute on function public.gym_api(text, jsonb, text) to anon, authenticated;
grant execute on function public.gym_setup(text, jsonb) to authenticated;
grant execute on function public.gym_installed() to anon, authenticated;
grant usage on schema gymp to authenticated;                      -- only so the storage rules below can call is_owner()
grant execute on function gymp.is_owner() to authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ================================================================= product photos (Supabase Storage)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('products', 'products', true, 1048576, array['image/jpeg'])
on conflict (id) do update set public = true, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'];

create policy "gym owner adds product photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'products' and gymp.is_owner() and name ~ '^[a-f0-9-]{36}\.jpg$');
create policy "gym owner reads product photo list" on storage.objects for select to authenticated
  using (bucket_id = 'products' and gymp.is_owner());
create policy "gym owner replaces product photos" on storage.objects for update to authenticated
  using (bucket_id = 'products' and gymp.is_owner());
create policy "gym owner removes product photos" on storage.objects for delete to authenticated
  using (bucket_id = 'products' and gymp.is_owner());

-- pin the search path of every private helper (database linter hygiene)
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'gymp' loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', f.sig);
  end loop;
end $$;
