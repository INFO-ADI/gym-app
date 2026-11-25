/* A gym owner sets up their app with the setup code from the platform admin.
   The code works once; the database checks it (wrong codes are slowed down and limited). */
(function () {
  'use strict';
  const CFG = window.GYM_CONFIG || {};
  const $ = id => document.getElementById(id);
  const APP_URL = CFG.base || './';
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) { const v = attrs[k]; if (v == null || v === false) continue; if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : v); }
    kids.flat().forEach(k => { if (k != null && k !== false) el.append(k instanceof Node ? k : String(k)); });
    return el;
  }
  function status(title, text, cls, extra) {
    $('status').className = 'card ' + (cls || '');
    $('status').replaceChildren(h('h2', null, title), text ? h('p', null, text) : null, extra || null);
  }
  const ERR = {
    wrong_setup_code: 'That setup code is wrong or has expired. Ask your app provider for a new one.',
    too_many_attempts: 'Too many wrong tries. Wait 15 minutes and try again.',
    gym_not_found: 'This gym was not found. Check the link.',
    owner_name_required: 'Enter your name.', gym_name_required: 'Enter the gym name.',
    bad_upi: 'UPI ID looks wrong. It should look like name@okaxis.', bad_phone: 'WhatsApp number should be a 10-digit mobile number.',
    add_at_least_one_plan: 'Add at least one plan.', bad_plan_months: 'Plan months must be between 1 and 36.', bad_plan_fee: 'Check the plan fees.',
    not_logged_in: 'Could not log you in. Try again.',
  };

  if (!CFG.url || !window.supabase) { status('Not connected', 'This page could not load its settings. Reload the page.', 'err'); return; }
  const sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, storageKey: 'gym-auth-' + CFG.slug } });
  let claimed = false;

  // the code arrives in the link as #code=XXXX-...
  const m = location.hash.match(/code=([A-Za-z0-9-]{8,30})/);
  if (m) $('form').elements.code.value = m[1].toUpperCase();
  $('form').elements.gym_name.value = CFG.name || '';

  const defaults = [['Monthly', 1, 1000], ['Quarterly', 3, 2700], ['Half-yearly', 6, 5000], ['Yearly', 12, 9000], ['', '', ''], ['', '', '']];
  $('plans').append(...defaults.map(([n, mo, f]) => h('div', { class: 'row plan-row' },
    h('input', { class: 'grow', 'data-p': 'name', value: n, placeholder: 'Plan name', maxlength: 60 }),
    h('input', { 'data-p': 'months', value: mo, placeholder: 'Months', inputmode: 'numeric', size: 4 }),
    h('input', { 'data-p': 'fee', value: f, placeholder: 'Fee ₹', inputmode: 'numeric', size: 6 }))));

  async function start() {
    const r = await sb.rpc('site_api', { p_action: 'brand', p_in: { slug: CFG.slug } });
    if (r.error || !r.data) throw new Error('network');
    if (!r.data.ok) { status('Gym not found', ERR.gym_not_found, 'err'); return; }
    claimed = !!r.data.data.claimed;
    if (claimed) {
      // already set up: a fresh code from the admin adds one more owner login (e.g. a partner)
      $('gymbox').remove();
      $('loginTitle').textContent = '2. Your owner login';
      $('go').textContent = 'Add my owner login';
      status('This gym is already set up', 'If your app provider gave you a new setup code, you can add your own owner login below. Otherwise just open the app.', 'ok',
        h('a', { class: 'btn ghost', href: './' }, 'Open the app'));
    } else {
      $('status').className = 'hidden';
    }
    $('form').className = '';
  }

  $('form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const btn = $('go'); const errBox = $('err'); const label = btn.textContent;
    errBox.className = 'err-text hidden';
    const f = Object.fromEntries(new FormData($('form')).entries());
    const fail = msg => { errBox.textContent = msg; errBox.className = 'err-text'; btn.disabled = false; btn.textContent = label; };
    if ((f.owner_password || '').length < 10) return fail('Password must be at least 10 characters.');
    if (f.owner_password !== f.owner_password2) return fail('The two passwords do not match.');
    btn.disabled = true; btn.textContent = 'Setting up…';
    const plans = [...document.querySelectorAll('.plan-row')].map(r => {
      const o = {}; r.querySelectorAll('input').forEach(i => { o[i.getAttribute('data-p')] = i.value.trim(); }); return o;
    }).filter(p => p.name);

    // 1. owner login (create it, or log in if this email already has one)
    const email = f.owner_email.trim().toLowerCase();
    let { data, error } = await sb.auth.signUp({ email, password: f.owner_password, options: { emailRedirectTo: APP_URL } });
    if (error && /registered|exists/i.test(error.message)) ({ data, error } = await sb.auth.signInWithPassword({ email, password: f.owner_password }));
    if (error) return fail(/invalid login/i.test(error.message) ? 'This email already has a login with a different password. Use that password, or another email.' : 'Could not create your login: ' + error.message);
    if (!data.session) {
      const s = await sb.auth.signInWithPassword({ email, password: f.owner_password });
      if (s.error) return fail('Your login needs email confirmation. Ask your app provider.');
    }
    // 2. claim the gym with the code
    const res = await sb.rpc('gym_claim', { p_gym: CFG.slug, p_code: f.code, p_data: claimed ? { owner_name: f.owner_name } : {
      gym_name: f.gym_name, gym_whatsapp: f.gym_whatsapp, gym_address: f.gym_address, gym_timings: f.gym_timings,
      upi_id: f.upi_id, upi_name: f.upi_name, owner_name: f.owner_name, plans, demo: !!f.demo } });
    if (res.error) return fail('Setup failed. Check your internet and try again.');
    if (!res.data.ok) return fail(ERR[res.data.error] || ('Setup failed: ' + res.data.error));
    $('form').className = 'hidden';
    const demo = res.data.data && res.data.data.demo;
    status('Done! Your gym app is ready.', null, 'ok', h('div', null,
      h('ol', { class: 'small' },
        h('li', null, 'Your owner login: ', h('code', null, email), ' and the password you just set. You are logged in on this phone.'),
        demo ? h('li', null, 'Demo member login: phone ', h('code', null, demo.phone), ', PIN ', h('code', null, demo.pin), '. Remove demo data later in More → Settings.') : null,
        h('li', null, 'Install it: open the app in Chrome → ⋮ → Install app / Add to Home screen.'),
        h('li', null, 'Share this link with your members: ', h('code', null, APP_URL))),
      h('a', { class: 'btn', href: './' }, 'Open my app')));
  });

  start().catch(() => status('Can’t reach the server', 'Check your internet connection and reload.', 'err'));
})();
