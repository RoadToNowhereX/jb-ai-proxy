const { v4: uuidv4 } = require('uuid');
const { loadConfig, loadCredentials, saveCredentials } = require('./config');
const jb = require('./jb-client');

let accounts = [];
let refreshTimer = null;
let quotaRefreshTimer = null;

function normalizeAccount(account) {
  const normalized = {
    ...account,
    status: account.status || 'active',
  };

  if (normalized.quota_date_mode !== 'manual') {
    normalized.quota_date_mode = 'auto';
    normalized.manual_quota_refresh_day = null;
    normalized.manual_cert_expires_on = null;
    return normalized;
  }

  normalized.manual_quota_refresh_day = normalizeRefreshDay(normalized.manual_quota_refresh_day);
  normalized.manual_cert_expires_on = isValidDateOnly(normalized.manual_cert_expires_on)
    ? normalized.manual_cert_expires_on
    : null;

  if (!normalized.manual_quota_refresh_day || !normalized.manual_cert_expires_on) {
    normalized.quota_date_mode = 'auto';
    normalized.manual_quota_refresh_day = null;
    normalized.manual_cert_expires_on = null;
  }

  return normalized;
}

function getQuotaDateMode(account) {
  return account.quota_date_mode === 'manual' ? 'manual' : 'auto';
}

function normalizeRefreshDay(value) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return day;
}

function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

function getNextMonthlyDateMs(dayOfMonth, fromMs = Date.now()) {
  const day = normalizeRefreshDay(dayOfMonth);
  if (!day) return null;

  const now = new Date(fromMs);
  if (Number.isNaN(now.getTime())) return null;

  let year = now.getFullYear();
  let month = now.getMonth();
  const buildDate = (targetYear, targetMonth) => {
    const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
    return new Date(targetYear, targetMonth, Math.min(day, lastDay));
  };

  let next = buildDate(year, month);
  const today = new Date(year, month, now.getDate());
  if (next <= today) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
    next = buildDate(year, month);
  }

  return next.getTime();
}

function getEffectiveQuotaResetAt(account) {
  if (getQuotaDateMode(account) === 'manual') {
    return getNextMonthlyDateMs(account.manual_quota_refresh_day);
  }

  const resetAt = account.quota_reset_at;
  if (typeof resetAt === 'number' && isFinite(resetAt) && resetAt > 0) return resetAt;
  return null;
}

function init() {
  accounts = loadCredentials().map(normalizeAccount);
  startRefreshLoop();
  startQuotaRefreshLoop();
  console.log(`Account manager: loaded ${accounts.length} account(s)`);
}

function getAll() {
  return accounts.map(account => {
    const effectiveQuotaResetAt = getEffectiveQuotaResetAt(account);
    return {
      id: account.id,
      email: account.email,
      status: account.status,
      license_id: account.license_id,
      added_at: account.added_at,
      last_used_at: account.last_used_at,
      last_error_type: account.last_error_type || null,
      last_error_at: account.last_error_at || null,
      last_error_message: account.last_error_message || null,
      last_recovery_attempt_at: account.last_recovery_attempt_at || null,
      quota_used: account.quota_used,
      quota_max: account.quota_max,
      quota_updated_at: account.quota_updated_at,
      quota_reset_at: effectiveQuotaResetAt || account.quota_reset_at,
      quota_date_mode: getQuotaDateMode(account),
      manual_quota_refresh_day: Number.isInteger(account.manual_quota_refresh_day) ? account.manual_quota_refresh_day : null,
      manual_cert_expires_on: account.manual_cert_expires_on || null,
      account_weight: getAccountWeight(account),
      grazie_agent: account.grazie_agent,
    };
  });
}

