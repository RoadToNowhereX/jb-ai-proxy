const express = require('express');
const accountManager = require('../account-manager');
const { loadConfig, saveConfig } = require('../config');

const router = express.Router();
const AUTO_RETRY_TYPES = ['network', 'timeout', 'server_error', 'rate_limit', 'auth', 'client_error', 'unknown'];

router.get('/api/accounts', (req, res) => {
  res.json(accountManager.getAll());
});

router.get('/api/settings/refresh-policy', (req, res) => {
  res.json(loadConfig().refresh_policy || {});
});

router.post('/api/settings/refresh-policy', (req, res) => {
  const config = loadConfig();
  const current = config.refresh_policy || {};
  const { max_retries, retry_delay_ms, auto_retry_on_error, auto_retry_types } = req.body;

  if (!Number.isInteger(max_retries) || max_retries < 0 || max_retries > 10) {
    return res.status(400).json({ error: 'max_retries must be an integer between 0 and 10' });
  }
  if (!Number.isInteger(retry_delay_ms) || retry_delay_ms < 100 || retry_delay_ms > 600000) {
    return res.status(400).json({ error: 'retry_delay_ms must be an integer between 100 and 600000' });
  }
  if (typeof auto_retry_on_error !== 'boolean') {
    return res.status(400).json({ error: 'auto_retry_on_error must be boolean' });
  }
  if (!Array.isArray(auto_retry_types) || auto_retry_types.some(type => !AUTO_RETRY_TYPES.includes(type))) {
    return res.status(400).json({ error: `auto_retry_types must be an array of: ${AUTO_RETRY_TYPES.join(', ')}` });
  }

  const next = saveConfig({
    ...config,
    refresh_policy: {
      ...current,
      max_retries,
      retry_delay_ms,
      auto_retry_on_error,
      auto_retry_types,
    },
  });

  res.json(next.refresh_policy);
});

router.post('/api/accounts/manual', async (req, res) => {
  const { refresh_token, license_id } = req.body;
  if (!refresh_token) {
    return res.status(400).json({ error: 'refresh_token is required' });
  }
  try {
    const account = await accountManager.addManual(refresh_token, license_id || '');
    res.json({ id: account.id, email: account.email, status: account.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/accounts/bulk-disable', (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || !id.trim())) {
    return res.status(400).json({ error: 'ids must be a non-empty array of account ids' });
  }

  try {
    const result = accountManager.bulkDisable(ids);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/accounts/:id/disable', (req, res) => {
  try {
    const account = accountManager.disable(req.params.id);
    res.json({ id: account.id, email: account.email, status: account.status });
  } catch (err) {
    if (err.message === 'Account not found') {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/accounts/:id/enable', async (req, res) => {
  try {
    const account = await accountManager.enable(req.params.id);
    res.json({ id: account.id, email: account.email, status: account.status });
  } catch (err) {
    if (err.message === 'Account not found') {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/accounts/:id', (req, res) => {
  const ok = accountManager.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Account not found' });
  res.json({ ok: true });
});

router.post('/api/accounts/:id/license', async (req, res) => {
  const { license_id } = req.body;
  if (!license_id) return res.status(400).json({ error: 'license_id is required' });
  try {
    const account = await accountManager.updateLicenseId(req.params.id, license_id);
    res.json({ id: account.id, email: account.email, status: account.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/accounts/:id/refresh', async (req, res) => {
  try {
    await accountManager.forceRefresh(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/accounts/:id/quota', async (req, res) => {
  try {
    const quota = await accountManager.getQuotaForAccount(req.params.id);
    res.json(quota);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
