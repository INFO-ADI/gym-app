/* Gym Manager - single page app. No innerHTML with user data anywhere: all text goes through textContent. */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Basics
   * ------------------------------------------------------------------ */
  const CFG = window.GYM_CONFIG || {};
  const sb = window.supabase && CFG.url && CFG.key
    ? window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'gym-auth-' + (CFG.slug || 'x') } })
    : null;
  // One web address hosts many gyms, so the member login is stored per gym.
  const TOKEN_KEY = 'gym_member_token_' + (/^[a-z0-9-]{2,40}$/.test(CFG.slug || '') ? CFG.slug : 'default');
  function loadToken() {
    try {
      let t = localStorage.getItem(TOKEN_KEY);
      if (!t && CFG.legacyToken) {          // the first gym used one shared key before; move it over once
        t = localStorage.getItem('gym_member_token');
        if (t) { localStorage.setItem(TOKEN_KEY, t); localStorage.removeItem('gym_member_token'); }
      }
      return t || null;
    } catch (e) { return null; }
  }
  const S = { info: null, me: null, gym: 'Gym', cart: {}, cache: {}, token: loadToken(), recovery: /type=recovery/.test(location.hash) };
  function saveToken(t) {
    S.token = t || null;
    try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* private mode: keep in memory */ }
  }
  const photoUrl = name => (name && /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]\/[a-f0-9-]{36}\.jpg$/.test(name)) ? CFG.url + '/storage/v1/object/public/products/' + name : null;
  /** This gym's logo (uploaded by the platform admin), or the default icon. */
  function brandIcon(size) {
    const b = S.info && S.info.gym && S.info.gym.brand;
    if (b && b.logo_version > 0) return CFG.url + '/storage/v1/object/public/brand/' + b.slug + '/v' + b.logo_version + '/icon-' + size + '.png';
    return '/assets/icons/icon-' + size + '.png';
  }
  const $app = document.getElementById('app');
  function getTheme() { try { return localStorage.getItem('gym_theme') || 'dark'; } catch (e) { return 'dark'; } }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.setAttribute('content', t === 'light' ? '#f4f5f9' : '#0a0b0f');
    try { localStorage.setItem('gym_theme', t); } catch (e) { /* ignore */ }
  }
  applyTheme(getTheme());
  function themeRow() {
    const sw = h('input', { type: 'checkbox', checked: getTheme() === 'light' });
    sw.addEventListener('change', () => applyTheme(sw.checked ? 'light' : 'dark'));
    return h('label', { class: 'item switch' }, h('div', { class: 'ico' }, icon('sun')), h('div', { class: 'grow' }, h('div', { class: 't' }, 'Light mode'), h('div', { class: 's' }, 'Easier to read in bright daylight')), sw);
  }
  const APP_URL = CFG.base || (location.origin + location.pathname.replace(/index\.html$/, ''));

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    users: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM3 21c1-4 5-6 9-6s8 2 9 6',
    bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
    rupee: 'M6 4h12M6 9h12M6 4c6 0 8 2 8 5s-3 5-8 5l9 7',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    cart: 'M3 4h2l2.4 11h11l2-8H6.3M9 20a1 1 0 1 0 0-.1M18 20a1 1 0 1 0 0-.1',
    clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    user: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21c1-4 4-6 8-6s7 2 8 6',
    card: 'M3 6h18v12H3zM3 10h18',
    chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
    fire: 'M12 22c4.4 0 7-2.9 7-6.6 0-3.1-2-5.6-3.6-7.4.1 1.8-.6 3.1-1.8 3.6C13.8 8.1 12.4 5 9.5 2c.4 3.3-1.6 5.6-3 7.4C5.4 10.9 5 12.4 5 14.4 5 19.1 7.6 22 12 22z',
    qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4h-4',
    chat: 'M4 4h16v12H8l-4 4z',
    wallet: 'M3 7h18v13H3zM16 14h.01M3 7l3-4h12l3 4',
    idcard: 'M3 5h18v14H3zM7 10h4M7 14h6M15 9h3v4h-3z',
    sun: 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
    gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
    mega: 'M3 10v4h4l7 5V5L7 10zM18 9a4 4 0 0 1 0 6',
    tag: 'M3 3h8l10 10-8 8L3 11zM7.5 7.5h.01',
    upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
    report: 'M6 3h9l4 4v14H6zM9 12h6M9 16h6M9 8h3',
    scan: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M7 12h10',
    leaf: 'M5 19c0-8 6-14 15-14-1 9-7 15-15 14zM5 19l7-7',
    gift: 'M3 9h18v4H3zM5 13h14v8H5zM12 9v12M12 9c-2-4-6-4-6-1s4 1 6 1c2 0 6 2 6-1s-4-3-6 1',
    snow: 'M12 2v20M4 6l16 12M20 6L4 18M9 4l3 2 3-2M9 20l3-2 3 2',
    users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M2 21v-1a6 6 0 0 1 12 0v1M16 3a4 4 0 0 1 0 8M22 21v-1a6 6 0 0 0-4-5.6',
  };
  function icon(name) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', name === 'more' ? '3.2' : '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', ICONS[name]); s.append(p);
    return s;
  }

  const fmtMoney = n => { const v = Number(n || 0); return (v < 0 ? '−₹' : '₹') + Math.abs(v).toLocaleString('en-IN'); };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = String(iso).slice(0, 10).split('-');
    return Number(d[2]) + ' ' + MONTHS[Number(d[1]) - 1] + ' ' + d[0];
  }
  function fmtDateTime(s) { return s ? fmtDate(s) + ', ' + String(s).slice(11, 16) : '—'; }
  function todayISO() {
    const d = new Date(Date.now() + 330 * 60000); // India time
    return d.toISOString().slice(0, 10);
  }
  const shortPhone = p => String(p || '').replace(/^91/, '');
  const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

  const ERR = {
    wrong_login: 'Wrong login details.', too_many_attempts: 'Too many wrong tries. Wait 15 minutes and try again.',
    account_inactive: 'This account is not active. Please contact the gym.', login_required: 'Please log in again.',
    bad_checkin_code: 'That code is not right. Scan the poster at the front desk again.', membership_expired: 'Your membership has ended. Renew to check in.', membership_frozen: 'Your membership is paused. Ask the gym to unfreeze it.', bad_weight: 'Enter your weight in kg, e.g. 72.5',
    category_required: 'Enter a category, e.g. Rent.',
    batch_full: 'This batch is full. Pick another batch or raise its capacity.', bad_batch: 'That batch no longer exists.', bad_time: 'Enter a valid time.', bad_capacity: 'Capacity must be 0–1000 (0 = no limit).',
    bad_coupon: 'That coupon code is not valid.', coupon_expired: 'This coupon has expired.', coupon_used_up: 'This coupon has been fully used.', coupon_already_used: 'You have already used this coupon.',
    coupon_joining_only: 'This coupon is only for new joinings.', coupon_renewal_only: 'This coupon is only for renewals.', bad_coupon_code: 'Code must be 3–20 letters or numbers, no spaces.',
    bad_percent: 'Percent discount can be at most 90%.', coupon_exists: 'A coupon with this code already exists.',
    freeze_limit: 'That is more than the freeze days left for this year.', freeze_min_days: 'Freeze must be at least 3 days.', bad_days: 'Enter a valid number of days.', not_active: 'Only an active membership can be paused.',
    pt_expired: 'This training package has expired.', pt_no_sessions: 'No sessions left in this package.', pt_not_active: 'This package is finished or cancelled.', nothing_to_undo: 'No session to undo.',
    bad_sessions: 'Sessions must be between 1 and 200.', bad_trainer: 'Pick a trainer from the list.', bad_ref_code: 'No member found with that code.', diet_required: 'Write the diet plan.',
    not_configured: 'The app is not connected to its database yet (config.js).', wrong_setup_key: 'Wrong setup key.', bad_photo: 'Photo could not be saved.', bad_phone: 'Enter a valid 10-digit mobile number.', phone_exists: 'A member with this phone already exists.',
    name_required: 'Please enter a name.', bad_plan: 'Please choose a plan.', already_waiting: 'A payment is already waiting for the owner to confirm.',
    already_decided: 'This payment was already handled.', out_of_stock: 'Sorry, not enough stock for one of the items.',
    product_unavailable: 'One of the products is no longer available.', order_not_open: 'This order is no longer open.',
    pin_must_be_6_digits: 'PIN must be exactly 6 digits.', pin_too_simple: 'That PIN is too easy to guess. Pick another.',
    wrong_old_pin: 'Current PIN is wrong.', pin_same: 'New PIN must be different.', password_too_short: 'Password must be at least 10 characters.',
    wrong_old_password: 'Current password is wrong.', bad_upi: 'UPI ID looks wrong (example: name@okaxis).', bad_link: 'Map link must start with https://',
    photo_too_big: 'Photo is too big (max 4 MB).', not_an_image: 'Please choose a JPG, PNG or WebP photo.', bad_utr: 'UPI reference should be letters and numbers only.',
    too_many_open_orders: 'You already have 3 open orders. Wait for them to be completed.', payment_waiting: 'A payment for this is waiting for confirmation.',
    not_paid_yet: 'Order is not paid yet.', only_unpaid_can_cancel: 'Only unpaid orders can be cancelled.', pin_change_required: 'Please set your own PIN first.',
    bad_date: 'Please enter a valid date.', bad_amount: 'Please enter a valid amount.', server_error: 'Something went wrong on the server. Try again.',
    pin_mismatch: 'The two new PINs do not match.',
    not_installed: 'This gym app is not set up yet.', network: 'No internet connection.',
    gym_not_found: 'This gym was not found. Check the link.', subscription_expired: 'This gym app is paused. Please contact the gym.', autopay_not_ready: 'Auto-pay is not available yet. Use UPI below.', autopay_already_on: 'Auto-pay is already on.', razorpay_error: 'Razorpay could not start auto-pay. Try again in a minute.', verify_failed: 'Could not confirm auto-pay. Check again in a minute.',
  };
  const errText = e => ERR[e] || (String(e || '').startsWith('missing_column_') ? 'CSV is missing the column: ' + e.slice(15) : 'Error: ' + e);

  async function api(action, opts) {
    opts = opts || {};
    if (!sb) throw new Error('not_configured');
    const p_in = Object.assign({}, opts.query || {}, opts.body || {});
    let res;
    try { res = await sb.rpc('gym_api', { p_gym: CFG.slug || '', p_action: action, p_in, p_token: S.token }); } catch (e) { throw new Error('network'); }
    if (res.error) throw new Error(/fetch|network|Failed/i.test(res.error.message || '') ? 'network' : 'server_error');
    const json = res.data;
    if (!json || !json.ok) {
      const e = json ? json.error : 'server_error';
      if (e === 'login_required' && action !== 'info') { saveToken(null); S.me = null; await boot(); }
      if (e === 'pin_change_required') { location.hash = '#/pin'; }
      if (e === 'subscription_expired' && action !== 'info') { setTimeout(boot, 50); }
      throw new Error(e);
    }
    if (json.data && json.data.token) saveToken(json.data.token);
    return json.data;
  }

  let toastTimer;
  function toast(msg, isErr) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 3200);
  }
  const showErr = e => toast(errText(e && e.message ? e.message : e), true);

  /** Run an async action from a button, disabling it meanwhile so it can't be double-tapped. */
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
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    d.showModal();
    return d;
  }
  function confirmBox(title, text, okLabel, danger) {
    return new Promise(resolve => {
      let d;
      const ok = h('button', { class: 'btn ' + (danger ? 'bad' : ''), onclick: () => { resolve(true); d.close(); } }, okLabel || 'Yes');
      const no = h('button', { class: 'btn ghost', onclick: () => { resolve(false); d.close(); } }, 'Cancel');
      d = modal(title, h('p', null, text), [no, ok]);
      d.addEventListener('cancel', () => resolve(false));
    });
  }

  function field(label, input) { return h('label', { class: 'f' }, label, input); }
  function formData(form) {
    const o = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') o[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
      else o[el.name] = el.value;
    }
    return o;
  }

  function waLink(phone, text) {
    const p = String(phone || '').replace(/\D/g, '');
    return 'https://wa.me/' + p + (text ? '?text=' + encodeURIComponent(text) : '');
  }
  function upiLink(upi, amount, note) {
    // the UPI ID is validated on the server (letters, digits, . _ - and one @), so it is safe to use as-is;
    // several UPI apps fail if the @ is percent-encoded
    const pa = String(upi.id).replace(/[^A-Za-z0-9.@_-]/g, '');
    return 'upi://pay?pa=' + pa + '&pn=' + encodeURIComponent(upi.name || S.gym) + '&am=' + Number(amount).toFixed(2) +
      '&cu=INR&tn=' + encodeURIComponent(note.slice(0, 50));
  }
  function qrImage(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return h('img', { src: qr.createDataURL(6, 2), alt: 'UPI QR code' });
  }
  function fill(tpl, vars) { return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)); }
  function safeHttps(url) { return /^https:\/\//i.test(url || '') ? url : null; }

  function badge(status) {
    const label = { active: 'Active', expiring: 'Expiring', expired: 'Expired', frozen: 'Frozen', archived: 'Left', waiting: 'Waiting', confirmed: 'Confirmed', rejected: 'Rejected',
      new: 'New', paid: 'Paid', handed: 'Handed over', cancelled: 'Cancelled' }[status] || status;
    const cls = { confirmed: 'active', paid: 'active', handed: 'archived', cancelled: 'archived', rejected: 'expired', new: 'waiting' }[status] || status;
    return h('span', { class: 'badge ' + cls }, label);
  }

  function daysText(n) {
    if (n === 0) return 'Ends today';
    if (n === 1) return 'Ends tomorrow';
    if (n > 0) return n + ' days left';
    if (n === -1) return 'Ended yesterday';
    return 'Ended ' + (-n) + ' days ago';
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/csv' });
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ------------------------------------------------------------------ *
   * Page frame & router
   * ------------------------------------------------------------------ */
  const OWNER_NAV = [['#/home', 'Home', 'home'], ['#/members', 'Members', 'users'], ['#/reminders', 'Remind', 'bell'], ['#/payments', 'Payments', 'rupee'], ['#/more', 'More', 'more']];
  const MEMBER_NAV = [['#/home', 'Home', 'home'], ['#/progress', 'Progress', 'fire'], ['#/renew', 'Renew', 'card'], ['#/shop', 'Shop', 'cart'], ['#/profile', 'Profile', 'user']];
  let badges = {};

  function frame(title, content, opts) {
    opts = opts || {};
    const nav = S.me.role === 'owner' ? OWNER_NAV : MEMBER_NAV;
    const cur = '#/' + (location.hash.slice(2).split('/')[0] || 'home');
    const top = h('header', { class: 'top' },
      opts.back ? h('button', { class: 'back', 'aria-label': 'Back', onclick: () => history.length > 1 ? history.back() : (location.hash = opts.back) }, '‹') : null,
      h('h1', null, opts.sub !== false ? h('span', { class: 'gymname' }, S.gym) : null, title),
      opts.action || null);
    const navEl = h('nav', { class: 'nav' }, nav.map(([href, label, ic]) =>
      h('a', { href, class: href === cur ? 'on' : '' }, icon(ic), label, badges[href] ? h('span', { class: 'dot' }, badges[href]) : null)));
    $app.className = '';
    $app.replaceChildren(top, h('main', { class: 'page' }, content), navEl);
    window.scrollTo(0, 0);
  }
  function loading(title) { frame(title, [h('div', { class: 'sk sk-hero' }), h('div', { class: 'sk-row' }, h('div', { class: 'sk' }), h('div', { class: 'sk' })), h('div', { class: 'sk sk-line' }), h('div', { class: 'sk sk-line' }), h('div', { class: 'sk sk-line short' })]); }

  /* ---------- little visual components (all SVG built with DOM calls) ---------- */
  function svg(tag, attrs, kids) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs || {}) el.setAttribute(k, attrs[k]);
    (kids || []).forEach(k => el.append(k));
    return el;
  }
  let gradSeq = 0;
  /** This gym's brand colours, read from the CSS variables set by assets/theme.css. */
  const DEFAULT_COLORS = { a1: '#ffb300', a2: '#ff6a00', a3: '#ff2e63', accent: '#ff8a00' };
  function brand(name) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
      if (/^#[0-9a-f]{3,8}$|^rgba?\(/i.test(v)) return v;
    } catch (e) { /* fall through */ }
    return DEFAULT_COLORS[name];
  }
  function gradDef(id) {
    return svg('defs', {}, [svg('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' }, [
      svg('stop', { offset: '0', 'stop-color': brand('a1') }), svg('stop', { offset: '.55', 'stop-color': brand('a2') }), svg('stop', { offset: '1', 'stop-color': brand('a3') })])]);
  }
  /** Progress ring. pct 0..1 */
  function ring(pct, size, color) {
    const r = 54, c = 2 * Math.PI * r, id = 'rg' + (++gradSeq);
    const fg = svg('circle', { cx: 64, cy: 64, r, fill: 'none', stroke: color || 'url(#' + id + ')', 'stroke-width': 12, 'stroke-linecap': 'round',
      'stroke-dasharray': c.toFixed(1), 'stroke-dashoffset': c.toFixed(1), transform: 'rotate(-90 64 64)' });
    const el = svg('svg', { viewBox: '0 0 128 128', width: size || 132, height: size || 132, class: 'ring' }, [gradDef(id),
      svg('circle', { cx: 64, cy: 64, r, fill: 'none', stroke: 'rgba(255,255,255,.08)', 'stroke-width': 12 }), fg]);
    requestAnimationFrame(() => requestAnimationFrame(() => fg.setAttribute('stroke-dashoffset', (c * (1 - Math.max(0, Math.min(1, pct)))).toFixed(1))));
    return el;
  }
  /** Bar chart. rows: [{label, values:[..]}], colors per series */
  function barChart(rows, colors, opts) {
    opts = opts || {};
    const W = 340, H = opts.h || 150, pad = 18, n = rows.length, gap = n > 10 ? 3 : 8;
    const max = Math.max(1, ...rows.map(r => r.values.reduce((a, b) => a + b, 0)));
    const bw = (W - (n - 1) * gap) / n, id = 'bg' + (++gradSeq);
    if (opts.grouped) return groupedChart(rows, colors, opts, W, H, pad, gap, bw, id);
    const kids = [gradDef(id)];
    rows.forEach((r, i) => {
      let y = H - pad;
      r.values.forEach((v, k) => {
        const hgt = (H - pad - 14) * v / max;
        if (hgt > 0) kids.push(svg('rect', { x: (i * (bw + gap)).toFixed(1), y: (y - hgt).toFixed(1), width: bw.toFixed(1), height: hgt.toFixed(1), rx: Math.min(6, bw / 3),
          fill: colors[k] === 'grad' ? 'url(#' + id + ')' : colors[k] }));
        y -= hgt;
      });
      const total = r.values.reduce((a, b) => a + b, 0);
      if (opts.top && total) { const t = svg('text', { x: (i * (bw + gap) + bw / 2).toFixed(1), y: (y - 4).toFixed(1), 'text-anchor': 'middle' }); t.textContent = opts.top(total); kids.push(t); }
      if (r.label && (n <= 8 || i % 2 === n % 2 - 1 || i === n - 1)) { const t = svg('text', { x: (i * (bw + gap) + bw / 2).toFixed(1), y: H - 3, 'text-anchor': 'middle' }); t.textContent = r.label; kids.push(t); }
    });
    return svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img' }, kids);
  }
  function groupedChart(rows, colors, opts, W, H, pad, gap, bw, id) {
    const max = Math.max(1, ...rows.flatMap(r => r.values));
    const k = rows[0].values.length, sub = (bw - 3 * (k - 1)) / k, kids = [gradDef(id)];
    rows.forEach((r, i) => {
      r.values.forEach((v, j) => {
        const hgt = (H - pad - 14) * Math.max(0, v) / max;
        if (hgt > 0) kids.push(svg('rect', { x: (i * (bw + gap) + j * (sub + 3)).toFixed(1), y: (H - pad - hgt).toFixed(1), width: sub.toFixed(1), height: hgt.toFixed(1), rx: Math.min(5, sub / 3), fill: colors[j] === 'grad' ? 'url(#' + id + ')' : colors[j] }));
      });
      if (r.label) { const t = svg('text', { x: (i * (bw + gap) + bw / 2).toFixed(1), y: H - 3, 'text-anchor': 'middle' }); t.textContent = r.label; kids.push(t); }
    });
    return svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img' }, kids);
  }
  const kfmt = v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1) + 'k' : String(v);

  /** Line chart for weights. points [{label, v}] */
  function lineChart(points) {
    const W = 340, H = 140, pad = 20, id = 'lg' + (++gradSeq);
    const vs = points.map(p => p.v), lo = Math.min(...vs) - 1, hi = Math.max(...vs) + 1;
    const X = i => pad + (W - 2 * pad) * (points.length === 1 ? .5 : i / (points.length - 1));
    const Y = v => 10 + (H - 34) * (1 - (v - lo) / (hi - lo));
    const d = points.map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join(' ');
    const kids = [gradDef(id), svg('path', { d, fill: 'none', stroke: 'url(#' + id + ')', 'stroke-width': 3.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })];
    points.forEach((p, i) => kids.push(svg('circle', { cx: X(i).toFixed(1), cy: Y(p.v).toFixed(1), r: i === points.length - 1 ? 5 : 3, fill: i === points.length - 1 ? brand('a2') : brand('a1') })));
    [0, points.length - 1].forEach(i => { if (points[i]) { const t = svg('text', { x: X(i).toFixed(1), y: H - 4, 'text-anchor': i ? 'end' : 'start' }); t.textContent = points[i].label; kids.push(t); } });
    const last = points[points.length - 1]; const t = svg('text', { x: X(points.length - 1).toFixed(1), y: (Y(last.v) - 10).toFixed(1), 'text-anchor': 'end' }); t.textContent = last.v + ' kg'; kids.push(t);
    return svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img' }, kids);
  }
  function confetti() {
    const box = h('div', { class: 'confetti' });
    const colors = [brand('a1'), brand('a2'), brand('a3'), '#22d48a', '#4aa8ff', '#ffffff'];
    for (let i = 0; i < 90; i++) {
      const c = h('i');
      c.style.left = (Math.random() * 100) + 'vw';
      c.style.background = colors[i % colors.length];
      c.animate([{ transform: 'translateY(0) rotate(0)', opacity: 1 }, { transform: 'translateY(' + (60 + Math.random() * 50) + 'vh) translateX(' + (Math.random() * 120 - 60) + 'px) rotate(' + (Math.random() * 720) + 'deg)', opacity: 0 }],
        { duration: 1400 + Math.random() * 1200, delay: Math.random() * 250, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
      box.append(c);
    }
    document.body.append(box);
    setTimeout(() => box.remove(), 3000);
  }
  const BADGE_ICON = { first: '👟', week: '🔥', ten: '💪', month12: '📅', early: '🌅', night: '🌙', weekend: '⚡', fifty: '🏅', month30: '🏆' };
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  function workoutIcon(text) { return /rest|recover/i.test(text || '') ? '🧘' : /leg/i.test(text || '') ? '🦵' : /cardio|run/i.test(text || '') ? '🏃' : '🏋️'; }

  const routes = {};
  function route() {
    if (S.stopScan) { S.stopScan(); S.stopScan = null; }
    if (S.recovery) return newPasswordPage();
    const ck = location.hash.match(/^#\/checkin\/([A-Za-z0-9]{4,12})$/);
    if (ck && (!S.me || S.me.role !== 'member')) S.pendingCheckin = ck[1];
    const jn = location.hash.match(/^#\/join(?:\/([A-Za-z0-9-]{4,12}))?$/);
    if (jn && (!S.me || S.me.role !== 'owner')) return joinPage(jn[1] || '');
    if (!S.me) return loginPage();
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    const name = parts[0] || 'home';
    if (S.me.role === 'member' && S.me.pin_must_change && name !== 'pin') { location.hash = '#/pin'; return; }
    const table = S.me.role === 'owner' ? routes.owner : routes.member;
    const fn = table[name] || table.home;
    Promise.resolve(fn(parts[1], parts[2])).catch(showErr);
  }
  window.addEventListener('hashchange', route);

  async function boot() {
    if (S.recovery) return newPasswordPage();
    try {
      const info = await api('info');
      S.info = info;
      applyBrand(info.gym && info.gym.brand);
      if (info.sub && info.sub.locked) return lockedPage(info);
      if (!info.installed) {
        $app.className = 'boot';
        $app.replaceChildren(h('div', { class: 'login center' }, h('img', { class: 'logo', src: brandIcon(192), alt: '' }),
          h('h1', null, 'Almost there'), h('p', { class: 'muted' }, 'This gym app is not set up yet. Gym owner: open the setup link you received on WhatsApp.'),
          h('a', { class: 'btn', href: 'setup' }, 'I have a setup code')));
        return;
      }
      S.me = info.me; S.gym = info.gym.name || 'Gym';
      document.title = S.gym;
      route();
    } catch (e) {
      $app.className = 'boot';
      $app.replaceChildren(h('div', { class: 'login center' }, h('h1', null, 'Can’t open the app'), h('p', { class: 'muted' }, errText(e.message)),
        h('button', { class: 'btn', onclick: boot }, 'Try again')));
    }
  }

  /** Owner-only note when the trial or paid period is about to end. */
  function subBanner() {
    const sub = S.info && S.info.sub;
    const out = [];
    if (S.info && S.info.notice) out.push(h('div', { class: 'card subnote' }, h('div', { class: 'grow' }, h('b', null, 'Message from ' + (CFG.site || 'your app provider')), h('div', { class: 'small' }, S.info.notice))));
    if (!sub || sub.locked) return out;
    const days = (S.info.remind_days || 2);
    let text = null;
    if (sub.state === 'grace') text = 'Your app subscription ended on ' + fmtDate(sub.ends) + '. Renew now so the app doesn’t pause.';
    else if (sub.state === 'trial' && sub.days_left <= Math.max(7, days)) { const n = Math.max(0, sub.days_left); text = 'Free trial: ' + n + (n === 1 ? ' day' : ' days') + ' left (till ' + fmtDate(sub.ends) + ').'; }
    else if (sub.state === 'active' && sub.days_left <= Math.max(5, days)) text = 'Your app plan ends on ' + fmtDate(sub.ends) + '.';
    if (text) out.push(h('div', { class: 'card subnote' + (sub.state === 'grace' ? ' due' : '') }, h('div', { class: 'grow' }, h('b', null, text)),
      h('a', { class: 'btn sm', href: '#/subscription' }, 'Renew')));
    return out;
  }

  /** Once a day, from a few days before the app plan ends, the owner sees a renewal reminder. */
  function renewPopup() {
    const sub = S.info && S.info.sub;
    if (!sub || sub.locked || !S.me || S.me.role !== 'owner') return;
    const days = S.info.remind_days || 2;
    const due = sub.state === 'grace' || (['trial', 'active'].includes(sub.state) && sub.days_left <= days);
    if (!due) return;
    const key = 'kg_renew_seen_' + CFG.slug;
    let today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    try { if (localStorage.getItem(key) === today) return; localStorage.setItem(key, today); } catch (e) { /* private mode: show it anyway */ }
    const n = Math.max(0, sub.days_left);
    const text = sub.state === 'grace' ? 'Your app plan ended on ' + fmtDate(sub.ends) + '. The app will pause for you and your members in a few days unless you renew.'
      : (sub.state === 'trial' ? 'Your free trial ends ' : 'Your app plan ends ') + (n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days') + ' (' + fmtDate(sub.ends) + '). Renew to keep the app running for your members.';
    let d;
    d = modal(sub.state === 'trial' ? 'Free trial ending' : 'Time to renew', h('p', null, text), [
      h('button', { class: 'btn ghost', onclick: () => d.close() }, 'Later'),
      h('a', { class: 'btn', href: '#/subscription', onclick: () => d.close() }, 'Renew now')]);
  }

  /** Razorpay auto-pay: the owner approves UPI AutoPay / card once and is charged every month or year automatically. */
  async function rzpCall(body) {
    const r = await sb.functions.invoke('razorpay', { body: Object.assign({ gym: CFG.slug }, body) });
    if (r.error) throw new Error('network');
    if (!r.data || !r.data.ok) throw new Error((r.data && r.data.error) || 'server_error');
    return r.data;
  }
  function loadCheckout() {
    if (window.Razorpay) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = () => res(); s.onerror = () => rej(new Error('network'));
      document.head.append(s);
    });
  }
  function autopayCard(d, standalone) {
    if (!d.autopay_on) return null;
    const ap = d.autopay;
    const again = () => renewPage(standalone).catch(showErr);
    if (ap && ['active', 'authenticated', 'pending'].includes(ap.status)) {
      const stop = h('button', { class: 'btn sm ghost' }, 'Stop auto-pay');
      stop.addEventListener('click', async () => {
        if (!(await confirmBox('Stop auto-pay?', 'You will then need to renew by hand before your plan ends.', 'Stop auto-pay', true))) return;
        stop.disabled = true;
        try { await rzpCall({ action: 'cancel' }); toast('Auto-pay stopped'); again(); } catch (e) { showErr(e); stop.disabled = false; }
      });
      return h('div', { class: 'card subnote' }, h('div', { class: 'grow' },
        h('b', null, ap.status === 'pending' ? 'Auto-pay: last payment failed, retrying' : '✓ Auto-pay is on'),
        h('div', { class: 'small' }, (ap.plan === 'yearly' ? 'Yearly ' + fmtMoney(d.price_year) : 'Monthly ' + fmtMoney(d.price_month)) +
          ' is charged automatically when your plan ends. Nothing to do.')), stop);
    }
    let plan = 'yearly';
    const pick = h('select', null, h('option', { value: 'yearly' }, 'Yearly · ' + fmtMoney(d.price_year)), h('option', { value: 'monthly' }, 'Monthly · ' + fmtMoney(d.price_month)));
    pick.addEventListener('change', () => { plan = pick.value; });
    const go = h('button', { class: 'btn block' }, 'Turn on auto-pay');
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const [r] = await Promise.all([rzpCall({ action: 'start', plan }), loadCheckout()]);
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#22d48a';
        const rz = new window.Razorpay({
          key: r.key, subscription_id: r.subscription_id, name: CFG.site || 'KanpurGym',
          description: (plan === 'yearly' ? 'Yearly' : 'Monthly') + ' app plan · ' + (S.gym || CFG.name),
          prefill: { email: (S.me && S.me.email) || '' }, theme: { color: accent },
          handler: async resp => {
            try { await rzpCall({ action: 'verify', payment_id: resp.razorpay_payment_id, signature: resp.razorpay_signature }); toast('Auto-pay is on. Thank you!'); }
            catch (e) { toast('Auto-pay set up. It may take a minute to show.'); }
            again();
          },
          modal: { ondismiss: () => { go.disabled = false; } },
        });
        rz.on('payment.failed', () => { toast('Payment did not go through. Try again or use another UPI app.', true); go.disabled = false; });
        rz.open();
      } catch (e) { showErr(e); go.disabled = false; }
    });
    return h('div', { class: 'card' }, h('b', null, 'Auto-pay (recommended)'),
      h('div', { class: 'small muted' }, 'Approve once with UPI AutoPay or card. Your plan renews by itself' +
        (d.sub.state === 'trial' ? ', first charge when your free trial ends on ' + fmtDate(d.sub.ends) : '') + '. Stop any time.'),
      field('Plan', pick), go);
  }

  /** Owner pays the platform by UPI and tells us; the platform admin confirms it. Also used from the lock screen. */
  async function renewPage(standalone) {
    const call = async (action, body) => {
      const r = await sb.rpc('gym_renew', { p_gym: CFG.slug || '', p_action: action, p_in: body || {} });
      if (r.error) throw new Error('network');
      if (!r.data.ok) throw new Error(r.data.error);
      return r.data.data;
    };
    const d = await call('info');
    const s = d.sub;
    const state = s.state === 'trial' ? 'Free trial till ' + fmtDate(s.ends) : s.state === 'active' ? 'Paid till ' + fmtDate(s.ends)
      : s.state === 'grace' ? 'Ended on ' + fmtDate(s.ends) : s.state === 'suspended' ? 'Paused' : 'Ended on ' + fmtDate(s.ends);
    const box = h('div');
    const draw = (plan) => {
      if (d.pending) {
        box.replaceChildren(h('div', { class: 'card subnote' }, h('div', { class: 'grow' }, h('b', null, 'Payment sent for checking'),
          h('div', { class: 'small' }, (d.pending.plan === 'yearly' ? 'Yearly' : 'Monthly') + ' · ' + fmtMoney(d.pending.amount) + ' · sent ' + fmtDate(d.pending.at) + '. Your app will be switched on as soon as it is confirmed, usually within a few hours.'))));
        return;
      }
      const amount = plan === 'yearly' ? d.price_year : d.price_month;
      const save = d.price_month * 12 - d.price_year;
      const pick = (p, title, price, note) => h('button', { class: 'card plan-pick' + (p === plan ? ' on' : ''), onclick: () => draw(p) },
        h('div', { class: 'row between' }, h('b', null, title), h('b', null, fmtMoney(price))), note ? h('div', { class: 'small muted' }, note) : null);
      const utr = h('input', { placeholder: 'UPI reference / UTR number (optional)', maxlength: 40, inputmode: 'numeric' });
      const sent = h('button', { class: 'btn block' }, 'I’ve paid ' + fmtMoney(amount));
      sent.addEventListener('click', async () => {
        sent.disabled = true;
        try { await call('request', { plan, utr: utr.value }); toast('Thanks! We’ll confirm your payment soon.'); return renewPage(standalone); }
        catch (e) { showErr(e); sent.disabled = false; }
      });
      const upi = /@/.test(d.upi_id || '') ? { id: d.upi_id, name: d.upi_name } : null;
      const note = (CFG.site || 'App') + ' ' + CFG.slug + ' ' + plan;
      box.replaceChildren(
        pick('monthly', 'Monthly', d.price_month, null),
        pick('yearly', 'Yearly', d.price_year, save > 0 ? 'Save ' + fmtMoney(save) + ' a year' : null),
        upi ? h('div', { class: 'card center' },
          h('div', { class: 'muted small' }, 'Pay ' + fmtMoney(amount) + ' to ' + d.upi_name + ' (' + d.upi_id + ')'),
          h('a', { class: 'btn block', href: upiLink(upi, amount, note) }, 'Pay with UPI app'),
          h('div', { class: 'qrbox' }, qrImage(upiLink(upi, amount, note))),
          h('div', { class: 'muted small' }, 'Or scan this QR from another phone.')) : null,
        upi ? h('div', { class: 'card' }, h('div', { class: 'small' }, 'After paying, tap the button so we can confirm it.'), utr, sent) : null,
        /^91\d{10}$/.test(d.whatsapp || '') ? h('a', { class: 'btn ghost block wa', href: waLink(d.whatsapp, 'Hi, I want to renew the app for ' + (S.gym || CFG.name) + ' (' + CFG.slug + '), ' + plan + ' plan.'), target: '_blank', rel: 'noopener' }, upi ? 'Questions? WhatsApp us' : 'Renew on WhatsApp') : null);
    };
    draw('yearly');
    const content = [h('div', { class: 'hero' }, h('div', { class: 'hello' }, 'Your app plan'), h('h2', null, state)), autopayCard(d, standalone), box];
    if (standalone) {
      $app.className = 'boot';
      $app.replaceChildren(h('div', { class: 'login' }, h('h1', null, 'Renew your app'), ...content, h('button', { class: 'btn ghost block', onclick: boot }, 'Back')));
    } else frame('App plan', content, { back: '#/more' });
  }

  /** The gym's colours, so charts and buttons match its brand even before theme.css refreshes. */
  function applyBrand(b) {
    if (!b || !b.colors) return;
    const root = document.documentElement.style;
    ['a1', 'a2', 'a3', 'accent'].forEach(k => { if (/^#[0-9a-f]{6}$/i.test(b.colors[k] || '')) root.setProperty('--' + k, b.colors[k]); });
    if (/^#[0-9a-f]{6}$/i.test(b.colors.bg || '') && document.documentElement.getAttribute('data-theme') !== 'light') root.setProperty('--bg', b.colors.bg);
  }

  /** Shown when the gym's subscription has ended or the gym is paused by the platform. */
  function lockedPage(info) {
    $app.className = 'boot';
    const owner = info.me && info.me.role === 'owner';
    const wa = /^91\d{10}$/.test(info.contact || '') ? info.contact : null;
    const name = (info.gym && info.gym.name) || 'This gym';
    $app.replaceChildren(h('div', { class: 'login center' },
      h('img', { class: 'logo', src: brandIcon(192), alt: '' }),
      h('h1', null, owner && info.sub.state !== 'suspended' ? 'Subscription ended' : 'App paused'),
      h('p', { class: 'muted' }, owner && info.sub.state === 'suspended'
        ? 'Your ' + name + ' app is paused. Your data is safe. Message us to switch it back on.'
        : owner
        ? 'Your ' + name + ' app subscription ended on ' + fmtDate(info.sub.ends) + '. Your data is safe. Renew to switch the app back on for you and your members.'
        : name + '’s app is paused right now. Please contact the gym front desk.'),
      owner ? h('button', { class: 'btn block', onclick: () => renewPage(true).catch(showErr) }, 'Renew now') : null,
      owner && wa ? h('a', { class: 'btn ghost wa block', href: waLink(wa, 'Hi, I want to renew the gym app for ' + name + ' (' + (info.gym.brand ? info.gym.brand.slug : '') + ').'), target: '_blank', rel: 'noopener' }, 'WhatsApp us') : null,
      owner ? h('button', { class: 'btn ghost block', onclick: logoutNow }, 'Log out') : null,
      h('button', { class: 'btn ghost block', onclick: boot }, 'Check again')));
  }

  /* ------------------------------------------------------------------ *
   * Login
   * ------------------------------------------------------------------ */
  function loginPage() {
    $app.className = '';
    let mode = 'member';
    const box = h('div');
    const draw = () => {
      const seg = h('div', { class: 'seg' },
        h('button', { class: mode === 'member' ? 'on' : '', onclick: () => { mode = 'member'; draw(); } }, 'Member'),
        h('button', { class: mode === 'owner' ? 'on' : '', onclick: () => { mode = 'owner'; draw(); } }, 'Owner'));
      const btn = h('button', { class: 'btn block', type: 'submit' }, 'Log in');
      const form = mode === 'member'
        ? h('form', null,
          field('Mobile number', h('input', { name: 'phone', inputmode: 'tel', autocomplete: 'tel', required: true, placeholder: '98765 43210', maxlength: 14 })),
          field('6-digit PIN', h('input', { name: 'pin', type: 'password', inputmode: 'numeric', autocomplete: 'current-password', required: true, maxlength: 6, pattern: '\\d{6}' })),
          btn, h('p', { class: 'muted small center' }, 'Forgot your PIN? Ask at the gym front desk.'),
          h('p', { class: 'small center' }, h('a', { href: '#/join' }, 'New here? Ask to join →')))
        : h('form', null,
          field('Email', h('input', { name: 'email', type: 'email', autocomplete: 'username', required: true })),
          field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
          btn, h('p', { class: 'center' }, h('a', { href: '#', onclick: forgotPassword }, 'Forgot password?')));
      form.addEventListener('submit', busy(btn, async () => {
        const d = formData(form);
        if (mode === 'member') {
          const r = await api('login_member', { body: d });
          S.me = r.me; location.hash = S.pendingCheckin ? '#/checkin/' + S.pendingCheckin : '#/home'; S.pendingCheckin = null; route();
          return;
        }
        if (!sb) throw new Error('not_configured');
        saveToken(null);
        const { error } = await sb.auth.signInWithPassword({ email: d.email.trim(), password: d.password });
        if (error) throw new Error(/rate|many/i.test(error.message) ? 'too_many_attempts' : 'wrong_login');
        location.hash = '#/home'; await boot();
      }));
      box.replaceChildren(seg, form);
    };
    draw();
    $app.replaceChildren(h('div', { class: 'login' },
      h('img', { class: 'logo', src: brandIcon(192), alt: '' }),
      h('h1', null, S.gym), h('p', { class: 'muted center' }, 'Members and gym management'),
      h('div', { class: 'card' }, box)));
  }

  function joinPage(ref) {
    $app.className = '';
    const btn = h('button', { class: 'btn block', type: 'submit' }, 'Send my details');
    const form = h('form', null,
      field('Your name', h('input', { name: 'name', required: true, maxlength: 100, autocomplete: 'name' })),
      field('Mobile number', h('input', { name: 'phone', inputmode: 'tel', required: true, autocomplete: 'tel', placeholder: '98765 43210', maxlength: 14 })),
      field('What are you looking for? (optional)', h('input', { name: 'interest', maxlength: 200, placeholder: 'e.g. weight loss, morning batch' })),
      btn, h('p', { class: 'muted small center' }, 'The gym will call or WhatsApp you. Your number is only shared with the gym.'));
    const card = h('div', { class: 'card' }, form);
    form.addEventListener('submit', busy(btn, async () => {
      const d = formData(form); d.ref = ref;
      await api('join_request', { body: d });
      card.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'bigemoji' }, '🎉'), h('h2', null, 'Thanks, ' + d.name.split(' ')[0] + '!'),
        h('p', { class: 'muted' }, S.gym + ' will contact you soon. Come for a free trial session!')));
    }));
    $app.replaceChildren(h('div', { class: 'login' },
      h('img', { class: 'logo', src: brandIcon(192), alt: '' }),
      h('h1', null, 'Join ' + S.gym), h('p', { class: 'muted center' }, ref ? 'Your friend invited you. Leave your number and we’ll get in touch.' : 'Leave your number and we’ll get in touch.'),
      card, S.me ? null : h('p', { class: 'center small' }, h('a', { href: '#/' }, 'Already a member? Log in'))));
  }

  async function forgotPassword(ev) {
    ev.preventDefault();
    const email = (document.querySelector('input[name=email]') || {}).value || '';
    if (!email.includes('@')) return toast('Type your email first, then tap Forgot password.', true);
    const { error } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: APP_URL });
    if (error) return toast('Could not send the email. Try again in a minute.', true);
    toast('Check your email for a link to set a new password.');
  }

  function newPasswordPage() {
    const save = h('button', { class: 'btn block', type: 'submit' }, 'Save new password');
    const form = h('form', null,
      field('New password (10+ characters)', h('input', { type: 'password', name: 'p1', required: true, minlength: 10, autocomplete: 'new-password' })),
      field('Repeat new password', h('input', { type: 'password', name: 'p2', required: true, minlength: 10, autocomplete: 'new-password' })), save);
    form.addEventListener('submit', busy(save, async () => {
      const f = formData(form);
      if (f.p1.length < 10) throw new Error('password_too_short');
      if (f.p1 !== f.p2) throw new Error('pin_mismatch');
      const { error } = await sb.auth.updateUser({ password: f.p1 });
      if (error) throw new Error('server_error');
      await sb.auth.signOut({ scope: 'others' });
      S.recovery = false; toast('Password saved'); location.hash = '#/home'; boot();
    }));
    $app.className = '';
    $app.replaceChildren(h('div', { class: 'login' }, h('h1', null, 'Set a new password'), h('div', { class: 'card' }, form)));
  }

  async function logoutNow() {
    if (S.me && S.me.role === 'owner' && sb) { try { await sb.auth.signOut(); } catch (e) { /* ignore */ } }
    else { try { await api('logout', { body: {} }); } catch (e) { /* ignore */ } }
    saveToken(null);
    S.me = null; S.cart = {}; S.cache = {}; document.getElementById('toast').className = ''; location.hash = '#/'; boot();
  }

  /* ================================================================== *
   * OWNER
   * ================================================================== */
  routes.owner = {};
  routes.owner.subscription = () => renewPage(false);

  async function refreshOwnerBadges(d) {
    badges = { '#/payments': d.counts.waiting || 0, '#/reminders': d.counts.to_remind || 0 };
  }

  routes.owner.home = async () => {
    loading('Dashboard');
    const [d, ins, fin] = await Promise.all([api('o_dashboard'), api('o_insights'), api('o_finance')]);
    refreshOwnerBadges(d);
    const c = d.counts;
    const tile = (n, l, cls, href) => h('a', { class: 'tile ' + cls, href }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));
    const todoItem = (href, t, sub) => h('a', { class: 'item', href }, h('div', { class: 'grow' }, h('div', { class: 't' }, t), h('div', { class: 's' }, sub)), '›');
    const plural = (n, w) => n + ' ' + w + (n > 1 ? 's' : '');
    const todo = [];
    if (c.waiting) todo.push(todoItem('#/payments', plural(c.waiting, 'payment') + ' to confirm', 'Check your UPI app, then confirm'));
    if (c.to_remind) todo.push(todoItem('#/reminders', plural(c.to_remind, 'reminder') + ' to send', 'Expiring soon or just expired'));
    if (c.new_orders) todo.push(todoItem('#/shop/orders', plural(c.new_orders, 'shop order') + ' open', 'Collect payment or hand over'));
    if (c.birthdays) todo.push(todoItem('#/reminders', plural(c.birthdays, 'birthday') + ' today', 'Send a wish on WhatsApp'));
    if (fin.freeze_waiting) todo.push(todoItem('#/freezes', plural(fin.freeze_waiting, 'freeze request'), 'Members asking to pause their membership'));
    if (fin.pt_expiring) todo.push(todoItem('#/pt', plural(fin.pt_expiring, 'PT package') + ' ending soon', 'Few sessions or days left. Offer a renewal'));
    if (fin.leads_due) todo.push(todoItem('#/leads', plural(fin.leads_due, 'enquiry follow-up') + ' due', 'Call or WhatsApp people who asked about joining'));
    if (ins.missing.length) todo.push(todoItem('#/insights', ins.missing.length + ' active member' + (ins.missing.length > 1 ? 's' : '') + ' missing for a week+', 'Send a “we miss you” message'));
    const warn = [];
    if (!d.upi_set) warn.push(h('a', { class: 'card', href: '#/settings' }, h('b', null, 'Add your UPI ID'), h('div', { class: 'muted small' }, 'Members can’t pay in the app until you add it in Settings.')));
    if (d.has_demo) warn.push(h('a', { class: 'card', href: '#/settings' }, h('b', null, 'Demo data is on'), h('div', { class: 'muted small' }, 'Remove the fake members and products in Settings when you’re ready.')));
    if (d.backup_due) warn.push(h('a', { class: 'card', href: '#/settings' }, h('b', null, 'Time for a backup'), h('div', { class: 'muted small' }, 'Download a backup from Settings. It takes one tap.')));
    const ptMonth = fin.months[5].pt || 0;
    const total = d.month.membership + d.month.shop + ptMonth;
    frame('Dashboard', [
      subBanner(),
      warn,
      h('div', { class: 'hero' },
        h('div', { class: 'hello' }, d.month.label),
        h('div', { class: 'big-money gradtext' }, fmtMoney(total)),
        h('div', { class: 'muted small' }, 'Memberships ' + fmtMoney(d.month.membership) + ' · Shop ' + fmtMoney(d.month.shop) + (ptMonth ? ' · PT ' + fmtMoney(ptMonth) : '')
          + (fin.months[5].expenses ? ' · Profit ' + fmtMoney(fin.months[5].income - fin.months[5].expenses) : '')),
        h('div', { class: 'statrow' },
          h('div', { class: 'stat' }, h('b', null, ins.checkins_today), h('span', null, 'In today')),
          h('div', { class: 'stat' }, h('b', null, ins.active_rate + '%'), h('span', null, 'Regulars')),
          h('div', { class: 'stat' }, h('b', null, fmtMoney(ins.renewal_due_value)), h('span', null, 'Due in 7d')))),
      h('div', { class: 'tiles' },
        tile(c.active, 'Active members', 'good', '#/members/active'),
        tile(c.expiring, 'Expiring in 3 days', 'warn', '#/members/expiring'),
        tile(c.expired, 'Expired', 'bad', '#/members/expired'),
        tile(c.dues, 'Payment due', 'info', '#/members/dues')),
      h('a', { class: 'card', href: '#/insights' },
        h('div', { class: 'row between' }, h('b', null, 'Collection, last 6 months'), h('span', { class: 'muted small' }, 'Insights ›')),
        barChart(ins.revenue.map(r => ({ label: r.label, values: [r.membership, r.shop] })), ['grad', '#4aa8ff'], { h: 130, top: v => v >= 1000 ? Math.round(v / 1000) + 'k' : v })),
      h('div', { class: 'section' }, 'Today'),
      todo.length ? h('div', { class: 'list' }, todo) : h('div', { class: 'card muted' }, 'Nothing pending. Nice!'),
      h('div', { class: 'btns' }, h('a', { class: 'btn', href: '#/member-new' }, '+ Add member'), h('a', { class: 'btn ghost', href: '#/leads/new' }, '+ Enquiry')),
    ]);
    renewPopup();
  };

  routes.owner.insights = async () => {
    loading('Insights');
    const [ins, ck, fin] = await Promise.all([api('o_insights'), api('o_checkins'), api('o_finance')]);
    await loadTemplates();
    const prof = fin.months.reduce((a, r) => a + r.income - r.expenses, 0);
    frame('Insights', [
      h('a', { class: 'card', href: '#/expenses' }, h('div', { class: 'row between' }, h('h3', null, 'Income vs expenses'), h('span', { class: 'muted small' }, 'Expenses ›')),
        barChart(fin.months.map(r => ({ label: r.label, values: [r.income, r.expenses] })), ['grad', '#8b93a7'], { h: 150, grouped: true }),
        h('div', { class: 'legend' }, h('span', null, h('i', { class: 'lg-a' }), 'Income'), h('span', null, h('i', { class: 'lg-c' }), 'Expenses')),
        h('p', { class: 'small' }, 'Profit in 6 months: ', h('b', { class: prof >= 0 ? 'pos-num' : 'neg-num' }, fmtMoney(prof)))),
      h('div', { class: 'card' }, h('h3', null, 'Collection by month'),
        barChart(ins.revenue.map(r => ({ label: r.label, values: [r.membership, r.shop] })), ['grad', '#4aa8ff'], { h: 160, top: v => v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : v }),
        h('div', { class: 'legend' }, h('span', null, h('i', { class: 'lg-a' }), 'Memberships'), h('span', null, h('i', { class: 'lg-b' }), 'Shop'))),
      h('div', { class: 'card' }, h('h3', null, 'New members by month'),
        barChart(ins.joins.map(r => ({ label: r.label, values: [r.n] })), ['grad'], { h: 120, top: v => v })),
      h('div', { class: 'card' }, h('h3', null, 'Check-ins, last 14 days'),
        barChart(ck.days.map(r => ({ label: String(Number(r.day.slice(8))), values: [r.n] })), ['grad'], { h: 120, top: v => v })),
      h('div', { class: 'card' }, h('h3', null, 'Busy hours (last 30 days)'),
        barChart(ck.hours.map(r => ({ label: r.h % 12 === 0 ? '12' : String(r.h % 12), values: [r.n] })), [brand('a2')], { h: 110 }),
        h('p', { class: 'muted small' }, 'From 5 am to 10 pm. Use it to plan staff and batch timings.')),
      h('div', { class: 'section' }, 'Missing for a week or more'),
      ins.missing.length ? h('div', { class: 'list' }, ins.missing.map(m => h('div', { class: 'item' },
        h('a', { class: 'grow', href: '#/member/' + m.id }, h('div', { class: 't' }, m.name), h('div', { class: 's' }, 'Last visit ' + fmtDate(m.last))),
        h('a', { class: 'btn wa sm', target: '_blank', rel: 'noopener', href: waLink(m.phone, 'Namaste ' + m.name.split(' ')[0] + '! ' + S.gym + ' me aapko kuch dino se nahi dekha. Sab theek? Aaj workout pe aa jaiye! 💪') }, 'Nudge'))))
        : h('div', { class: 'card muted' }, 'Everyone is showing up. 🔥'),
    ], { back: '#/home' });
  };

  routes.owner.checkins = async () => {
    loading('Check-ins');
    const ck = await api('o_checkins');
    const url = APP_URL + '#/checkin/' + ck.code;
    const lb = h('input', { type: 'checkbox', checked: ck.leaderboard });
    lb.addEventListener('change', () => api('o_checkin_settings', { body: { leaderboard: lb.checked } }).then(() => toast(lb.checked ? 'Leaderboard on' : 'Leaderboard off')).catch(showErr));
    const newCode = h('button', { class: 'btn ghost' }, 'New code');
    newCode.addEventListener('click', busy(newCode, async () => {
      if (!(await confirmBox('Make a new check-in code?', 'The old printed QR will stop working. Print the new one and replace it at the desk.', 'New code'))) return;
      await api('o_checkin_settings', { body: { new_code: true } }); toast('New code ready. Print it!'); route();
    }));
    frame('Check-ins', [
      h('div', { class: 'poster' },
        h('div', { class: 'hello' }, S.gym),
        h('h2', null, 'Scan to check in 🔥'),
        h('div', { class: 'qrbox' }, qrImage(url)),
        h('div', { class: 'muted small' }, 'Or type this code in the app'),
        h('div', { class: 'code gradtext' }, ck.code)),
      h('div', { class: 'btns noprint' }, h('button', { class: 'btn', onclick: () => window.print() }, 'Print poster'), newCode),
      h('label', { class: 'chk noprint' }, lb, 'Show the monthly leaderboard to members (first name + initial only)'),
      h('div', { class: 'section noprint' }, 'Today (' + ck.today.length + ')'),
      ck.today.length ? h('div', { class: 'list noprint' }, ck.today.map(x => h('a', { class: 'item', href: '#/member/' + x.id },
        h('div', { class: 'avatar' }, initials(x.name)), h('div', { class: 'grow' }, h('div', { class: 't' }, x.name), h('div', { class: 's' }, x.code + (x.by_owner ? ' · added by you' : ''))), h('b', null, x.time))))
        : h('div', { class: 'card muted noprint' }, 'No check-ins yet today.'),
      h('div', { class: 'card noprint' }, h('h3', null, 'Last 14 days'), barChart(ck.days.map(r => ({ label: String(Number(r.day.slice(8))), values: [r.n] })), ['grad'], { h: 120, top: v => v })),
    ], { back: '#/more' });
  };

  routes.owner.workouts = async () => {
    loading('Workout plan');
    const w = (await api('o_workouts', { body: {} })).days;
    const inputs = DAY_NAMES.map((dname, i) => h('input', { value: w[String(i + 1)] || '', maxlength: 200, 'data-day': i + 1 }));
    const save = h('button', { class: 'btn block' }, 'Save plan');
    save.addEventListener('click', busy(save, async () => {
      const days = {}; inputs.forEach(x => { days[x.getAttribute('data-day')] = x.value; });
      await api('o_workouts', { body: { days } }); toast('Workout plan saved');
    }));
    frame('Workout plan', [
      h('p', { class: 'muted small' }, 'Members see today’s workout on their home screen.'),
      h('div', { class: 'card' }, DAY_NAMES.map((dname, i) => field(dname, inputs[i])), save),
    ], { back: '#/more' });
  };

  /* ---------- members ---------- */
  routes.owner.members = async (filter, batch) => {
    filter = filter || 'all';
    const batches = (S.cache.batches = S.cache.batches || (await api('o_batches')).batches);
    loading('Members');
    const tabs = [['all', 'All'], ['active', 'Active'], ['expiring', 'Expiring'], ['expired', 'Expired'], ['dues', 'Due'], ['frozen', 'Frozen'], ['archived', 'Left']];
    const listBox = h('div');
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Search name, phone or ID', autocomplete: 'off' });
    let timer;
    const load = async () => {
      const d = await api('o_members', { query: { filter, q: search.value, batch: batch || '' } });
      listBox.replaceChildren(d.members.length ? h('div', { class: 'list' }, d.members.map(memberRow)) : h('div', { class: 'empty' }, 'No members here.'));
    };
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch(showErr), 250); });
    frame('Members', [
      h('div', { class: 'seg' }, tabs.map(([k, l]) => h('button', { class: k === filter ? 'on' : '', onclick: () => { location.hash = '#/members/' + k + (batch ? '/' + batch : ''); } }, l))),
      batches.length ? h('div', { class: 'chips' }, h('a', { class: 'chip' + (batch ? '' : ' on'), href: '#/members/' + filter }, 'All batches'),
        batches.filter(b => b.active).map(b => h('a', { class: 'chip' + (String(b.id) === String(batch) ? ' on' : ''), href: '#/members/' + filter + '/' + b.id }, b.name))) : null,
      h('div', { class: 'row' }, h('div', { class: 'grow' }, search), 'BarcodeDetector' in window ? h('a', { class: 'btn ghost sm scanbtn', href: '#/scancard', title: 'Scan membership card' }, icon('scan')) : null),
      listBox,
      h('div', { class: 'btns' }, h('a', { class: 'btn', href: '#/member-new' }, '+ Add member'), h('a', { class: 'btn ghost', href: '#/import' }, 'Import CSV')),
    ], { action: h('a', { class: 'btn sm', href: '#/member-new' }, '+ Add') });
    await load();
  };

  function memberRow(m) {
    return h('a', { class: 'item', href: '#/member/' + m.id },
      h('div', { class: 'avatar' }, initials(m.name)),
      h('div', { class: 'grow' }, h('div', { class: 't' }, m.name), h('div', { class: 's' }, (m.plan || 'No plan') + ' · ' + (m.status === 'frozen' ? 'Frozen' + (m.freeze_until ? ' till ' + fmtDate(m.freeze_until) : '') : daysText(m.days_left)) + (m.batch ? ' · ' + m.batch.split(' · ')[0] : ''))),
      m.dues > 0 ? h('span', { class: 'badge dues' }, 'Due ' + fmtMoney(m.dues)) : badge(m.status));
  }

  routes.owner.member = async (id) => {
    loading('Member');
    await loadTemplates();
    const [d, ptd] = await Promise.all([api('o_member', { query: { id } }), api('o_pt', { body: { member_id: id, status: 'all' } })]);
    const m = d.member;
    const act = async (action, msg, confirmText, danger, extra) => {
      if (confirmText && !(await confirmBox(confirmText[0], confirmText[1], confirmText[2], danger))) return;
      try {
        const r = await api('o_member_action', { body: Object.assign({ id: m.id, action }, extra || {}) });
        if (r.pin) return showPin(m, r.pin, true);
        toast(msg); route();
      } catch (e) { showErr(e); }
    };
    const pays = d.payments.map(p => h(p.status === 'confirmed' ? 'a' : 'div', { class: 'item', href: p.status === 'confirmed' ? '#/receipt/' + p.id : null },
      h('div', { class: 'grow' }, h('div', { class: 't' }, fmtMoney(p.amount) + ' · ' + payLabel(p)),
        h('div', { class: 's' }, fmtDateTime(p.decided_at || p.created_at) + ' · ' + p.mode.toUpperCase() + (p.receipt_no ? ' · ' + p.receipt_no : ''))), badge(p.status)));
    const reminderMsg = () => {
      const tpl = m.dues > 0 ? 'dues' : (m.days_left < 0 ? 'expired' : (m.days_left === 0 ? 'today' : 'soon'));
      return reminderText(tpl, m);
    };
    frame(m.name, [
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('div', null, h('div', { class: 'muted small' }, m.code), h('div', { class: 'small' }, '+91 ' + shortPhone(m.phone))), badge(m.status)),
        h('hr', { class: 'hidden' }),
        h('dl', { class: 'kv' },
          h('dt', null, 'Plan'), h('dd', null, (m.plan || '—') + ' · ' + fmtMoney(m.fee)),
          h('dt', null, 'Started'), h('dd', null, fmtDate(m.start_date)),
          h('dt', null, 'Expiry'), h('dd', null, fmtDate(m.expiry_date) + ' (' + (m.status === 'frozen' ? 'frozen' + (m.freeze_until ? ', resumes ' + fmtDate(m.freeze_until) : '') : daysText(m.days_left)) + ')'),
          h('dt', null, 'Batch'), h('dd', null, m.batch || '—'),
          h('dt', null, 'Diet plan'), h('dd', null, m.diet || '—'),
          m.dues > 0 ? [h('dt', null, 'Payment due'), h('dd', null, h('b', null, fmtMoney(m.dues)))] : null,
          m.birthday ? [h('dt', null, 'Birthday'), h('dd', null, fmtDate(m.birthday))] : null,
          m.notes ? [h('dt', null, 'Notes'), h('dd', null, m.notes)] : null,
          h('dt', null, 'WhatsApp reminders'), h('dd', null, m.consent ? 'Yes' : 'No'))),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => recordPayment(m) }, m.dues > 0 ? 'Collect due' : 'Record payment'),
        h('a', { class: 'btn wa', href: waLink(m.phone, reminderMsg()), target: '_blank', rel: 'noopener', onclick: () => api('o_mark_reminded', { body: { id: m.id } }).catch(() => {}) }, 'WhatsApp'),
        h('a', { class: 'btn ghost', href: 'tel:+' + m.phone }, 'Call'),
        h('a', { class: 'btn ghost', href: '#/member-edit/' + m.id }, 'Edit')),
      m.status === 'active' || m.status === 'expiring' ? h('button', { class: 'btn ghost block', onclick: () => api('o_checkin_member', { body: { id: m.id } }).then(r => toast(r.fresh ? 'Checked in for today ✓' : 'Already checked in today')).catch(showErr) }, '✓ Mark check-in for today') : null,
      h('div', { class: 'section row between' }, h('span', null, 'Personal training'), h('button', { class: 'btn sm ghost', onclick: () => ptForm(m) }, '+ Package')),
      ptd.packages.length ? ptd.packages.slice(0, 3).map(ptCard) : h('div', { class: 'card muted small' }, 'No training package. Tap “+ Package” to sell PT sessions.'),
      h('div', { class: 'section' }, 'Payments'),
      pays.length ? h('div', { class: 'list' }, pays) : h('div', { class: 'card muted' }, 'No payments yet.'),
      d.orders.length ? [h('div', { class: 'section' }, 'Shop orders'), h('div', { class: 'list' }, d.orders.map(orderRow))] : null,
      h('div', { class: 'section' }, 'Account'),
      h('div', { class: 'btns' },
        m.raw_status === 'frozen' ? h('button', { class: 'btn ghost', onclick: () => act('unfreeze', 'Membership resumed. Paused days were added back.') }, 'Unfreeze')
          : m.raw_status === 'active' ? h('button', { class: 'btn ghost', onclick: () => freezeAsk(m, act) }, 'Freeze') : null,
        h('button', { class: 'btn ghost', onclick: () => act('reset_pin', '', ['Reset PIN?', 'A new 6-digit PIN will be made. The member will be logged out on all phones and must set their own PIN after logging in.', 'Reset PIN']) }, 'Reset PIN'),
        m.raw_status === 'archived' ? h('button', { class: 'btn ghost', onclick: () => act('restore', 'Member restored.') }, 'Restore')
          : h('button', { class: 'btn bad', onclick: () => act('archive', 'Member moved to Left.', ['Mark as left?', 'The member can no longer log in. Their history is kept and you can restore them anytime.', 'Mark as left'], true) }, 'Mark as left')),
    ], { back: '#/members' });
  };

  function payLabel(p) { return p.kind === 'shop' ? 'Shop' : p.kind === 'pt' ? 'Personal training' : (p.plan_name || 'Membership'); }

  function freezeAsk(m, act) {
    const days = h('input', { name: 'days', inputmode: 'numeric', placeholder: 'Leave empty to unfreeze yourself later' });
    const go = h('button', { class: 'btn' }, 'Freeze');
    const dlg = modal('Freeze membership?', [h('p', { class: 'muted small' }, 'For travel, illness or exams. The days left are paused and added back when the freeze ends.'),
      field('Freeze for how many days?', days)], [h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'), go]);
    go.addEventListener('click', () => { dlg.close(); act('freeze', days.value.trim() ? 'Frozen. It resumes by itself after ' + days.value.trim() + ' days.' : 'Membership frozen.', null, false, days.value.trim() ? { days: days.value.trim() } : null); });
  }

  function reminderText(kind, m) {
    const t = (S.cache.templates || {})[kind] || '';
    return fill(t, { name: m.name.split(' ')[0], gym: S.gym, expiry: fmtDate(m.expiry_date), link: APP_URL, amount: m.dues || m.fee });
  }

  async function loadTemplates() {
    if (!S.cache.templates) { const r = await api('o_reminders'); S.cache.templates = r.templates; S.cache.upi = r.upi; }
  }

  function showPin(m, pin, isReset) {
    const msg = (isReset ? 'Namaste ' + m.name.split(' ')[0] + '! Aapka naya PIN: ' : 'Welcome to ' + S.gym + ', ' + m.name.split(' ')[0] + '! ') +
      (isReset ? pin : '\nApp: ' + APP_URL + '\nMobile: ' + shortPhone(m.phone) + '\nPIN: ' + pin) + '\nLogin ke baad apna khud ka PIN set karein.';
    const d = modal(isReset ? 'New PIN' : 'Member added', [
      h('p', { class: 'muted' }, 'Give this PIN to ' + m.name + '. It is shown only once.'),
      h('div', { class: 'pin' }, pin),
      h('p', { class: 'muted small' }, 'They log in with their mobile number and this PIN, then set their own PIN.'),
    ], [
      h('button', { class: 'btn ghost', onclick: () => { d.close(); location.hash = '#/member/' + m.id; route(); } }, 'Done'),
      h('a', { class: 'btn wa', href: waLink(m.phone, msg), target: '_blank', rel: 'noopener' }, 'Send on WhatsApp'),
    ]);
  }

  async function recordPayment(m) {
    const plans = (await api('o_plans')).plans.filter(p => p.active == 1);
    const due = m.dues > 0;
    const form = h('form', null,
      due ? [h('p', null, 'Due: ', h('b', null, fmtMoney(m.dues))), field('Amount received (₹)', h('input', { name: 'amount', inputmode: 'numeric', value: m.dues, required: true }))]
        : field('Plan', h('select', { name: 'plan_id' }, plans.map(p => h('option', { value: p.id, selected: p.id == m.plan_id }, p.name + ' · ' + fmtMoney(p.fee))))),
      field('Paid by', h('select', { name: 'mode' }, h('option', { value: 'cash' }, 'Cash'), h('option', { value: 'upi' }, 'UPI (at the counter)'))),
      due ? null : field('Coupon code (optional)', h('input', { name: 'coupon', maxlength: 20, autocapitalize: 'characters' })),
      due ? null : h('p', { class: 'muted small' }, 'The membership will be extended from ' + (m.days_left >= 0 ? 'the current expiry date' : 'today') + '.'));
    const save = h('button', { class: 'btn' }, 'Save payment');
    const d = modal(due ? 'Collect due' : 'Record payment', form, [h('button', { class: 'btn ghost', onclick: () => d.close() }, 'Cancel'), save]);
    save.addEventListener('click', busy(save, async () => {
      const r = await api('o_payment_record', { body: Object.assign({ member_id: m.id }, formData(form)) });
      d.close(); toast('Payment saved'); location.hash = '#/receipt/' + r.receipt_id;
    }));
  }

  async function memberForm(id, leadId) {
    loading(id ? 'Edit member' : 'Add member');
    const [plansR, prefs, bR, dR] = await Promise.all([api('o_plans'), api('o_prefs', { body: {} }), api('o_batches'), api('o_diets')]);
    const plans = plansR.plans;
    const m = id ? (await api('o_member', { query: { id } })).member : null;
    const lead = leadId && S.cache.leads ? S.cache.leads.find(x => String(x.id) === String(leadId)) : null;
    const save = h('button', { class: 'btn block', type: 'submit' }, id ? 'Save changes' : 'Add member');
    const form = h('form', null,
      lead ? h('div', { class: 'note' }, 'From enquiry: ' + lead.name + (lead.interest ? ' · ' + lead.interest : '')) : null,
      field('Full name', h('input', { name: 'name', required: true, maxlength: 100, value: m ? m.name : lead ? lead.name : '' })),
      field('Mobile number', h('input', { name: 'phone', inputmode: 'tel', required: true, value: m ? shortPhone(m.phone) : lead ? shortPhone(lead.phone) : '', placeholder: '98765 43210' })),
      field('Plan', h('select', { name: 'plan_id' }, plans.filter(p => p.active == 1 || (m && p.id == m.plan_id)).map(p => h('option', { value: p.id, selected: m && p.id == m.plan_id }, p.name + ' · ' + fmtMoney(p.fee))))),
      m ? [
        field('Expiry date (change only to correct a mistake)', h('input', { name: 'expiry_date', type: 'date', value: m.expiry_date, required: true })),
        field('Payment due (₹)', h('input', { name: 'dues', inputmode: 'numeric', value: m.dues })),
      ] : [
        lead && lead.ref_name ? h('div', { class: 'note' }, 'Referred by ' + lead.ref_name + (prefs.referral_days ? '. They get ' + prefs.referral_days + ' free days when you add this member.' : '')) : null,
        field('Start date', h('input', { name: 'start_date', type: 'date', value: todayISO(), required: true })),
        prefs.admission_fee > 0 ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'admission', checked: true }), 'Charge admission fee ' + fmtMoney(prefs.admission_fee)) : null,
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'paid_now', checked: true }), 'Fee paid now'),
        field('Paid by', h('select', { name: 'mode' }, h('option', { value: 'cash' }, 'Cash'), h('option', { value: 'upi' }, 'UPI'))),
        field('Coupon code (optional)', h('input', { name: 'coupon', maxlength: 20, autocapitalize: 'characters', placeholder: 'e.g. JOIN500' })),
        lead && lead.ref_name ? null : field('Referred by member ID (optional)', h('input', { name: 'ref_code', maxlength: 12, autocapitalize: 'characters', placeholder: 'e.g. GYM-0012' })),
      ],
      bR.batches.length ? field('Batch / time slot', h('select', { name: 'batch_id' }, h('option', { value: '' }, 'No batch'),
        bR.batches.filter(b => b.active || (m && b.id == m.batch_id)).map(b => h('option', { value: b.id, selected: m && b.id == m.batch_id },
          b.label + (b.capacity ? ' (' + b.members + '/' + b.capacity + ')' : ''))))) : null,
      dR.diets.length ? field('Diet plan', h('select', { name: 'diet_plan_id' }, h('option', { value: '' }, 'No diet plan'),
        dR.diets.map(x => h('option', { value: x.id, selected: m && x.id == m.diet_plan_id }, x.name)))) : null,
      field('Birthday (optional)', h('input', { name: 'birthday', type: 'date', value: m && m.birthday ? m.birthday : '' })),
      field('Notes (optional)', h('textarea', { name: 'notes', maxlength: 500, placeholder: 'e.g. knee injury, no heavy squats' }, m && m.notes ? m.notes : '')),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'consent', checked: m ? m.consent : true }), 'Member agrees to get WhatsApp reminders'),
      save);
    form.addEventListener('submit', busy(save, async () => {
      const body = formData(form);
      if (id) body.id = id;
      if (lead) body.lead_id = lead.id;
      const r = await api('o_member_save', { body });
      if (id) { toast('Saved'); location.hash = '#/member/' + id; return; }
      if (r.referral) toast(r.referral.name.split(' ')[0] + ' got ' + r.referral.days + ' free days for the referral 🎁');
      S.cache.batches = null;
      showPin({ id: r.id, name: body.name, phone: '91' + body.phone.replace(/\D/g, '').slice(-10) }, r.pin, false);
    }));
    frame(id ? 'Edit member' : 'Add member', h('div', { class: 'card' }, form), { back: id ? '#/member/' + id : '#/members' });
  }
  routes.owner['member-new'] = (a, b) => memberForm(null, a === 'lead' ? b : null);
  routes.owner['member-edit'] = id => memberForm(id);

  /** Small CSV reader (quotes, commas inside quotes, Excel BOM). Returns objects keyed by the header row. */
  function parseCsv(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    if (text.length > 500000) throw new Error('file_too_big');
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    const data = rows.filter(r => r.some(x => x.trim() !== ''));
    if (data.length < 2) throw new Error('empty_file');
    const head = data.shift().map(x => x.trim().toLowerCase());
    for (const need of ['name', 'phone', 'plan', 'expiry_date']) if (head.indexOf(need) < 0) throw new Error('missing_column_' + need);
    return data.map(r => { const o = {}; head.forEach((k, i) => { o[k] = (r[i] || '').trim(); }); return o; });
  }

  routes.owner.import = () => {
    const ta = h('textarea', { name: 'csv', placeholder: 'name,phone,plan,start_date,expiry_date,dues\nRavi Kumar,9876543210,Monthly,2026-11-01,2026-12-01,0' });
    const file = h('input', { type: 'file', accept: '.csv,text/csv' });
    file.addEventListener('change', () => { const f = file.files[0]; if (f && f.size < 500000) f.text().then(t => { ta.value = t; }); });
    const result = h('div');
    const go = h('button', { class: 'btn block' }, 'Import members');
    go.addEventListener('click', busy(go, async () => {
      const r = await api('o_import_members', { body: { rows: parseCsv(ta.value) } });
      const rows = ['name,phone,pin'].concat(r.created.map(c => [c.name, shortPhone(c.phone), c.pin].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')));
      result.replaceChildren(h('div', { class: 'card' },
        h('b', null, r.created.length + (r.created.length === 1 ? ' member added' : ' members added')),
        r.errors.length ? h('ul', { class: 'small' }, r.errors.map(e => h('li', null, e))) : null,
        r.created.length ? [h('p', { class: 'muted small' }, 'Download the PIN list now. PINs are shown only once.'),
          h('button', { class: 'btn', onclick: () => download('member-pins.csv', rows.join('\r\n')) }, 'Download PIN list')] : null));
    }));
    frame('Import members', [
      h('div', { class: 'card' },
        h('p', { class: 'small' }, 'Make a CSV (Excel → Save As → CSV) with these columns: ', h('b', null, 'name, phone, plan, expiry_date'), ' and optionally ', h('b', null, 'start_date, dues'), '. Dates as YYYY-MM-DD. Plan names must match your plans.'),
        h('button', { class: 'btn ghost sm', onclick: () => download('members-template.csv', 'name,phone,plan,start_date,expiry_date,dues\r\nRavi Kumar,9876543210,Monthly,2026-11-01,2026-12-01,0\r\n') }, 'Download template'),
        h('p'), file, h('p'), field('Or paste CSV here', ta), go),
      result,
    ], { back: '#/members' });
  };

  /* ---------- reminders ---------- */
  routes.owner.reminders = async () => {
    loading('Reminders');
    const d = await api('o_reminders');
    S.cache.templates = d.templates; S.cache.upi = d.upi;
    const groups = [
      ['today', 'Ending today', 'today'], ['soon', 'Ending in 1–3 days', 'soon'], ['expired', 'Expired in the last 30 days', 'expired'],
      ['dues', 'Payment due', 'dues'], ['birthdays', 'Birthdays today', 'birthday'], ['winback', 'Win back (left over 30 days ago)', 'winback'],
    ];
    const t = d.date;
    const row = (m, kind) => {
      const sent = m.last_reminder === t;
      const btn = h('a', { class: 'btn wa sm', href: waLink(m.phone, reminderText(kind, m)), target: '_blank', rel: 'noopener' }, sent ? 'Sent ✓' : 'Send');
      btn.addEventListener('click', () => { api('o_mark_reminded', { body: { id: m.id } }).then(() => { btn.textContent = 'Sent ✓'; }).catch(() => {}); });
      return h('div', { class: 'item' },
        h('a', { class: 'grow', href: '#/member/' + m.id }, h('div', { class: 't' }, m.name), h('div', { class: 's' },
          kind === 'dues' ? 'Due ' + fmtMoney(m.dues) : kind === 'birthday' ? 'Birthday' : fmtDate(m.expiry_date) + ' · ' + daysText(m.days_left))),
        m.consent ? btn : h('span', { class: 'badge' }, 'No consent'));
    };
    const total = groups.reduce((n, g) => n + d[g[0]].length, 0);
    frame('Reminders', [
      h('p', { class: 'muted small' }, 'Tap Send: WhatsApp opens with the message ready. Just press send. You can change the wording in More → Settings.'),
      total ? groups.filter(g => d[g[0]].length).map(([k, label, kind]) => [h('div', { class: 'section' }, label + ' (' + d[k].length + ')'), h('div', { class: 'list' }, d[k].map(m => row(m, kind)))])
        : h('div', { class: 'card muted' }, 'No reminders to send today.'),
    ]);
  };

  /* ---------- payments ---------- */
  routes.owner.payments = async (tab) => {
    tab = tab || 'waiting';
    loading('Payments');
    const d = await api('o_payments', { query: { status: tab } });
    if (tab === 'waiting') badges['#/payments'] = d.payments.length;
    const card = p => {
      const what = (p.kind === 'shop' ? 'Shop order: ' + p.items.map(i => i.qty + '× ' + i.name).join(', ') : (p.plan_name || 'Membership') + ' renewal') + (p.note ? ' · ' + p.note : '');
      const box = h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('div', null, h('div', { class: 'big-money' }, fmtMoney(p.amount)), h('div', null, h('b', null, p.member_name), h('span', { class: 'muted small' }, ' · ' + p.member_code))), badge(p.status)),
        h('div', { class: 'muted small' }, what),
        h('div', { class: 'muted small' }, (p.status === 'waiting' ? 'Requested ' : '') + fmtDateTime(p.decided_at || p.created_at) + ' · ' + p.mode.toUpperCase() + (p.utr ? ' · Ref ' + p.utr : '') + (p.receipt_no ? ' · ' + p.receipt_no : '')));
      if (p.status === 'waiting') {
        const ok = h('button', { class: 'btn good' }, 'Confirm');
        const no = h('button', { class: 'btn bad' }, 'Not received');
        ok.addEventListener('click', busy(ok, async () => {
          if (!(await confirmBox('Money received?', 'Only confirm after you see ' + fmtMoney(p.amount) + ' from ' + p.member_name + ' in your UPI app or bank SMS.', 'Yes, received'))) return;
          const r = await api('o_payment_decide', { body: { id: p.id, decision: 'confirm' } });
          toast('Confirmed. ' + (p.kind === 'shop' ? 'Order marked paid.' : 'Membership updated.'));
          location.hash = '#/receipt/' + r.receipt_id;
        }));
        no.addEventListener('click', busy(no, async () => {
          if (!(await confirmBox('Mark as not received?', 'The member will see that the payment was not received and can pay again.', 'Not received', true))) return;
          await api('o_payment_decide', { body: { id: p.id, decision: 'reject' } });
          toast('Marked as not received'); route();
        }));
        box.append(h('div', { class: 'btns' }, no, ok));
      } else if (p.status === 'confirmed') {
        box.append(h('a', { class: 'btn ghost sm', href: '#/receipt/' + p.id }, 'Receipt'));
      }
      return box;
    };
    frame('Payments', [
      h('div', { class: 'seg' }, [['waiting', 'Waiting'], ['confirmed', 'Confirmed'], ['rejected', 'Not received']].map(([k, l]) =>
        h('button', { class: k === tab ? 'on' : '', onclick: () => { location.hash = '#/payments/' + k; } }, l))),
      tab === 'waiting' ? h('p', { class: 'muted small' }, 'Members tap “I’ve paid” after paying your UPI. Check your UPI app first, then confirm.') : null,
      d.payments.length ? d.payments.map(card) : h('div', { class: 'empty' }, tab === 'waiting' ? 'No payments waiting.' : 'Nothing here yet.'),
    ]);
  };

  /* ---------- receipt (both roles) ---------- */
  async function receiptPage(id) {
    loading('Receipt');
    const d = await api('receipt', { query: { id } });
    const p = d.payment, g = d.gym;
    const lines = p.kind === 'shop' ? p.items.map(i => i.qty + ' × ' + i.name + ' = ' + fmtMoney(i.qty * i.price)) : p.kind === 'pt' ? [p.note || 'Personal training'] :
      [(p.plan_name || 'Membership') + (p.period_to ? ' (valid till ' + fmtDate(p.period_to) + ')' : '')].concat(p.note && p.note !== 'Joining' ? [p.note] : []);
    const text = g.name + ' – Payment receipt\nReceipt: ' + p.receipt_no + '\nDate: ' + fmtDate(p.decided_at) + '\nMember: ' + p.member_name + ' (' + p.member_code + ')\n' +
      lines.join('\n') + '\nAmount paid: ' + fmtMoney(p.amount) + ' (' + p.mode.toUpperCase() + ')\nThank you!';
    frame('Receipt', [
      h('div', { class: 'receipt' },
        h('h2', null, g.name), g.address ? h('div', { class: 'muted small' }, g.address) : null, h('hr'),
        h('dl', { class: 'kv' },
          h('dt', null, 'Receipt'), h('dd', null, p.receipt_no), h('dt', null, 'Date'), h('dd', null, fmtDateTime(p.decided_at)),
          h('dt', null, 'Member'), h('dd', null, p.member_name + ' (' + p.member_code + ')'), h('dt', null, 'Paid by'), h('dd', null, p.mode.toUpperCase())),
        h('hr'), lines.map(l => h('div', null, l)), h('hr'),
        h('div', { class: 'row between' }, h('b', null, 'Total paid'), h('b', { class: 'big-money' }, fmtMoney(p.amount)))),
      h('div', { class: 'btns noprint' },
        S.me.role === 'owner' ? h('a', { class: 'btn wa', href: waLink(p.member_phone, text), target: '_blank', rel: 'noopener' }, 'Send on WhatsApp')
          : h('button', { class: 'btn', onclick: () => navigator.share ? navigator.share({ text }).catch(() => {}) : navigator.clipboard.writeText(text).then(() => toast('Copied')) }, 'Share'),
        h('button', { class: 'btn ghost', onclick: () => window.print() }, 'Print')),
    ], { back: S.me.role === 'owner' ? '#/payments/confirmed' : '#/history' });
  }
  routes.owner.receipt = receiptPage;

  /* ---------- more ---------- */
  routes.owner.more = () => {
    const link = (href, ic, t, s) => h('a', { class: 'item', href }, h('div', { class: 'ico' }, icon(ic)), h('div', { class: 'grow' }, h('div', { class: 't' }, t), h('div', { class: 's' }, s)), '›');
    frame('More', [
      h('div', { class: 'section' }, 'Grow'),
      h('div', { class: 'list' },
        link('#/leads', 'chat', 'Enquiries', 'People who asked about joining, follow-ups'),
        link('#/freezes', 'snow', 'Freeze requests', 'Members asking to pause their membership'),
        link('#/insights', 'chart', 'Insights', 'Profit, revenue trend, busy hours, missing members'),
        link('#/checkins', 'qr', 'Check-ins', 'Front-desk QR poster, today’s visitors')),
      h('div', { class: 'section' }, 'Money'),
      h('div', { class: 'list' },
        link('#/expenses', 'wallet', 'Expenses & profit', 'Rent, salaries, bills and monthly profit'),
        link('#/reports', 'report', 'Reports', 'Monthly collection, joinings, best sellers'),
        link('#/plans', 'tag', 'Plans & fees', 'Plans, admission fee, referral and freeze rules'),
        link('#/coupons', 'gift', 'Offers & coupons', 'Discount codes for joining and renewals')),
      h('div', { class: 'section' }, 'Members'),
      h('div', { class: 'list' },
        link('#/pt', 'fire', 'Personal training', 'Trainers, PT packages and sessions'),
        link('#/batches', 'clock', 'Batches & slots', 'Morning / evening batches and capacity'),
        link('#/diets', 'leaf', 'Diet plans', 'Diet charts members see in their app'),
        link('#/workouts', 'fire', 'Workout plan', 'Today’s workout shown to members'),
        link('#/notices', 'mega', 'Announcements', 'Notices members see in their app'),
        link('#/shop', 'cart', 'Shop', 'Products, stock and orders'),
        link('#/import', 'upload', 'Import members', 'Add many members from a CSV file')),
      h('div', { class: 'section' }, 'App'),
      h('div', { class: 'list' }, link('#/settings', 'gear', 'Settings', 'Gym details, UPI, messages, backup, password'),
        link('#/subscription', 'card', 'App plan', S.info && S.info.sub ? (S.info.sub.state === 'trial' ? 'Free trial till ' : 'Valid till ') + fmtDate(S.info.sub.ends) + ' · renew' : 'Renew this app'), themeRow()),
      h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Join link for new people (put it on Instagram / WhatsApp status)'),
        h('div', { class: 'row' }, h('code', { class: 'grow small' }, APP_URL + '#/join'), h('button', { class: 'btn sm ghost', onclick: () => navigator.clipboard.writeText(APP_URL + '#/join').then(() => toast('Link copied')) }, 'Copy'))),
      h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Member app link (share this with members)'),
        h('div', { class: 'row' }, h('code', { class: 'grow small' }, APP_URL), h('button', { class: 'btn sm ghost', onclick: () => navigator.clipboard.writeText(APP_URL).then(() => toast('Link copied')) }, 'Copy')),
        h('div', { class: 'qrbox' }, qrImage(APP_URL))),
      h('button', { class: 'btn ghost block', onclick: logoutNow }, 'Log out'),
    ]);
  };

  /* ---------- enquiries ---------- */
  routes.owner.leads = async (tab) => {
    const openNew = tab === 'new';
    tab = openNew ? 'open' : (tab || 'open');
    loading('Enquiries');
    const d = await api('o_leads', { body: { status: tab } });
    S.cache.leads = d.leads;
    const c = d.counts;
    const stat = { new: 'New', following: 'Following up', joined: 'Joined', lost: 'Not interested' };
    const card = l => {
      const msg = 'Namaste ' + l.name.split(' ')[0] + '! ' + S.gym + ' me interest dikhane ke liye dhanyavaad 🙏 Aaj free trial ke liye aaiye! Timings ya fees ke liye yahin message karein.';
      return h('div', { class: 'card' + (l.due ? ' due' : '') },
        h('div', { class: 'row between' }, h('div', null, h('b', null, l.name), h('div', { class: 'muted small' }, '+91 ' + shortPhone(l.phone) + (l.source ? ' · ' + l.source : ''))),
          h('span', { class: 'badge ' + (l.status === 'joined' ? 'active' : l.status === 'lost' ? 'archived' : l.due ? 'expired' : 'waiting') }, l.due ? 'Follow up today' : stat[l.status])),
        l.ref_name ? h('div', { class: 'small refby' }, '🎁 Referred by ' + l.ref_name) : null,
        l.interest ? h('div', { class: 'small' }, l.interest) : null,
        l.notes ? h('div', { class: 'muted small' }, l.notes) : null,
        l.next_followup && (l.status === 'new' || l.status === 'following') ? h('div', { class: 'muted small' }, 'Next follow-up: ' + fmtDate(l.next_followup)) : null,
        l.status === 'joined' || l.status === 'lost' ? h('div', { class: 'btns' }, h('button', { class: 'btn ghost sm', onclick: () => leadForm(l) }, 'Edit'), l.member_id ? h('a', { class: 'btn ghost sm', href: '#/member/' + l.member_id }, 'Open member') : null)
          : h('div', { class: 'btns three' },
            h('a', { class: 'btn wa sm', href: waLink(l.phone, msg), target: '_blank', rel: 'noopener' }, 'WhatsApp'),
            h('button', { class: 'btn ghost sm', onclick: () => leadForm(l) }, 'Update'),
            h('a', { class: 'btn sm', href: '#/member-new/lead/' + l.id }, 'Joined ✓')));
    };
    frame('Enquiries', [
      h('div', { class: 'tiles' },
        h('div', { class: 'tile hot' }, h('div', { class: 'n' }, c.due), h('div', { class: 'l' }, 'Follow-ups due')),
        h('div', { class: 'tile good' }, h('div', { class: 'n' }, c.joined_month + '/' + c.total_month), h('div', { class: 'l' }, 'Joined / enquired this month'))),
      h('div', { class: 'seg' }, [['open', 'Open'], ['joined', 'Joined'], ['lost', 'Lost'], ['all', 'All']].map(([k, l]) =>
        h('button', { class: k === tab ? 'on' : '', onclick: () => { location.hash = '#/leads/' + k; } }, l))),
      d.leads.length ? d.leads.map(card) : h('div', { class: 'empty' }, tab === 'open' ? 'No open enquiries. Add one when someone asks about joining.' : 'Nothing here yet.'),
      h('button', { class: 'btn block', onclick: () => leadForm(null) }, '+ New enquiry'),
    ], { back: '#/more', action: h('button', { class: 'btn sm', onclick: () => leadForm(null) }, '+ Add') });
    if (openNew) leadForm(null);
  };

  function leadForm(l) {
    const tomorrow = new Date(Date.parse(todayISO() + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
    const form = h('form', null,
      field('Name', h('input', { name: 'name', required: true, maxlength: 100, value: l ? l.name : '' })),
      field('Mobile number', h('input', { name: 'phone', inputmode: 'tel', required: true, value: l ? shortPhone(l.phone) : '' })),
      field('Interested in', h('input', { name: 'interest', maxlength: 200, value: l && l.interest ? l.interest : '', placeholder: 'e.g. weight loss, evening batch' })),
      field('How did they hear about us?', h('select', { name: 'source' }, ['Walk-in', 'Friend / referral', 'Instagram', 'Google', 'Poster / banner', 'Other'].map(x => h('option', { selected: l && l.source === x }, x)))),
      l ? field('Status', h('select', { name: 'status' }, [['new', 'New'], ['following', 'Following up'], ['joined', 'Joined'], ['lost', 'Not interested']].map(([v, t]) => h('option', { value: v, selected: l.status === v }, t)))) : null,
      field('Next follow-up', h('input', { name: 'next_followup', type: 'date', value: l && l.next_followup ? l.next_followup : tomorrow })),
      field('Notes', h('textarea', { name: 'notes', maxlength: 500 }, l && l.notes ? l.notes : '')));
    const save = h('button', { class: 'btn' }, 'Save');
    const del = l ? h('button', { class: 'btn bad' }, 'Delete') : h('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
    const dlg = modal(l ? 'Update enquiry' : 'New enquiry', form, [del, save]);
    save.addEventListener('click', busy(save, async () => {
      const body = formData(form); if (l) body.id = l.id; else body.status = 'new';
      await api('o_lead_save', { body }); dlg.close(); toast('Saved'); if (location.hash !== '#/leads/open') location.hash = '#/leads/open'; else route();
    }));
    del.addEventListener('click', busy(del, async () => {
      if (!l) return dlg.close();
      if (!(await confirmBox('Delete this enquiry?', l.name, 'Delete', true))) return;
      await api('o_lead_delete', { body: { id: l.id } }); dlg.close(); toast('Deleted'); route();
    }));
  }

  /* ---------- expenses & profit ---------- */
  routes.owner.expenses = async (month) => {
    month = /^\d{4}-\d{2}$/.test(month || '') ? month : todayISO().slice(0, 7);
    loading('Expenses');
    const d = await api('o_expenses', { body: { month } });
    const picker = h('input', { type: 'month', value: month, class: 'search' });
    picker.addEventListener('change', () => { if (picker.value) location.hash = '#/expenses/' + picker.value; });
    const profit = d.income - d.total;
    const add = (x) => {
      const form = h('form', null,
        field('Category', h('input', { name: 'category', required: true, maxlength: 40, list: 'expcats', value: x ? x.category : '' })),
        h('datalist', { id: 'expcats' }, ['Rent', 'Salaries', 'Electricity', 'Water', 'Equipment', 'Equipment repair', 'Cleaning', 'Marketing', 'Internet', 'Other'].map(c => h('option', { value: c }))),
        field('Amount (₹)', h('input', { name: 'amount', inputmode: 'numeric', required: true, value: x ? x.amount : '' })),
        field('Date', h('input', { name: 'day', type: 'date', value: x ? x.day : todayISO() })),
        field('Note (optional)', h('input', { name: 'note', maxlength: 200, value: x && x.note ? x.note : '' })));
      const save = h('button', { class: 'btn' }, 'Save');
      const del = x ? h('button', { class: 'btn bad' }, 'Delete') : h('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
      const dlg = modal(x ? 'Edit expense' : 'Add expense', form, [del, save]);
      save.addEventListener('click', busy(save, async () => { const b = formData(form); if (x) b.id = x.id; await api('o_expense_save', { body: b }); dlg.close(); toast('Saved'); route(); }));
      del.addEventListener('click', busy(del, async () => { if (!x) return dlg.close(); await api('o_expense_delete', { body: { id: x.id } }); dlg.close(); toast('Deleted'); route(); }));
    };
    frame('Expenses & profit', [
      picker,
      h('div', { class: 'hero' },
        h('div', { class: 'hello' }, 'Profit this month'),
        h('div', { class: 'big-money ' + (profit >= 0 ? 'gradtext' : 'neg-num') }, fmtMoney(profit)),
        h('div', { class: 'statrow two' },
          h('div', { class: 'stat' }, h('b', null, fmtMoney(d.income)), h('span', null, 'Income')),
          h('div', { class: 'stat' }, h('b', null, fmtMoney(d.total)), h('span', null, 'Expenses')))),
      d.by_category.length ? h('div', { class: 'card' }, h('h3', null, 'Where the money went'),
        d.by_category.map(c => h('div', { class: 'barrow' }, h('div', { class: 'row between small' }, h('span', null, c.category), h('b', null, fmtMoney(c.amount))),
          h('div', { class: 'track' }, (() => { const f = h('i'); f.style.width = Math.max(3, Math.round(100 * c.amount / d.total)) + '%'; return f; })())))) : null,
      h('button', { class: 'btn block', onclick: () => add(null) }, '+ Add expense'),
      h('div', { class: 'section' }, 'Entries'),
      d.items.length ? h('div', { class: 'list' }, d.items.map(x => h('button', { class: 'item', onclick: () => add(x) },
        h('div', { class: 'ico' }, icon('wallet')), h('div', { class: 'grow' }, h('div', { class: 't' }, x.category), h('div', { class: 's' }, fmtDate(x.day) + (x.note ? ' · ' + x.note : ''))), h('b', null, fmtMoney(x.amount)))))
        : h('div', { class: 'card muted' }, 'No expenses added for this month.'),
    ], { back: '#/more' });
  };

  /* ---------- scan a member's card (owner) ---------- */
  routes.owner.scancard = async () => {
    const video = h('video', { class: 'scan', playsinline: true, muted: true });
    const box = h('div', { class: 'card center' }, h('p', { class: 'muted' }, 'Starting camera…'));
    frame('Scan member card', [box, h('p', { class: 'muted small center' }, 'Point the camera at the QR on the member’s card in their app.')], { back: '#/members' });
    try {
      const det = new window.BarcodeDetector({ formats: ['qr_code'] });
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      let stop = false;
      S.stopScan = () => { stop = true; stream.getTracks().forEach(t => t.stop()); };
      video.srcObject = stream; await video.play(); box.replaceChildren(video);
      const tick = async () => {
        if (stop) return;
        try {
          const f = await det.detect(video);
          const mm = f.length && f[0].rawValue.match(/^GYMCARD:(GYM-\d{4,6})$/);
          if (mm) {
            S.stopScan(); S.stopScan = null;
            const r = await api('o_members', { query: { filter: 'all', q: mm[1] } });
            const hit = r.members.find(x => x.code === mm[1]);
            if (hit) { location.hash = '#/member/' + hit.id; return; }
            toast('No member found for ' + mm[1], true); return;
          }
        } catch (e) { /* keep scanning */ }
        setTimeout(tick, 250);
      };
      tick();
    } catch (e) { box.replaceChildren(h('p', { class: 'muted' }, 'Camera not available on this phone. Search the member by name or code instead.')); }
  };

  /* ---------- personal training ---------- */
  function ptCard(k) {
    const pct = k.sessions ? k.used / k.sessions : 0;
    const bar = h('div', { class: 'track' }, (() => { const f = h('i'); f.style.width = Math.round(100 * pct) + '%'; return f; })());
    const mark = h('button', { class: 'btn sm' + (k.today ? ' ghost' : '') }, k.today ? '✓ Again' : '✓ Session done');
    mark.addEventListener('click', busy(mark, async () => { const r = await api('o_pt_session', { body: { id: k.id } }); toast(r.left ? 'Session marked. ' + r.left + ' left.' : 'Last session done! Package complete 🎉'); route(); }));
    const undo = h('button', { class: 'btn sm ghost' }, 'Undo');
    undo.addEventListener('click', busy(undo, async () => { await api('o_pt_session', { body: { id: k.id, undo: true } }); toast('Last session removed'); route(); }));
    const warn = k.status === 'active' && (k.expired || k.left <= 1);
    return h('div', { class: 'card ptcard' + (warn ? ' due' : '') },
      h('div', { class: 'row between' },
        h('div', null, h('a', { href: '#/member/' + k.member_id }, h('b', null, k.member_name)), h('div', { class: 'muted small' }, (k.trainer ? 'with ' + k.trainer + ' · ' : '') + 'till ' + fmtDate(k.expires))),
        h('div', { class: 'ptleft' }, h('b', null, k.left), h('span', null, 'left'))),
      bar, h('div', { class: 'muted small' }, k.used + ' of ' + k.sessions + ' sessions done' + (k.last_session ? ' · last ' + fmtDateTime(k.last_session) : '')),
      k.status === 'active' ? h('div', { class: 'btns three' }, mark, k.used ? undo : h('span'),
        h('a', { class: 'btn sm wa', href: waLink(k.member_phone, 'Hi ' + k.member_name.split(' ')[0] + '! ' + k.left + ' PT sessions left in your package at ' + S.gym + ' (valid till ' + fmtDate(k.expires) + ') 💪'), target: '_blank', rel: 'noopener' }, 'WhatsApp'))
        : h('div', { class: 'row between small' }, badge(k.status === 'done' ? 'confirmed' : 'archived'), k.used ? undo : null));
  }

  async function ptForm(member) {
    const [pt, ms] = await Promise.all([api('o_pt', { body: {} }), member ? null : api('o_members', { query: { filter: 'all', q: '' } })]);
    const pick = member ? null : h('select', { name: 'member_id', required: true }, h('option', { value: '' }, 'Choose member'), ms.members.map(x => h('option', { value: x.id }, x.name + ' (' + x.code + ')')));
    const form = h('form', null,
      member ? h('p', null, 'For ', h('b', null, member.name)) : field('Member', pick),
      field('Trainer', h('select', { name: 'trainer_id' }, h('option', { value: '' }, 'Not decided'), pt.trainers.filter(t => t.active).map(t => h('option', { value: t.id }, t.name)))),
      h('div', { class: 'row' }, h('label', { class: 'f grow' }, 'Sessions', h('input', { name: 'sessions', inputmode: 'numeric', value: 12, required: true })),
        h('label', { class: 'f grow' }, 'Valid for (days)', h('input', { name: 'valid_days', inputmode: 'numeric', value: 60 }))),
      field('Price (₹)', h('input', { name: 'amount', inputmode: 'numeric', required: true, placeholder: 'e.g. 6000' })),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'paid_now', checked: true }), 'Paid now (otherwise added to their dues)'),
      field('Paid by', h('select', { name: 'mode' }, h('option', { value: 'cash' }, 'Cash'), h('option', { value: 'upi' }, 'UPI'))));
    const save = h('button', { class: 'btn' }, 'Save package');
    const dlg = modal('New PT package', form, [h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'), save]);
    save.addEventListener('click', busy(save, async () => {
      const b = formData(form); if (member) b.member_id = member.id;
      if (!b.member_id) throw new Error('bad_id');
      const r = await api('o_pt_save', { body: b }); dlg.close(); toast('Package added');
      if (r.receipt_id) location.hash = '#/receipt/' + r.receipt_id; else route();
    }));
  }

  routes.owner.pt = async (tab) => {
    tab = tab || 'active';
    loading('Personal training');
    const d = await api('o_pt', { body: { status: tab } });
    const trainerEdit = (t) => {
      const form = h('form', null, field('Name', h('input', { name: 'name', required: true, maxlength: 60, value: t ? t.name : '' })),
        field('Mobile (optional)', h('input', { name: 'phone', inputmode: 'tel', value: t && t.phone ? shortPhone(t.phone) : '' })),
        t ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'active', checked: t.active }), 'Still working here') : null);
      const save = h('button', { class: 'btn' }, 'Save');
      const dlg = modal(t ? 'Edit trainer' : 'Add trainer', form, [h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'), save]);
      save.addEventListener('click', busy(save, async () => { const b = formData(form); if (t) { b.id = t.id; b.active = !!b.active; } await api('o_trainer_save', { body: b }); dlg.close(); toast('Saved'); route(); }));
    };
    frame('Personal training', [
      h('div', { class: 'tiles' },
        h('div', { class: 'tile hot' }, h('div', { class: 'n' }, d.sessions_today), h('div', { class: 'l' }, 'Sessions today')),
        h('div', { class: 'tile good' }, h('div', { class: 'n' }, d.packages.filter(k => k.status === 'active').length), h('div', { class: 'l' }, 'Active clients'))),
      h('div', { class: 'section row between' }, h('span', null, 'Trainers'), h('button', { class: 'btn sm ghost', onclick: () => trainerEdit(null) }, '+ Trainer')),
      d.trainers.length ? h('div', { class: 'list' }, d.trainers.map(t => h('button', { class: 'item', onclick: () => trainerEdit(t) },
        h('div', { class: 'avatar' }, initials(t.name)), h('div', { class: 'grow' }, h('div', { class: 't' }, t.name + (t.active ? '' : ' (left)')),
          h('div', { class: 's' }, t.clients + ' client' + (t.clients === 1 ? '' : 's') + ' · ' + t.sessions_month + ' sessions this month')), '›')))
        : h('div', { class: 'card muted small' }, 'Add your trainers so you can see who trains whom.'),
      h('div', { class: 'section' }, 'Packages'),
      h('div', { class: 'seg' }, [['active', 'Active'], ['done', 'Finished'], ['all', 'All']].map(([k, l]) => h('button', { class: k === tab ? 'on' : '', onclick: () => { location.hash = '#/pt/' + k; } }, l))),
      d.packages.length ? d.packages.map(ptCard) : h('div', { class: 'empty' }, tab === 'active' ? 'No active PT clients yet.' : 'Nothing here yet.'),
      h('button', { class: 'btn block', onclick: () => ptForm(null) }, '+ New PT package'),
    ], { back: '#/more', action: h('button', { class: 'btn sm', onclick: () => ptForm(null) }, '+ Add') });
  };

  /* ---------- batches ---------- */
  routes.owner.batches = async () => {
    loading('Batches');
    const d = await api('o_batches'); S.cache.batches = d.batches;
    const edit = (b) => {
      const form = h('form', null, field('Batch name', h('input', { name: 'name', required: true, maxlength: 40, value: b ? b.name : '', placeholder: 'e.g. Morning, Ladies, Evening' })),
        h('div', { class: 'row' }, h('label', { class: 'f grow' }, 'Starts', h('input', { name: 'starts', type: 'time', value: b && b.starts ? b.starts : '' })),
          h('label', { class: 'f grow' }, 'Ends', h('input', { name: 'ends', type: 'time', value: b && b.ends ? b.ends : '' }))),
        field('Max members (0 = no limit)', h('input', { name: 'capacity', inputmode: 'numeric', value: b ? b.capacity : 0 })),
        b ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'active', checked: b.active }), 'Batch is running') : null);
      const save = h('button', { class: 'btn' }, 'Save');
      const del = b ? h('button', { class: 'btn bad' }, 'Delete') : h('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
      const dlg = modal(b ? 'Edit batch' : 'New batch', form, [del, save]);
      save.addEventListener('click', busy(save, async () => { const x = formData(form); if (b) { x.id = b.id; x.active = !!x.active; } await api('o_batch_save', { body: x }); dlg.close(); toast('Saved'); route(); }));
      del.addEventListener('click', busy(del, async () => {
        if (!b) return dlg.close();
        if (!(await confirmBox('Delete ' + b.name + '?', 'Members in this batch will have no batch.', 'Delete', true))) return;
        await api('o_batch_delete', { body: { id: b.id } }); dlg.close(); toast('Deleted'); route();
      }));
    };
    frame('Batches & slots', [
      h('p', { class: 'muted small' }, 'Split members into time slots so the gym never gets too crowded. Members see their batch in the app.'),
      d.batches.length ? d.batches.map(b => {
        const pct = b.capacity ? Math.min(1, b.members / b.capacity) : 0;
        const fill = h('i'); fill.style.width = Math.round(100 * pct) + '%'; if (pct >= 1) fill.className = 'full';
        return h('div', { class: 'card batch' + (b.active ? '' : ' off') },
          h('div', { class: 'row between' }, h('div', null, h('b', null, b.name), h('div', { class: 'muted small' }, (b.starts ? b.label.split(' · ')[1] : 'No fixed time') + (b.active ? '' : ' · paused'))),
            h('div', { class: 'ptleft' }, h('b', null, b.members + (b.capacity ? '/' + b.capacity : '')), h('span', null, 'members'))),
          b.capacity ? h('div', { class: 'track' }, fill) : null,
          h('div', { class: 'btns' }, h('a', { class: 'btn sm ghost', href: '#/members/all/' + b.id }, 'See members'), h('button', { class: 'btn sm ghost', onclick: () => edit(b) }, 'Edit')));
      }) : h('div', { class: 'empty' }, 'No batches yet.'),
      d.unassigned ? h('div', { class: 'card muted small' }, d.unassigned + ' member' + (d.unassigned > 1 ? 's have' : ' has') + ' no batch. Set it from their profile → Edit.') : null,
      h('button', { class: 'btn block', onclick: () => edit(null) }, '+ New batch'),
    ], { back: '#/more' });
  };

  /* ---------- diet plans ---------- */
  routes.owner.diets = async () => {
    loading('Diet plans');
    const d = await api('o_diets');
    const edit = (x) => {
      const form = h('form', null,
        field('Plan name', h('input', { name: 'name', required: true, maxlength: 60, value: x ? x.name : '', placeholder: 'e.g. Fat loss (veg)' })),
        field('Goal (optional)', h('input', { name: 'goal', maxlength: 60, value: x && x.goal ? x.goal : '', placeholder: 'e.g. Weight loss' })),
        field('Meals: one per line, like “Breakfast: poha + 2 boiled eggs”', h('textarea', { name: 'body', rows: 10, maxlength: 3000, required: true },
          x ? x.body : 'Early morning: \nBreakfast: \nMid-morning: \nLunch: \nEvening: \nDinner: \nNotes: ')));
      const save = h('button', { class: 'btn' }, 'Save');
      const del = x ? h('button', { class: 'btn bad' }, 'Delete') : h('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
      const dlg = modal(x ? 'Edit diet plan' : 'New diet plan', form, [del, save]);
      save.addEventListener('click', busy(save, async () => { const b = formData(form); if (x) b.id = x.id; await api('o_diet_save', { body: b }); dlg.close(); toast('Saved'); route(); }));
      del.addEventListener('click', busy(del, async () => {
        if (!x) return dlg.close();
        if (!(await confirmBox('Delete ' + x.name + '?', x.members ? x.members + ' member(s) use this plan. They will have no diet plan.' : '', 'Delete', true))) return;
        await api('o_diet_delete', { body: { id: x.id } }); dlg.close(); toast('Deleted'); route();
      }));
    };
    frame('Diet plans', [
      h('p', { class: 'muted small' }, 'Make a few standard diet charts, then pick one for each member (Members → profile → Edit). They see it in their app.'),
      d.diets.length ? h('div', { class: 'list' }, d.diets.map(x => h('button', { class: 'item', onclick: () => edit(x) }, h('div', { class: 'ico' }, icon('leaf')),
        h('div', { class: 'grow' }, h('div', { class: 't' }, x.name), h('div', { class: 's' }, (x.goal ? x.goal + ' · ' : '') + x.members + ' member' + (x.members === 1 ? '' : 's'))), '›')))
        : h('div', { class: 'empty' }, 'No diet plans yet.'),
      h('button', { class: 'btn block', onclick: () => edit(null) }, '+ New diet plan'),
    ], { back: '#/more' });
  };

  /* ---------- offers & coupons ---------- */
  routes.owner.coupons = async () => {
    loading('Offers');
    const d = await api('o_coupons');
    const appliesTxt = { renewal: 'Renewals', joining: 'New joinings', both: 'Joining + renewals' };
    const edit = (c) => {
      const form = h('form', null,
        field('Code members type', h('input', { name: 'code', required: true, maxlength: 20, autocapitalize: 'characters', value: c ? c.code : '', placeholder: 'e.g. DIWALI15' })),
        h('div', { class: 'row' },
          h('label', { class: 'f grow' }, 'Discount type', h('select', { name: 'kind' }, h('option', { value: 'percent', selected: !c || c.kind === 'percent' }, '% off'), h('option', { value: 'flat', selected: c && c.kind === 'flat' }, '₹ off'))),
          h('label', { class: 'f grow' }, 'Value', h('input', { name: 'value', inputmode: 'numeric', required: true, value: c ? c.value : '' }))),
        field('Use for', h('select', { name: 'applies' }, Object.keys(appliesTxt).map(k => h('option', { value: k, selected: c ? c.applies === k : k === 'renewal' }, appliesTxt[k])))),
        h('div', { class: 'row' },
          h('label', { class: 'f grow' }, 'Valid till (optional)', h('input', { name: 'valid_till', type: 'date', value: c && c.valid_till ? c.valid_till : '' })),
          h('label', { class: 'f grow' }, 'Max uses (optional)', h('input', { name: 'max_uses', inputmode: 'numeric', value: c && c.max_uses ? c.max_uses : '' }))),
        field('Short message (optional)', h('input', { name: 'note', maxlength: 100, value: c && c.note ? c.note : '', placeholder: 'e.g. Diwali offer on all plans' })),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'show_in_app', checked: c ? c.show_in_app : true }), 'Show this offer to members in the app'),
        c ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'active', checked: c.active }), 'Active') : null);
      const save = h('button', { class: 'btn' }, 'Save');
      const del = c ? h('button', { class: 'btn bad' }, 'Delete') : h('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
      const dlg = modal(c ? 'Edit coupon' : 'New coupon', form, [del, save]);
      save.addEventListener('click', busy(save, async () => { const b = formData(form); b.show_in_app = !!b.show_in_app; if (c) { b.id = c.id; b.active = !!b.active; } await api('o_coupon_save', { body: b }); dlg.close(); toast('Saved'); route(); }));
      del.addEventListener('click', busy(del, async () => {
        if (!c) return dlg.close();
        const r = await api('o_coupon_delete', { body: { id: c.id } }); dlg.close(); toast(r.hidden ? 'Turned off (it was already used, so history is kept)' : 'Deleted'); route();
      }));
    };
    const share = c => 'https://wa.me/?text=' + encodeURIComponent('🔥 ' + S.gym + ' offer: ' + c.label + (c.note ? ' – ' + c.note : '') + '! Use code ' + c.code + (c.valid_till ? ' till ' + fmtDate(c.valid_till) : '') + '.\n' + APP_URL + (c.applies === 'joining' ? '#/join' : ''));
    frame('Offers & coupons', [
      h('p', { class: 'muted small' }, 'Make discount codes for festivals or walk-in offers. Members type the code when renewing in the app, or you enter it at the counter.'),
      d.coupons.length ? d.coupons.map(c => h('div', { class: 'card coupon' + (c.active && !c.expired ? '' : ' off') },
        h('div', { class: 'row between' }, h('div', null, h('div', { class: 'ccode' }, c.code), h('div', { class: 'muted small' }, appliesTxt[c.applies] + (c.valid_till ? ' · till ' + fmtDate(c.valid_till) : ''))),
          h('div', { class: 'clabel' }, c.label)),
        c.note ? h('div', { class: 'small' }, c.note) : null,
        h('div', { class: 'muted small' }, 'Used ' + c.uses + (c.max_uses ? '/' + c.max_uses : '') + ' times · discount given ' + fmtMoney(c.saved) + (c.show_in_app ? ' · shown in app' : '') + (!c.active ? ' · off' : c.expired ? ' · expired' : '')),
        h('div', { class: 'btns' }, h('a', { class: 'btn sm wa', href: share(c), target: '_blank', rel: 'noopener' }, 'Share offer'), h('button', { class: 'btn sm ghost', onclick: () => edit(c) }, 'Edit'))))
        : h('div', { class: 'empty' }, 'No coupons yet.'),
      h('button', { class: 'btn block', onclick: () => edit(null) }, '+ New coupon'),
    ], { back: '#/more' });
  };

  /* ---------- freeze requests ---------- */
  routes.owner.freezes = async () => {
    loading('Freeze requests');
    const d = await api('o_freeze_requests');
    const decide = (r, decision) => async () => {
      const x = await api('o_freeze_decide', { body: { id: r.id, decision } });
      toast(decision === 'approve' ? 'Frozen till ' + fmtDate(x.freeze_until) + '. It resumes by itself.' : 'Request declined'); route();
    };
    frame('Freeze requests', [
      h('p', { class: 'muted small' }, 'Members can ask to pause their membership (up to ' + (d.max_days || 'any number of') + ' days a year; change this in Plans & fees). When approved, the paused days are added back automatically.'),
      d.requests.length ? d.requests.map(r => {
        const a = h('button', { class: 'btn sm good' }, 'Approve'); a.addEventListener('click', busy(a, decide(r, 'approve')));
        const n = h('button', { class: 'btn sm ghost' }, 'Decline'); n.addEventListener('click', busy(n, decide(r, 'reject')));
        return h('div', { class: 'card' },
          h('div', { class: 'row between' }, h('div', null, h('a', { href: '#/member/' + r.member_id }, h('b', null, r.name)), h('div', { class: 'muted small' }, r.code + ' · asked ' + fmtDateTime(r.created_at))),
            h('div', { class: 'ptleft' }, h('b', null, r.days), h('span', null, 'days'))),
          r.reason ? h('div', { class: 'small' }, '“' + r.reason + '”') : null,
          h('div', { class: 'muted small' }, 'Used this year: ' + r.used + ' days · expiry now ' + fmtDate(r.expiry_date)),
          h('div', { class: 'btns three' }, a, n, h('a', { class: 'btn sm wa', href: waLink(r.phone, 'Hi ' + r.name.split(' ')[0] + ', about your freeze request at ' + S.gym + ': '), target: '_blank', rel: 'noopener' }, 'WhatsApp')));
      }) : h('div', { class: 'empty' }, 'No freeze requests right now.'),
    ], { back: '#/more' });
  };

  /* ---------- plans ---------- */
  function admissionCard() {
    const inp = h('input', { inputmode: 'numeric', placeholder: '0 = no admission fee' });
    const ref = h('input', { inputmode: 'numeric', placeholder: '0 = off' });
    const frz = h('input', { inputmode: 'numeric', placeholder: '0 = no limit' });
    api('o_prefs', { body: {} }).then(r => { inp.value = r.admission_fee || ''; ref.value = r.referral_days; frz.value = r.freeze_max_days; }).catch(() => {});
    const save = h('button', { class: 'btn block' }, 'Save rules');
    save.addEventListener('click', busy(save, async () => {
      await api('o_prefs', { body: { admission_fee: inp.value.trim() || '0', referral_days: ref.value.trim() || '0', freeze_max_days: frz.value.trim() || '0' } });
      toast('Rules saved');
    }));
    return h('div', { class: 'card' }, h('h3', null, 'Fees & rules'),
      h('label', { class: 'f' }, 'Admission fee (₹)', inp),
      h('p', { class: 'muted small' }, 'One-time joining fee. Tick “Charge admission fee” when adding a member and it is added to their first payment.'),
      h('label', { class: 'f' }, 'Refer & earn: free days per friend who joins', ref),
      h('label', { class: 'f' }, 'Freeze: most days a member can pause per year', frz),
      save);
  }
  routes.owner.plans = async () => {
    loading('Plans');
    const d = await api('o_plans');
    const edit = p => {
      const form = h('form', null,
        field('Plan name', h('input', { name: 'name', required: true, value: p ? p.name : '', maxlength: 60 })),
        field('Months', h('input', { name: 'months', inputmode: 'numeric', required: true, value: p ? p.months : 1 })),
        field('Fee (₹)', h('input', { name: 'fee', inputmode: 'numeric', required: true, value: p ? p.fee : '' })),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'active', checked: p ? p.active == 1 : true }), 'Available for new joinings and renewals'),
        h('p', { class: 'muted small' }, 'A new fee applies to new joinings and renewals only. Past payments are not changed.'));
      const save = h('button', { class: 'btn' }, 'Save');
      const dlg = modal(p ? 'Edit plan' : 'New plan', form, [h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'), save]);
      save.addEventListener('click', busy(save, async () => { await api('o_plan_save', { body: Object.assign(formData(form), p ? { id: p.id } : {}) }); dlg.close(); toast('Plan saved'); route(); }));
    };
    frame('Plans & fees', [
      h('div', { class: 'list' }, d.plans.map(p => h('button', { class: 'item', onclick: () => edit(p) },
        h('div', { class: 'grow' }, h('div', { class: 't' }, p.name), h('div', { class: 's' }, p.months + ' month' + (p.months > 1 ? 's' : ''))),
        h('b', null, fmtMoney(p.fee)), p.active == 1 ? null : h('span', { class: 'badge' }, 'Hidden')))),
      h('button', { class: 'btn block', onclick: () => edit(null) }, '+ New plan'),
      admissionCard(),
    ], { back: '#/more' });
  };

  /* ---------- shop (owner) ---------- */
  function orderRow(o) {
    return h('div', { class: 'item' }, h('div', { class: 'grow' },
      h('div', { class: 't' }, fmtMoney(o.total) + ' · ' + o.items.map(i => i.qty + '× ' + i.name).join(', ')),
      h('div', { class: 's' }, fmtDateTime(o.created_at) + ' · ' + (o.pay_mode === 'counter' ? 'Pay at counter' : 'UPI'))), badge(o.status));
  }

  routes.owner.shop = async (tab) => {
    tab = tab || 'products';
    loading('Shop');
    const seg = h('div', { class: 'seg' }, [['products', 'Products'], ['orders', 'Open orders'], ['done', 'Completed']].map(([k, l]) =>
      h('button', { class: k === tab ? 'on' : '', onclick: () => { location.hash = '#/shop/' + k; } }, l)));
    if (tab === 'products') {
      const d = await api('o_products');
      frame('Shop', [seg,
        d.products.length ? h('div', { class: 'list' }, d.products.map(p => h('a', { class: 'item', href: '#/product/' + p.id },
          h('div', { class: 'avatar' }, photoUrl(p.photo) ? h('img', { src: photoUrl(p.photo), alt: '', width: 40, height: 40, class: 'avatar' }) : initials(p.name)),
          h('div', { class: 'grow' }, h('div', { class: 't' }, p.name), h('div', { class: 's' }, p.category + ' · ' + (p.stock > 0 ? p.stock + ' in stock' : 'Out of stock'))),
          h('b', null, fmtMoney(p.price)), p.visible ? null : h('span', { class: 'badge' }, 'Hidden')))) : h('div', { class: 'empty' }, 'No products yet.'),
        h('a', { class: 'btn block', href: '#/product/new' }, '+ Add product'),
      ], { back: '#/more' });
      return;
    }
    const d = await api('o_orders', { query: { status: tab === 'orders' ? 'open' : 'handed' } });
    const card = o => {
      const box = h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('div', null, h('b', null, o.member_name), h('div', { class: 'muted small' }, fmtDateTime(o.created_at))), badge(o.status)),
        h('ul', { class: 'small' }, o.items.map(i => h('li', null, i.qty + ' × ' + i.name + ' — ' + fmtMoney(i.qty * i.price)))),
        h('div', { class: 'row between' }, h('span', { class: 'muted small' }, o.pay_mode === 'counter' ? 'Will pay at counter' : (o.waiting_payment ? 'Paid by UPI – confirm in Payments' : 'UPI not paid yet')), h('b', null, fmtMoney(o.total))));
      const acts = [];
      if (o.status === 'new' && o.waiting_payment) acts.push(h('a', { class: 'btn', href: '#/payments' }, 'Confirm payment'));
      if (o.status === 'new' && !o.waiting_payment) {
        const paid = h('button', { class: 'btn good' }, 'Paid at counter');
        paid.addEventListener('click', busy(paid, async () => {
          if (!(await confirmBox('Payment received?', 'Mark ' + fmtMoney(o.total) + ' as received at the counter? Stock will be reduced.', 'Yes, paid'))) return;
          const r = await api('o_order_status', { body: { id: o.id, status: 'paid_counter', mode: 'cash' } });
          toast('Order paid'); location.hash = '#/receipt/' + r.receipt_id;
        }));
        const cancel = h('button', { class: 'btn bad' }, 'Cancel order');
        cancel.addEventListener('click', busy(cancel, async () => {
          if (!(await confirmBox('Cancel this order?', 'The member will see it as cancelled.', 'Cancel order', true))) return;
          await api('o_order_status', { body: { id: o.id, status: 'cancelled' } }); toast('Order cancelled'); route();
        }));
        acts.push(cancel, paid);
      }
      if (o.status === 'paid') {
        const handed = h('button', { class: 'btn' }, 'Handed over');
        handed.addEventListener('click', busy(handed, async () => { await api('o_order_status', { body: { id: o.id, status: 'handed' } }); toast('Done'); route(); }));
        acts.push(h('a', { class: 'btn wa', href: waLink(o.member_phone, 'Namaste ' + o.member_name.split(' ')[0] + '! Aapka order ready hai. Gym se collect kar lijiye. – ' + S.gym), target: '_blank', rel: 'noopener' }, 'Tell member'), handed);
      }
      if (acts.length) box.append(h('div', { class: 'btns' }, acts));
      return box;
    };
    frame('Shop', [seg, d.orders.length ? d.orders.map(card) : h('div', { class: 'empty' }, 'No orders here.')], { back: '#/more' });
  };

  /** Resize any photo to max 800px and re-save it as a fresh JPEG (this also strips hidden data), then upload. */
  async function uploadPhoto(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('not_an_image');
    if (file.size > 15 * 1024 * 1024) throw new Error('photo_too_big');
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('not_an_image')); i.src = URL.createObjectURL(file); });
    const scale = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale)); c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
    if (!blob || blob.size > 1024 * 1024) throw new Error('photo_too_big');
    const name = CFG.slug + '/' + (crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, x => (x ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> x / 4).toString(16))) + '.jpg';
    const { error } = await sb.storage.from('products').upload(name, blob, { contentType: 'image/jpeg', upsert: false });
    if (error) throw new Error('upload_failed');
    return name;
  }
  function removePhotos(names) {
    const ok = (names || []).filter(n => /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]\/[a-f0-9-]{36}\.jpg$/.test(n) && n.split('/')[0] === CFG.slug);
    if (ok.length && sb) sb.storage.from('products').remove(ok).catch(() => {});
  }

  routes.owner.product = async (id) => {
    loading('Product');
    const isNew = id === 'new';
    const p = isNew ? null : (await api('o_products')).products.find(x => String(x.id) === String(id));
    if (!isNew && !p) { location.hash = '#/shop'; return; }
    const cats = ['Supplements', 'Accessories', 'Clothing', 'Drinks & snacks', 'Other'];
    const preview = h('div', { class: 'pimg qrbox' }, p && photoUrl(p.photo) ? h('img', { src: photoUrl(p.photo), alt: '' }) : 'Photo');
    const photo = h('input', { type: 'file', name: 'photo', accept: 'image/jpeg,image/png,image/webp' });
    photo.addEventListener('change', () => { const f = photo.files[0]; if (f) preview.replaceChildren(h('img', { src: URL.createObjectURL(f), alt: '' })); });
    const save = h('button', { class: 'btn block', type: 'submit' }, 'Save product');
    const form = h('form', null,
      preview, field('Photo (optional)', photo),
      field('Product name', h('input', { name: 'name', required: true, maxlength: 100, value: p ? p.name : '' })),
      field('Category', h('select', { name: 'category' }, cats.map(c => h('option', { selected: p && p.category === c }, c)))),
      field('Price (₹)', h('input', { name: 'price', inputmode: 'numeric', required: true, value: p ? p.price : '' })),
      field('Stock (how many you have)', h('input', { name: 'stock', inputmode: 'numeric', required: true, value: p ? p.stock : '' })),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'visible', checked: p ? p.visible : true }), 'Show in member shop'),
      save);
    form.addEventListener('submit', busy(save, async () => {
      const o = formData(form);
      const body = { name: o.name, category: o.category, price: o.price, stock: o.stock, visible: !!o.visible };
      if (!isNew) body.id = p.id;
      if (photo.files[0]) body.photo = await uploadPhoto(photo.files[0]);
      const r = await api('o_product_save', { body });
      if (r.old_photo) removePhotos([r.old_photo]);
      toast('Product saved'); location.hash = '#/shop/products';
    }));
    const del = isNew ? null : h('button', { class: 'btn bad block' }, 'Delete product');
    if (del) del.addEventListener('click', busy(del, async () => {
      if (!(await confirmBox('Delete product?', 'If it was ever ordered, it is hidden instead so order history stays correct.', 'Delete', true))) return;
      const r = await api('o_product_delete', { body: { id: p.id } });
      if (r.photo) removePhotos([r.photo]);
      toast(r.hidden ? 'Product hidden (it has past orders)' : 'Product deleted'); location.hash = '#/shop/products';
    }));
    frame(isNew ? 'Add product' : 'Edit product', [h('div', { class: 'card' }, form), del], { back: '#/shop/products' });
  };

  /* ---------- notices ---------- */
  routes.owner.notices = async () => {
    loading('Announcements');
    const d = await api('o_announcements');
    const ta = h('textarea', { name: 'body', maxlength: 500, placeholder: 'e.g. Gym closed on Sunday for Diwali' });
    const pin = h('input', { type: 'checkbox', name: 'pinned' });
    const post = h('button', { class: 'btn block' }, 'Post');
    post.addEventListener('click', busy(post, async () => { await api('o_announcement_save', { body: { body: ta.value, pinned: pin.checked } }); toast('Posted'); route(); }));
    frame('Announcements', [
      h('div', { class: 'card' }, field('New announcement', ta), h('label', { class: 'chk' }, pin, 'Pin to top'), post),
      d.notices.length ? h('div', { class: 'list' }, d.notices.map(n => {
        const del = h('button', { class: 'btn bad sm' }, 'Delete');
        del.addEventListener('click', busy(del, async () => { if (!(await confirmBox('Delete announcement?', n.body, 'Delete', true))) return; await api('o_announcement_delete', { body: { id: n.id } }); route(); }));
        return h('div', { class: 'item' }, h('div', { class: 'grow' }, h('div', null, (n.pinned == 1 ? '📌 ' : '') + n.body), h('div', { class: 's' }, fmtDateTime(n.created_at))), del);
      })) : h('div', { class: 'empty' }, 'No announcements.'),
    ], { back: '#/more' });
  };

  /* ---------- reports ---------- */
  routes.owner.reports = async (month) => {
    month = /^\d{4}-\d{2}$/.test(month || '') ? month : todayISO().slice(0, 7);
    loading('Reports');
    const d = await api('o_report', { query: { month } });
    const picker = h('input', { type: 'month', value: month, class: 'search' });
    picker.addEventListener('change', () => { if (picker.value) location.hash = '#/reports/' + picker.value; });
    const tile = (n, l, cls) => h('div', { class: 'tile ' + (cls || '') }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));
    frame('Reports', [
      picker,
      h('div', { class: 'tiles' },
        tile(fmtMoney(d.membership + d.shop), 'Total collected', 'good'), tile(d.joined, 'New members', 'info'),
        tile(d.renewals, 'Membership payments'), tile(fmtMoney(d.shop), 'Shop sales')),
      h('div', { class: 'card' }, h('h3', null, 'By payment mode'),
        d.by_mode.length ? h('dl', { class: 'kv' }, d.by_mode.map(r => [h('dt', null, r.mode.toUpperCase()), h('dd', null, fmtMoney(r.amount))])) : h('div', { class: 'muted' }, 'No payments this month.')),
      h('div', { class: 'card' }, h('h3', null, 'Best-selling products'),
        d.best.length ? h('dl', { class: 'kv' }, d.best.map(r => [h('dt', null, r.name), h('dd', null, r.qty + ' sold · ' + fmtMoney(r.amount))])) : h('div', { class: 'muted' }, 'No shop sales this month.')),
      h('div', { class: 'card' }, h('h3', null, 'Active members by plan (today)'),
        d.by_plan.length ? h('dl', { class: 'kv' }, d.by_plan.map(r => [h('dt', null, r.plan), h('dd', null, r.members)])) : h('div', { class: 'muted' }, 'No active members.')),
    ], { back: '#/more' });
  };

  /* ---------- exports (built in the browser from data the database sends) ---------- */
  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // stop Excel from treating it as a formula
    return '"' + s.replace(/"/g, '""') + '"';
  }
  async function exportData(type) {
    const d = await api('o_export', { body: { type } });
    const stamp = todayISO();
    if (type === 'backup') return download('gym-backup-' + stamp + '.json', JSON.stringify(d, null, 2), 'application/json');
    const cols = type === 'members'
      ? ['code', 'name', 'phone', 'plan', 'fee', 'start_date', 'expiry_date', 'dues', 'status', 'birthday', 'notes']
      : ['receipt_no', 'member_code', 'member_name', 'kind', 'plan_name', 'amount', 'mode', 'status', 'utr', 'period_from', 'period_to', 'created_at', 'decided_at'];
    const lines = [cols.join(',')].concat(d.rows.map(r => cols.map(c => csvCell(r[c])).join(',')));
    download('gym-' + type + '-' + stamp + '.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv');
  }

  /* ---------- settings ---------- */
  routes.owner.settings = async () => {
    loading('Settings');
    const d = await api('o_settings');
    const s = d.settings;
    const save = h('button', { class: 'btn block', type: 'submit' }, 'Save settings');
    const labels = { soon: 'Ending in 1–3 days', today: 'Ending today', expired: 'Expired', winback: 'Win back', dues: 'Payment due', birthday: 'Birthday' };
    const form = h('form', null,
      field('Gym name', h('input', { name: 'gym_name', required: true, value: s.gym_name, maxlength: 80 })),
      field('Address', h('input', { name: 'gym_address', value: s.gym_address, maxlength: 200 })),
      field('Timings', h('input', { name: 'gym_timings', value: s.gym_timings, maxlength: 120 })),
      field('Gym WhatsApp number', h('input', { name: 'gym_whatsapp', inputmode: 'tel', value: shortPhone(s.gym_whatsapp) })),
      field('Google Maps link (optional)', h('input', { name: 'gym_maps', value: s.gym_maps, placeholder: 'https://maps.app.goo.gl/…' })),
      field('UPI ID (payments go here)', h('input', { name: 'upi_id', value: s.upi_id, placeholder: 'gymname@okaxis', autocapitalize: 'off' })),
      field('Name shown on UPI', h('input', { name: 'upi_name', value: s.upi_name, maxlength: 60 })),
      h('div', { class: 'section' }, 'WhatsApp messages'),
      h('p', { class: 'muted small' }, 'You can use {name}, {gym}, {expiry}, {amount} and {link}.'),
      Object.keys(labels).map(k => field(labels[k], h('textarea', { 'data-tpl': k, maxlength: 600 }, d.templates[k]))),
      save);
    form.addEventListener('submit', busy(save, async () => {
      const body = formData(form);
      body.templates = {};
      form.querySelectorAll('textarea[data-tpl]').forEach(t => { body.templates[t.getAttribute('data-tpl')] = t.value; });
      await api('o_settings_save', { body });
      S.gym = body.gym_name; S.cache = {}; toast('Settings saved'); route();
    }));

    const pw = h('form', null,
      field('Current password', h('input', { type: 'password', name: 'old', required: true, autocomplete: 'current-password' })),
      field('New password (10+ characters)', h('input', { type: 'password', name: 'new', required: true, minlength: 10, autocomplete: 'new-password' })));
    const pwBtn = h('button', { class: 'btn ghost block', type: 'submit' }, 'Change password');
    pw.append(pwBtn);
    pw.addEventListener('submit', busy(pwBtn, async () => {
      const f = formData(pw);
      if (f.new.length < 10) throw new Error('password_too_short');
      const check = await sb.auth.signInWithPassword({ email: d.owner.email, password: f.old });
      if (check.error) throw new Error('wrong_old_password');
      const { error } = await sb.auth.updateUser({ password: f.new });
      if (error) throw new Error('server_error');
      await sb.auth.signOut({ scope: 'others' });
      pw.reset(); toast('Password changed. Other devices were logged out.');
    }));

    const dl = (type, label) => { const b = h('button', { class: 'btn ghost' }, label); b.addEventListener('click', busy(b, () => exportData(type))); return b; };
    const demoBtn = h('button', { class: 'btn bad block' }, 'Remove demo data');
    demoBtn.addEventListener('click', busy(demoBtn, async () => {
      if (!(await confirmBox('Remove demo data?', 'All fake members, their payments, demo products and demo announcements will be deleted. Your real data stays.', 'Remove', true))) return;
      const r = await api('o_remove_demo', { body: {} });
      removePhotos(r.photos); toast('Demo data removed'); route();
    }));
    frame('Settings', [
      h('div', { class: 'card' }, form),
      h('div', { class: 'section' }, 'Backup'),
      h('div', { class: 'card' }, h('p', { class: 'muted small' }, 'Last full backup: ' + (d.last_backup ? fmtDate(d.last_backup) : 'never') + '. Download one every month and keep it in Google Drive.'),
        h('div', { class: 'btns' }, dl('backup', 'Full backup'), dl('members', 'Members CSV'), dl('payments', 'Payments CSV'))),
      h('div', { class: 'section' }, 'Owner login'),
      h('div', { class: 'card' }, h('p', { class: 'muted small' }, d.owner.name + ' · ' + d.owner.email), pw),
      h('div', { class: 'section' }, 'Demo'),
      h('div', { class: 'card' }, demoBtn),
    ], { back: '#/more' });
  };

  /* ================================================================== *
   * MEMBER
   * ================================================================== */
  routes.member = {};

  routes.member.home = async () => {
    loading('Home');
    const [d, st, ex] = await Promise.all([api('m_home'), api('m_stats'), api('m_extra')]);
    S.cache.home = d; S.cache.stats = st; S.cache.extra = ex;
    const m = d.member;
    const color = m.status === 'frozen' ? '#4aa8ff' : m.days_left > 7 ? null : m.days_left >= 0 ? '#ffb020' : '#ff4d6d';
    const pct = m.status === 'frozen' ? 1 : Math.max(0, m.days_left) / st.plan_days;
    const t = todayISO();
    const monday = new Date(Date.parse(t + 'T00:00:00Z') - ((new Date(t + 'T00:00:00Z').getUTCDay() + 6) % 7) * 864e5);
    const week = DAY_NAMES.map((dn, i) => { const iso = new Date(monday.getTime() + i * 864e5).toISOString().slice(0, 10);
      return h('div', { class: (st.week.indexOf(iso) >= 0 ? 'on ' : '') + (iso === t ? 'today' : '') }, h('i'), dn.slice(0, 1)); });
    const earned = st.badges.filter(b => b.got);
    const canCheckin = m.status !== 'frozen' && m.days_left >= 0;
    frame('Hi, ' + m.name.split(' ')[0] + ' 👋', [
      h('div', { class: 'hero' },
        h('div', { class: 'row' },
          h('div', { class: 'ringwrap' }, ring(pct, 132, color), h('div', { class: 'ringtxt' },
            h('b', null, m.status === 'frozen' ? '❄' : Math.abs(m.days_left)), h('span', null, m.status === 'frozen' ? 'paused' : m.days_left >= 0 ? 'days left' : 'days over'))),
          h('div', { class: 'grow' },
            h('div', { class: 'hello' }, m.plan || 'Membership'),
            h('h2', null, st.streak ? h('span', null, h('span', { class: 'flame' }, '🔥'), ' ' + st.streak + '-day streak') : 'Let’s go!'),
            h('div', { class: 'muted small' }, m.status === 'frozen' && ex.freeze.until ? 'Paused till ' + fmtDate(ex.freeze.until) : 'Valid till ' + fmtDate(m.expiry_date)),
            h('div', { class: 'small row' }, badge(m.status), ex.batch ? h('span', { class: 'chip sm' }, '⏰ ' + ex.batch.split(' · ')[0]) : null))),
        h('div', { class: 'week' }, week),
        h('div', { class: 'statrow' },
          h('div', { class: 'stat' }, h('b', null, st.month), h('span', null, 'This month')),
          h('div', { class: 'stat' }, h('b', null, st.best_streak), h('span', null, 'Best streak')),
          h('div', { class: 'stat' }, h('b', null, earned.length + '/' + st.badges.length), h('span', null, 'Badges')))),
      canCheckin ? (st.checked_in_today ? h('div', { class: 'checkin-btn done' }, '✓ Checked in today. Crush it!')
        : h('a', { class: 'checkin-btn', href: '#/checkin' }, '🔥 Check in')) : null,
      st.workout_today ? h('div', { class: 'card workout' }, h('div', { class: 'ico' }, workoutIcon(st.workout_today)),
        h('div', { class: 'grow' }, h('div', { class: 'hello' }, 'Today’s workout'), h('b', null, st.workout_today))) : null,
      ex.pt ? h('div', { class: 'card ptmini' }, h('div', { class: 'row between' },
        h('div', null, h('div', { class: 'hello' }, 'Personal training'), h('b', null, ex.pt.left + ' of ' + ex.pt.sessions + ' sessions left'),
          h('div', { class: 'muted small' }, (ex.pt.trainer ? 'with ' + ex.pt.trainer + ' · ' : '') + 'valid till ' + fmtDate(ex.pt.expires))),
        ring(ex.pt.sessions ? ex.pt.left / ex.pt.sessions : 0, 64, '#4aa8ff'))) : null,
      ex.diet ? h('a', { class: 'card workout', href: '#/diet' }, h('div', { class: 'ico' }, '🥗'), h('div', { class: 'grow' }, h('div', { class: 'hello' }, 'Your diet plan'), h('b', null, ex.diet)), '›') : null,
      ex.offers.length && !d.waiting.length ? h('a', { class: 'card offer', href: '#/renew' }, h('div', { class: 'ico' }, '🏷️'),
        h('div', { class: 'grow' }, h('b', null, ex.offers[0].label + ' with code ' + ex.offers[0].code), h('div', { class: 'small' }, ex.offers[0].note || 'Use it when you renew' + (ex.offers[0].valid_till ? ' · till ' + fmtDate(ex.offers[0].valid_till) : ''))), '›') : null,
      m.dues > 0 ? h('div', { class: 'card' }, h('b', null, 'Payment due: ' + fmtMoney(m.dues)), h('div', { class: 'muted small' }, 'Please pay to keep your membership active.')) : null,
      d.waiting.length ? h('div', { class: 'card' }, h('b', null, 'Waiting for confirmation'), d.waiting.map(p => h('div', { class: 'muted small' }, fmtMoney(p.amount) + ' · sent ' + fmtDateTime(p.created_at))),
        h('div', { class: 'muted small' }, 'The gym will confirm after checking the payment.')) : null,
      !d.waiting.length && (m.dues > 0 || m.days_left <= 7) ? h('a', { class: 'btn block', href: '#/renew' }, m.dues > 0 ? 'Pay ' + fmtMoney(m.dues) : 'Renew membership') : null,
      d.notices.length ? [h('div', { class: 'section' }, 'Announcements'), h('div', { class: 'list' }, d.notices.map(n => h('div', { class: 'item' }, h('div', { class: 'grow' },
        h('div', null, (n.pinned == 1 ? '📌 ' : '') + n.body), h('div', { class: 's' }, fmtDate(n.created_at))))))] : null,
      ex.referral_days > 0 ? h('a', { class: 'card refer', href: '#/refer' }, h('div', { class: 'ico' }, '🎁'),
        h('div', { class: 'grow' }, h('b', null, 'Bring a friend, get ' + ex.referral_days + ' free days'), h('div', { class: 'small' }, 'Share your invite link. When they join, your membership is extended.')), '›') : null,
      h('div', { class: 'section' }, 'Gym'),
      gymInfoCard(d.gym),
    ]);
  };

  routes.member.diet = async () => {
    loading('Diet plan');
    const d = (await api('m_diet')).diet;
    if (!d) { frame('Diet plan', h('div', { class: 'empty' }, 'Your gym hasn’t given you a diet plan yet. Ask your trainer!'), { back: '#/profile' }); return; }
    const meals = [], notes = [];
    d.body.split(/\r?\n/).map(x => x.trim()).filter(Boolean).forEach(line => {
      const mm = line.match(/^([^:]{2,30}):\s*(.*)$/);
      if (mm && !/^notes?$/i.test(mm[1].trim())) meals.push([mm[1].trim(), mm[2]]); else notes.push(mm ? mm[2] : line);
    });
    const emoji = t => /early|morning|wake/i.test(t) ? '🌅' : /break/i.test(t) ? '🍳' : /lunch/i.test(t) ? '🍛' : /dinner|night/i.test(t) ? '🌙' : /pre/i.test(t) ? '⚡' : /post/i.test(t) ? '🥤' : /evening|snack|mid/i.test(t) ? '🍎' : '🍽️';
    frame('Diet plan', [
      h('div', { class: 'hero' }, h('div', { class: 'hello' }, d.goal || 'Your plan'), h('h2', null, d.name), h('div', { class: 'muted small' }, 'Updated ' + fmtDate(d.updated))),
      h('div', { class: 'meals' }, meals.map(([t, food]) => h('div', { class: 'meal' }, h('div', { class: 'me' }, emoji(t)), h('div', { class: 'grow' }, h('div', { class: 'hello' }, t), h('div', null, food || '—'))))),
      notes.length ? h('div', { class: 'card' }, h('h3', null, 'Notes'), notes.map(n => h('p', { class: 'small' }, n))) : null,
      h('p', { class: 'muted small center' }, 'Follow your trainer’s advice. Tell the gym about any allergy or medical condition.'),
    ], { back: '#/profile' });
  };

  routes.member.refer = async () => {
    loading('Refer & earn');
    const r = await api('m_referrals');
    const link = APP_URL + '#/join/' + r.code;
    const msg = 'Hey! I train at ' + S.gym + ' 💪 Join me! Leave your number here and they’ll call you for a free trial: ' + link;
    frame('Refer & earn', [
      h('div', { class: 'hero center' }, h('div', { class: 'bigemoji' }, '🎁'), h('h2', null, r.days > 0 ? 'Get ' + r.days + ' free days for every friend who joins' : 'Invite your friends'),
        h('p', { class: 'muted small' }, 'Share your link. When your friend joins the gym, your membership is extended automatically.'),
        h('div', { class: 'statrow two' }, h('div', { class: 'stat' }, h('b', null, r.friends.length), h('span', null, 'Friends joined')), h('div', { class: 'stat' }, h('b', null, r.total_days), h('span', null, 'Free days earned')))),
      h('a', { class: 'btn wa block', href: 'https://wa.me/?text=' + encodeURIComponent(msg), target: '_blank', rel: 'noopener' }, 'Share on WhatsApp'),
      h('div', { class: 'row' }, h('code', { class: 'grow small' }, link), h('button', { class: 'btn sm ghost', onclick: () => navigator.clipboard.writeText(link).then(() => toast('Link copied')) }, 'Copy')),
      r.pending ? h('div', { class: 'card muted small' }, r.pending + ' friend' + (r.pending > 1 ? 's have' : ' has') + ' asked to join. You get your days when they sign up.') : null,
      r.friends.length ? [h('div', { class: 'section' }, 'Friends who joined'), h('div', { class: 'list' }, r.friends.map(f => h('div', { class: 'item' }, h('div', { class: 'avatar' }, initials(f.name)),
        h('div', { class: 'grow' }, h('div', { class: 't' }, f.name), h('div', { class: 's' }, fmtDate(f.date))), h('b', { class: 'pos-num' }, '+' + f.days + ' days'))))] : null,
    ], { back: '#/profile' });
  };

  routes.member.freeze = async () => {
    loading('Pause membership');
    const [home, ex] = await Promise.all([api('m_home'), api('m_extra')]);
    const m = home.member, f = ex.freeze;
    const left = f.max_days ? Math.max(0, f.max_days - f.used) : null;
    let body;
    if (m.status === 'frozen') {
      body = h('div', { class: 'card center' }, h('div', { class: 'bigemoji' }, '❄️'), h('h2', null, 'Your membership is paused'),
        h('p', { class: 'muted' }, f.until ? 'It starts again on ' + fmtDate(f.until) + '. The paused days are added to your expiry date.' : 'Ask the gym to resume it when you are back.'));
    } else if (f.waiting) {
      const cancel = h('button', { class: 'btn ghost block' }, 'Cancel request');
      cancel.addEventListener('click', busy(cancel, async () => { await api('m_freeze_cancel'); toast('Request cancelled'); route(); }));
      body = h('div', { class: 'card' }, h('b', null, 'Request sent: pause for ' + f.waiting.days + ' days'), h('p', { class: 'muted small' }, 'The gym will approve it soon. Sent ' + fmtDateTime(f.waiting.created_at) + '.'), cancel);
    } else if (m.days_left < 0) {
      body = h('div', { class: 'card muted' }, 'Your membership has ended, so it can’t be paused. Renew first.');
    } else {
      const form = h('form', null,
        field('Pause for how many days?', h('input', { name: 'days', inputmode: 'numeric', required: true, placeholder: left !== null ? '3 to ' + left : 'e.g. 10' })),
        field('Reason (optional)', h('input', { name: 'reason', maxlength: 200, placeholder: 'e.g. travelling home, exams, unwell' })));
      const send = h('button', { class: 'btn block', type: 'submit' }, 'Send request to gym');
      form.appendChild(send);
      form.addEventListener('submit', busy(send, async () => { await api('m_freeze_request', { body: formData(form) }); toast('Request sent'); route(); }));
      body = h('div', { class: 'card' }, form);
    }
    frame('Pause membership', [
      h('p', { class: 'muted' }, 'Going out of town, exams or unwell? Pause your membership and don’t lose your days.'),
      f.max_days ? h('div', { class: 'statrow two' }, h('div', { class: 'stat' }, h('b', null, f.used), h('span', null, 'Days used this year')), h('div', { class: 'stat' }, h('b', null, left), h('span', null, 'Days left to pause'))) : null,
      body,
    ], { back: '#/profile' });
  };

  /** Check-in: from the desk QR link (#/checkin/CODE), the in-app scanner, or by typing the code. */
  routes.member.checkin = async (code) => {
    const doCheckin = async c => {
      const r = await api('m_checkin', { body: { code: c } });
      if (r.fresh) confetti();
      frame('Checked in', [h('div', { class: 'hero center' },
        h('div', { class: 'shout gradtext' }, r.fresh ? 'YOU’RE IN!' : 'ALREADY IN'),
        h('h2', null, h('span', { class: 'flame' }, '🔥'), ' ' + r.streak + '-day streak'),
        h('p', { class: 'muted' }, r.month + ' workout' + (r.month === 1 ? '' : 's') + ' this month. Keep going!')),
        h('a', { class: 'btn block', href: '#/home' }, 'Done'), h('p'), h('a', { class: 'btn ghost block', href: '#/progress' }, 'See my progress')], { back: '#/home' });
    };
    if (code) {
      try { await doCheckin(code); } catch (e) { showErr(e); location.hash = '#/checkin'; }
      return;
    }
    const video = h('video', { class: 'scan', playsinline: true, muted: true });
    const scanBox = h('div', { class: 'card center' });
    const codeIn = h('input', { maxlength: 12, autocapitalize: 'characters', placeholder: 'e.g. 3F9A27C1' });
    const go = h('button', { class: 'btn block' }, 'Check in');
    go.addEventListener('click', busy(go, () => doCheckin(codeIn.value.trim())));
    const startScan = async () => {
      try {
        const det = new window.BarcodeDetector({ formats: ['qr_code'] });
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        let stop = false;
        S.stopScan = () => { stop = true; stream.getTracks().forEach(tr => tr.stop()); };
        video.srcObject = stream; await video.play();
        scanBox.replaceChildren(video, h('p', { class: 'muted small' }, 'Point at the QR poster at the front desk.'));
        const tick = async () => {
          if (stop) return;
          try {
            const found = await det.detect(video);
            const raw = found.length ? found[0].rawValue : '';
            const mm = raw.match(/#\/checkin\/([A-Za-z0-9]{4,12})/) || raw.match(/^([A-Za-z0-9]{8})$/);
            if (mm) { S.stopScan(); S.stopScan = null; await doCheckin(mm[1]).catch(showErr); return; }
          } catch (e) { /* keep scanning */ }
          setTimeout(tick, 250);
        };
        tick();
      } catch (e) {
        scanBox.replaceChildren(h('p', { class: 'muted' }, 'Camera not available. Use your phone’s camera app on the poster, or type the code below.'));
      }
    };
    const hasScanner = 'BarcodeDetector' in window && navigator.mediaDevices;
    scanBox.append(hasScanner ? h('button', { class: 'btn block', onclick: startScan }, '📷 Scan the desk QR')
      : h('p', { class: 'muted' }, 'Open your phone’s camera and point it at the QR poster at the front desk, or type the code below.'));
    frame('Check in', [scanBox, h('div', { class: 'card' }, field('Code on the poster', codeIn), go)], { back: '#/home' });
  };

  routes.member.progress = async () => {
    loading('Progress');
    const st = await api('m_stats');
    const kg = h('input', { inputmode: 'decimal', placeholder: 'e.g. 72.5', maxlength: 5 });
    const saveKg = h('button', { class: 'btn' }, 'Save');
    saveKg.addEventListener('click', busy(saveKg, async () => { await api('m_weight', { body: { kg: kg.value.trim() } }); toast('Weight saved'); route(); }));
    const w = st.weights;
    const change = w.length > 1 ? (w[w.length - 1].kg - w[0].kg) : 0;
    frame('Progress', [
      h('div', { class: 'hero' },
        h('div', { class: 'statrow' },
          h('div', { class: 'stat' }, h('b', null, h('span', { class: 'flame' }, '🔥'), st.streak), h('span', null, 'Streak')),
          h('div', { class: 'stat' }, h('b', null, st.month), h('span', null, 'This month')),
          h('div', { class: 'stat' }, h('b', null, st.total), h('span', null, 'All time')))),
      h('div', { class: 'section' }, 'Badges'),
      h('div', { class: 'bgrid' }, st.badges.map(b => h('div', { class: 'bdg' + (b.got ? ' got' : '') }, h('div', { class: 'medal' }, BADGE_ICON[b.id] || '★'), h('b', null, b.name), h('span', null, b.hint)))),
      h('div', { class: 'section' }, 'Body weight'),
      h('div', { class: 'card' },
        w.length ? [lineChart(w.map(x => ({ label: fmtDate(x.day).slice(0, -5), v: Number(x.kg) }))),
          w.length > 1 ? h('p', { class: 'muted small' }, (change <= 0 ? '▼ ' : '▲ ') + Math.abs(change).toFixed(1) + ' kg since ' + fmtDate(w[0].day)) : null]
          : h('p', { class: 'muted small' }, 'Log your weight every week to see your progress here.'),
        h('div', { class: 'row' }, h('label', { class: 'f grow' }, 'Today’s weight (kg)', kg), saveKg)),
      st.leaderboard ? [h('div', { class: 'section' }, 'Top this month'),
        st.leaderboard.length ? h('div', { class: 'list' }, st.leaderboard.map((x, i) => h('div', { class: 'lead p' + (i + 1) + (x.me ? ' me' : '') },
          h('div', { class: 'pos' }, i + 1), h('div', { class: 'grow' }, x.name + (x.me ? ' (you)' : '')), h('b', null, x.visits + ' 🔥'))))
          : h('div', { class: 'card muted' }, 'Be the first to check in this month!')] : null,
      h('div', { class: 'section' }, 'Weekly workout plan'),
      h('div', { class: 'list' }, DAY_NAMES.map((dn, i) => h('div', { class: 'item' }, h('b', null, dn), h('div', { class: 'grow s' }, st.workouts[String(i + 1)] || '—')))),
    ]);
  };

  function gymInfoCard(g) {
    return h('div', { class: 'card' },
      h('b', null, g.name),
      g.timings ? h('div', { class: 'small' }, '🕒 ' + g.timings) : null,
      g.address ? h('div', { class: 'small' }, '📍 ' + g.address) : null,
      h('div', { class: 'btns' },
        g.whatsapp ? h('a', { class: 'btn wa sm', href: waLink(g.whatsapp, ''), target: '_blank', rel: 'noopener' }, 'WhatsApp gym') : null,
        safeHttps(g.maps) ? h('a', { class: 'btn ghost sm', href: safeHttps(g.maps), target: '_blank', rel: 'noopener noreferrer' }, 'Directions') : null));
  }

  /** Shared payment screen: UPI app button + QR + "I've paid". */
  function payScreen(opts) {
    const upi = opts.upi;
    if (!upi || !upi.id) {
      return h('div', { class: 'card' }, h('b', null, 'Online payment is not set up yet.'), h('p', { class: 'muted small' }, 'Please pay at the gym counter.'));
    }
    const link = upiLink(upi, opts.amount, opts.note);
    const utr = h('input', { name: 'utr', inputmode: 'text', maxlength: 40, placeholder: 'e.g. 432112345678', autocapitalize: 'characters' });
    const done = h('button', { class: 'btn good block' }, 'I’ve paid ' + fmtMoney(opts.amount));
    done.addEventListener('click', busy(done, async () => {
      if (!(await confirmBox('Did the payment go through?', 'Tap Yes only after your UPI app shows the payment was successful.', 'Yes, paid'))) return;
      await opts.onPaid(utr.value.replace(/\s/g, ''));
    }));
    return h('div', null,
      h('div', { class: 'card center' },
        h('div', { class: 'muted small' }, 'Amount to pay'),
        h('div', { class: 'big-money' }, fmtMoney(opts.amount)),
        h('div', { class: 'muted small' }, 'To: ' + (upi.name || S.gym) + ' (' + upi.id + ')'),
        h('a', { class: 'btn block', href: link }, 'Pay with UPI app'),
        h('p', { class: 'muted small' }, 'Opens Google Pay, PhonePe, Paytm or your bank app with the amount filled in.'),
        h('div', { class: 'qrbox' }, qrImage(link)),
        h('p', { class: 'muted small' }, 'Or scan this QR from another phone, or show it at the counter.')),
      h('div', { class: 'card' },
        field('UPI reference / UTR number (optional, helps the gym find your payment)', utr),
        done));
  }

  routes.member.renew = async (planId) => {
    loading('Renew');
    const home = await api('m_home');
    const m = home.member;
    if (home.waiting.some(p => p.kind === 'membership')) {
      frame('Renew', h('div', { class: 'card' }, h('b', null, 'Your payment is waiting for confirmation.'), h('p', { class: 'muted small' }, 'The gym will confirm it after checking. You’ll see the new expiry date on your home screen.')));
      return;
    }
    let coupon = null;
    const onPaid = (plan) => async utr => {
      await api('m_renew', { body: { plan_id: plan, utr, coupon: coupon ? coupon.code : '' } });
      toast('Sent! The gym will confirm soon.'); location.hash = '#/home';
    };
    if (m.dues > 0) {
      frame('Pay due', payScreen({ upi: home.upi, amount: m.dues, note: S.gym + ' ' + m.code + ' due', onPaid: onPaid(null) }), { back: '#/home' });
      return;
    }
    const pr = await api('m_plans');
    const plans = pr.plans;
    const chosen = plans.find(p => String(p.id) === String(planId));
    if (chosen) {
      const payBox = h('div');
      const code = h('input', { maxlength: 20, autocapitalize: 'characters', placeholder: 'Coupon code', class: 'search grow couponin' });
      const apply = h('button', { class: 'btn ghost sm', type: 'button' }, 'Apply');
      const couponMsg = h('div', { class: 'small' });
      const draw = () => payBox.replaceChildren(payScreen({ upi: home.upi, amount: coupon ? coupon.amount : chosen.fee, note: S.gym + ' ' + m.code + ' ' + chosen.name + (coupon ? ' ' + coupon.code : ''), onPaid: onPaid(chosen.id) }));
      apply.addEventListener('click', busy(apply, async () => {
        if (!code.value.trim()) return;
        coupon = await api('m_coupon_check', { body: { code: code.value.trim(), plan_id: chosen.id } });
        couponMsg.replaceChildren(h('span', { class: 'pos-num' }, '✓ ' + coupon.code + ' applied: you save ' + fmtMoney(coupon.discount)));
        draw();
      }));
      if (pr.offers.length) code.value = pr.offers[0].code;
      draw();
      frame('Pay for ' + chosen.name, [
        h('p', { class: 'muted small' }, 'New expiry after confirmation: ' + fmtDate(addMonthsISO(m.days_left >= 0 ? m.expiry_date : todayISO(), chosen.months))),
        h('div', { class: 'card' }, h('div', { class: 'row' }, code, apply), couponMsg, pr.offers.length ? h('div', { class: 'muted small' }, 'Offer: ' + pr.offers[0].label + ' with ' + pr.offers[0].code + '. Tap Apply.') : null),
        payBox,
      ], { back: '#/renew' });
      return;
    }
    frame('Renew', [
      pr.offers.map(o => h('div', { class: 'card offer' }, h('div', { class: 'ico' }, '🏷️'), h('div', { class: 'grow' }, h('b', null, o.label + ' · code ' + o.code), h('div', { class: 'small' }, (o.note || 'Apply it on the next screen') + (o.valid_till ? ' · till ' + fmtDate(o.valid_till) : ''))))),
      h('p', { class: 'muted' }, 'Choose a plan'),
      h('div', { class: 'list' }, plans.map(p => h('a', { class: 'item', href: '#/renew/' + p.id },
        h('div', { class: 'grow' }, h('div', { class: 't' }, p.name), h('div', { class: 's' }, p.months + ' month' + (p.months > 1 ? 's' : '') + (p.id == m.plan_id ? ' · your current plan' : ''))),
        h('b', null, fmtMoney(p.fee)), '›'))),
    ]);
  };

  function addMonthsISO(iso, months) {
    const [y, mo, d] = iso.split('-').map(Number);
    const total = mo - 1 + months, ny = y + Math.floor(total / 12), nm = total % 12;
    const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return ny + '-' + String(nm + 1).padStart(2, '0') + '-' + String(Math.min(d, last)).padStart(2, '0');
  }

  /* ---------- member shop ---------- */
  function cartCount() { return Object.values(S.cart).reduce((a, b) => a + b, 0); }

  routes.member.shop = async () => {
    loading('Shop');
    const d = await api('m_products');
    S.cache.products = d.products; S.cache.upi = d.upi;
    const bar = h('div', { class: 'cartbar' });
    const drawBar = () => {
      const n = cartCount();
      const total = d.products.reduce((s, p) => s + (S.cart[p.id] || 0) * p.price, 0);
      bar.replaceChildren(n ? h('a', { class: 'btn block', href: '#/cart' }, 'View cart · ' + n + ' item' + (n > 1 ? 's' : '') + ' · ' + fmtMoney(total)) : '');
    };
    const card = p => {
      const qtyBox = h('div');
      const drawQty = () => {
        const q = S.cart[p.id] || 0;
        if (p.stock < 1) return qtyBox.replaceChildren(h('span', { class: 'badge' }, 'Out of stock'));
        qtyBox.replaceChildren(q === 0 ? h('button', { class: 'btn sm block', onclick: () => { S.cart[p.id] = 1; drawQty(); drawBar(); } }, 'Add')
          : h('div', { class: 'qty' },
            h('button', { onclick: () => { S.cart[p.id] = q - 1; if (!S.cart[p.id]) delete S.cart[p.id]; drawQty(); drawBar(); } }, '−'),
            h('b', null, q),
            h('button', { onclick: () => { if (q < Math.min(10, p.stock)) S.cart[p.id] = q + 1; drawQty(); drawBar(); } }, '+')));
      };
      drawQty();
      return h('div', { class: 'pcard' },
        h('div', { class: 'pimg' }, photoUrl(p.photo) ? h('img', { src: photoUrl(p.photo), alt: '', loading: 'lazy' }) : initials(p.name)),
        h('div', { class: 'pb' }, h('div', { class: 'muted small' }, p.category), h('div', { class: 'pn' }, p.name), h('div', { class: 'pp' }, fmtMoney(p.price)), qtyBox));
    };
    frame('Shop', [d.products.length ? h('div', { class: 'pgrid' }, d.products.map(card)) : h('div', { class: 'empty' }, 'No products yet.'), bar]);
    drawBar();
  };

  routes.member.cart = async () => {
    if (!S.cache.products) { location.hash = '#/shop'; return; }
    const items = S.cache.products.filter(p => S.cart[p.id]);
    if (!items.length) { location.hash = '#/shop'; return; }
    const total = items.reduce((s, p) => s + S.cart[p.id] * p.price, 0);
    const upiBtn = h('button', { class: 'btn block' }, 'Pay now with UPI');
    const counterBtn = h('button', { class: 'btn ghost block' }, 'Pay at the counter');
    const place = mode => async () => {
      const r = await api('m_order', { body: { pay_mode: mode, items: items.map(p => ({ id: p.id, qty: S.cart[p.id] })) } });
      S.cart = {};
      if (mode === 'counter') { toast('Order placed. Pay and collect at the gym.'); location.hash = '#/history'; return; }
      location.hash = '#/orderpay/' + r.order_id + '/' + r.total;
    };
    upiBtn.addEventListener('click', busy(upiBtn, place('upi')));
    counterBtn.addEventListener('click', busy(counterBtn, place('counter')));
    frame('Your cart', [
      h('div', { class: 'list' }, items.map(p => h('div', { class: 'item' }, h('div', { class: 'grow' }, h('div', { class: 't' }, p.name), h('div', { class: 's' }, S.cart[p.id] + ' × ' + fmtMoney(p.price))), h('b', null, fmtMoney(S.cart[p.id] * p.price))))),
      h('div', { class: 'card row between' }, h('b', null, 'Total'), h('b', { class: 'big-money' }, fmtMoney(total))),
      upiBtn, h('p'), counterBtn,
      h('p', { class: 'muted small center' }, 'Collect your items at the gym after payment.'),
    ], { back: '#/shop' });
  };

  routes.member.orderpay = async (orderId, total) => {
    const upi = S.cache.upi || (await api('m_products')).upi;
    frame('Pay for order', payScreen({ upi, amount: Number(total), note: S.gym + ' order ' + orderId, onPaid: async utr => {
      await api('m_order_paid', { body: { order_id: orderId, utr } });
      toast('Sent! The gym will confirm soon.'); location.hash = '#/history';
    } }), { back: '#/history' });
  };

  /* ---------- member history & profile ---------- */
  routes.member.history = async () => {
    loading('History');
    const d = await api('m_history');
    const orderCard = o => {
      const box = h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('b', null, fmtMoney(o.total)), badge(o.status)),
        h('div', { class: 'muted small' }, o.items.map(i => i.qty + '× ' + i.name).join(', ')),
        h('div', { class: 'muted small' }, fmtDateTime(o.created_at) + (o.status === 'paid' ? ' · Ready to collect at the gym' : '')));
      if (o.status === 'new' && !o.waiting_payment) {
        const cancel = h('button', { class: 'btn bad sm' }, 'Cancel');
        cancel.addEventListener('click', busy(cancel, async () => {
          if (!(await confirmBox('Cancel order?', 'Only cancel if you have not paid.', 'Cancel order', true))) return;
          await api('m_order_cancel', { body: { order_id: o.id } }); toast('Order cancelled'); route();
        }));
        box.append(h('div', { class: 'btns' }, cancel, h('a', { class: 'btn sm', href: '#/orderpay/' + o.id + '/' + o.total }, 'Pay by UPI')));
      } else if (o.status === 'new' && o.waiting_payment) {
        box.append(h('div', { class: 'muted small' }, 'Payment sent – waiting for the gym to confirm.'));
      }
      return box;
    };
    const openOrders = d.orders.filter(o => o.status === 'new' || o.status === 'paid');
    frame('History', [
      openOrders.length ? [h('div', { class: 'section' }, 'Open orders'), openOrders.map(orderCard)] : null,
      h('div', { class: 'section' }, 'Payments'),
      d.payments.length ? h('div', { class: 'list' }, d.payments.map(p => h(p.status === 'confirmed' ? 'a' : 'div', { class: 'item', href: p.status === 'confirmed' ? '#/receipt/' + p.id : null },
        h('div', { class: 'grow' }, h('div', { class: 't' }, fmtMoney(p.amount) + ' · ' + (p.kind === 'shop' ? 'Shop order' : payLabel(p))),
          h('div', { class: 's' }, fmtDateTime(p.decided_at || p.created_at) + (p.receipt_no ? ' · ' + p.receipt_no : ''))),
        badge(p.status)))) : h('div', { class: 'card muted' }, 'No payments yet.'),
      d.orders.length > openOrders.length ? [h('div', { class: 'section' }, 'Past orders'), h('div', { class: 'list' }, d.orders.filter(o => openOrders.indexOf(o) < 0).map(orderRow))] : null,
    ]);
  };
  routes.member.receipt = receiptPage;

  routes.member.card = async () => {
    loading('Membership card');
    const d = await api('m_home');
    const m = d.member;
    frame('Membership card', [
      h('div', { class: 'idcard' },
        h('div', { class: 'row between' }, h('div', { class: 'hello' }, d.gym.name || S.gym), badge(m.status)),
        h('div', { class: 'row idrow' },
          h('div', { class: 'grow' },
            h('div', { class: 'idname' }, m.name),
            h('div', { class: 'idcode' }, m.code),
            h('dl', { class: 'kv' }, h('dt', null, 'Plan'), h('dd', null, m.plan || '—'), h('dt', null, 'Valid till'), h('dd', null, fmtDate(m.expiry_date)))),
          h('div', { class: 'qrmini' }, qrImage('GYMCARD:' + m.code)))),
      h('p', { class: 'muted small center' }, 'Show this card at the front desk. The gym can scan it to find you and check you in.'),
      h('button', { class: 'btn ghost block noprint', onclick: () => window.print() }, 'Print / save as PDF'),
    ], { back: '#/profile' });
  };

  routes.member.profile = async () => {
    const d = S.cache.home || await api('m_home');
    const m = d.member;
    frame('Profile', [
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'avatar' }, initials(m.name)), h('div', null, h('b', null, m.name), h('div', { class: 'muted small' }, m.code + ' · +91 ' + shortPhone(m.phone))))),
      h('div', { class: 'list' },
        h('a', { class: 'item', href: '#/card' }, h('div', { class: 'ico' }, icon('idcard')), h('div', { class: 'grow t' }, 'My membership card'), '›'),
        h('a', { class: 'item', href: '#/diet' }, h('div', { class: 'ico' }, icon('leaf')), h('div', { class: 'grow t' }, 'My diet plan'), '›'),
        h('a', { class: 'item', href: '#/refer' }, h('div', { class: 'ico' }, icon('gift')), h('div', { class: 'grow t' }, 'Refer & earn'), '›'),
        h('a', { class: 'item', href: '#/freeze' }, h('div', { class: 'ico' }, icon('snow')), h('div', { class: 'grow t' }, 'Pause membership'), '›'),
        h('a', { class: 'item', href: '#/history' }, h('div', { class: 'ico' }, icon('clock')), h('div', { class: 'grow t' }, 'Payments & orders'), '›'),
        h('a', { class: 'item', href: '#/checkin' }, h('div', { class: 'ico' }, icon('qr')), h('div', { class: 'grow t' }, 'Check in'), '›'),
        h('a', { class: 'item', href: '#/pin' }, h('div', { class: 'ico' }, icon('gear')), h('div', { class: 'grow t' }, 'Change PIN'), '›'),
        themeRow()),
      gymInfoCard(d.gym),
      h('button', { class: 'btn ghost block', onclick: logoutNow }, 'Log out'),
    ]);
  };

  routes.member.pin = () => {
    const forced = S.me.pin_must_change;
    const save = h('button', { class: 'btn block', type: 'submit' }, 'Save PIN');
    const form = h('form', null,
      field(forced ? 'PIN given by the gym' : 'Current PIN', h('input', { name: 'old_pin', type: 'password', inputmode: 'numeric', maxlength: 6, required: true, autocomplete: 'current-password' })),
      field('New 6-digit PIN', h('input', { name: 'new_pin', type: 'password', inputmode: 'numeric', maxlength: 6, pattern: '\\d{6}', required: true, autocomplete: 'new-password' })),
      field('Repeat new PIN', h('input', { name: 'new_pin2', type: 'password', inputmode: 'numeric', maxlength: 6, required: true, autocomplete: 'new-password' })),
      h('p', { class: 'muted small' }, 'Don’t use your birth year, 123456 or the same digit six times.'),
      save);
    form.addEventListener('submit', busy(save, async () => {
      const f = formData(form);
      if (f.new_pin !== f.new_pin2) throw new Error('pin_mismatch');
      const r = await api('m_change_pin', { body: { old_pin: f.old_pin, new_pin: f.new_pin } });
      S.me = r.me; toast('PIN saved'); location.hash = '#/home';
    }));
    const content = [forced ? h('div', { class: 'card' }, h('b', null, 'Set your own PIN'), h('p', { class: 'muted small' }, 'For your safety, choose a new PIN that only you know.')) : null, h('div', { class: 'card' }, form)];
    if (forced) {
      $app.className = '';
      $app.replaceChildren(h('div', { class: 'login' }, h('h1', null, S.gym), content, h('button', { class: 'btn ghost block', onclick: logoutNow }, 'Log out')));
    } else {
      frame('Change PIN', content, { back: '#/profile' });
    }
  };

  /* ------------------------------------------------------------------ *
   * Start
   * ------------------------------------------------------------------ */
  if (sb) sb.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') { S.recovery = true; newPasswordPage(); } });
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  boot();
})();