async function addFromOAuth(tokens, licenseId) {
  const { id_token, refresh_token } = tokens;
  if (!licenseId) throw new Error('License ID is required');

  const payload = jb.decodeJwtPayload(id_token);
  const email = payload.email || payload.preferred_username || 'unknown';

  const existing = accounts.find(account => account.email === email);
  if (existing) {
    existing.refresh_token = refresh_token;
    existing.id_token = id_token;
    existing.id_token_expires_at = (payload.exp || 0) * 1000;
    existing.license_id = licenseId;
    existing.status = 'active';
    await refreshJwt(existing);
    persist();
    return existing;
  }

  const userInfo = await jb.getUserInfo(id_token);
  if (!userInfo.ok) {
    await jb.registerGrazie(id_token);
  }

  const account = {
    id: uuidv4(),
    email,
    refresh_token,
    license_id: licenseId,
    id_token,
    id_token_expires_at: (payload.exp || 0) * 1000,
    jwt: null,
    jwt_expires_at: 0,
    status: 'active',
    added_at: Date.now(),
    last_used_at: null,
    grazie_agent: null,
  };

  await refreshJwt(account);
  accounts.push(account);
  persist();
  return account;
}

async function addManual(refreshToken, licenseId) {
  if (!licenseId) throw new Error('License ID is required');

  const tokens = await jb.refreshIdToken(refreshToken);
  const payload = jb.decodeJwtPayload(tokens.id_token);
  const email = payload.email || payload.preferred_username || 'unknown';

  const existing = accounts.find(account => account.email === email);
  if (existing) {
    existing.refresh_token = tokens.refresh_token || refreshToken;
    existing.license_id = licenseId;
    existing.id_token = tokens.id_token;
    existing.id_token_expires_at = (payload.exp || 0) * 1000;
    existing.status = 'active';
    await refreshJwt(existing);
    persist();
    return existing;
  }

  const userInfo = await jb.getUserInfo(tokens.id_token);
  if (!userInfo.ok) {
    await jb.registerGrazie(tokens.id_token);
  }

  const account = {
    id: uuidv4(),
    email,
    refresh_token: tokens.refresh_token || refreshToken,
    license_id: licenseId,
    id_token: tokens.id_token,
    id_token_expires_at: (payload.exp || 0) * 1000,
    jwt: null,
    jwt_expires_at: 0,
    status: 'active',
    added_at: Date.now(),
    last_used_at: null,
    grazie_agent: null,
  };

  await refreshJwt(account);
  accounts.push(account);
  persist();
  return account;
}

function remove(id) {
  const idx = accounts.findIndex(account => account.id === id);
  if (idx === -1) return false;
  accounts.splice(idx, 1);
  persist();
  return true;
}

function disable(id) {
  const account = getAccountById(id);
  if (account.status === 'disabled') return account;
  account.status = 'disabled';
  persist();
  return account;
}

function bulkDisable(ids) {
  const uniqueIds = [...new Set(ids)];
  let updated = 0;

  for (const id of uniqueIds) {
    const account = accounts.find(item => item.id === id);
    if (!account || account.status === 'disabled') continue;
    account.status = 'disabled';
    updated++;
  }

  if (updated > 0) persist();
  return { ok: true, updated };
}

/**
 * Returns a value in [0, 1] representing the remaining quota fraction,
 * or null if quota data is unavailable / invalid.
 */
function getRemainingQuotaPercent(account) {
  const max = account.quota_max;
  if (typeof max !== 'number' || !isFinite(max) || max <= 0) return null;
  const used = typeof account.quota_used === 'number' && isFinite(account.quota_used)
    ? account.quota_used
    : 0;
  return Math.max(0, Math.min(1, (max - used) / max));
}

/**
 * Returns a positive weight (0..1) for use in Smooth WRR.
 * Combines quota score and time score (dual-dimension SWRR):
 *   weight = quotaScore × (1 - α) + timeScore × α
 *
 * timeScore is inversely proportional to time until quota reset:
 *   accounts closer to reset get higher timeScore → higher priority.
 *
 * Parameters read from config:
 *   polling.time_weight   (α)            default 0.3
 *   polling.horizon_days  (horizon)      default 30
 *
 * Accounts with unknown or invalid quota data return null (excluded from scheduling).
 */
