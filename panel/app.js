const PAGE_SIZE = 15;
const AUTO_RETRY_TYPES = ['network', 'timeout', 'server_error', 'rate_limit', 'auth', 'client_error', 'unknown'];

let allAccounts = [];
let currentPage = 1;
let selectedAccountIds = new Set();

let agentPool = [];

document.addEventListener('DOMContentLoaded', async () => {
  const res = await fetch('/api/accounts');
  if (res.status === 401) {
    location.href = '/panel/login.html';
    return;
  }

  await loadRefreshPolicy();
  await loadQuotaSettings();
  await loadPollingSettings();
  await loadAgentPool();
  await loadAccounts();
});

async function loadAgentPool() {
  try {
    const res = await fetch('/api/settings/grazie-agents');
    agentPool = await res.json();
  } catch (err) {
    console.error('Failed to load agent pool', err);
  }
}

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

async function loadQuotaSettings() {
  const msg = document.getElementById('quota-save-msg');
  if (msg) msg.textContent = '加载设置中...';

  try {
    const res = await fetch('/api/settings/quota');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载设置失败');

    const elInterval = document.getElementById('quota-refresh-interval');
    if (elInterval) elInterval.value = data.quota_refresh_interval ?? 60;

    const elThreshold = document.getElementById('quota-min-remaining-percent');
    if (elThreshold) elThreshold.value = data.quota_min_remaining_percent ?? 10;

    if (msg) msg.textContent = '当前设置已加载';
  } catch (err) {
    if (msg) msg.textContent = `加载设置失败: ${esc(err.message)}`;
  }
}

async function saveQuotaSettings(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const msg = document.getElementById('quota-save-msg');

  await withLoading(btn, '保存中...', async () => {
    const interval = Number(document.getElementById('quota-refresh-interval').value);
    const threshold = Number(document.getElementById('quota-min-remaining-percent').value);

    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
      throw new Error('轮询最低额度阈值必须为 0 到 100 之间的整数');
    }

    const res = await fetch('/api/settings/quota', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quota_refresh_interval: interval,
        quota_min_remaining_percent: threshold,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存设置失败');
    msg.textContent = '设置已保存';
  }).catch(err => {
    msg.textContent = `保存设置失败: ${esc(err.message)}`;
  });
}

async function loadPollingSettings() {
  const msg = document.getElementById('polling-save-msg');
  if (msg) msg.textContent = '加载设置中...';

  try {
    const res = await fetch('/api/settings/polling');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载设置失败');

    const tw = data.time_weight ?? 0.3;
    const elSlider = document.getElementById('polling-time-weight-slider');
    const elNumber = document.getElementById('polling-time-weight');
    if (elSlider) elSlider.value = tw;
    if (elNumber) elNumber.value = parseFloat(tw).toFixed(2);

    const elHorizon = document.getElementById('polling-horizon-days');
    if (elHorizon) elHorizon.value = data.horizon_days ?? 30;

    if (msg) msg.textContent = '当前设置已加载';
  } catch (err) {
    if (msg) msg.textContent = `加载设置失败: ${esc(err.message)}`;
  }
}

