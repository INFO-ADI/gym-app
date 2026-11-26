/* Payment page on the main website. Gym apps on subdomains send owners here so that
   Razorpay only needs kanpurgym.com approved. The order / subscription is created by the
   gym app (logged in); this page only opens Razorpay Checkout and confirms the result. */
(function () {
  'use strict';
  const CFG = window.SITE_CONFIG || {};
  const q = new URLSearchParams(location.search);
  const $ = id => document.getElementById(id);
  const inr = n => '₹' + Number(n).toLocaleString('en-IN');
  const key = q.get('k') || '', order = q.get('o') || '', sub = q.get('s') || '';
  const plan = q.get('p') === 'yearly' ? 'yearly' : 'monthly';
  const gym = (q.get('g') || '').slice(0, 80);
  const amount = Math.max(0, parseInt(q.get('a') || '0', 10));
  const first = /^\d{4}-\d{2}-\d{2}$/.test(q.get('f') || '') ? q.get('f') : '';
  // only ever send people back to one of our own gym apps
  const ret = /^https:\/\/([a-z0-9-]+\.)?kanpurgym\.com\/[^\s"'<>]*$/.test(q.get('r') || '') || /^http:\/\/([a-z0-9-]+\.)?kg\.localhost(:\d+)?\/[^\s"'<>]*$/.test(q.get('r') || '') ? q.get('r') : '/';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = d => { const [y, m, dd] = d.split('-'); return +dd + ' ' + months[+m - 1] + ' ' + y; };
  $('back').href = ret;

  function msg(text, kind) { $('msg').textContent = text; $('msg').className = 'msg' + (kind ? ' ' + kind : ''); }
  function li(t) { const x = document.createElement('li'); x.textContent = t; return x; }

  if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(key) || !(/^order_[A-Za-z0-9]+$/.test(order) || /^sub_[A-Za-z0-9]+$/.test(sub))) {
    $('title').textContent = 'This payment link is not valid';
    msg('Go back to your gym app and tap Pay again.', 'err');
    return;
  }
  const isSub = !!sub;
  $('kind').textContent = isSub ? 'Auto-pay set-up' : 'One-time payment';
  $('title').textContent = (plan === 'yearly' ? 'Yearly' : 'Monthly') + ' app plan';
  $('gym').textContent = gym;
  $('amount').textContent = amount ? inr(amount / 100) + (isSub ? (plan === 'yearly' ? ' / year' : ' / month') : '') : '';
  const pts = isSub
    ? ['Approve once with UPI AutoPay or a card', first ? 'Nothing is charged today. First charge on ' + fmtDate(first) : 'Charged automatically each ' + (plan === 'yearly' ? 'year' : 'month'), 'Stop any time from the app']
    : ['Pay with any UPI app, card, net banking or wallet', 'Adds one ' + (plan === 'yearly' ? 'year' : 'month') + ' to your plan', 'Your app updates straight away'];
  pts.forEach(t => $('points').append(li(t)));
  $('go').textContent = isSub ? 'Set up auto-pay' : 'Pay ' + (amount ? inr(amount / 100) : 'now');

  async function verify(resp) {
    msg('Confirming your payment…');
    const body = isSub ? { subscription_id: sub, payment_id: resp.razorpay_payment_id, signature: resp.razorpay_signature }
                       : { order_id: order, payment_id: resp.razorpay_payment_id, signature: resp.razorpay_signature };
    let r = null;
    try {
      const res = await fetch(CFG.url + '/functions/v1/razorpay?pay=1', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.key }, body: JSON.stringify(body) });
      r = await res.json();
    } catch (e) { /* the Razorpay webhook will still update the plan */ }
    $('go').hidden = true;
    $('title').textContent = isSub ? 'Auto-pay is on' : 'Payment received';
    $('points').replaceChildren(li(r && r.paid_until ? 'Plan valid till ' + fmtDate(r.paid_until) : isSub ? 'Your plan renews by itself' : 'Your plan updates within a minute'));
    msg('Taking you back to your gym app…', 'ok');
    $('back').textContent = 'Back to the gym app now';
    setTimeout(() => { location.href = ret; }, 2500);
  }

  function open() {
    $('go').disabled = true;
    const rz = new window.Razorpay(Object.assign({
      key, name: CFG.site || 'KanpurGym', description: (plan === 'yearly' ? 'Yearly' : 'Monthly') + ' app plan · ' + gym,
      theme: { color: '#0f6b43' }, handler: verify,
      modal: { ondismiss: () => { $('go').disabled = false; msg('Payment window closed. Tap the button to try again.'); } },
    }, isSub ? { subscription_id: sub } : { order_id: order, amount, currency: 'INR' }));
    rz.on('payment.failed', () => { $('go').disabled = false; msg('That did not go through. Try again or use another method.', 'err'); });
    rz.open();
  }

  const s = document.createElement('script');
  s.src = 'https://checkout.razorpay.com/v1/checkout.js';
  s.onload = () => { $('go').disabled = false; $('go').addEventListener('click', open); open(); };
  s.onerror = () => msg('Could not load Razorpay. Check your internet and refresh.', 'err');
  document.head.append(s);
})();
