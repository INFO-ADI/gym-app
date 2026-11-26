/* Super admin panel: create and manage every gym, their trials and payments, and website leads.
   Everything goes through public.platform_api, which only answers platform admins. */
(function () {
  'use strict';
  const CFG = window.SITE_CONFIG || {};
  const sb = window.supabase && CFG.url ? window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'kg-admin-auth' } }) : null;
  const $app = document.getElementById('app');
  const S = { settings: null, me: null };
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

  /* ---------------- tiny helpers (same look as the gym app) ---------------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) { if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid)); }
    return el;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    gyms: 'M6 7v10M18 7v10M3 9v6M21 9v6M6 12h12',
    chat: 'M4 4h16v12H8l-4 4z',
    rupee: 'M6 4h12M6 9h12M6 4c6 0 8 2 8 5s-3 5-8 5l9 7',
    bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
    gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
  };
  function icon(name) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', ICONS[name]); s.append(p);
    return s;
  }
  const fmtMoney = n => '₹' + Number(n || 0).toLocaleString('en-IN');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(iso) { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return +d + ' ' + MONTHS[+m - 1] + ' ' + y; }
  function todayISO() { const d = new Date(Date.now() + 5.5 * 3600e3); return d.toISOString().slice(0, 10); }
  function waLink(phone, text) { return 'https://wa.me/' + String(phone || '').replace(/\D/g, '') + (text ? '?text=' + encodeURIComponent(text) : ''); }
  function shortPhone(p) { return String(p || '').replace(/^91/, '').replace(/(\d{5})(\d{5})/, '$1 $2'); }
  let toastTimer;
  function toast(msg, isErr) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 3500);
  }
  const ERR = {
    login_required: 'Please log in again.', forbidden: 'This account is not a platform admin.', network: 'No internet connection.',
    wrong_setup_key: 'That admin setup key is wrong.', already_installed: 'An admin already exists. Log in with that account.',
    too_many_attempts: 'Too many tries. Wait 15 minutes.', name_required: 'Enter the gym name.', bad_slug: 'Web name: 3–30 small letters, numbers and single dashes.',
    slug_taken: 'That web name is already used by another gym.', slug_reserved: 'That web name is reserved. Pick another.', bad_color: 'Pick valid colours.',
    bad_phone: 'Enter a 10-digit mobile number.', bad_plan: 'Pick monthly or yearly.', bad_amount: 'Check the amount.', bad_days: 'Days must be 1–90.',
    confirm_slug: 'Type the gym web name exactly to confirm.', not_found: 'Not found. It may have been deleted.', server_error: 'Something went wrong. Try again.',
    upload_failed: 'Logo upload failed. Use a PNG or JPG under 5 MB.', bad_upi: 'UPI ID looks wrong. It should look like name@okaxis.', not_an_image: 'That file is not an image.',
  };
  const errText = e => ERR[e] || ('Error: ' + e);
  const showErr = e => toast(errText(e && e.message ? e.message : e), true);
  function busy(btn, fn) {
    return async ev => {
      if (ev) ev.preventDefault();
      if (btn.disabled) return;
      btn.disabled = true;
      try { await fn(); } catch (e) { showErr(e); } finally { btn.disabled = false; }
    };
  }
  function modal(title, body, actions) {
    const d = h('dialog', null, h('h3', null, title), body, h('div', { class: 'btns' }, actions || []));
    document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
    return d;
  }
  function field(label, input) { return h('label', { class: 'f' }, label, input); }
  function formData(form) {
    const o = {};
    for (const el of form.elements) { if (!el.name) continue; o[el.name] = el.type === 'checkbox' ? el.checked : el.value; }
    return o;
  }
  function copy(text, what) { navigator.clipboard.writeText(text).then(() => toast((what || 'Text') + ' copied')).catch(() => toast('Copy failed', true)); }

  async function api(action, body) {
    if (!sb) throw new Error('network');
    let res;
    try { res = await sb.rpc('platform_api', { p_action: action, p_in: body || {} }); } catch (e) { throw new Error('network'); }
    if (res.error) throw new Error(/fetch|network|Failed/i.test(res.error.message || '') ? 'network' : 'server_error');
    if (!res.data || !res.data.ok) {
      const e = res.data ? res.data.error : 'server_error';
      if (e === 'login_required') { await sb.auth.signOut(); boot(); }
      throw new Error(e);
    }
    return res.data.data;
  }

  function gymUrl(slug) {
    const st = S.settings || {};
    const dom = st.base_domain || CFG.domain || location.host;
    const port = location.port ? ':' + location.port : '';
    const pre = (location.protocol === 'http:' ? 'http://' : 'https://');
    return st.url_style === 'path' ? pre + dom + port + '/g/' + slug + '/' : pre + slug + '.' + dom + port + '/';
  }
  const STATE = {
    trial: ['Trial', 'waiting'], active: ['Paid', 'active'], grace: ['Ended · grace', 'expiring'], expired: ['Expired', 'expired'], suspended: ['Paused', 'archived'],
  };
  function stateBadge(g) { const s = STATE[g.sub.state] || [g.sub.state, '']; return h('span', { class: 'badge ' + s[1] }, s[0]); }
  function stateLine(g) {
    const s = g.sub;
    if (s.state === 'suspended') return 'Paused by you';
    if (s.state === 'trial') return 'Free trial · ' + (s.days_left >= 0 ? s.days_left + ' days left' : 'ended') + ' (' + fmtDate(s.ends) + ')';
    if (s.state === 'active') return (g.plan === 'yearly' ? 'Yearly' : 'Monthly') + ' · paid till ' + fmtDate(s.ends);
    if (s.state === 'grace') return 'Ended ' + fmtDate(s.ends) + ' · locks in ' + Math.max(0, (Number(S.settings && S.settings.grace_days) || 3) + s.days_left) + ' days';
    return 'Locked since ' + fmtDate(s.ends);
  }

  /* ---------------- frame ---------------- */
  const NAV = [['#/', 'Home', 'home'], ['#/gyms', 'Gyms', 'gyms'], ['#/remind', 'Remind', 'bell'], ['#/leads', 'Leads', 'chat'], ['#/settings', 'Settings', 'gear']];
  function frame(title, content, opts) {
    opts = opts || {};
    const cur = '#/' + (location.hash.slice(2).split('/')[0] || '');
    const top = h('header', { class: 'top' },
      opts.back ? h('button', { class: 'back', 'aria-label': 'Back', onclick: () => { location.hash = opts.back; } }, '‹') : null,
      h('h1', null, h('span', { class: 'gymname' }, (CFG.site || 'Gym') + ' admin'), title), opts.action || null);
    const nav = h('nav', { class: 'nav' }, NAV.map(([href, label, ic]) => h('a', { href, class: href === cur || (href === '#/' && cur === '#/') ? 'on' : '' }, icon(ic), label)));
    $app.className = '';
    $app.replaceChildren(top, h('main', { class: 'page' }, content), nav);
    window.scrollTo(0, 0);
  }
  function loading(title) { frame(title, [h('div', { class: 'sk sk-hero' }), h('div', { class: 'sk sk-line' }), h('div', { class: 'sk sk-line' })]); }
  function plain(content) { $app.className = 'boot'; $app.replaceChildren(h('div', { class: 'login' }, content)); }

  /* ---------------- login / first admin ---------------- */
  function loginPage(msg) {
    let mode = 'login';
    const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'username' });
    const pw = h('input', { type: 'password', name: 'password', required: true, minlength: 10, autocomplete: 'current-password' });
    const btn = h('button', { class: 'btn block', type: 'submit' }, 'Log in');
    const sw = h('a', { href: '#', class: 'small' }, 'First time? Create the admin account');
    const form = h('form', { class: 'card' }, msg ? h('p', { class: 'err-text' }, msg) : null, field('Email', email), field('Password (10+ characters)', pw), btn,
      h('p', { class: 'center' }, sw), h('p', { class: 'center' }, h('a', { href: '#', class: 'small', onclick: forgot }, 'Forgot password?')));
    sw.addEventListener('click', ev => {
      ev.preventDefault(); mode = mode === 'login' ? 'signup' : 'login';
      btn.textContent = mode === 'login' ? 'Log in' : 'Create account';
      sw.textContent = mode === 'login' ? 'First time? Create the admin account' : 'I already have an account';
      pw.setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    });
    async function forgot(ev) {
      ev.preventDefault();
      if (!email.value.trim()) return toast('Type your email first', true);
      const { error } = await sb.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: location.origin + '/admin/' });
      toast(error ? 'Could not send the email' : 'Password reset email sent', !!error);
    }
    form.addEventListener('submit', busy(btn, async () => {
      const e = email.value.trim().toLowerCase(), p = pw.value;
      let r = mode === 'login' ? await sb.auth.signInWithPassword({ email: e, password: p }) : await sb.auth.signUp({ email: e, password: p });
      if (!r.error && mode === 'signup' && !r.data.session) r = await sb.auth.signInWithPassword({ email: e, password: p });
      if (r.error) throw new Error(/invalid/i.test(r.error.message) ? 'Wrong email or password' : r.error.message);
      boot();
    }));
    plain([h('h1', null, (CFG.site || 'Gym') + ' admin'), h('p', { class: 'muted center' }, 'For the platform owner only.'), form]);
  }

  function bootstrapPage() {
    const key = h('input', { name: 'key', required: true, placeholder: 'XXXX-XXXX-XXXX-XXXX', autocapitalize: 'characters' });
    const btn = h('button', { class: 'btn block', type: 'submit' }, 'Make me the admin');
    const form = h('form', { class: 'card' }, h('p', { class: 'small' }, 'One-time step: enter the admin setup key to make ', h('b', null, S.me.email), ' the platform admin. It works only once.'),
      field('Admin setup key', key), btn, h('button', { class: 'btn ghost block', type: 'button', onclick: logout }, 'Use another account'));
    form.addEventListener('submit', busy(btn, async () => { await api('bootstrap', { key: key.value }); toast('You are now the admin'); boot(); }));
    plain([h('h1', null, 'Almost done'), form]);
  }

  async function logout() { await sb.auth.signOut(); location.hash = '#/'; boot(); }

  async function newPassword() {
    const pw = h('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
    const btn = h('button', { class: 'btn block', type: 'submit' }, 'Save new password');
    const form = h('form', { class: 'card' }, field('New password (10+ characters)', pw), btn);
    form.addEventListener('submit', busy(btn, async () => {
      const { error } = await sb.auth.updateUser({ password: pw.value });
      if (error) throw new Error(error.message);
      S.recovery = false; toast('Password changed'); boot();
    }));
    plain([h('h1', null, 'New password'), form]);
  }

  const IDLE_MS = 12 * 3600e3;
  function touch() { try { localStorage.setItem('kg_admin_seen', String(Date.now())); } catch (e) { /* ignore */ } }
  function idleTooLong() { try { const t = +localStorage.getItem('kg_admin_seen') || 0; return t && Date.now() - t > IDLE_MS; } catch (e) { return false; } }
  async function boot() {
    if (sb && idleTooLong()) { await sb.auth.signOut(); try { localStorage.removeItem('kg_admin_seen'); } catch (e) { /* ignore */ } return loginPage('Logged out after 12 hours without use. Please log in again.'); }
    if (!sb) return plain([h('h1', null, 'Not connected'), h('p', { class: 'muted' }, 'site-config.js did not load.')]);
    if (S.recovery) return newPassword();
    const { data } = await sb.auth.getSession();
    if (!data.session) return loginPage();
    try { S.me = await api('me'); } catch (e) { return loginPage(errText(e.message)); }
    if (!S.me.is_admin) {
      if (S.me.needs_bootstrap) return bootstrapPage();
      return plain([h('h1', null, 'Not an admin'), h('p', { class: 'muted center' }, S.me.email + ' is not a platform admin.'), h('button', { class: 'btn', onclick: logout }, 'Log out')]);
    }
    try { S.settings = await api('settings', {}); } catch (e) { S.settings = {}; }
    route();
  }

  /* ---------------- router ---------------- */
  const routes = {};
  function route() {
    if (!S.me || !S.me.is_admin) return;
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    touch();
    const fn = routes[parts[0] || 'home'] || routes.home;
    Promise.resolve(fn(parts[1])).catch(showErr);
  }
  window.addEventListener('hashchange', route);

  /* ---------------- home ---------------- */
  routes.home = async () => {
    loading('Overview');
    const [d, rm] = await Promise.all([api('overview'), api('reminders')]);
    S.gyms = d.gyms;
    const c = d.counts;
    const attention = d.gyms.filter(g => g.sub.state === 'grace' || g.sub.state === 'expired' || (['trial', 'active'].includes(g.sub.state) && g.sub.days_left <= 5) || !g.claimed);
    frame('Overview', [
      h('div', { class: 'hero' },
        h('div', { class: 'hello' }, 'Monthly recurring income'),
        h('div', { class: 'big-money gradtext' }, fmtMoney(d.mrr)),
        h('a', { class: 'muted small', href: '#/money' }, 'Collected this month ' + fmtMoney(d.collected_month) + ' · all time ' + fmtMoney(d.collected_total) + ' ›'),
        h('div', { class: 'statrow' },
          h('div', { class: 'stat' }, h('b', null, c.total), h('span', null, 'Gyms')),
          h('div', { class: 'stat' }, h('b', null, c.active), h('span', null, 'Paying')),
          h('div', { class: 'stat' }, h('b', null, c.trial), h('span', null, 'On trial')))),
      h('div', { class: 'tiles' },
        h('a', { class: 'tile hot', href: '#/leads' }, h('div', { class: 'n' }, d.leads_new), h('div', { class: 'l' }, 'New demo requests')),
        h('a', { class: 'tile warn', href: '#/remind' }, h('div', { class: 'n' }, rm.gyms.filter(g => !g.reminded_today).length), h('div', { class: 'l' }, 'Reminders to send')),
        h('div', { class: 'tile good' }, h('div', { class: 'n' }, c.members), h('div', { class: 'l' }, 'Members on all gyms')),
        h('a', { class: 'tile', href: '#/new' }, h('div', { class: 'n' }, '+'), h('div', { class: 'l' }, 'New gym'))),
      rm.requests.length ? h('a', { class: 'card subnote', href: '#/remind' }, h('div', { class: 'grow' }, h('b', null, rm.requests.length + ' renewal payment' + (rm.requests.length > 1 ? 's' : '') + ' to confirm'),
        h('div', { class: 'small muted' }, 'Gym owners paid by UPI from their app. Check your UPI app, then confirm.')), '›') : null,
      h('div', { class: 'section' }, 'Needs attention'),
      attention.length ? attention.slice(0, 8).map(gymCard) : h('div', { class: 'card muted small' }, 'All good. No trials ending, nothing overdue.'),
      h('a', { class: 'btn block', href: '#/new' }, '+ Create a new gym'),
    ]);
  };

  function gymCard(g) {
    return h('a', { class: 'card gymrow', href: '#/gym/' + g.id },
      h('div', { class: 'swatch', style: null }, swatch(g.colors)),
      h('div', { class: 'grow' },
        h('div', { class: 'row between' }, h('b', null, g.name), stateBadge(g)),
        h('div', { class: 'muted small' }, gymUrl(g.slug).replace(/^https?:\/\//, '')),
        h('div', { class: 'small' }, g.claimed ? stateLine(g) + ' · ' + g.members + ' members' : '⏳ Waiting for the owner to set up · ' + stateLine(g))));
  }
  function swatch(c) {
    const el = h('span', { class: 'sw' });
    el.style.background = 'linear-gradient(135deg,' + c.a1 + ',' + c.a2 + ',' + c.a3 + ')';
    el.style.boxShadow = '0 0 0 3px ' + c.bg;
    return el;
  }

  /* ---------------- gyms ---------------- */
  routes.gyms = async (filter) => {
    filter = filter || 'all';
    loading('Gyms');
    const d = await api('overview');
    S.gyms = d.gyms;
    const q = h('input', { class: 'search', placeholder: 'Search gym, city or owner', type: 'search' });
    const box = h('div');
    const tabs = [['all', 'All'], ['attention', 'Follow up'], ['trial', 'Trial'], ['active', 'Paid'], ['expired', 'Expired']];
    const match = g => filter === 'all' ? true : filter === 'attention'
      ? (g.sub.state === 'grace' || g.sub.state === 'expired' || (['trial', 'active'].includes(g.sub.state) && g.sub.days_left <= 5) || !g.claimed)
      : filter === 'expired' ? ['expired', 'suspended', 'grace'].includes(g.sub.state) : g.sub.state === filter;
    const draw = () => {
      const t = q.value.trim().toLowerCase();
      const list = d.gyms.filter(match).filter(g => !t || [g.name, g.slug, g.city, g.owner_name, g.owners].join(' ').toLowerCase().includes(t));
      box.replaceChildren(...(list.length ? list.map(gymCard) : [h('div', { class: 'empty' }, d.gyms.length ? 'No gyms here.' : 'No gyms yet. Create your first one!')]));
    };
    q.addEventListener('input', draw);
    frame('Gyms', [
      q, h('div', { class: 'seg' }, tabs.map(([k, l]) => h('button', { class: k === filter ? 'on' : '', onclick: () => { location.hash = '#/gyms/' + k; } }, l))),
      box, h('a', { class: 'btn block', href: '#/new' }, '+ New gym'),
    ], { action: h('a', { class: 'btn sm', href: '#/new' }, '+ New') });
    draw();
  };

  /* ---------------- create a gym ---------------- */
  const PRESETS = [
    ['Fire', { a1: '#ffb300', a2: '#ff6a00', a3: '#ff2e63', accent: '#ff8a00', bg: '#0f1115' }],
    ['Ocean', { a1: '#22e1ff', a2: '#3b82f6', a3: '#7b5cff', accent: '#3b82f6', bg: '#060b1a' }],
    ['Lime', { a1: '#d4ff3a', a2: '#22d48a', a3: '#0ea5a4', accent: '#22d48a', bg: '#0b1210' }],
    ['Royal', { a1: '#e879f9', a2: '#a855f7', a3: '#6d28d9', accent: '#a855f7', bg: '#0f0a1a' }],
    ['Blood', { a1: '#ff6b6b', a2: '#e11d48', a3: '#9f1239', accent: '#f43f5e', bg: '#120709' }],
    ['Gold', { a1: '#fde68a', a2: '#f59e0b', a3: '#b45309', accent: '#f59e0b', bg: '#120d05' }],
    ['Steel', { a1: '#f1f5f9', a2: '#94a3b8', a3: '#475569', accent: '#94a3b8', bg: '#0b0f14' }],
  ];
  function colorPicker(start) {
    const cur = Object.assign({}, start || PRESETS[0][1]);
    const preview = h('div', { class: 'brandprev' });
    const inputs = {};
    const paint = () => {
      preview.style.background = cur.bg;
      preview.replaceChildren(h('span', { class: 'pv-btn' }, 'Log in'));
      preview.firstChild.style.background = 'linear-gradient(135deg,' + cur.a1 + ',' + cur.a2 + ' 55%,' + cur.a3 + ')';
      for (const k in inputs) inputs[k].value = cur[k];
    };
    const presets = h('div', { class: 'chips' }, PRESETS.map(([n, c]) => {
      const b = h('button', { type: 'button', class: 'chip' }, swatch(c), ' ', n);
      b.addEventListener('click', () => { Object.assign(cur, c); paint(); });
      return b;
    }));
    const custom = h('div', { class: 'colorrow' }, [['a1', 'Start'], ['a2', 'Middle'], ['a3', 'End'], ['accent', 'Accent'], ['bg', 'Background']].map(([k, l]) => {
      inputs[k] = h('input', { type: 'color', value: cur[k], 'aria-label': l });
      inputs[k].addEventListener('input', () => { cur[k] = inputs[k].value.toLowerCase(); paint(); });
      return h('label', { class: 'cpick' }, inputs[k], h('span', null, l));
    }));
    paint();
    return { el: h('div', null, presets, preview, h('details', null, h('summary', { class: 'small' }, 'Custom colours'), custom)), get: () => Object.assign({}, cur) };
  }

  /** Makes the 4 app icons from any logo picture, in the browser, then uploads them. */
  async function uploadLogo(slug, version, file, bg) {
    if (!/^image\//.test(file.type)) throw new Error('not_an_image');
    if (file.size > 5 * 1024 * 1024) throw new Error('upload_failed');
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('not_an_image')); i.src = URL.createObjectURL(file); });
    const make = (size, pad, fill) => {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const x = c.getContext('2d');
      if (fill) { x.fillStyle = bg; x.fillRect(0, 0, size, size); }
      const box = size * (1 - 2 * pad), sc = Math.min(box / img.naturalWidth, box / img.naturalHeight);
      const w = img.naturalWidth * sc, hh = img.naturalHeight * sc;
      x.imageSmoothingQuality = 'high';
      x.drawImage(img, (size - w) / 2, (size - hh) / 2, w, hh);
      return new Promise(r => c.toBlob(r, 'image/png'));
    };
    const files = { 'icon-192.png': await make(192, 0.04, false), 'icon-512.png': await make(512, 0.04, false),
      'maskable-512.png': await make(512, 0.2, true), 'apple-touch-icon.png': await make(180, 0.1, true) };
    URL.revokeObjectURL(img.src);
    for (const [name, blob] of Object.entries(files)) {
      const { error } = await sb.storage.from('brand').upload(slug + '/v' + version + '/' + name, blob, { contentType: 'image/png', upsert: true });
      if (error) throw new Error('upload_failed');
    }
  }
  function removeLogo(slug, version) {
    if (!version) return;
    sb.storage.from('brand').remove(['icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png'].map(n => slug + '/v' + version + '/' + n)).catch(() => {});
  }
  const toSlug = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 30).replace(/-+$/, '');

  routes.new = () => {
    const pre = S.prefill || {}; S.prefill = null;
    const name = h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'Power House Gym', value: pre.name || '' });
    const slug = h('input', { name: 'slug', required: true, maxlength: 30, pattern: '[a-z0-9][a-z0-9\\-]{1,28}[a-z0-9]', autocapitalize: 'off', value: pre.name ? toSlug(pre.name) : '' });
    const urlPrev = h('div', { class: 'small muted' });
    let slugTouched = false;
    const showUrl = () => { urlPrev.textContent = SLUG_RE.test(slug.value) ? 'App address: ' + gymUrl(slug.value) : 'Small letters, numbers and dashes, 3–30 characters.'; };
    name.addEventListener('input', () => { if (!slugTouched) slug.value = toSlug(name.value); showUrl(); });
    slug.addEventListener('input', () => { slugTouched = true; slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); showUrl(); });
    showUrl();
    const colors = colorPicker();
    const logo = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    const btn = h('button', { class: 'btn block', type: 'submit' }, 'Create gym app');
    const subNote = (S.settings && S.settings.url_style === 'path') ? null : h('div', { class: 'card subnote small' },
      '⚠️ First create this subdomain in Hostinger: hPanel → Domains → Subdomains → type the web name below, keep "Use public_html directory" ticked → Create (and check its SSL).');
    const form = h('form', null, subNote,
      h('div', { class: 'card' },
        field('Gym name', name), field('Web name (part of the link)', slug), urlPrev,
        field('Short name under the app icon (max 20)', h('input', { name: 'short_name', maxlength: 20, placeholder: 'Power House' })),
        field('City', h('input', { name: 'city', maxlength: 60, value: pre.city || 'Kanpur' }))),
      h('div', { class: 'card' }, h('h3', null, 'Owner'),
        field('Owner name', h('input', { name: 'owner_name', maxlength: 100, value: pre.owner_name || '' })),
        field('Owner WhatsApp', h('input', { name: 'owner_phone', inputmode: 'tel', placeholder: '98765 43210', value: pre.phone ? shortPhone(pre.phone) : '' }))),
      h('div', { class: 'card' }, h('h3', null, 'Look'), colors.el, field('Logo (optional, square works best)', logo)),
      h('div', { class: 'card' }, field('Notes (only you see these)', h('textarea', { name: 'notes', maxlength: 1000 }, pre.notes || ''))),
      btn);
    form.addEventListener('submit', busy(btn, async () => {
      const b = formData(form); b.colors = colors.get();
      btn.textContent = 'Creating…';
      try {
        const r = await api('gym_create', b);
        let g = r.gym;
        if (logo.files[0]) {
          try { await uploadLogo(g.slug, 1, logo.files[0], b.colors.bg); g = await api('gym_update', { id: g.id, logo_bump: true }); }
          catch (e) { toast('Gym created, but the logo upload failed. Add it from the gym page.', true); }
        }
        createdPage(g, r.code);
      } finally { btn.textContent = 'Create gym app'; }
    }));
    frame('New gym', form, { back: '#/gyms' });
  };

  function setupMessage(g, code) {
    const link = gymUrl(g.slug) + 'setup#code=' + code;
    return 'Namaste' + (g.owner_name ? ' ' + g.owner_name.split(' ')[0] : '') + ' ji! 🎉 ' + g.name + ' ka apna app taiyaar hai.\n\n' +
      '1. Ye link kholiye: ' + link + '\n2. Setup code: ' + code + '\n3. Apni gym details, plans aur password daaliye.\n\n' +
      'Aapka ' + ((S.settings && S.settings.trial_days) || 30) + ' din ka FREE trial shuru ho gaya hai. Koi bhi sawaal ho toh isi number pe message kijiye.\n- ' + (CFG.site || 'Team');
  }
  function codeCard(g, code) {
    const link = gymUrl(g.slug) + 'setup#code=' + code;
    return h('div', { class: 'card codebox' },
      h('div', { class: 'muted small' }, 'Setup code for the owner (valid 30 days, works once)'),
      h('div', { class: 'bigcode' }, code),
      h('div', { class: 'small' }, h('code', null, link)),
      h('div', { class: 'btns' },
        g.owner_phone ? h('a', { class: 'btn wa', href: waLink(g.owner_phone, setupMessage(g, code)), target: '_blank', rel: 'noopener' }, 'Send on WhatsApp')
          : h('a', { class: 'btn wa', href: 'https://wa.me/?text=' + encodeURIComponent(setupMessage(g, code)), target: '_blank', rel: 'noopener' }, 'Share on WhatsApp'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => copy(setupMessage(g, code), 'Message') }, 'Copy message')),
      h('p', { class: 'muted small' }, 'The code is shown only now. If it gets lost, make a new one from the gym page.'));
  }
  function createdPage(g, code) {
    history.replaceState(null, '', '#/gym/' + g.id);   // a refresh shows the gym page; "Create another" works
    frame('Gym created', [
      h('div', { class: 'hero center' }, h('div', { class: 'bigemoji' }, '🎉'), h('h2', null, g.name + ' is live'),
        h('p', null, h('a', { href: gymUrl(g.slug), target: '_blank', rel: 'noopener' }, gymUrl(g.slug))),
        h('p', { class: 'muted small' }, 'Free trial until ' + fmtDate(g.trial_ends) + '.')),
      codeCard(g, code),
      h('a', { class: 'btn ghost block', href: '#/gym/' + g.id }, 'Open gym page'),
      h('a', { class: 'btn ghost block', href: '#/new' }, 'Create another gym'),
    ], { back: '#/gyms' });
  }

  /* ---------------- one gym ---------------- */
  routes.gym = async (id) => {
    loading('Gym');
    const d = await api('gym_detail', { id });
    const g = d.gym;
    const reload = () => routes.gym(id);
    const pay = () => {
      const plan = h('select', { name: 'plan' }, h('option', { value: 'monthly' }, 'Monthly · ' + fmtMoney(S.settings.price_month)), h('option', { value: 'yearly' }, 'Yearly · ' + fmtMoney(S.settings.price_year)));
      const amount = h('input', { name: 'amount', inputmode: 'numeric', value: S.settings.price_month });
      plan.addEventListener('change', () => { amount.value = plan.value === 'yearly' ? S.settings.price_year : S.settings.price_month; });
      const form = h('form', null, field('Plan', plan), field('Amount received (₹)', amount),
        field('Paid by', h('select', { name: 'mode' }, h('option', { value: 'upi' }, 'UPI'), h('option', { value: 'cash' }, 'Cash'), h('option', { value: 'bank' }, 'Bank transfer'))),
        field('Paid on', h('input', { name: 'paid_on', type: 'date', value: todayISO() })), field('Note (optional)', h('input', { name: 'note', maxlength: 200 })),
        h('p', { class: 'muted small' }, 'The paid period starts after the current trial or paid period ends.'));
      const save = h('button', { class: 'btn' }, 'Save payment');
      const dlg = modal('Record payment', form, [h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'), save]);
      save.addEventListener('click', busy(save, async () => {
        const r = await api('gym_payment', Object.assign({ id: g.id }, formData(form)));
        dlg.close(); toast('Payment saved. Paid till ' + fmtDate(r.period_to));
        if (g.owner_phone) {
          const msg = 'Thank you! 🙏 Payment of ' + fmtMoney(formData(form).amount) + ' received for ' + g.name + ' app. Valid till ' + fmtDate(r.period_to) + '. - ' + (CFG.site || '');
          setTimeout(() => modal('Send receipt?', h('p', null, 'Send a WhatsApp thank-you to the owner?'), [
            h('button', { class: 'btn ghost', onclick: ev => ev.target.closest('dialog').close() }, 'No'),
            h('a', { class: 'btn wa', href: waLink(g.owner_phone, msg), target: '_blank', rel: 'noopener', onclick: ev => ev.target.closest('dialog').close() }, 'Send')]), 300);
        }
        reload();
      }));
    };
    const trial = () => {
      const days = h('select', { name: 'days' }, [7, 14, 30].map(n => h('option', { value: n }, '+' + n + ' days')));
      const save = h('button', { class: 'btn' }, 'Extend');
      const dlg = modal('Extend free trial', field('Add', days), [h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'), save]);
      save.addEventListener('click', busy(save, async () => { await api('gym_trial', { id: g.id, days: days.value }); dlg.close(); toast('Trial extended'); reload(); }));
    };
    const newCode = busy(h('button'), async () => { const r = await api('gym_code', { id: g.id }); frame('Setup code', [codeCard(r.gym, r.code)], { back: '#/gym/' + g.id }); });
    const pause = async () => {
      const to = g.status === 'suspended' ? 'active' : 'suspended';
      if (to === 'suspended' && !confirm('Pause ' + g.name + '? The owner and members will see "App paused" until you resume it.')) return;
      await api('gym_status', { id: g.id, status: to }); toast(to === 'active' ? 'Gym resumed' : 'Gym paused'); reload();
    };
    const edit = () => {
      const colors = colorPicker(g.colors);
      const logo = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
      const form = h('form', null,
        field('Gym name', h('input', { name: 'name', required: true, maxlength: 80, value: g.name })),
        field('Short name (max 20)', h('input', { name: 'short_name', maxlength: 20, value: g.short_name })),
        field('City', h('input', { name: 'city', maxlength: 60, value: g.city || '' })),
        field('Owner name', h('input', { name: 'owner_name', maxlength: 100, value: g.owner_name || '' })),
        field('Owner WhatsApp', h('input', { name: 'owner_phone', inputmode: 'tel', value: g.owner_phone ? shortPhone(g.owner_phone) : '' })),
        h('div', { class: 'section' }, 'Look'), colors.el,
        field(g.logo_version ? 'Replace logo' : 'Add logo', logo),
        g.logo_version ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'logo_remove' }), 'Remove the logo (use the default icon)') : null,
        field('Notes', h('textarea', { name: 'notes', maxlength: 1000 }, g.notes || '')));
      const save = h('button', { class: 'btn' }, 'Save');
      const dlg = modal('Edit ' + g.name, form, [h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'), save]);
      save.addEventListener('click', busy(save, async () => {
        const b = formData(form); b.id = g.id; b.colors = colors.get();
        if (logo.files[0]) { await uploadLogo(g.slug, g.logo_version + 1, logo.files[0], b.colors.bg); b.logo_bump = true; b.logo_remove = false; }
        await api('gym_update', b);
        if (b.logo_bump || b.logo_remove) removeLogo(g.slug, g.logo_version);
        dlg.close(); toast('Saved. The app updates within a minute.'); reload();
      }));
    };
    const del = () => {
      const conf = h('input', { placeholder: g.slug, autocapitalize: 'off' });
      const go = h('button', { class: 'btn bad' }, 'Delete forever');
      const dlg = modal('Delete ' + g.name + '?', h('div', null, h('p', null, 'This deletes the gym app and ALL its members, payments and data. It cannot be undone.'),
        field('Type ' + g.slug + ' to confirm', conf)), [h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'), go]);
      go.addEventListener('click', busy(go, async () => {
        const r = await api('gym_delete', { id: g.id, confirm: conf.value.trim() });
        if (r.photos && r.photos.length) sb.storage.from('products').remove(r.photos).catch(() => {});
        removeLogo(r.deleted, r.logo_version);
        dlg.close(); toast(g.name + ' deleted'); location.hash = '#/gyms';
      }));
    };
    frame(g.name, [
      h('div', { class: 'hero gymhero' },
        h('div', { class: 'row' }, g.logo_version ? h('img', { class: 'glogo', src: CFG.url + '/storage/v1/object/public/brand/' + g.slug + '/v' + g.logo_version + '/icon-192.png', alt: '' }) : swatch(g.colors),
          h('div', { class: 'grow' }, h('div', { class: 'row between' }, h('h2', null, g.name), stateBadge(g)),
            h('a', { class: 'small', href: gymUrl(g.slug), target: '_blank', rel: 'noopener' }, gymUrl(g.slug).replace(/^https?:\/\//, '')))),
        h('div', { class: 'small' }, stateLine(g)),
        g.autopay ? h('div', { class: 'small' }, 'Auto-pay: ' + ({ active: '✓ on', authenticated: '✓ on, first charge pending', pending: '⚠ payment failed, Razorpay retrying', halted: '✗ stopped after failed payments', cancelled: 'cancelled', completed: 'completed', created: 'started but not approved' }[g.autopay.status] || g.autopay.status) + ' · ' + (g.autopay.plan || '')) : null,
        h('div', { class: 'statrow' },
          h('div', { class: 'stat' }, h('b', null, g.members), h('span', null, 'Members')),
          h('div', { class: 'stat' }, h('b', null, g.active_members), h('span', null, 'Active')),
          h('div', { class: 'stat' }, h('b', null, g.last_activity ? fmtDate(g.last_activity) : '—'), h('span', null, 'Last activity')))),
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: pay }, '₹ Record payment'), h('button', { class: 'btn ghost', onclick: trial }, 'Extend trial')),
      h('div', { class: 'section' }, 'Owner'),
      h('div', { class: 'card' },
        h('div', null, h('b', null, g.owner_name || 'Owner'), g.owner_phone ? ' · +91 ' + shortPhone(g.owner_phone) : ''),
        g.claimed ? h('div', { class: 'small muted' }, 'Logins: ' + (d.owner_list.map(o => o.email).join(', ') || '—') + ' · set up ' + fmtDate(g.claimed_at))
          : h('div', { class: 'small' }, '⏳ The owner has not set up the app yet.' + (g.code_pending ? ' A setup code is active until ' + fmtDate(g.code_expires) + '.' : ' The last code has expired.')),
        h('div', { class: 'btns' },
          g.owner_phone ? h('a', { class: 'btn sm wa', href: waLink(g.owner_phone, 'Namaste ji, ' + (CFG.site || '') + ' se bol raha hoon. '), target: '_blank', rel: 'noopener' }, 'WhatsApp') : null,
          (() => { const b = h('button', { class: 'btn sm ghost' }, g.claimed ? 'Code for another owner' : 'New setup code'); b.addEventListener('click', newCode); return b; })())),
      h('div', { class: 'section' }, 'Payments'),
      d.payments.length ? h('div', { class: 'list' }, d.payments.map(p => h('div', { class: 'item' }, h('div', { class: 'grow' },
        h('div', { class: 't' }, fmtMoney(p.amount) + ' · ' + (p.plan === 'yearly' ? 'Yearly' : 'Monthly') + ' · ' + p.mode.toUpperCase()),
        h('div', { class: 's' }, 'Paid ' + fmtDate(p.paid_on) + ' · covers ' + fmtDate(p.period_from) + ' – ' + fmtDate(p.period_to) + (p.note ? ' · ' + p.note : '')))))) : h('div', { class: 'card muted small' }, 'No payments yet.'),
      g.notes ? h('div', { class: 'card small' }, h('b', null, 'Notes: '), g.notes) : null,
      h('div', { class: 'section' }, 'Manage'),
      h('div', { class: 'list' },
        h('button', { class: 'item', onclick: edit }, h('div', { class: 'grow t' }, 'Edit name, owner, colours, logo'), '›'),
        h('a', { class: 'item', href: gymUrl(g.slug), target: '_blank', rel: 'noopener' }, h('div', { class: 'grow t' }, 'Open the gym app'), '›'),
        h('button', { class: 'item', onclick: () => pause().catch(showErr) }, h('div', { class: 'grow t' }, g.status === 'suspended' ? 'Resume the app' : 'Pause the app (unpaid)'), '›'),
        h('button', { class: 'item danger', onclick: del }, h('div', { class: 'grow t' }, 'Delete gym'), '›')),
    ], { back: '#/gyms' });
  };

  /* ---------------- reminders to gyms + renewal payments to confirm ---------------- */
  const REASON = { trial_ending: ['Trial ending', 'waiting'], plan_ending: ['Plan ending', 'expiring'], grace: ['Ended · grace', 'expiring'], expired: ['Expired', 'expired'], not_setup: ['Not set up', 'archived'] };
  function reminderText(g) {
    const first = g.owner_name ? ' ' + g.owner_name.split(' ')[0] : '';
    const st = S.settings || {};
    const price = fmtMoney(st.price_month || 800) + '/month ya ' + fmtMoney(st.price_year || 4999) + '/year';
    const how = 'App me More → App plan kholiye, wahan UPI se 1 minute me renew ho jayega.';
    const sign = '\n- ' + (CFG.site || 'Team');
    const ends = fmtDate(g.sub.ends);
    switch (g.reason) {
      case 'trial_ending': return 'Namaste' + first + ' ji! ' + g.name + ' app ka free trial ' + ends + ' ko khatam ho raha hai. Aage chalane ke liye ' + price + '. ' + how + sign;
      case 'plan_ending': return 'Namaste' + first + ' ji! ' + g.name + ' app ka plan ' + ends + ' ko khatam ho raha hai. ' + how + sign;
      case 'grace': return 'Namaste' + first + ' ji! ' + g.name + ' app ka plan ' + ends + ' ko khatam ho gaya. Kuch hi din me app aapke aur members ke liye band ho jayega. ' + how + sign;
      case 'expired': return 'Namaste' + first + ' ji! ' + g.name + ' app abhi band hai. Aapka saara data safe hai. Renew karte hi turant chalu ho jayega: ' + price + '. Reply kijiye, main help kar deta hoon.' + sign;
      default: return 'Namaste' + first + ' ji! ' + g.name + ' ka app abhi setup nahi hua hai. Setup me 5 minute lagte hain. Kya main abhi call karke help kar doon?' + sign;
    }
  }
  routes.remind = async () => {
    loading('Reminders');
    const d = await api('reminders');
    const reqCard = r => {
      const ok = h('button', { class: 'btn sm good' }, 'Confirm ' + fmtMoney(r.amount));
      const no = h('button', { class: 'btn sm ghost' }, 'Not received');
      ok.addEventListener('click', busy(ok, async () => { const x = await api('request_decide', { id: r.id, confirm: true }); toast(r.gym_name + ' renewed till ' + fmtDate(x.period_to)); routes.remind(); }));
      no.addEventListener('click', busy(no, async () => { if (!confirm('Mark this payment as not received? The owner can send it again.')) return; await api('request_decide', { id: r.id, confirm: false }); toast('Marked as not received'); routes.remind(); }));
      return h('div', { class: 'card due' }, h('div', { class: 'row between' }, h('b', null, r.gym_name), h('b', null, fmtMoney(r.amount))),
        h('div', { class: 'small muted' }, (r.plan === 'yearly' ? 'Yearly' : 'Monthly') + ' · sent ' + fmtDate(r.at) + (r.utr ? ' · UTR ' + r.utr : '') + (r.by ? ' · ' + r.by : '')),
        h('div', { class: 'small' }, 'Check your UPI app for this payment first.'), h('div', { class: 'btns' }, ok, no));
    };
    const gymRow = g => {
      const rs = REASON[g.reason] || [g.reason, ''];
      if (g.autopay && ['active', 'authenticated'].includes(g.autopay.status) && ['trial_ending', 'plan_ending'].includes(g.reason)) {
        return h('div', { class: 'card' }, h('div', { class: 'row between' }, h('a', { href: '#/gym/' + g.id }, h('b', null, g.name)), h('span', { class: 'badge active' }, 'Auto-pay on')),
          h('div', { class: 'small' }, stateLine(g) + '. Razorpay will charge automatically, no reminder needed.'));
      }
      const send = g.owner_phone ? h('a', { class: 'btn sm wa', href: waLink(g.owner_phone, reminderText(g)), target: '_blank', rel: 'noopener' }, g.reminded_today ? 'Send again' : 'Send') : h('a', { class: 'btn sm ghost', href: '#/gym/' + g.id }, 'Add phone');
      send.addEventListener('click', () => { if (g.owner_phone) api('reminded', { id: g.id, kind: g.reason }).then(() => setTimeout(routes.remind, 800)).catch(() => {}); });
      return h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('a', { href: '#/gym/' + g.id }, h('b', null, g.name)), h('span', { class: 'badge ' + rs[1] }, rs[0])),
        h('div', { class: 'small' }, stateLine(g)),
        h('div', { class: 'row between' }, h('span', { class: 'small muted' }, g.reminded_today ? '✓ Reminded today' : g.last_reminded ? 'Last reminded ' + fmtDate(g.last_reminded) : 'Not reminded yet'), send));
    };
    frame('Reminders', [
      d.requests.length ? [h('div', { class: 'section' }, 'Payments to confirm'), d.requests.map(reqCard)] : null,
      h('div', { class: 'section' }, 'Gyms to remind'),
      h('p', { class: 'muted small' }, 'Gyms whose trial or plan ends within ' + d.remind_days + ' days, recently expired gyms, and gyms not set up yet. Their owners also see a renewal pop-up in their app every day. Tap Send: WhatsApp opens with the message ready.'),
      d.gyms.length ? d.gyms.map(gymRow) : h('div', { class: 'empty' }, 'No reminders due. Every gym is paid up.'),
    ]);
  };

  /* ---------------- leads from the website ---------------- */
  routes.leads = async (tab) => {
    tab = tab || 'open';
    loading('Leads');
    const d = await api('leads', { status: tab });
    const ST = [['new', 'New'], ['contacted', 'Contacted'], ['demo', 'Demo done'], ['won', 'Signed up'], ['lost', 'Not interested']];
    const card = l => {
      const sel = h('select', null, ST.map(([v, t]) => h('option', { value: v, selected: l.status === v }, t)));
      const notes = h('input', { value: l.notes || '', placeholder: 'Notes', maxlength: 500 });
      const save = h('button', { class: 'btn sm ghost' }, 'Save');
      save.addEventListener('click', busy(save, async () => { await api('lead_update', { id: l.id, status: sel.value, notes: notes.value }); toast('Saved'); }));
      const msg = 'Namaste ' + l.name.split(' ')[0] + ' ji! ' + (CFG.site || '') + ' se bol raha hoon. Aapne gym app ke demo ke liye request ki thi. Kab 10 minute ka demo dikha doon?';
      return h('div', { class: 'card' + (l.status === 'new' ? ' due' : '') },
        h('div', { class: 'row between' }, h('div', null, h('b', null, l.name), h('div', { class: 'muted small' }, (l.gym_name || 'Gym not given') + (l.city ? ' · ' + l.city : '') + ' · ' + fmtDate(l.created_at))),
          h('a', { class: 'btn sm wa', href: waLink(l.phone, msg), target: '_blank', rel: 'noopener' }, 'WhatsApp')),
        h('div', { class: 'small' }, '+91 ' + shortPhone(l.phone)),
        l.message ? h('div', { class: 'small muted' }, '“' + l.message + '”') : null,
        h('div', { class: 'row' }, sel, h('div', { class: 'grow' }, notes), save),
        h('div', { class: 'btns' }, h('button', { class: 'btn sm', onclick: () => { S.prefill = { name: l.gym_name || '', owner_name: l.name, phone: l.phone, city: l.city || 'Kanpur', notes: 'From website lead #' + l.id }; location.hash = '#/new'; } }, 'Create their gym app')));
    };
    frame('Leads', [
      h('p', { class: 'muted small' }, 'Demo requests from the landing page.'),
      h('div', { class: 'seg' }, [['open', 'Open'], ['won', 'Signed up'], ['lost', 'Lost'], ['all', 'All']].map(([k, l]) => h('button', { class: k === tab ? 'on' : '', onclick: () => { location.hash = '#/leads/' + k; } }, l))),
      d.leads.length ? d.leads.map(card) : h('div', { class: 'empty' }, 'No leads here yet.'),
    ]);
  };

  /* ---------------- money ---------------- */
  routes.money = async () => {
    loading('Money');
    const [ov, d] = await Promise.all([api('overview'), api('payments')]);
    frame('Money', [
      h('div', { class: 'hero' }, h('div', { class: 'hello' }, 'Collected this month'), h('div', { class: 'big-money gradtext' }, fmtMoney(ov.collected_month)),
        h('div', { class: 'statrow' }, h('div', { class: 'stat' }, h('b', null, fmtMoney(ov.mrr)), h('span', null, 'Monthly recurring')),
          h('div', { class: 'stat' }, h('b', null, fmtMoney(ov.collected_total)), h('span', null, 'All time')))),
      h('div', { class: 'section' }, 'Payments received'),
      d.payments.length ? h('div', { class: 'list' }, d.payments.map(p => h('a', { class: 'item', href: p.gym_id ? '#/gym/' + p.gym_id : '#/money' }, h('div', { class: 'grow' },
        h('div', { class: 't' }, fmtMoney(p.amount) + ' · ' + p.gym_name), h('div', { class: 's' }, fmtDate(p.paid_on) + ' · ' + (p.plan === 'yearly' ? 'Yearly' : 'Monthly') + ' · till ' + fmtDate(p.period_to))), '›')))
        : h('div', { class: 'empty' }, 'No payments yet. Record one from a gym page.'),
    ]);
  };

  /* ---------------- settings ---------------- */
  routes.settings = async () => {
    loading('Settings');
    const st = S.settings = await api('settings', {});
    const form = h('form', { class: 'card' },
      field('Your WhatsApp number (shown on the website and lock screens)', h('input', { name: 'whatsapp', inputmode: 'tel', value: st.whatsapp ? shortPhone(st.whatsapp) : '' })),
      h('div', { class: 'row' }, h('label', { class: 'f grow' }, 'Price per month (₹)', h('input', { name: 'price_month', inputmode: 'numeric', value: st.price_month })),
        h('label', { class: 'f grow' }, 'Price per year (₹)', h('input', { name: 'price_year', inputmode: 'numeric', value: st.price_year }))),
      h('div', { class: 'row' }, h('label', { class: 'f grow' }, 'Free trial (days)', h('input', { name: 'trial_days', inputmode: 'numeric', value: st.trial_days })),
        h('label', { class: 'f grow' }, 'Grace after expiry (days)', h('input', { name: 'grace_days', inputmode: 'numeric', value: st.grace_days }))),
      field('Your UPI ID (gym owners pay renewals to this)', h('input', { name: 'upi_id', value: st.upi_id || '', placeholder: 'yourname@okaxis', autocapitalize: 'off' })),
      field('Name shown on UPI', h('input', { name: 'upi_name', value: st.upi_name || '', maxlength: 60 })),
      field('Start reminding gyms this many days before the plan ends', h('input', { name: 'remind_days', inputmode: 'numeric', value: st.remind_days || 2 })),
      field('Notice to all gym owners (shown on their dashboard, leave empty for none)', h('textarea', { name: 'notice', maxlength: 300 }, st.notice || '')),
      field('Demo gym web name (used for "See demo" on the website)', h('input', { name: 'demo_slug', value: st.demo_slug || '', autocapitalize: 'off' })),
      field('Razorpay auto-pay for gym owners', h('select', { name: 'autopay' }, h('option', { value: 'off', selected: st.autopay !== 'on' }, 'Off (UPI QR only)'), h('option', { value: 'on', selected: st.autopay === 'on' }, 'On'))),
      field('Gym app addresses', h('select', { name: 'url_style' }, h('option', { value: 'subdomain', selected: st.url_style !== 'path' }, 'gymname.' + (st.base_domain || 'domain')),
        h('option', { value: 'path', selected: st.url_style === 'path' }, (st.base_domain || 'domain') + '/g/gymname'))),
      h('button', { class: 'btn block', type: 'submit' }, 'Save settings'));
    form.addEventListener('submit', busy(form.querySelector('button'), async () => { S.settings = await api('settings', formData(form)); toast('Settings saved'); }));
    const pw = h('input', { type: 'password', minlength: 10, autocomplete: 'new-password', placeholder: 'New password (10+ characters)' });
    const pwBtn = h('button', { class: 'btn ghost' }, 'Change password');
    pwBtn.addEventListener('click', busy(pwBtn, async () => {
      if (pw.value.length < 10) throw new Error('Password must be at least 10 characters');
      const { error } = await sb.auth.updateUser({ password: pw.value }); if (error) throw new Error(error.message);
      pw.value = ''; toast('Password changed');
    }));
    const everywhere = h('button', { class: 'btn ghost' }, 'Log out on all devices');
    everywhere.addEventListener('click', busy(everywhere, async () => {
      if (!confirm('Log out of the admin panel on every phone and computer, including this one?')) return;
      await sb.auth.signOut({ scope: 'global' }); location.hash = '#/'; boot();
    }));
    frame('Settings', [form,
      h('div', { class: 'section' }, 'Security'),
      h('div', { class: 'card' }, h('div', { class: 'small muted' }, 'Logged in as ' + S.me.email + '. The panel logs out by itself after 12 hours without use.'),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, pw), pwBtn), h('div', { class: 'btns' }, everywhere, h('a', { class: 'btn ghost', href: '#/audit' }, 'Activity log'))),
      h('div', { class: 'section' }, 'Export'),
      h('div', { class: 'btns' }, h('button', { class: 'btn ghost', onclick: () => exportCsv('gyms').catch(showErr) }, 'Gyms (CSV)'), h('button', { class: 'btn ghost', onclick: () => exportCsv('payments').catch(showErr) }, 'Payments (CSV)')),
      h('button', { class: 'btn ghost block', onclick: logout }, 'Log out')]);
  };

  /* ---------------- activity log + export ---------------- */
  const ACTIONS = { bootstrap: 'Became admin', gym_create: 'Created gym', gym_update: 'Edited gym', gym_code: 'New setup code', gym_payment: 'Recorded payment',
    gym_trial: 'Extended trial', gym_status: 'Paused / resumed gym', gym_delete: 'Deleted gym', lead_update: 'Updated lead', lead_delete: 'Deleted lead',
    request_decide: 'Renewal payment checked', settings: 'Changed settings' };
  routes.audit = async () => {
    loading('Activity log');
    const d = await api('audit');
    frame('Activity log', [h('p', { class: 'muted small' }, 'Every change made in this admin panel, newest first.'),
      d.audit.length ? h('div', { class: 'list' }, d.audit.map(a => h('div', { class: 'item' }, h('div', { class: 'grow' },
        h('div', { class: 't' }, (ACTIONS[a.action] || a.action) + (a.detail && a.detail.gym ? ' · ' + a.detail.gym : '')),
        h('div', { class: 's' }, fmtDate(a.at) + ' ' + String(a.at).slice(11, 16) + ' · ' + (a.email || ''))))))
        : h('div', { class: 'empty' }, 'Nothing yet.')], { back: '#/settings' });
  };
  async function exportCsv(kind) {
    const esc = v => { v = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    let rows;
    if (kind === 'gyms') {
      const d = await api('overview');
      rows = [['Gym', 'Web name', 'City', 'Owner', 'Owner phone', 'Status', 'Plan', 'Trial ends', 'Paid until', 'Members', 'Set up on', 'Created']]
        .concat(d.gyms.map(g => [g.name, g.slug, g.city, g.owner_name, g.owner_phone, g.sub.state, g.plan, g.trial_ends, g.paid_until, g.members, g.claimed_at, g.created_at]));
    } else {
      const d = await api('payments');
      rows = [['Paid on', 'Gym', 'Web name', 'Plan', 'Amount', 'Mode', 'Valid till', 'Note']].concat(d.payments.map(p => [p.paid_on, p.gym_name, p.gym_slug, p.plan, p.amount, p.mode, p.period_to, p.note]));
    }
    const blob = new Blob(['\ufeff' + rows.map(r => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = h('a', { href: URL.createObjectURL(blob), download: (CFG.site || 'export') + '-' + kind + '-' + todayISO() + '.csv' });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------------- start ---------------- */
  if (sb) sb.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') { S.recovery = true; boot(); } });
  boot();
})();
