// Minimal client for the wallet API. No framework, no build step.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const rand = (v) => `R ${Number(v).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso) => new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

let token = localStorageGet('token');
let me = null;
let mode = 'send';

function localStorageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k, v) {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ }
}

async function api(path, { method = 'GET', body, idempotent = false } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotent) headers['idempotency-key'] = idempotent === true ? crypto.randomUUID() : idempotent;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    signOut();
    throw new Error('Your session expired. Please sign in again.');
  }
  if (!res.ok) throw new Error(data.error?.message ?? `Request failed (${res.status})`);
  return data;
}

function flash(msg, kind = 'ok') {
  const el = $('#flash');
  el.textContent = msg;
  el.className = `flash ${kind}`;
  el.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => (el.hidden = true), 5000);
}

async function busy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}

const formData = (form) => Object.fromEntries(new FormData(form));

// ---- Auth ------------------------------------------------------------------

document.querySelectorAll('[data-tab]').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
    $('#login-form').hidden = tab.dataset.tab !== 'login';
    $('#register-form').hidden = tab.dataset.tab !== 'register';
    $('#auth-error').textContent = '';
  }),
);

for (const [id, path] of [['#login-form', '/api/auth/login'], ['#register-form', '/api/auth/register']]) {
  $(id).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    await busy(btn, async () => {
      try {
        const res = await api(path, { method: 'POST', body: formData(e.target) });
        token = res.token;
        localStorageSet('token', token);
        await boot();
      } catch (err) {
        $('#auth-error').textContent = err.message;
      }
    });
  });
}

function signOut() {
  if (token) fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {});
  token = null;
  me = null;
  localStorageSet('token', null);
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
}
$('#logout').addEventListener('click', signOut);

// ---- Main view ---------------------------------------------------------------

async function refresh() {
  const [user, wallet, activity, requests] = await Promise.all([
    api('/api/me'), api('/api/wallet'), api('/api/activity'), api('/api/requests'),
  ]);
  me = user;
  $('#me-name').textContent = user.displayName;
  $('#me-handle').textContent = `@${user.handle}`;
  $('#balance').textContent = rand(wallet.balance);
  $('#kyc-banner').hidden = user.kycTier > 0;
  $('#lim-bal').textContent = Number(user.limits.maxBalance).toLocaleString('en-ZA');
  $('#lim-send').textContent = Number(user.limits.dailySend).toLocaleString('en-ZA');
  $('#wd-fee').textContent = user.limits.withdrawalFee;
  renderActivity(activity);
  renderRequests(requests);
}

function renderActivity(items) {
  const labels = {
    deposit: 'Added money',
    withdrawal: 'Withdrawal',
    withdrawal_reversal: 'Withdrawal returned',
  };
  $('#activity').innerHTML = items.length
    ? items.map((a) => {
        const incoming = Number(a.amount) > 0;
        const title = a.kind === 'transfer'
          ? (incoming ? `From @${esc(a.counterparty)}` : `To @${esc(a.counterparty)}`)
          : esc(labels[a.kind] ?? a.description);
        return `<li><div><div class="title">${title}</div>
          <div class="muted">${a.note ? esc(a.note) + ' · ' : ''}${when(a.createdAt)}</div></div>
          <div class="amt ${incoming ? 'in' : 'out'}">${incoming ? '+' : '−'}${rand(Math.abs(a.amount))}</div></li>`;
      }).join('')
    : '<li class="muted">No activity yet. Add money to get started.</li>';
}

