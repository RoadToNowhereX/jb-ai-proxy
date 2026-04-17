document.addEventListener('DOMContentLoaded', async () => {
  // Check panel auth
  const res = await fetch('/api/accounts');
  if (res.status === 401) {
    location.href = '/panel/login.html';
    return;
  }
  loadAccounts();
});

// 通用：给按钮加 loading 状态
async function withLoading(btn, text, fn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = text;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

const PAGE_SIZE = 15;
let allAccounts = [];
let currentPage = 1;

async function loadAccounts() {
  const container = document.getElementById('accounts-list');
  container.innerHTML = '<p class="muted">加载中...</p>';
  try {
    const res = await fetch('/api/accounts');
    allAccounts = await res.json();
    currentPage = 1;
    renderAccounts();
  } catch (err) {
    container.innerHTML = `<p class="muted">加载失败: ${esc(err.message)}</p>`;
    document.getElementById('accounts-summary').textContent = '';
    document.getElementById('accounts-pagination').innerHTML = '';
  }
}

function renderAccounts() {
  const summaryEl = document.getElementById('accounts-summary');
  const container = document.getElementById('accounts-list');
  const pagEl = document.getElementById('accounts-pagination');

  const counts = { active: 0, suspended: 0, quota_exhausted: 0, error: 0 };
  for (const a of allAccounts) counts[a.status] = (counts[a.status] || 0) + 1;
  const parts = [`共 ${allAccounts.length}`];
  if (counts.active) parts.push(`正常 ${counts.active}`);
  if (counts.suspended) parts.push(`已封禁 ${counts.suspended}`);
  if (counts.quota_exhausted) parts.push(`配额耗尽 ${counts.quota_exhausted}`);
  if (counts.error) parts.push(`异常 ${counts.error}`);
  summaryEl.textContent = parts.join('  ·  ');

  if (allAccounts.length === 0) {
    container.innerHTML = '<p class="muted">暂无账号</p>';
    pagEl.innerHTML = '';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(allAccounts.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PAGE_SIZE;
  const slice = allAccounts.slice(start, start + PAGE_SIZE);

  container.innerHTML = slice.map(acc => `
    <div class="account-row">
      <div class="account-info">
        <div class="account-email">${esc(acc.email)}</div>
        <div class="account-meta">
          <span class="status status-${acc.status}">${statusText(acc.status)}</span>
          <span>${esc(acc.license_id || '')}</span>
        </div>
        <div id="quota-${acc.id}"></div>
      </div>
      <div class="account-actions">
        <button class="btn-sm" onclick="withLoading(this,'查询中...',()=>loadQuota('${acc.id}'))">配额</button>
        <button class="btn-sm" onclick="withLoading(this,'刷新中...',()=>refreshAccount('${acc.id}'))">刷新</button>
        <button class="btn-danger" onclick="deleteAccount(this,'${acc.id}')">删除</button>
      </div>
    </div>`).join('');

  if (totalPages <= 1) {
    pagEl.innerHTML = '';
  } else {
    pagEl.innerHTML = `
      <button class="btn-sm" onclick="goToPage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="muted">${currentPage} / ${totalPages}</span>
      <button class="btn-sm" onclick="goToPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>下一页</button>
    `;
  }
}

function goToPage(p) {
  currentPage = p;
  renderAccounts();
}

function statusText(s) {
  const map = { active: '正常', error: '异常', quota_exhausted: '配额耗尽', suspended: '已封禁' };
  return map[s] || s;
}

async function loadQuota(id) {
  const el = document.getElementById(`quota-${id}`);
  el.innerHTML = '<span class="muted">查询中...</span>';
  try {
    const res = await fetch(`/api/accounts/${id}/quota`);
    const d = await res.json();
    const used = parseFloat(d.current?.tariffQuota?.current?.amount || d.current?.current?.amount || 0);
    const max = parseFloat(d.current?.tariffQuota?.maximum?.amount || d.current?.maximum?.amount || 1000000);
    const pct = Math.max(0, Math.min(100, ((max - used) / max) * 100));
    el.innerHTML = `
      <div class="account-meta">已用 ${used.toFixed(0)} / ${max.toFixed(0)}</div>
      <div class="quota-bar"><div class="quota-fill" style="width:${pct}%"></div></div>`;
  } catch (err) {
    el.innerHTML = `<span class="muted">${err.message}</span>`;
  }
}

async function refreshAccount(id) {
  try {
    await fetch(`/api/accounts/${id}/refresh`, { method: 'POST' });
    await loadAccounts();
  } catch (err) {
    alert('刷新失败: ' + err.message);
  }
}

async function deleteAccount(btn, id) {
  if (!confirm('确定删除该账号？')) return;
  await withLoading(btn, '删除中...', async () => {
    try {
      await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
      await loadAccounts();
    } catch (err) {
      alert('删除失败: ' + err.message);
    }
  });
}

async function startOAuth() {
  try {
    const res = await fetch('/auth/start');
    const data = await res.json();
    document.getElementById('oauth-url').href = data.url;
    document.getElementById('oauth-form').classList.remove('hidden');
    document.getElementById('manual-form').classList.add('hidden');
  } catch (err) {
    alert('启动登录失败: ' + err.message);
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
    if (!res.ok) throw new Error(data.error);
    hideOAuthForm();
    await loadAccounts();
  }).catch(err => alert('添加失败: ' + err.message));
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
    const rt = document.getElementById('manual-rt').value.trim();
    const lid = document.getElementById('manual-lid').value.trim();
    const res = await fetch('/api/accounts/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt, license_id: lid }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    hideManualForm();
    document.getElementById('manual-rt').value = '';
    document.getElementById('manual-lid').value = '';
    await loadAccounts();
  }).catch(err => alert('添加失败: ' + err.message));
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}
