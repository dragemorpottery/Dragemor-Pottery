/* Direct PayPal checkout. SDK loads only after the customer chooses PayPal. */
(() => {
  const endpoint = '/api/create-checkout-session?provider=paypal';
  const box = document.getElementById('paypalCheckout');
  const choose = document.getElementById('paypalChoose');
  const buttons = document.getElementById('paypalButtons');
  const status = document.getElementById('paypalStatus');
  const retry = document.getElementById('paypalRetry');
  const cancel = document.getElementById('paypalCancel');
  if (!box) return;
  let configPromise, sdkPromise, rendered = false, busy = false, pending = null, unavailable = true;
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
    buttons.style.pointerEvents = busy || unavailable || pending ? 'none' : '';
    buttons.style.opacity = busy || unavailable || pending ? '.5' : '';
  }
  window.refreshPayPalCheckout = function (disabled) {
    unavailable = !!disabled;
    refresh();
    if (!document.getElementById('cartDrawer')?.classList.contains('open')) return;
    if (!configPromise) {
      configPromise = fetch(endpoint, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(); return r.json(); });
      configPromise.then(cfg => { box.hidden = !cfg.enabled; }).catch(() => { box.hidden = true; configPromise = null; });
    }
  };
  function loadSdk(clientId) {
    if (!sdkPromise) sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(clientId) + '&currency=EUR&intent=capture&components=buttons&disable-funding=card,credit,paylater,venmo';
      script.dataset.namespace = 'dragemorPayPal';
      script.onload = () => resolve(window.dragemorPayPal);
      script.onerror = () => { script.remove(); sdkPromise = null; reject(new Error('PayPal konnte nicht geladen werden. Bitte erneut versuchen.')); };
      document.head.appendChild(script);
    });
    return sdkPromise;
  }
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
  choose.addEventListener('click', async () => {
    if (busy || unavailable || pending) return;
    choose.disabled = true;
    message('PayPal wird geladen …');
    try {
      const cfg = await configPromise;
      if (!cfg?.enabled) throw new Error('PayPal ist momentan nicht verfügbar.');
      const sdk = await loadSdk(cfg.clientId);
      if (!rendered) {
        await sdk.Buttons({
          fundingSource: sdk.FUNDING.PAYPAL,
          style: { layout: 'vertical', color: 'gold', label: 'pay', shape: 'rect', height: 45 },
          onClick: (_data, actions) => {
            if (busy || unavailable || pending) return actions.reject();
            return actions.resolve();
          },
          createOrder: async () => {
            busy = true; refresh();
            const items = dragemorCart.map(i => ({ id: i.id }));
            const voucherCode = dragemorVoucher?.code || '';
            try {
              const result = await request({ action: 'create', items, voucherCode });
              setPending({ ...result, items, voucherCode });
              message('Prüfe bei PayPal bitte Artikel, Lieferadresse und Gesamtbetrag einschließlich Versand.');
              return result.orderId;
            } finally { busy = false; refresh(); }
          },
          onApprove: data => {
            if (!pending || data.orderID !== pending.orderId) throw new Error('Die PayPal-Bestellung passt nicht zur Zahlungssitzung.');
            return check('capture');
          },
          onCancel: () => check('cancel'),
          onError: () => {
            message(pending ? 'PayPal konnte noch nicht bestätigt werden. Bitte „Zahlung fortsetzen / Status prüfen“ wählen.' : 'PayPal konnte nicht geöffnet werden. Bitte erneut versuchen.');
            busy = false; refresh();
          }
        }).render(buttons);
        rendered = true;
      }
      choose.hidden = true;
      message('Mit PayPal bezahlen. Versand innerhalb Deutschlands: 6,99 €.');
    } catch (e) { message(e.message); }
    finally { refresh(); }
  });
  if (pending) message('Eine PayPal-Zahlung ist noch offen. Bitte zuerst den Status prüfen.');
  refresh();
})();