function renderRequests({ incoming, outgoing }) {
  const pendingIn = incoming.filter((r) => r.status === 'pending');
  const recentOut = outgoing.slice(0, 5);
  $('#requests-card').hidden = !pendingIn.length && !recentOut.length;
  $('#requests').innerHTML = [
    ...pendingIn.map((r) => `<li><div><div class="title">@${esc(r.requester.handle)} requests ${rand(r.amount)}</div>
      <div class="muted">${r.note ? esc(r.note) + ' · ' : ''}${when(r.createdAt)}</div></div>
      <div class="row"><button class="btn small primary" data-pay="${r.id}">Pay</button>
      <button class="btn small" data-decline="${r.id}">Decline</button></div></li>`),
    ...recentOut.map((r) => `<li><div><div class="title">You requested ${rand(r.amount)} from @${esc(r.payer.handle)}</div>
      <div class="muted">${r.note ? esc(r.note) + ' · ' : ''}${when(r.createdAt)}</div></div>
      <div class="row"><span class="pill">${esc(r.status)}</span>
      ${r.status === 'pending' ? `<button class="btn small" data-cancel="${r.id}">Cancel</button>` : ''}</div></li>`),
  ].join('');
}

$('#requests').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  await busy(btn, async () => {
    try {
      if (btn.dataset.pay) {
        const r = await api(`/api/requests/${btn.dataset.pay}/pay`, { method: 'POST', idempotent: `pay-${btn.dataset.pay}` });
        flash(`Paid ${rand(r.transfer.amount)} to @${r.transfer.to.handle}`);
      } else if (btn.dataset.decline) {
        await api(`/api/requests/${btn.dataset.decline}/decline`, { method: 'POST' });
        flash('Request declined');
      } else if (btn.dataset.cancel) {
        await api(`/api/requests/${btn.dataset.cancel}/cancel`, { method: 'POST' });
        flash('Request cancelled');
      }
      await refresh();
    } catch (err) {
      flash(err.message, 'err');
    }
  });
});

// ---- Send / request --------------------------------------------------------

document.querySelectorAll('[data-mode]').forEach((tab) =>
  tab.addEventListener('click', () => {
    mode = tab.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach((t) => t.classList.toggle('active', t === tab));
    $('#who-label').textContent = mode === 'send' ? 'To' : 'From';
    $('#pay-submit').textContent = mode === 'send' ? 'Send money' : 'Request money';
  }),
);

let lookupTimer;
$('#pay-form [name=who]').addEventListener('input', (e) => {
  clearTimeout(lookupTimer);
  const q = e.target.value.trim();
  $('#recipient-preview').textContent = '';
  if (q.length < 3) return;
  lookupTimer = setTimeout(async () => {
    try {
      const u = await api(`/api/users/lookup?q=${encodeURIComponent(q)}`);
      if (e.target.value.trim() === q) $('#recipient-preview').textContent = `✓ ${u.displayName} (@${u.handle})`;
    } catch { /* not found yet */ }
  }, 300);
});

// One idempotency key per form submission attempt, reused on retry of the same values.
let pendingKey = null;
let pendingSig = null;

$('#pay-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  const sig = JSON.stringify([mode, f]);
  if (sig !== pendingSig) {
    pendingSig = sig;
    pendingKey = crypto.randomUUID();
  }
  await busy($('#pay-submit'), async () => {
    try {
      if (mode === 'send') {
        if (!confirm(`Send ${rand(f.amount)} to ${f.who}?`)) return;
        const t = await api('/api/transfers', { method: 'POST', idempotent: pendingKey, body: { to: f.who, amount: f.amount, note: f.note || null } });
        flash(`Sent ${rand(t.amount)} to @${t.to.handle}`);
      } else {
        const r = await api('/api/requests', { method: 'POST', body: { from: f.who, amount: f.amount, note: f.note || null } });
        flash(`Requested ${rand(r.amount)} from @${r.payer.handle}`);
      }
      pendingSig = null;
      e.target.reset();
      $('#recipient-preview').textContent = '';
      await refresh();
    } catch (err) {
      flash(err.message, 'err');
    }
  });
});

// ---- Dialogs ---------------------------------------------------------------

