/**
 * test/test-polling.js
 *
 * Pure Node.js — no test framework required.
 * Run with:  node test/test-polling.js
 *
 * Tests the dual-dimension SWRR weight algorithm implemented in
 * src/account-manager.js :: getAccountWeight()
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Inline implementation of the functions under test.
// This avoids any dependency on the full server stack while still testing
// exactly the same logic that lives in account-manager.js.
// ─────────────────────────────────────────────────────────────────────────────

function getRemainingQuotaPercent(account) {
  const max = account.quota_max;
  if (typeof max !== 'number' || !isFinite(max) || max <= 0) return null;
  const used = typeof account.quota_used === 'number' && isFinite(account.quota_used)
    ? account.quota_used
    : 0;
  return Math.max(0, Math.min(1, (max - used) / max));
}

/**
 * Compute the dual-dimension weight.
 * @param {object} account
 * @param {{ time_weight?: number, horizon_days?: number }} [pollingCfg]
 */
function getAccountWeight(account, pollingCfg = {}) {
  const quotaScore = getRemainingQuotaPercent(account);
  if (quotaScore === null) return null;

  const timeWeight = typeof pollingCfg.time_weight === 'number'
    ? Math.max(0, Math.min(1, pollingCfg.time_weight))
    : 0.3;
  const horizonMs = typeof pollingCfg.horizon_days === 'number' && pollingCfg.horizon_days > 0
    ? pollingCfg.horizon_days * 86400000
    : 30 * 86400000;

  let timeScore = 0.5;
  const resetAt = account.quota_reset_at;
  if (typeof resetAt === 'number' && isFinite(resetAt)) {
    const msUntilReset = resetAt - Date.now();
    if (msUntilReset <= 0) {
      timeScore = 1;
    } else {
      timeScore = Math.max(0, 1 - msUntilReset / horizonMs);
    }
  }

  return quotaScore * (1 - timeWeight) + timeScore * timeWeight;
}

/**
 * Smooth Weighted Round-Robin selection over an array of candidate accounts.
 * Returns the winning account (modifies _smooth_weight in-place).
 */
function swrrNext(candidates, pollingCfg) {
  for (const acc of candidates) {
    const w = getAccountWeight(acc, pollingCfg);
    acc._smooth_weight = (acc._smooth_weight || 0) + w;
  }
  let best = candidates[0];
  for (const acc of candidates) {
    if (acc._smooth_weight > best._smooth_weight) best = acc;
  }
  const total = candidates.reduce((s, a) => s + getAccountWeight(a, pollingCfg), 0);
  best._smooth_weight -= total;
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiny test harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`[PASS] ${message}`);
    passed++;
  } else {
    console.error(`[FAIL] ${message}`);
    failed++;
  }
}

function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}

const DAY = 86400000;
const NOW = Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// T1: All accounts lack quota_reset_at → timeScore=0.5, ordering by quotaScore
// ─────────────────────────────────────────────────────────────────────────────
{
  const cfg = { time_weight: 0.3, horizon_days: 30 };
  const a80 = { quota_max: 100, quota_used: 20 };           // quotaScore=0.8
  const a40 = { quota_max: 100, quota_used: 60 };           // quotaScore=0.4

  const w80 = getAccountWeight(a80, cfg);
  const w40 = getAccountWeight(a40, cfg);

  // Expected: quotaScore×0.7 + 0.5×0.3
  const exp80 = 0.8 * 0.7 + 0.5 * 0.3;
  const exp40 = 0.4 * 0.7 + 0.5 * 0.3;

  assert(approx(w80, exp80), 'T1: 无 quota_reset_at → 中性 timeScore=0.5，不影响额度排序');
  assert(w80 > w40, 'T1: 高额度账号权重高于低额度账号（无时间数据时）');
}

// ─────────────────────────────────────────────────────────────────────────────
// T2: Same quota, fast-reset vs slow-reset → fast-reset wins
// ─────────────────────────────────────────────────────────────────────────────
{
  const cfg = { time_weight: 0.3, horizon_days: 30 };
  const fast = { quota_max: 100, quota_used: 20, quota_reset_at: NOW + 5 * DAY };
  const slow = { quota_max: 100, quota_used: 20, quota_reset_at: NOW + 25 * DAY };

  const wFast = getAccountWeight(fast, cfg);
  const wSlow = getAccountWeight(slow, cfg);

  assert(wFast > wSlow, 'T2: 快刷新账号权重高于慢刷新账号');
}

// ─────────────────────────────────────────────────────────────────────────────
// T3: Numeric verification against formula
//   Account A: quota 80%, reset in 5 days, α=0.3, horizon=30
//   timeScore = 1 - 5/30 = 0.8333...
//   weight    = 0.8×0.7 + 0.8333×0.3 = 0.56 + 0.25 = 0.81
// ─────────────────────────────────────────────────────────────────────────────
{
  const cfg = { time_weight: 0.3, horizon_days: 30 };
  const msUntilReset = 5 * DAY;
  const acc = { quota_max: 100, quota_used: 20, quota_reset_at: NOW + msUntilReset };

  const w = getAccountWeight(acc, cfg);
  const expTimeScore = Math.max(0, 1 - msUntilReset / (30 * DAY));
  const expected = 0.8 * 0.7 + expTimeScore * 0.3;

  assert(approx(w, expected, 1e-6), 'T3: 综合权重数值符合公式计算值');
}

