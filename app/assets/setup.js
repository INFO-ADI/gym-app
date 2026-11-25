/* Gym Manager - first-run setup. The database refuses setup once an owner exists, and a GitHub Action
   deletes this page from the website after setup is done. */
(function () {
  'use strict';
  const CFG = window.GYM_CONFIG || {};
  const $ = id => document.getElementById(id);
  const APP_URL = location.origin + location.pathname.replace(/setup\.html$/, '');
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
    wrong_setup_key: 'The setup key is wrong. Ask your app provider for it.',
    already_installed: 'This app is already set up. Open the app and log in as owner.',
    owner_name_required: 'Enter the owner name.', gym_name_required: 'Enter the gym name.',
    bad_upi: 'UPI ID looks wrong. It should look like name@okaxis.', bad_phone: 'WhatsApp number should be a 10-digit mobile number.',
    add_at_least_one_plan: 'Add at least one plan.', bad_plan_months: 'Plan months must be between 1 and 36.', bad_plan_fee: 'Check the plan fees.',
  };

  if (!CFG.url || !window.supabase) { status('Not connected', 'config.js is missing the Supabase address. Ask whoever installed the app.', 'err'); return; }
  const sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true } });
  $('appurl').textContent = APP_URL;

  // plan rows
  const defaults = [['Monthly', 1, 1200], ['Quarterly', 3, 3200], ['Half-yearly', 6, 6000], ['Yearly', 12, 11000], ['', '', ''], ['', '', '']];
  $('plans').append(...defaults.map(([n, m, f]) => h('div', { class: 'row plan-row' },
    h('input', { class: 'grow', 'data-p': 'name', value: n, placeholder: 'Plan name', maxlength: 60 }),
    h('input', { 'data-p': 'months', value: m, placeholder: 'Months', inputmode: 'numeric', size: 4 }),
    h('input', { 'data-p': 'fee', value: f, placeholder: 'Fee ₹', inputmode: 'numeric', size: 6 }))));

  async function start() {
    const r = await sb.rpc('gym_installed');
    if (r.error) { status('Database not ready', 'The Supabase database has not been prepared yet (supabase/schema.sql has not been run).', 'err'); return; }
    if (r.data === true) {
      status('Already set up', 'For safety, setup can only run once. This page is removed from the website automatically.', 'ok',
        h('a', { class: 'btn', href: './' }, 'Open the app'));
      return;
    }
    $('status').className = 'hidden';
    $('guide').className = '';
  }

  $('form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const btn = $('go'); const errBox = $('err');
    errBox.className = 'err-text hidden';
    const f = Object.fromEntries(new FormData($('form')).entries());
    const fail = msg => { errBox.textContent = msg; errBox.className = 'err-text'; btn.disabled = false; btn.textContent = 'Set up the gym app'; };
    if ((f.owner_password || '').length < 10) return fail('Password must be at least 10 characters.');
    if (f.owner_password !== f.owner_password2) return fail('The two passwords do not match.');
    btn.disabled = true; btn.textContent = 'Setting up…';
    const plans = [...document.querySelectorAll('.plan-row')].map(r => {
      const o = {}; r.querySelectorAll('input').forEach(i => { o[i.getAttribute('data-p')] = i.value.trim(); }); return o;
    }).filter(p => p.name);

    // 1. owner account (Supabase Auth)
    const email = f.owner_email.trim().toLowerCase();
    let { data, error } = await sb.auth.signUp({ email, password: f.owner_password, options: { emailRedirectTo: APP_URL } });
    if (error && /registered|exists/i.test(error.message)) ({ data, error } = await sb.auth.signInWithPassword({ email, password: f.owner_password }));
    if (error) return fail(/confirm/i.test(error.message) ? 'Email is not confirmed. In Supabase turn off "Confirm email" (see step 1 above), then try again.' : 'Could not create the owner login: ' + error.message);
    if (!data.session) {
      const s = await sb.auth.signInWithPassword({ email, password: f.owner_password });
      if (s.error) return fail('Supabase wants the email confirmed first. Turn off "Confirm email" (step 1 above) and press the button again.');
    }
    // 2. lock in the owner, settings, plans and demo data
    const res = await sb.rpc('gym_setup', { p_key: f.setup_key, p_data: {
      gym_name: f.gym_name, gym_whatsapp: f.gym_whatsapp, gym_address: f.gym_address, gym_timings: f.gym_timings,
      upi_id: f.upi_id, upi_name: f.upi_name, owner_name: f.owner_name, plans, demo: !!f.demo } });
    if (res.error) return fail('Setup failed: ' + res.error.message);
    if (!res.data.ok) {
      if (res.data.error === 'wrong_setup_key' || res.data.error === 'already_installed') await sb.auth.signOut();
      return fail(ERR[res.data.error] || res.data.error);
    }
    $('guide').className = 'hidden';
    const demo = res.data.data.demo;
    status('Done. Your gym app is ready.', 'Setup is now locked forever, and this page will disappear from the website automatically.', 'ok', h('div', null,
      h('ol', { class: 'small' },
        h('li', null, 'Owner login: ', h('code', null, email), ' and the password you just set. You are already logged in on this device.'),
        demo ? h('li', null, 'Member demo: phone ', h('code', null, demo.phone), ', PIN ', h('code', null, demo.pin), '. Remove demo data later in More → Settings.') : null,
        h('li', null, 'In Supabase, turn off "Allow new users to sign up" (Authentication → Sign In / Providers).'),
        h('li', null, 'Install on the phone: open the app in Chrome → ⋮ → Install app / Add to Home screen.')),
      h('a', { class: 'btn', href: './' }, 'Open the app')));
  });

  start().catch(() => status('Can’t reach the database', 'Check your internet connection and reload.', 'err'));
})();
