/* Direct PayPal checkout with a return to the shop in the same tab. */
(() => {
  const endpoint = '/api/create-checkout-session?provider=paypal';
  const box = document.getElementById('paypalCheckout');
  const choose = document.getElementById('paypalChoose');
  const status = document.getElementById('paypalStatus');
  const retry = document.getElementById('paypalRetry');
  const cancel = document.getElementById('paypalCancel');
  if (!box) return;
  let configPromise, busy = false, pending = null, unavailable = true;
  const storageKey = 'dragemorPayPalPending';
  try { pending = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}
  if (pending && (!pending.orderId || !pending.token || !Array.isArray(pending.items))) pending = null;

  function setPending(value) {
    pending = value;
    try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); } catch (_) {}
  }
  function message(text) { status.textContent = text; }
  async function request(body) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'PayPal konnte noch nicht bestätigt werden.');
    return data;
  }
  function refresh() {
    choose.disabled = busy || unavailable || !!pending;
    retry.hidden = !pending;
    retry.disabled = busy;
    cancel.hidden = !pending; cancel.disabled = busy;
  }
  window.refreshPayPalCheckout = function (disabled) {
    unavailable = !!disabled;
    refresh();
    if (!document.getElementById('cartDrawer')?.classList.contains('open')) return;
    if (!configPromise) {
      configPromise = fetch(endpoint, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(); return r.json(); });
      configPromise.then(cfg => { box.hidden = !cfg.enabled && !pending && !paypalReturn; }).catch(() => { box.hidden = !pending && !paypalReturn; configPromise = null; });
    }
  };
  function success() {
    const completed = pending;
    if (!completed) return;
    setPending(null);
    const purchasedIds = new Set(completed.items.map(i => i.id));
    // Preserve any other pieces added while the PayPal window was open.
    dragemorCart = dragemorCart.filter(i => !purchasedIds.has(i.id));
    if (dragemorVoucher?.code === completed.voucherCode) { dragemorVoucher = null; saveVoucher(); }
    try { localStorage.setItem('dragemorCart', JSON.stringify(dragemorCart)); } catch (_) {}
    clearPreparedStripeCheckout();
    renderCart();
    closeCart();
    const overlay = document.getElementById('orderSuccessOverlay');
    if (overlay) {
      overlay.classList.add('active'); overlay.setAttribute('aria-hidden', 'false');
      overlay.style.setProperty('display', 'flex', 'important');
      overlay.style.setProperty('visibility', 'visible', 'important');
      overlay.style.setProperty('opacity', '1', 'important');
      overlay.style.setProperty('z-index', '2147483647', 'important');
      document.body.style.overflow = 'hidden';
    }
    message('Deine PayPal-Zahlung ist bestätigt. Vielen Dank!');
  }
  async function check(action) {
    if (!pending || busy) return;
    busy = true; refresh();
    message('PayPal-Zahlung wird sicher geprüft …');
    try {
      const result = await request({ action, orderId: pending.orderId, token: pending.token });
      if (result.status === 'paid') success();
      else if (result.status === 'cancelled') {
        setPending(null); message('PayPal wurde geschlossen. Deine Artikel bleiben im Warenkorb.');
      } else if (result.status === 'denied') {
        setPending(null);
        message('PayPal hat die Zahlung abgelehnt. Bitte wähle eine andere Zahlungsart oder versuche es erneut.');
      } else {
        message('Deine Zahlung ist noch nicht bestätigt. Bitte prüfe den Status hier erneut, bevor du eine neue Zahlung startest.');
      }
    } catch (e) { message(e.message); }
    finally { busy = false; refresh(); }
  }
  retry.addEventListener('click', () => check('capture'));
  cancel.addEventListener('click', () => check('cancel'));
  const returnUrl = new URL(window.location.href);
  const paypalReturn = returnUrl.searchParams.get('paypal');

  choose.addEventListener('click', async () => {
    if (busy || unavailable || pending) return;
    busy = true; refresh();
    message('PayPal wird geöffnet …');
    let redirecting = false;
    try {
      const cfg = await configPromise;
      if (!cfg?.enabled) throw new Error('PayPal ist momentan nicht verfügbar.');
      const items = dragemorCart.map(i => ({ id: i.id }));
      const voucherCode = dragemorVoucher?.code || '';
      const { orderId, token, approvalUrl } = await request({ action: 'create', items, voucherCode });
      if (!approvalUrl) throw new Error('PayPal hat keinen Zahlungslink geliefert. Bitte erneut versuchen.');
      setPending({ orderId, token, items, voucherCode });
      if (!sessionStorage.getItem(storageKey)) {
        throw new Error('Der Browser konnte die Zahlungssitzung nicht speichern.');
      }
      window.location.assign(approvalUrl);
      redirecting = true;
    } catch (e) { message(e.message); }
    finally { if (!redirecting) { busy = false; refresh(); } }
  });

  if (pending) message('Eine PayPal-Zahlung ist noch offen. Bitte zuerst den Status prüfen.');
  refresh();

  if (paypalReturn === 'return' || paypalReturn === 'cancel') {
    const orderId = returnUrl.searchParams.get('token');
    for (const key of ['paypal', 'token', 'PayerID']) returnUrl.searchParams.delete(key);
    window.history.replaceState(window.history.state, '', returnUrl);
    openCart();
    box.hidden = false;
    if (pending && orderId === pending.orderId) {
      void check(paypalReturn === 'return' ? 'capture' : 'cancel');
    } else {
      message('Die PayPal-Rückkehr konnte keiner Zahlung in diesem Tab zugeordnet werden. Bitte prüfe zuerst deine PayPal-Aktivitäten.');
    }
  }

  // A browser Back action can restore the pre-redirect page from memory.
  window.addEventListener('pageshow', event => {
    if (event.persisted && pending) {
      try { pending = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}
      busy = false;
      message(pending ? 'Eine PayPal-Zahlung ist noch offen. Bitte zuerst den Status prüfen.' : '');
      refresh();
    }
  });
})();
