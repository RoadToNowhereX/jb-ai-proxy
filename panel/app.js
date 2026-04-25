const PAGE_SIZE = 15;
const AUTO_RETRY_TYPES = ['network', 'timeout', 'server_error', 'rate_limit', 'auth', 'client_error', 'unknown'];

let allAccounts = [];
let currentPage = 1;
let selectedAccountIds = new Set();

document.addEventListener('DOMContentLoaded', async () => {
  const res = await fetch('/api/accounts');
  if (res.status === 401) {
    location.href = '/panel/login.html';
    return;
  }

  await loadRefreshPolicy();
  await loadAccounts();
});

async function withLoading(btn, text, fn) {
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = text;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function loadRefreshPolicy() {
  const msg = document.getElementById('policy-save-msg');
  msg.textContent = '加载策略中...';

  try {
    const res = await fetch('/api/settings/refresh-policy');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载策略失败');

    document.getElementById('policy-max-retries').value = data.max_retries ?? 2;
    document.getElementById('policy-retry-delay').value = data.retry_delay_ms ?? 1500;
    document.getElementById('policy-auto-retry-on-error').checked = Boolean(data.auto_retry_on_error);

    const selected = new Set(Array.isArray(data.auto_retry_types) ? data.auto_retry_types : []);
    document.querySelectorAll('#policy-auto-retry-types input[type=checkbox]').forEach(el => {
      el.checked = selected.has(el.value);
    });

    msg.textContent = '当前策略已加载';
  } catch (err) {
    msg.textContent = `加载策略失败: ${esc(err.message)}`;
  }
}

async function saveRefreshPolicy(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const msg = document.getElementById('policy-save-msg');

  await withLoading(btn, '保存中...', async () => {
    const autoRetryTypes = Array.from(
      document.querySelectorAll('#policy-auto-retry-types input[type=checkbox]:checked'),
    )
      .map(el => el.value)
      .filter(type => AUTO_RETRY_TYPES.includes(type));

    const res = await fetch('/api/settings/refresh-policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        max_retries: Number(document.getElementById('policy-max-retries').value),
        retry_delay_ms: Number(document.getElementById('policy-retry-delay').value),
        auto_retry_on_error: document.getElementById('policy-auto-retry-on-error').checked,
        auto_retry_types: autoRetryTypes,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存策略失败');
    msg.textContent = '策略已保存';
  }).catch(err => {
    msg.textContent = `保存策略失败: ${esc(err.message)}`;
  });
}

async function loadAccounts() {
  const container = document.getElementById('accounts-list');
  container.innerHTML = '<p class="muted">加载中...</p>';
  selectedAccountIds.clear();

  try {
    const res = await fetch('/api/accounts');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载账号失败');

    allAccounts = Array.isArray(data) ? data : [];
    currentPage = 1;
    renderAccounts();
  } catch (err) {
    container.innerHTML = `<p class="muted">加载失败: ${esc(err.message)}</p>`;
    document.getElementById('accounts-summary').textContent = '';
    document.getElementById('accounts-bulk-actions').innerHTML = '';
    document.getElementById('accounts-pagination').innerHTML = '';
  }
}

function renderAccounts() {
  const summaryEl = document.getElementById('accounts-summary');
  const bulkActionsEl = document.getElementById('accounts-bulk-actions');
  const container = document.getElementById('accounts-list');
  const pagEl = document.getElementById('accounts-pagination');

  const counts = { active: 0, suspended: 0, quota_exhausted: 0, error: 0, disabled: 0 };
  for (const account of allAccounts) {
    counts[account.status] = (counts[account.status] || 0) + 1;
  }

  const parts = [`总数 ${allAccounts.length}`];
  if (counts.active) parts.push(`正常 ${counts.active}`);
  if (counts.error) parts.push(`异常 ${counts.error}`);
  if (counts.quota_exhausted) parts.push(`额度耗尽 ${counts.quota_exhausted}`);
  if (counts.suspended) parts.push(`已封禁 ${counts.suspended}`);
  if (counts.disabled) parts.push(`已停用 ${counts.disabled}`);
  summaryEl.textContent = parts.join('  |  ');

  if (allAccounts.length === 0) {
    bulkActionsEl.innerHTML = '';
    container.innerHTML = '<p class="muted">暂无账号</p>';
    pagEl.innerHTML = '';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(allAccounts.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  const pageAccounts = getCurrentPageAccounts();
  renderBulkActions(pageAccounts);

  container.innerHTML = pageAccounts.map(acc => `
    <div class="account-row ${acc.status === 'disabled' ? 'account-row-disabled' : ''}">
      <label class="account-select-cell">
        <input
          type="checkbox"
          class="account-select"
          ${selectedAccountIds.has(acc.id) ? 'checked' : ''}
          ${acc.status === 'disabled' ? 'disabled' : ''}
          onchange="toggleAccountSelection('${acc.id}', this.checked)"
        >
      </label>
      <div class="account-info">
        <div class="account-email">${esc(acc.email)}</div>
        <div class="account-meta">
          <span class="status status-${acc.status}">${statusText(acc.status)}</span>
          <span>${esc(acc.license_id || '')}</span>
          ${acc.last_error_type ? `<span>错误类型 ${esc(acc.last_error_type)}</span>` : ''}
        </div>
        ${acc.last_error_message ? `<div class="account-error">${esc(acc.last_error_message)}</div>` : ''}
        <div id="quota-${acc.id}"></div>
      </div>
      <div class="account-actions">
        <button class="btn-sm" onclick="withLoading(this, '查询中...', () => loadQuota('${acc.id}'))">额度</button>
        ${acc.status === 'disabled'
          ? `<button class="btn-sm btn-success" onclick="enableAccount(this, '${acc.id}')">启用</button>`
          : `
            <button class="btn-sm" onclick="withLoading(this, '刷新中...', () => refreshAccount('${acc.id}'))">刷新</button>
            <button class="btn-warning" onclick="disableAccount(this, '${acc.id}')">停用</button>
          `}
        <button class="btn-danger" onclick="deleteAccount(this, '${acc.id}')">删除</button>
      </div>
    </div>
  `).join('');

  if (totalPages <= 1) {
    pagEl.innerHTML = '';
    return;
  }

  pagEl.innerHTML = `
    <button class="btn-sm" onclick="goToPage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="muted">${currentPage} / ${totalPages}</span>
    <button class="btn-sm" onclick="goToPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>下一页</button>
  `;
}

function renderBulkActions(pageAccounts) {
  const bulkActionsEl = document.getElementById('accounts-bulk-actions');
  const selectableAccounts = pageAccounts.filter(account => account.status !== 'disabled');
  const selectedCount = selectableAccounts.filter(account => selectedAccountIds.has(account.id)).length;
  const allSelected = selectableAccounts.length > 0 && selectedCount === selectableAccounts.length;

  bulkActionsEl.innerHTML = `
    <label class="checkbox-row bulk-select">
      <input
        type="checkbox"
        ${allSelected ? 'checked' : ''}
        ${selectableAccounts.length === 0 ? 'disabled' : ''}
        onchange="toggleSelectCurrentPage(this.checked)"
      >
      <span>全选当前页可停用账号</span>
    </label>
    <span class="muted">已选 ${selectedCount} 个</span>
    <button class="btn-warning" onclick="bulkDisableSelected(this)" ${selectedCount === 0 ? 'disabled' : ''}>批量停用</button>
  `;
}

function getCurrentPageAccounts() {
  const start = (currentPage - 1) * PAGE_SIZE;
  return allAccounts.slice(start, start + PAGE_SIZE);
}

function toggleAccountSelection(id, checked) {
  if (checked) selectedAccountIds.add(id);
  else selectedAccountIds.delete(id);
  renderBulkActions(getCurrentPageAccounts());
}

function toggleSelectCurrentPage(checked) {
  for (const account of getCurrentPageAccounts()) {
    if (account.status === 'disabled') continue;
    if (checked) selectedAccountIds.add(account.id);
    else selectedAccountIds.delete(account.id);
  }
  renderAccounts();
}

function goToPage(page) {
  currentPage = page;
  selectedAccountIds.clear();
  renderAccounts();
}

function statusText(status) {
  const map = {
    active: '正常',
    error: '异常',
    quota_exhausted: '额度耗尽',
    suspended: '已封禁',
    disabled: '已停用',
  };
  return map[status] || status;
}

async function loadQuota(id) {
  const el = document.getElementById(`quota-${id}`);
  el.innerHTML = '<span class="muted">查询中...</span>';

  try {
    const res = await fetch(`/api/accounts/${id}/quota`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '查询额度失败');

    const used = parseFloat(data.current?.tariffQuota?.current?.amount || data.current?.current?.amount || 0);
    const max = parseFloat(data.current?.tariffQuota?.maximum?.amount || data.current?.maximum?.amount || 1000000);
    const pct = Math.max(0, Math.min(100, ((max - used) / max) * 100));

    el.innerHTML = `
      <div class="account-meta">已用 ${used.toFixed(0)} / ${max.toFixed(0)}</div>
      <div class="quota-bar"><div class="quota-fill" style="width:${pct}%"></div></div>
    `;
  } catch (err) {
    el.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
  }
}

async function refreshAccount(id) {
  const res = await fetch(`/api/accounts/${id}/refresh`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '刷新失败');
  await loadAccounts();
}

async function disableAccount(btn, id) {
  if (!confirm('确定停用这个账号吗？停用后它不会再参与轮询。')) return;

  await withLoading(btn, '停用中...', async () => {
    const res = await fetch(`/api/accounts/${id}/disable`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '停用失败');
    await loadAccounts();
  }).catch(err => {
    alert(`停用失败: ${err.message}`);
  });
}

async function enableAccount(btn, id) {
  await withLoading(btn, '启用中...', async () => {
    const res = await fetch(`/api/accounts/${id}/enable`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '启用失败');
    await loadAccounts();
  }).catch(err => {
    alert(`启用失败: ${err.message}`);
  });
}

async function bulkDisableSelected(btn) {
  const ids = [...selectedAccountIds];
  if (ids.length === 0) return;
  if (!confirm(`确定批量停用选中的 ${ids.length} 个账号吗？`)) return;

  await withLoading(btn, '停用中...', async () => {
    const res = await fetch('/api/accounts/bulk-disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '批量停用失败');
    await loadAccounts();
  }).catch(err => {
    alert(`批量停用失败: ${err.message}`);
  });
}

async function deleteAccount(btn, id) {
  if (!confirm('确定删除这个账号吗？')) return;

  await withLoading(btn, '删除中...', async () => {
    const res = await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '删除失败');
    await loadAccounts();
  }).catch(err => {
    alert(`删除失败: ${err.message}`);
  });
}

async function startOAuth() {
  try {
    const res = await fetch('/auth/start');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '启动 OAuth 失败');
    document.getElementById('oauth-url').href = data.url;
    document.getElementById('oauth-form').classList.remove('hidden');
    document.getElementById('manual-form').classList.add('hidden');
  } catch (err) {
    alert(`启动 OAuth 失败: ${err.message}`);
  }
}

async function submitOAuthCallback(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');

  await withLoading(btn, '添加中...', async () => {
    const callbackUrl = document.getElementById('oauth-callback').value.trim();
    const licenseId = document.getElementById('oauth-license').value.trim();
    const res = await fetch('/auth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_url: callbackUrl, license_id: licenseId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '添加失败');
    hideOAuthForm();
    await loadAccounts();
  }).catch(err => {
    alert(`添加失败: ${err.message}`);
  });
}

function hideOAuthForm() {
  document.getElementById('oauth-form').classList.add('hidden');
  document.getElementById('oauth-callback').value = '';
  document.getElementById('oauth-license').value = '';
}

function showManualForm() {
  document.getElementById('manual-form').classList.remove('hidden');
  document.getElementById('oauth-form').classList.add('hidden');
}

function hideManualForm() {
  document.getElementById('manual-form').classList.add('hidden');
}

async function addManual(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');

  await withLoading(btn, '添加中...', async () => {
    const refreshToken = document.getElementById('manual-rt').value.trim();
    const licenseId = document.getElementById('manual-lid').value.trim();
    const res = await fetch('/api/accounts/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken, license_id: licenseId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '添加失败');
    hideManualForm();
    document.getElementById('manual-rt').value = '';
    document.getElementById('manual-lid').value = '';
    await loadAccounts();
  }).catch(err => {
    alert(`添加失败: ${err.message}`);
  });
}

function esc(value) {
  const d = document.createElement('div');
  d.textContent = value || '';
  return d.innerHTML;
}