function getAccountWeight(account) {
  // ── Quota score (preserves original logic) ──────────────────────────────
  const quotaScore = getRemainingQuotaPercent(account);
  if (quotaScore === null) return null; // invalid quota → exclude

  // ── Read configurable parameters ────────────────────────────────────────
  const cfg = loadConfig();
  const timeWeight = typeof cfg.polling?.time_weight === 'number'
    ? Math.max(0, Math.min(1, cfg.polling.time_weight))
    : 0.3;
  const horizonMs = typeof cfg.polling?.horizon_days === 'number' && cfg.polling.horizon_days > 0
    ? cfg.polling.horizon_days * 86400000
    : 30 * 86400000;

  // ── Time score (inverted: closer to reset → higher score) ───────────────
  let timeScore = 0.5; // neutral default when quota_reset_at is unknown
  const resetAt = account.quota_reset_at;
  if (typeof resetAt === 'number' && isFinite(resetAt)) {
    const msUntilReset = resetAt - Date.now();
    if (msUntilReset <= 0) {
      timeScore = 1; // reset has arrived (or is overdue) → highest priority
    } else {
      timeScore = Math.max(0, 1 - msUntilReset / horizonMs);
    }
  }

  // ── Combined weight ──────────────────────────────────────────────────────
  return quotaScore * (1 - timeWeight) + timeScore * timeWeight;
}

function getNext() {
  const cfg = loadConfig();
  // threshold is a percentage value 0-100; convert to fraction
  const thresholdFraction = (cfg.quota_min_remaining_percent ?? 10) / 100;

  // Only active accounts participate
  const active = accounts.filter(account => account.status === 'active');
  if (active.length === 0) return null;

  // Separate candidates: accounts with valid quota above threshold
  const candidates = active.filter(account => {
    const pct = getRemainingQuotaPercent(account);
    if (pct === null) return false; // unknown quota → excluded
    return pct > thresholdFraction;  // <= threshold → skip
  });

  if (candidates.length === 0) return null;

  // Smooth Weighted Round-Robin
  // Each account accumulates its weight each round; the highest wins and
  // has the total weight subtracted, distributing load proportionally.
  for (const acc of candidates) {
    const w = getAccountWeight(acc);
    acc._smooth_weight = (acc._smooth_weight || 0) + w;
  }

  // Pick the one with the highest current smooth weight
  let best = candidates[0];
  for (const acc of candidates) {
    if (acc._smooth_weight > best._smooth_weight) best = acc;
  }

  // Subtract total weight from the winner
  const totalWeight = candidates.reduce((sum, acc) => sum + getAccountWeight(acc), 0);
  best._smooth_weight -= totalWeight;

  best.last_used_at = Date.now();
  return best;
}

async function ensureValidJwt(account, opts = {}) {
  const preserveDisabled = opts.preserveDisabled ?? account.status === 'disabled';
  const now = Date.now();

  if (!account.id_token || now > account.id_token_expires_at - 300000) {
    try {
      const tokens = await jb.refreshIdToken(account.refresh_token);
      account.id_token = tokens.id_token;
      if (tokens.refresh_token) account.refresh_token = tokens.refresh_token;
      const payload = jb.decodeJwtPayload(tokens.id_token);
      account.id_token_expires_at = (payload.exp || 0) * 1000;
      clearAccountError(account);
    } catch (err) {
      markAccountError(account, 'refresh_id_token', err, { preserveDisabled });
      throw new Error(`Failed to refresh id_token for ${account.email}: ${jb.formatRequestError(err)}`);
    }
  }

  if (!account.jwt || now > account.jwt_expires_at - 1800000) {
    await refreshJwt(account, { preserveDisabled });
  }

  persist();
  return account.jwt;
}