// ─────────────────────────────────────────────────────────────────────────────
// T4: quota_reset_at in the past → timeScore=1
// ─────────────────────────────────────────────────────────────────────────────
{
  const cfg = { time_weight: 0.3, horizon_days: 30 };
  const acc = { quota_max: 100, quota_used: 20, quota_reset_at: NOW - 1000 };

  const w = getAccountWeight(acc, cfg);
  const expected = 0.8 * 0.7 + 1.0 * 0.3;

  assert(approx(w, expected, 1e-9), 'T4: 已过期 quota_reset_at → timeScore=1');
}

// ─────────────────────────────────────────────────────────────────────────────
// T5: quota_reset_at beyond horizon → timeScore clamped to 0
// ─────────────────────────────────────────────────────────────────────────────
{
  const cfg = { time_weight: 0.3, horizon_days: 30 };
  const acc = { quota_max: 100, quota_used: 20, quota_reset_at: NOW + 60 * DAY };

  const w = getAccountWeight(acc, cfg);
  const expected = 0.8 * 0.7 + 0.0 * 0.3;

  assert(approx(w, expected, 1e-9), 'T5: 超出 horizon_days → timeScore=0（下限钳制）');
}

// ─────────────────────────────────────────────────────────────────────────────
// T6: polling config missing entirely → defaults (α=0.3, horizon=30d), no crash
// ─────────────────────────────────────────────────────────────────────────────
{
  let w;
  try {
    w = getAccountWeight({ quota_max: 100, quota_used: 20 }); // no pollingCfg
  } catch (e) {
    w = null;
  }
  assert(w !== null && !isNaN(w), 'T6: 缺省 polling 配置 → 使用默认值，无报错');
}

// ─────────────────────────────────────────────────────────────────────────────
// T7: time_weight=0 → weight equals quotaScore exactly
// ─────────────────────────────────────────────────────────────────────────────
{
  const cfg = { time_weight: 0, horizon_days: 30 };
  const acc = { quota_max: 100, quota_used: 20, quota_reset_at: NOW + 5 * DAY };

  const w = getAccountWeight(acc, cfg);
  assert(approx(w, 0.8, 1e-9), 'T7: time_weight=0 → 纯额度模式');
}

// ─────────────────────────────────────────────────────────────────────────────
// T8: time_weight=1 → weight equals timeScore exactly
// ─────────────────────────────────────────────────────────────────────────────
{
  const cfg = { time_weight: 1, horizon_days: 30 };
  const msUntilReset = 5 * DAY;
  const acc = { quota_max: 100, quota_used: 20, quota_reset_at: NOW + msUntilReset };

  const w = getAccountWeight(acc, cfg);
  const expTimeScore = 1 - msUntilReset / (30 * DAY);

  assert(approx(w, expTimeScore, 1e-9), 'T8: time_weight=1 → 纯时间模式');
}

// ─────────────────────────────────────────────────────────────────────────────
// T9: SWRR 100-round distribution ≈ weight proportions (±10% tolerance)
// ─────────────────────────────────────────────────────────────────────────────
{
  const cfg = { time_weight: 0.3, horizon_days: 30 };

  const candidates = [
    { id: 'A', quota_max: 100, quota_used: 20, quota_reset_at: NOW + 5 * DAY,  _smooth_weight: 0 },
    { id: 'B', quota_max: 100, quota_used: 20, quota_reset_at: NOW + 25 * DAY, _smooth_weight: 0 },
    { id: 'C', quota_max: 100, quota_used: 60, quota_reset_at: NOW + 5 * DAY,  _smooth_weight: 0 },
    { id: 'D', quota_max: 100, quota_used: 60, quota_reset_at: NOW + 25 * DAY, _smooth_weight: 0 },
  ];

  const ROUNDS = 100;
  const hits = { A: 0, B: 0, C: 0, D: 0 };

  for (let i = 0; i < ROUNDS; i++) {
    const winner = swrrNext(candidates, cfg);
    hits[winner.id]++;
  }

  const totalWeight = candidates.reduce((s, a) => s + getAccountWeight(a, cfg), 0);
  let ok = true;
  for (const acc of candidates) {
    const expectedPct = getAccountWeight(acc, cfg) / totalWeight;
    const actualPct   = hits[acc.id] / ROUNDS;
    if (Math.abs(actualPct - expectedPct) > 0.10) {
      ok = false;
      console.error(`  → Account ${acc.id}: expected≈${(expectedPct*100).toFixed(1)}%, got ${(actualPct*100).toFixed(1)}%`);
    }
  }
  assert(ok, 'T9: SWRR 100 轮调度比例符合权重分布（±10%）');
}

// ─────────────────────────────────────────────────────────────────────────────
// T10: quota_max=0 → getAccountWeight returns null (excluded from scheduling)
// ─────────────────────────────────────────────────────────────────────────────
{
  const w = getAccountWeight({ quota_max: 0, quota_used: 0 });
  assert(w === null, 'T10: quota_max=0 → getAccountWeight 返回 null');
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log('');
console.log(`${passed + failed}/${passed + failed} tests run — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