document.querySelectorAll('[data-open]').forEach((b) =>
  b.addEventListener('click', async () => {
    const dlg = document.getElementById(b.dataset.open);
    if (dlg.id === 'withdraw-dialog') await loadWithdraw();
    dlg.showModal();
  }),
);

function dialogSubmit(formSel, handler) {
  $(formSel).addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return; // let method=dialog close it
    e.preventDefault();
    const btn = e.submitter ?? e.target.querySelector('button[type=submit]');
    await busy(btn, async () => {
      try {
        await handler(formData(e.target), e.target);
      } catch (err) {
        flash(err.message, 'err');
        alert(err.message);
      }
    });
  });
}

dialogSubmit('#deposit-form', async ({ amount }) => {
  const d = await api('/api/deposits', { method: 'POST', body: { amount } });
  location.href = d.checkoutUrl;
});

dialogSubmit('#kyc-form', async ({ idNumber }, form) => {
  await api('/api/me/verify-identity', { method: 'POST', body: { idNumber } });
  form.closest('dialog').close();
  form.reset();
  flash('Identity verified — your limits have been raised');
  await refresh();
});

async function loadWithdraw() {
  const [accounts, banks, withdrawals] = await Promise.all([api('/api/bank-accounts'), api('/api/banks'), api('/api/withdrawals')]);
  $('#bank-account-select').innerHTML = accounts.length
    ? accounts.map((a) => `<option value="${a.id}">${esc(a.bankName)} ••${esc(a.accountLast4)} (${esc(a.accountHolder)})</option>`).join('')
    : '<option value="">Add a bank account below</option>';
  $('#bank-select').innerHTML = banks.map((b) => `<option value="${esc(b.code)}">${esc(b.name)}</option>`).join('');
  $('.add-bank').open = !accounts.length;
  $('#withdrawals').innerHTML = withdrawals.slice(0, 5).map((w) =>
    `<li><span>${rand(w.amount)} → ${esc(w.destination)}</span><span class="pill">${esc(w.status)}</span></li>`).join('');
}

dialogSubmit('#bank-form', async (body, form) => {
  if (me?.displayName && !body.accountHolder) body.accountHolder = me.displayName;
  await api('/api/bank-accounts', { method: 'POST', body });
  form.reset();
  flash('Bank account saved');
  await loadWithdraw();
});

let withdrawKey = null;
dialogSubmit('#withdraw-form', async ({ bankAccountId, amount }, form) => {
  if (!bankAccountId) throw new Error('Add a bank account first');
  withdrawKey ??= crypto.randomUUID();
  const w = await api('/api/withdrawals', { method: 'POST', idempotent: withdrawKey, body: { bankAccountId, amount } });
  withdrawKey = null;
  form.closest('dialog').close();
  form.reset();
  flash(w.status === 'failed' ? `Withdrawal failed: ${w.failureReason ?? 'rejected'}` : `Withdrawal of ${rand(w.amount)} is on its way`, w.status === 'failed' ? 'err' : 'ok');
  await refresh();
  setTimeout(() => refresh().catch(() => {}), 2500);
});

// ---- Boot ------------------------------------------------------------------

async function boot() {
  if (!token) {
    $('#auth-view').hidden = false;
    $('#app-view').hidden = true;
    return;
  }
  try {
    await refresh();
    $('#auth-view').hidden = true;
    $('#app-view').hidden = false;
  } catch (err) {
    signOut();
    $('#auth-error').textContent = err.message;
    return;
  }

  const ref = new URLSearchParams(location.search).get('deposit');
  if (ref) {
    history.replaceState(null, '', '/');
    const deposits = await api('/api/deposits');
    const d = deposits.find((x) => x.reference === ref);
    if (d?.status === 'succeeded') flash(`${rand(d.amount)} added to your wallet`);
    else if (d?.status === 'failed') flash(`Payment failed${d.failureReason ? `: ${d.failureReason}` : ''}`, 'err');
    else if (d) flash('Payment is processing — your balance will update shortly');
  }
}

boot();