async function refreshJwt(account, opts = {}) {
  const preserveDisabled = Boolean(opts.preserveDisabled && account.status === 'disabled');

  try {
    const result = await jb.provideAccess(account.id_token, account.license_id);
    if (!result.token) throw new Error('No token in provide-access response');

    account.jwt = result.token;
    const jwtPayload = jb.decodeJwtPayload(result.token);
    account.jwt_expires_at = (jwtPayload.exp || 0) * 1000;
    account.status = preserveDisabled ? 'disabled' : 'active';

    if (!preserveDisabled) clearAccountError(account);
  } catch (err) {
    markAccountError(account, 'provide_access', err, { preserveDisabled });
    throw new Error(`Failed to get JWT for ${account.email}: ${jb.formatRequestError(err)}`);
  }
}

async function updateLicenseId(id, licenseId) {
  const account = getAccountById(id);
  account.license_id = licenseId;

  const now = Date.now();
  if (!account.id_token || now > account.id_token_expires_at - 300000) {
    const tokens = await jb.refreshIdToken(account.refresh_token);
    account.id_token = tokens.id_token;
    if (tokens.refresh_token) account.refresh_token = tokens.refresh_token;
    const payload = jb.decodeJwtPayload(tokens.id_token);
    account.id_token_expires_at = (payload.exp || 0) * 1000;
  }

  await refreshJwt(account, { preserveDisabled: account.status === 'disabled' });
  persist();
  return account;
}

function updateGrazieAgent(id, agentName) {
  const account = getAccountById(id);
  account.grazie_agent = agentName || null;
  persist();
  return account;
}

function updateDateSettings(id, settings = {}) {
  const account = getAccountById(id);
  const mode = settings.quota_date_mode === 'manual' ? 'manual' : 'auto';

  if (mode === 'auto') {
    account.quota_date_mode = 'auto';
    account.manual_quota_refresh_day = null;
    account.manual_cert_expires_on = null;
    persist();
    return account;
  }

  const manualQuotaRefreshDay = normalizeRefreshDay(settings.manual_quota_refresh_day);
  if (!manualQuotaRefreshDay) {
    throw new Error('manual_quota_refresh_day must be an integer between 1 and 31');
  }
  if (!isValidDateOnly(settings.manual_cert_expires_on)) {
    throw new Error('manual_cert_expires_on must be a valid YYYY-MM-DD date');
  }

  account.quota_date_mode = 'manual';
  account.manual_quota_refresh_day = manualQuotaRefreshDay;
  account.manual_cert_expires_on = settings.manual_cert_expires_on;
  account.quota_reset_at = getNextMonthlyDateMs(manualQuotaRefreshDay);
  persist();
  return account;
}

async function forceRefresh(id) {
  const account = getAccountById(id);

  if (account.status === 'error') {
    account.id_token_expires_at = 0;
    account.jwt_expires_at = 0;
  }

  await ensureValidJwt(account, { preserveDisabled: account.status === 'disabled' });

  if (account.status !== 'error' && account.status !== 'disabled') {
    account.status = 'active';
  }

  persist();
  return account;
}

async function enable(id) {
  const account = getAccountById(id);
  await ensureValidJwt(account, { preserveDisabled: false });
  account.status = 'active';
  clearAccountError(account);
  persist();
  return account;
}

async function getQuotaForAccount(id) {
  const account = getAccountById(id);
  const jwt = await ensureValidJwt(account, { preserveDisabled: account.status === 'disabled' });
  const quotaData = await jb.getQuota(jwt);
  
  const used = parseFloat(quotaData.current?.tariffQuota?.current?.amount || quotaData.current?.current?.amount || 0);
  const max = parseFloat(quotaData.current?.tariffQuota?.maximum?.amount || quotaData.current?.maximum?.amount || 1000000);
  
  account.quota_used = used;
  account.quota_max = max;
  account.quota_updated_at = Date.now();

  // Persist quota reset time from JetBrains response (millisecond timestamp)
  const until = quotaData.current?.until;
  if (getQuotaDateMode(account) === 'manual') {
    account.quota_reset_at = getNextMonthlyDateMs(account.manual_quota_refresh_day);
  } else if (typeof until === 'number' && isFinite(until) && until > 0) {
    account.quota_reset_at = until;
  }

  persist();
  
  return quotaData;
}

function startRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);

  refreshTimer = setInterval(async () => {
    for (const account of accounts) {
      if (account.status === 'active') {
        try {
          await ensureValidJwt(account);
        } catch (err) {
          console.error(`Auto-refresh failed for ${account.email}: ${err.message}`);
        }
        continue;
      }

      if (account.status !== 'error') continue;

      try {
        if (!shouldAutoRetryErrorAccount(account)) continue;
        account.last_recovery_attempt_at = Date.now();
        await ensureValidJwt(account);
        console.log(`Auto-recovery succeeded for ${account.email}`);
      } catch (err) {
        console.error(`Auto-recovery failed for ${account.email}: ${err.message}`);
      }
    }
  }, 600000);
}

function startQuotaRefreshLoop() {
  if (quotaRefreshTimer) clearInterval(quotaRefreshTimer);

  quotaRefreshTimer = setInterval(async () => {
    const intervalMinutes = loadConfig().quota_refresh_interval ?? 60;
    if (intervalMinutes <= 0) return; // 0 means disabled
    
    const intervalMs = intervalMinutes * 60 * 1000;
    const now = Date.now();

    for (const account of accounts) {
      if (account.status === 'disabled') continue;
      
      const lastUpdated = account.quota_updated_at || 0;
      if (now - lastUpdated > intervalMs) {
        try {
          await getQuotaForAccount(account.id);
        } catch (err) {
          console.error(`Auto quota refresh failed for ${account.email}: ${err.message}`);
        }
      }
    }
  }, 60000); // Check every minute
}

function getRefreshPolicy() {
  return loadConfig().refresh_policy || {};
}

function getAccountById(id) {
  const account = accounts.find(item => item.id === id);
  if (!account) throw new Error('Account not found');
  return account;
}

function classifyAccountError(err) {
  if (err instanceof jb.JBRequestError) return err.type || 'unknown';
  return 'unknown';
}

function markAccountError(account, stage, err, opts = {}) {
  const preserveDisabled = Boolean(opts.preserveDisabled && account.status === 'disabled');
  account.status = preserveDisabled ? 'disabled' : 'error';
  account.last_error_type = classifyAccountError(err);
  account.last_error_at = Date.now();
  account.last_error_stage = stage;
  account.last_error_message = jb.formatRequestError(err);
  persist();
}

function clearAccountError(account) {
  account.last_error_type = null;
  account.last_error_at = null;
  account.last_error_stage = null;
  account.last_error_message = null;
}

function shouldAutoRetryErrorAccount(account) {
  const policy = getRefreshPolicy();
  if (!policy.auto_retry_on_error) return false;

  const allowedTypes = Array.isArray(policy.auto_retry_types) ? policy.auto_retry_types : [];
  const errorType = account.last_error_type || 'unknown';
  if (!allowedTypes.includes(errorType)) return false;

  const retryDelayMs = Number.isInteger(policy.retry_delay_ms) ? policy.retry_delay_ms : 1500;
  const cooldownMs = Math.max(retryDelayMs, 60000);
  if (account.last_recovery_attempt_at && Date.now() - account.last_recovery_attempt_at < cooldownMs) return false;
  return true;
}

function persist() {
  saveCredentials(accounts);
}

function markStatus(account, status) {
  if (account.status === status) return;
  account.status = status;
  persist();
}

module.exports = {
  init,
  getAll,
  addFromOAuth,
  addManual,
  remove,
  disable,
  enable,
  bulkDisable,
  updateLicenseId,
  updateGrazieAgent,
  updateDateSettings,
  getNext,
  ensureValidJwt,
  forceRefresh,
  getQuotaForAccount,
  markStatus,
  getNextMonthlyDateMs,
};