async function savePollingSettings(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const msg = document.getElementById('polling-save-msg');

  await withLoading(btn, '保存中...', async () => {
    const timeWeight = parseFloat(document.getElementById('polling-time-weight').value);
    const horizonDays = parseFloat(document.getElementById('polling-horizon-days').value);

    if (isNaN(timeWeight) || timeWeight < 0 || timeWeight > 1) {
      throw new Error('时间权重 α 必须为 0 到 1 之间的数值');
    }
    if (isNaN(horizonDays) || horizonDays <= 0) {
      throw new Error('Horizon 必须为正数（天）');
    }

    const res = await fetch('/api/settings/polling', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        time_weight: timeWeight,
        horizon_days: horizonDays,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存设置失败');
    msg.textContent = '设置已保存';
  }).catch(err => {
    msg.textContent = `保存设置失败: ${esc(err.message)}`;
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

  container.innerHTML = pageAccounts.map(acc => {
    const quotaHtml = renderQuota(acc);

    return `
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
          ${acc.grazie_agent ? `<span>Agent: ${esc(acc.grazie_agent)}</span>` : ''}
          ${acc.last_error_type ? `<span>错误类型 ${esc(acc.last_error_type)}</span>` : ''}
        </div>
        ${acc.last_error_message ? `<div class="account-error">${esc(acc.last_error_message)}</div>` : ''}
        <div id="quota-${acc.id}">${quotaHtml}</div>
      </div>
      <div class="account-actions">
        <button class="btn-sm" onclick="showAgentForm('${acc.id}', '${acc.email}', '${acc.grazie_agent || ''}')">选择标识</button>
        <button class="btn-sm" onclick="withLoading(this, '查询中...', () => loadQuota('${acc.id}'))">查额度</button>
        ${acc.status === 'disabled'
          ? `<button class="btn-sm btn-success" onclick="enableAccount(this, '${acc.id}')">启用</button>`
          : `
            <button class="btn-sm" onclick="withLoading(this, '刷新中...', () => refreshAccount('${acc.id}'))">刷新</button>
            <button class="btn-warning" onclick="disableAccount(this, '${acc.id}')">停用</button>
          `}
        <button class="btn-danger" onclick="deleteAccount(this, '${acc.id}')">删除</button>
      </div>
    </div>
  `}).join('');

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

async function loadQuota(id, silent = false) {
  const el = document.getElementById(`quota-${id}`);
  if (el && !silent) el.innerHTML = '<span class="muted">查询中...</span>';

  try {
    const res = await fetch(`/api/accounts/${id}/quota`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '查询额度失败');

    const used = parseFloat(data.current?.tariffQuota?.current?.amount || data.current?.current?.amount || 0);
    const max = parseFloat(data.current?.tariffQuota?.maximum?.amount || data.current?.maximum?.amount || 1000000);

    // Update local cache
    const acc = allAccounts.find(a => a.id === id);
    if (acc) {
      acc.quota_used = used;
      acc.quota_max = max;
      // Sync quota_reset_at from JetBrains current.until
      const until = parseQuotaResetAt(data);
      if (until !== null) acc.quota_reset_at = until;
      if (el) el.innerHTML = renderQuota(acc);
    } else if (el) {
      // Fallback: render without cache object
      const pct = Math.max(0, Math.min(100, ((max - used) / max) * 100));
      el.innerHTML = `
        <div class="account-meta" style="margin-top: 4px;">已用 ${used.toFixed(0)} / ${max.toFixed(0)}</div>
        <div class="quota-bar"><div class="quota-fill" style="width:${pct}%"></div></div>
      `;
    }
  } catch (err) {
    if (el && !silent) el.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
    if (!silent) throw err;
  }
}

/**
 * Extract quota reset timestamp (ms) from a JetBrains quota API response.
 * Returns a positive integer or null.
 */
function parseQuotaResetAt(quotaData) {
  const until = quotaData?.current?.until;
  if (typeof until === 'number' && isFinite(until) && until > 0) return until;
  return null;
}

/**
 * Format a millisecond timestamp to a locale datetime string (to the minute).
 */
function formatDateTime(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Infer the next monthly quota refresh date from the certificate expiry timestamp.
 * The refresh day-of-month equals the expiry day-of-month.
 * If today < that day  → refresh is this month on that day.
 * If today >= that day → refresh is next month on that day.
 * Clamps to the last day of the target month when needed (e.g. day 31 in April).
 * Returns a "YYYY-MM-DD" string, or null when the input is invalid.
 */
function guessNextRefreshDate(resetAtMs) {
  if (typeof resetAtMs !== 'number' || !isFinite(resetAtMs) || resetAtMs <= 0) return null;

  const pad = n => String(n).padStart(2, '0');
  const expiryDay = new Date(resetAtMs).getDate(); // the recurring monthly day

  const now = new Date();
  let year  = now.getFullYear();
  let month = now.getMonth(); // 0-indexed

  if (now.getDate() >= expiryDay) {
    // Already at or past the refresh day this month → push to next month
    month += 1;
    if (month > 11) { month = 0; year += 1; }
  }
  // Clamp to the last day of the target month
  const lastDay   = new Date(year, month + 1, 0).getDate();
  const actualDay = Math.min(expiryDay, lastDay);

  return `${year}-${pad(month + 1)}-${pad(actualDay)}`;
}

/**
 * Render the quota bar + time info row for a given account object.
 * Same line: "下次刷新 YYYY-MM-DD  证书过期 YYYY-MM-DD HH:mm"
 * Returns an HTML string. Safe to call when quota data is missing.
 */
function renderQuota(acc) {
  if (acc.quota_max === undefined || acc.quota_used === undefined) return '';

  const pct = Math.max(0, Math.min(100, ((acc.quota_max - acc.quota_used) / acc.quota_max) * 100));

  // Quota numbers: red when > 90% used
  const usedFraction = acc.quota_max > 0 ? acc.quota_used / acc.quota_max : 0;
  const usedStr = acc.quota_used.toFixed(0);
  const maxStr  = acc.quota_max.toFixed(0);
  const quotaNums = usedFraction > 0.9
    ? `<span style="color:red">${usedStr} / ${maxStr}</span>`
    : `${usedStr} / ${maxStr}`;

  let timeHtml = '';
  if (acc.quota_reset_at !== undefined) {
    const nextRefresh = guessNextRefreshDate(acc.quota_reset_at);
    const certExpiry  = formatDateTime(acc.quota_reset_at);

    // Next refresh date: red when within 7 days (parse as local midnight to avoid UTC shift)
    let nextDateHtml = '未知';
    if (nextRefresh) {
      const [ry, rm, rd] = nextRefresh.split('-').map(Number);
      const refreshLocal = new Date(ry, rm - 1, rd); // local midnight
      const todayLocal   = new Date();
      todayLocal.setHours(0, 0, 0, 0);
      const diffDays = Math.round((refreshLocal - todayLocal) / 86400000);
      const dateColor = diffDays <= 7 ? 'color:red' : 'color:#000';
      nextDateHtml = `<span style="${dateColor}">${esc(nextRefresh)}</span>`;
    }

    const nextPart   = `下次刷新 ${nextDateHtml}`;
    const expiryPart = certExpiry ? `证书过期 <span style="color:#000">${esc(certExpiry)}</span>` : '证书过期 未知';

    timeHtml = `<div class="account-meta" style="margin-top:2px;color:#000;">${nextPart}&ensp;|&ensp;${expiryPart}</div>`;
  }

  return `
    <div class="account-meta" style="margin-top: 4px; color:#000;">已用 ${quotaNums}</div>
    <div class="quota-bar"><div class="quota-fill" style="width:${pct}%"></div></div>
    ${timeHtml}
  `;
}

async function checkAllQuotas(btn) {
  const originalText = btn.textContent;
  btn.disabled = true;
  
  const targetAccounts = allAccounts.filter(a => a.status !== 'disabled');
  let successCount = 0;
  let failCount = 0;
  let processed = 0;

  btn.textContent = `查询中... 0/${targetAccounts.length}`;

  for (const account of targetAccounts) {
    try {
      await loadQuota(account.id, true);
      successCount++;
    } catch (err) {
      failCount++;
    }
    processed++;
    btn.textContent = `查询中... ${processed}/${targetAccounts.length}`;
  }

  btn.disabled = false;
  btn.textContent = originalText;
  
  // Refresh accounts view to ensure everything is rendered, 
  // though loadQuota already updates visible elements.
  renderAccounts();
  alert(`查询完成！成功: ${successCount}, 失败: ${failCount}`);
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

function showAgentForm(id, email, currentAgent) {
  document.getElementById('agent-modal').classList.remove('hidden');
  document.getElementById('agent-account-id').value = id;
  document.getElementById('agent-account-email').textContent = email;
  
  const select = document.getElementById('agent-select');
  select.innerHTML = '<option value="">(默认) aia:idea</option>' + 
    agentPool.map(a => `<option value="${esc(a.name)}">${esc(a.name)} (${esc(a.version)})</option>`).join('');
  
  if (currentAgent) {
    select.value = currentAgent;
  } else {
    select.value = "";
  }
}

function hideAgentForm() {
  document.getElementById('agent-modal').classList.add('hidden');
}

async function saveAgent(btn) {
  const id = document.getElementById('agent-account-id').value;
  const agent_name = document.getElementById('agent-select').value;
  await withLoading(btn, '保存中...', async () => {
    const res = await fetch(`/api/accounts/${id}/grazie-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: agent_name || null })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存失败');
    hideAgentForm();
    await loadAccounts();
  }).catch(err => {
    alert(`保存失败: ${err.message}`);
  });
}

function esc(value) {
  const d = document.createElement('div');
  d.textContent = value || '';
  return d.innerHTML;
}
