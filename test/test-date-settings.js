'use strict';

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log("[PASS] " + message); passed++; }
  else { console.error("[FAIL] " + message); failed++; }
}

// ---------- Inline implementations (same as account-manager.js) ----------

function normalizeRefreshDay(value) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return day;
}

function isValidDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

function getNextMonthlyDateMs(dayOfMonth, fromMs) {
  const day = normalizeRefreshDay(dayOfMonth);
  if (!day) return null;
  const now = new Date(fromMs || Date.now());
  if (Number.isNaN(now.getTime())) return null;
  let year = now.getFullYear(), month = now.getMonth();
  const buildDate = (ty, tm) => { const ld = new Date(ty, tm + 1, 0).getDate(); return new Date(ty, tm, Math.min(day, ld)); };
  let next = buildDate(year, month);
  const today = new Date(year, month, now.getDate());
  if (next <= today) { month += 1; if (month > 11) { month = 0; year += 1; } next = buildDate(year, month); }
  return next.getTime();
}

// ---------- Tests ----------

// T1: normalizeRefreshDay valid values
assert(normalizeRefreshDay(1) === 1, "T1: refresh day 1");
assert(normalizeRefreshDay(15) === 15, "T1: refresh day 15");
assert(normalizeRefreshDay(31) === 31, "T1: refresh day 31");
assert(normalizeRefreshDay(0) === null, "T1: refresh day 0 -> null");
assert(normalizeRefreshDay(32) === null, "T1: refresh day 32 -> null");
assert(normalizeRefreshDay("abc") === null, "T1: non-numeric -> null");
assert(normalizeRefreshDay(3.5) === null, "T1: non-integer -> null");

// T2: isValidDateOnly
assert(isValidDateOnly("2026-06-15") === true, "T2: valid date");
assert(isValidDateOnly("2026-02-29") === false, "T2: Feb 29 non-leap");
assert(isValidDateOnly("2024-02-29") === true, "T2: Feb 29 leap year");
assert(isValidDateOnly("not-a-date") === false, "T2: garbage string");
assert(isValidDateOnly("2026-13-01") === false, "T2: month 13");
assert(isValidDateOnly("2026-00-01") === false, "T2: month 0");
assert(isValidDateOnly("2026-06-00") === false, "T2: day 0");
assert(isValidDateOnly("") === false, "T2: empty string");

// T3: next 15th when today is June 14 -> June 15 (same month)
{
  const today = new Date(2026, 5, 14);
  const ts = getNextMonthlyDateMs(15, today.getTime());
  const d = new Date(ts);
  assert(d.getFullYear() === 2026, "T3: year 2026");
  assert(d.getMonth() === 5, "T3: month June");
  assert(d.getDate() === 15, "T3: day 15");
}

// T4: next 15th when today is June 10 -> June 15 (same month, earlier)
{
  const today = new Date(2026, 5, 10);
  const ts = getNextMonthlyDateMs(15, today.getTime());
  const d = new Date(ts);
  assert(d.getMonth() === 5 && d.getDate() === 15, "T4: day 15 after Jun 10 -> Jun 15");
}

// T5: day 31 after Mar 31 -> Apr 30 (clamp)
{
  const today = new Date(2026, 2, 31);
  const ts = getNextMonthlyDateMs(31, today.getTime());
  const d = new Date(ts);
  assert(d.getMonth() === 3 && d.getDate() === 30, "T5: day 31 after Mar 31 -> Apr 30");
}

// T6: day 15 when today is June 15 -> July 15 (next month, same day)
{
  const today = new Date(2026, 5, 15);
  const ts = getNextMonthlyDateMs(15, today.getTime());
  const d = new Date(ts);
  assert(d.getMonth() === 6 && d.getDate() === 15, "T6: day 15 on Jun 15 -> Jul 15");
}

// T7: day 1 when today is Dec 31 -> Jan 1 next year
{
  const today = new Date(2026, 11, 31);
  const ts = getNextMonthlyDateMs(1, today.getTime());
  const d = new Date(ts);
  assert(d.getFullYear() === 2027 && d.getMonth() === 0 && d.getDate() === 1, "T7: day 1 after Dec 31 -> Jan 1");
}

// T8: invalid day returns null
assert(getNextMonthlyDateMs(0) === null, "T8: day 0 -> null");
assert(getNextMonthlyDateMs(-5) === null, "T8: negative day -> null");

console.log("");
console.log(passed + failed + "/" + (passed + failed) + " tests run - " + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);