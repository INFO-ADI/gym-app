/* Policy pages: fill in the contact number from the platform settings. */
(function () {
  const CFG = window.SITE_CONFIG || {}, a = document.getElementById('cWa');
  if (!a || !CFG.url) return;
  fetch(CFG.url + '/rest/v1/rpc/site_api', { method: 'POST', headers: { apikey: CFG.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_action: 'site', p_in: {} }) })
    .then(r => r.json()).then(r => {
      const w = r && r.ok && r.data.whatsapp;
      if (/^91\d{10}$/.test(w || '')) { a.textContent = '+91 ' + w.slice(2, 7) + ' ' + w.slice(7); a.href = 'https://wa.me/' + w; }
      else { a.textContent = 'Use the form on our home page'; a.href = '/#demo'; }
    }).catch(() => { a.textContent = 'Use the form on our home page'; a.href = '/#demo'; });
})();
