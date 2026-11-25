/* Landing page: live prices and the "book a demo" form (saved for the platform admin). */
(function () {
  'use strict';
  const CFG = window.SITE_CONFIG || {};
  const $ = id => document.getElementById(id);
  const inr = n => '₹' + Number(n).toLocaleString('en-IN');

  async function rpc(action, body) {
    const r = await fetch(CFG.url + '/rest/v1/rpc/site_api', {
      method: 'POST',
      headers: { apikey: CFG.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_action: action, p_in: body || {} }),
    });
    if (!r.ok) throw new Error('network');
    return r.json();
  }

  rpc('site').then(r => {
    if (!r.ok) return;
    const s = r.data;
    $('pm').textContent = inr(s.price_month);
    $('py').textContent = inr(s.price_year);
    $('pyMonth').textContent = inr(Math.ceil(s.price_year / 12));
    const save = s.price_month * 12 - s.price_year;
    if (save > 0) $('save').textContent = 'Save ' + inr(save); else $('save').classList.add('hidden');
    $('trialDays').textContent = s.trial_days;
    if (s.demo_ready && s.demo_slug) {
      $('demoLink').href = s.url_style === 'path' ? '/g/' + s.demo_slug + '/' : location.protocol + '//' + s.demo_slug + '.' + (s.base_domain || location.hostname) + (location.port ? ':' + location.port : '') + '/';
      $('demoLink').classList.remove('hidden');
    }
    if (/^91\d{10}$/.test(s.whatsapp || '')) {
      $('waBtn').href = 'https://wa.me/' + s.whatsapp + '?text=' + encodeURIComponent('Hi! I want a demo of the gym app for my gym.');
      $('waBtn').classList.remove('hidden');
    }
  }).catch(() => {});

  const form = $('lead');
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const btn = form.querySelector('button'); const msg = $('leadMsg');
    const data = Object.fromEntries(new FormData(form).entries());
    if (!/^(\+?91)?[\s-]*[6-9]\d{4}[\s-]*\d{5}$/.test(data.phone.trim())) { msg.className = 'msg err'; msg.textContent = 'Please enter a 10-digit mobile number.'; return; }
    btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Sending…';
    try {
      const r = await rpc('lead', data);
      if (r.ok) { form.reset(); msg.className = 'msg ok'; msg.textContent = 'Thank you! We will WhatsApp you within a day. 🙏'; }
      else { msg.className = 'msg err'; msg.textContent = r.error === 'too_many_attempts' ? 'Already received. We will contact you soon.' : 'Please check your name and number.'; }
    } catch (e) { msg.className = 'msg err'; msg.textContent = 'No internet. Please try again.'; }
    btn.disabled = false;
  });
})();
