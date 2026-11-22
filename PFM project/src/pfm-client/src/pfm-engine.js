/**
 * MyPFM — Standalone Domain Engine (runs 100% on-device; also loadable in Node for tests)
 * --------------------------------------------------------------------------------------
 * Design rules:
 *  - All money math is done in integer cents (no floating-point drift).
 *  - Every transaction stores the exact `effects` it applied ([{accountId, deltaCents}]
 *    plus envelope effects). Delete = apply the negated effects; Edit = reverse + re-post.
 *  - Every mutating operation runs inside `atomic()`: any thrown error restores the
 *    full data object, so a failed edit can never leave half-applied balances.
 *  - ASNB lowest-monthly balances are RE-COMPUTED from the ledger after every change,
 *    so edits/deletes automatically reverse their ASNB impact.
 *  - Dates are LOCAL calendar dates (YYYY-MM-DD), never UTC `toISOString()` slices.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PfmEngine = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const SCHEMA_VERSION = 3;
  const PILLARS = ['ASSET_LIQUID', 'ASSET_INVESTMENT', 'LIABILITY', 'INCOME_SOURCE'];
  const INTEREST_METHODS = ['NONE', 'DAILY_COMPOUND', 'LOWEST_MONTHLY_BALANCE', 'FIXED_MATURITY', 'DYNAMIC_TIERED_RATE', 'ASNB_MIN_MONTHLY'];
  const TX_TYPES = ['EXPENSE', 'INCOME', 'TRANSFER', 'INSTALLMENT_PURCHASE', 'INSTALLMENT_PAYMENT', 'BALANCE_ADJUSTMENT', 'INTEREST'];
  const EDITABLE_TYPES = ['EXPENSE', 'INCOME', 'TRANSFER', 'INSTALLMENT_PURCHASE', 'INSTALLMENT_PAYMENT'];
  const DEDUP_WINDOW_MS = 2 * 60 * 1000;
  const COLLISION_WINDOW_MS = 5 * 60 * 1000;
  const OTHER_CATEGORY_ID = 'cat-other';
  /** IDs of records that only ever existed in the old built-in demo seed. */
  const LEGACY_SEED_IDS = {
    transactions: ['tx-seed-1', 'tx-seed-2'],
    installmentPlans: ['plan-spaylater-150'],
    reimbursements: ['reimb-1'],
    asnbSnapshots: ['snap-asnb-2026-10'],
    accounts: ['bank-a', 'bank-b', 'gxbank', 'tng-ewallet', 'tng-nfc', 'asnb-fixed', 'spaylater', 'cc-visa', 'income-salary']
  };

  const ERROR_CODES = [
    'INVALID_AMOUNT', 'AMOUNT_MUST_BE_POSITIVE', 'AMOUNT_TOO_LARGE', 'INVALID_TENURE', 'INVALID_RATE',
    'INVALID_DUE_DAY', 'INVALID_DATE', 'INVALID_FEE', 'INVALID_BALANCE', 'INVALID_PAID_COUNT',
    'ACCOUNT_NOT_FOUND', 'SAME_ACCOUNT', 'INVALID_ACCOUNT_FOR_TX', 'NOT_A_LIABILITY', 'NOTHING_OUTSTANDING',
    'PLAN_NOT_FOUND', 'SCHEDULE_NOT_FOUND', 'SCHEDULE_ALREADY_PAID', 'INVALID_PAYMENT_SOURCE',
    'INSUFFICIENT_FUNDS', 'LIABILITY_OVERPAID', 'PLAN_HAS_PAYMENTS', 'TX_NOT_FOUND', 'TX_NOT_EDITABLE',
    'NO_CHANGE', 'NAME_REQUIRED', 'INVALID_PILLAR', 'CATALOG_NOT_FOUND', 'INVALID_INTEREST_METHOD',
    'INVALID_BACKUP', 'REFUSED_EMPTY_OVERWRITE', 'UNKNOWN_TX_TYPE'
  ];

  class PfmError extends Error {
    constructor(code, details) {
      super(code);
      this.name = 'PfmError';
      this.code = code;
      this.details = details || {};
    }
  }

  // ===========================================================================
  // MONEY (integer cents)
  // ===========================================================================
  function toCents(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(Number((n * 100).toPrecision(12)));
  }
  function fromCents(c) { return Math.round(c) / 100; }
  function round2(v) { return fromCents(toCents(v)); }
  function addMoney(a, b) { return fromCents(toCents(a) + toCents(b)); }

  function cleanNumberInput(input) {
    if (typeof input === 'number') return input;
    if (input === null || input === undefined) return NaN;
    const s = String(input).replace(/rm|myr/gi, '').replace(/[,\s]/g, '');
    if (s === '' || !/^-?\d*\.?\d*$/.test(s)) return NaN;
    return Number(s);
  }

  // ===========================================================================
  // VALIDATION (guards against negative numbers / NaN everywhere)
  // ===========================================================================
  function parseAmount(input) {
    const n = cleanNumberInput(input);
    if (!Number.isFinite(n)) throw new PfmError('INVALID_AMOUNT');
    if (n <= 0 || toCents(n) <= 0) throw new PfmError('AMOUNT_MUST_BE_POSITIVE');
    if (n > 1e9) throw new PfmError('AMOUNT_TOO_LARGE');
    return round2(n);
  }
  function parseNonNegative(input, code) {
    const n = cleanNumberInput(input === '' ? 0 : input);
    if (!Number.isFinite(n) || n < 0) throw new PfmError(code || 'INVALID_AMOUNT');
    if (n > 1e9) throw new PfmError('AMOUNT_TOO_LARGE');
    return round2(n);
  }
  function parseTenure(input) {
    const n = cleanNumberInput(input);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 360) throw new PfmError('INVALID_TENURE');
    return n;
  }
  function parseRate(input) {
    const n = cleanNumberInput(input === '' ? 0 : input);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new PfmError('INVALID_RATE');
    return Math.round(n * 10000) / 10000;
  }
  function parseDueDay(input) {
    const n = cleanNumberInput(input);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 31) throw new PfmError('INVALID_DUE_DAY');
    return n;
  }
  function parseDate(input) {
    if (!isValidDateStr(input)) throw new PfmError('INVALID_DATE');
    return input;
  }

  // ===========================================================================
  // LOCAL CALENDAR DATES
  // ===========================================================================
  const pad2 = (n) => String(n).padStart(2, '0');
  function formatDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function todayStr(now) { return formatDate(now instanceof Date ? now : new Date()); }
  function isValidDateStr(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }
  function parseLocal(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(s, n) { const d = parseLocal(s); d.setDate(d.getDate() + n); return formatDate(d); }
  function daysBetween(a, b) {
    const [y1, m1, d1] = a.split('-').map(Number);
    const [y2, m2, d2] = b.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  }
  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
  function ymOf(s) { return s.slice(0, 7); }
  function nextYm(ym) { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${pad2(m + 1)}`; }
  function lastDayOfYm(ym) { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad2(daysInMonth(y, m))}`; }
  function dateWithClampedDay(y, m, day) { return `${y}-${pad2(m)}-${pad2(Math.min(day, daysInMonth(y, m)))}`; }

  function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ===========================================================================
  // ATOMIC MUTATION WRAPPER
  // ===========================================================================
  function atomic(data, fn) {
    const snapshot = JSON.stringify(data);
    try {
      return fn();
    } catch (err) {
      const restored = JSON.parse(snapshot);
      Object.keys(data).forEach((k) => { delete data[k]; });
      Object.assign(data, restored);
      throw err;
    }
  }

  // ===========================================================================
  // EMPTY / DEFAULT STRUCTURES
  // ===========================================================================
  function defaultCategories() {
    return [
      { id: 'cat-food', code: 'FOOD_DINING', nameEn: 'Food & Dining', nameZh: '餐饮美食', icon: '🍜', budget: 0 },
      { id: 'cat-transport', code: 'TRANSPORT_TOLL', nameEn: 'Transport, Toll & Parking', nameZh: '交通、过路费与停车', icon: '🚗', budget: 0 },
      { id: 'cat-shopping', code: 'SHOPPING_TECH', nameEn: 'Shopping, Tech & Lifestyle', nameZh: '购物、数码与生活', icon: '🛍️', budget: 0 },
      { id: 'cat-bills', code: 'BILLS_UTILITIES', nameEn: 'Bills & Utilities', nameZh: '账单与水电费', icon: '⚡', budget: 0 },
      { id: 'cat-insurance', code: 'INSURANCE', nameEn: 'Insurance & Protection', nameZh: '保险与医疗保障', icon: '🛡️', budget: 0 },
      { id: 'cat-fees', code: 'BANK_FEES', nameEn: 'Bank & Transfer Fees', nameZh: '银行与转账手续费', icon: '🏦', budget: 0 },
      { id: OTHER_CATEGORY_ID, code: 'OTHER', nameEn: 'Other / Uncategorised', nameZh: '其他 / 未分类', icon: '📌', budget: 0 }
    ];
  }
  function defaultTaxBuckets() {
    return [
      { code: 'LHDN_LIFESTYLE', nameEn: 'Lifestyle (Books, PC, Smartphone, Internet)', nameZh: '生活方式减免（书籍、电脑、手机、宽带）', cap: 2500, claimed: 0 },
      { code: 'LHDN_SPORTS', nameEn: 'Sports Equipment, Gym & Competition', nameZh: '体育器材、健身房与赛事减免', cap: 1000, claimed: 0 },
      { code: 'LHDN_MEDICAL', nameEn: 'Medical, Vaccination & Full Check-Up', nameZh: '医疗、疫苗与全面体检减免', cap: 10000, claimed: 0 }
    ];
  }
  function defaultSettings() {
    return { autoCreateFromNotifications: false, notificationListenerEnabled: true };
  }
  function defaultNotificationState() {
    return { dedup: {}, inbox: [], pendingDiscoveries: [], unmappedApps: [], ignoredPackages: [], packageAccountMap: {}, merchantRules: {} };
  }

  /** A brand-new install: NO accounts, NOT initialised (onboarding will be shown). */
  function createEmptyData() {
    return {
      schemaVersion: SCHEMA_VERSION,
      systemInitialized: false,
      lang: 'en',
      netMonthlyIncome: 0,
      accounts: [],
      transactions: [],
      installmentPlans: [],
      recurringBills: [],
      categories: defaultCategories(),
      reimbursements: [],
      taxBuckets: defaultTaxBuckets(),
      asnbSnapshots: [],
      settings: defaultSettings(),
      notificationState: defaultNotificationState()
    };
  }

  // ===========================================================================
  // ACCOUNTS
  // ===========================================================================
  function getCatalog(catalog) {
    return catalog || (root && root.PfmCatalog) || null;
  }

  
  /** Historical Rate Protection: finds rate active on a given date from rateHistory */
  function getEffectiveRate(acc, date) {
    if (!acc) return 0;
    const d = date || todayStr();
    if (Array.isArray(acc.rateHistory) && acc.rateHistory.length > 0) {
      const sorted = acc.rateHistory.slice().sort((a, b) => (a.effectiveDate || '').localeCompare(b.effectiveDate || ''));
      const matching = sorted.filter((h) => h.effectiveDate && h.effectiveDate <= d);
      if (matching.length > 0) return Number(matching[matching.length - 1].rate) || 0;
      return Number(sorted[0].rate) || 0;
    }
    return Number(acc.annualRate) || 0;
  }

  function normalizeAccount(a, today) {
    const acc = Object.assign({}, a);
    acc.id = acc.id || uid('acc');
    if (!PILLARS.includes(acc.pillar)) acc.pillar = 'ASSET_LIQUID';
    acc.nameEn = String(acc.nameEn || acc.nameZh || 'Account');
    acc.nameZh = String(acc.nameZh || acc.nameEn);
    acc.subTypeEn = String(acc.subTypeEn || acc.subTypeZh || 'Custom');
    acc.subTypeZh = String(acc.subTypeZh || acc.subTypeEn);
    acc.currentBalance = Number.isFinite(Number(acc.currentBalance)) ? round2(acc.currentBalance) : 0;
    acc.minBalanceLimit = Number.isFinite(Number(acc.minBalanceLimit)) && Number(acc.minBalanceLimit) >= 0 ? round2(acc.minBalanceLimit) : 0;
    if (!INTEREST_METHODS.includes(acc.interestMethod)) acc.interestMethod = 'NONE';
    acc.annualRate = Number.isFinite(Number(acc.annualRate)) && Number(acc.annualRate) >= 0 ? Number(acc.annualRate) : 0;
    if (!Array.isArray(acc.rateHistory) || acc.rateHistory.length === 0) {
      acc.rateHistory = acc.annualRate > 0 ? [{ effectiveDate: acc.createdDate || today, rate: acc.annualRate }] : [];
    }
    acc.tiers = Array.isArray(acc.tiers) ? acc.tiers.map((t) => ({
      upTo: (t.upTo === null || t.upTo === undefined || t.upTo === '') ? null : Number(t.upTo),
      rate: Number(t.rate) || 0
    })) : [];
    if (acc.interestMethod === 'FIXED_MATURITY') {
      acc.fdPrincipal = Number.isFinite(Number(acc.fdPrincipal)) ? round2(acc.fdPrincipal) : round2(acc.currentBalance);
      acc.fdTenureMonths = Number.isFinite(Number(acc.fdTenureMonths)) ? Number(acc.fdTenureMonths) : 12;
      acc.fdStartDate = isValidDateStr(acc.fdStartDate || '') ? acc.fdStartDate : today;
      acc.fdMaturityDate = isValidDateStr(acc.fdMaturityDate || '') ? acc.fdMaturityDate : addDays(acc.fdStartDate, acc.fdTenureMonths * 30);
    }
    if (typeof acc.autoAccrueInterest !== 'boolean') acc.autoAccrueInterest = acc.interestMethod === 'DAILY_COMPOUND';
    const initAccruedDate = acc.interestLastAccruedDate || acc.lastAccruedDate;
    if (acc.interestMethod === 'DAILY_COMPOUND') {
      acc.interestLastAccruedDate = isValidDateStr(initAccruedDate || '') ? initAccruedDate : today;
      acc.lastAccruedDate = acc.interestLastAccruedDate;
    }
    acc.interestCarry = Number.isFinite(Number(acc.interestCarry)) ? Number(acc.interestCarry) : 0;
    if (acc.interestMethod === 'ASNB_MIN_MONTHLY' || acc.interestMethod === 'LOWEST_MONTHLY_BALANCE') {
      if (!/^\d{4}-\d{2}$/.test(acc.asnbTrackingYm || '')) acc.asnbTrackingYm = ymOf(today);
      if (!Number.isFinite(Number(acc.lowestMonthlyBalance))) acc.lowestMonthlyBalance = acc.currentBalance;
    }
    acc.envelopes = (Array.isArray(acc.envelopes) ? acc.envelopes : []).map((e) => ({
      id: e.id || uid('env'),
      nameEn: String(e.nameEn || e.nameZh || 'Envelope'),
      nameZh: String(e.nameZh || e.nameEn || 'Envelope'),
      allocated: Math.max(0, round2(e.allocated ?? e.allocatedBalance ?? 0)),
      target: Math.max(0, round2(e.target || 0))
    }));
    acc.autoDebits = (Array.isArray(acc.autoDebits) ? acc.autoDebits : []).map((d) => {
      const ad = {
        id: d.id || uid('ad'),
        nameEn: String(d.nameEn || d.nameZh || 'Auto-debit'),
        nameZh: String(d.nameZh || d.nameEn || 'Auto-debit'),
        amount: Math.max(0, round2(d.amount || 0)),
        dayOfMonth: Number.isInteger(Number(d.dayOfMonth)) && d.dayOfMonth >= 1 && d.dayOfMonth <= 31 ? Number(d.dayOfMonth) : 1
      };
      if (d.dueInDays !== undefined && d.dueInDays !== null && Number.isFinite(Number(d.dueInDays))) {
        ad.dueInDays = Number(d.dueInDays);
      }
      return ad;
    });
    acc.androidPackages = Array.isArray(acc.androidPackages) ? acc.androidPackages.filter(Boolean).map(String) : [];
    acc.notificationKeywords = Array.isArray(acc.notificationKeywords) ? acc.notificationKeywords.map(String) : [];
    if (acc.pillar === 'INCOME_SOURCE' && !(acc.payDayOfMonth >= 1 && acc.payDayOfMonth <= 31)) acc.payDayOfMonth = 25;
    acc.isZeroInterestLiquid = acc.pillar === 'ASSET_LIQUID' && acc.interestMethod === 'NONE';
    acc.createdAt = acc.createdAt || new Date().toISOString();
    return acc;
  }

  function findAccount(data, id) { return data.accounts.find((a) => a.id === id) || null; }
  function requireAccount(data, id) {
    const acc = findAccount(data, id);
    if (!acc) throw new PfmError('ACCOUNT_NOT_FOUND', { accountId: id });
    return acc;
  }

  function createAccount(data, input, opts) {
    const today = (opts && opts.today) || todayStr();
    return atomic(data, () => {
      if (!PILLARS.includes(input.pillar)) throw new PfmError('INVALID_PILLAR');
      const nameEn = String(input.nameEn || '').trim();
      const nameZh = String(input.nameZh || '').trim();
      if (!nameEn && !nameZh) throw new PfmError('NAME_REQUIRED');
      if (input.interestMethod && !INTEREST_METHODS.includes(input.interestMethod)) throw new PfmError('INVALID_INTEREST_METHOD');
      const balance = parseNonNegative(input.currentBalance ?? 0, 'INVALID_BALANCE');
      const acc = normalizeAccount({
        id: input.id || uid('acc'),
        pillar: input.pillar,
        subTypeEn: input.subTypeEn, subTypeZh: input.subTypeZh,
        nameEn: nameEn || nameZh, nameZh: nameZh || nameEn,
        currentBalance: balance,
        lowestMonthlyBalance: input.lowestMonthlyBalance !== undefined ? parseNonNegative(input.lowestMonthlyBalance, 'INVALID_BALANCE') : balance,
        minBalanceLimit: parseNonNegative(input.minBalanceLimit ?? 0, 'INVALID_BALANCE'),
        interestMethod: input.interestMethod || 'NONE',
        annualRate: parseRate(input.annualRate ?? 0),
        tiers: input.tiers || [],
        fdPrincipal: input.fdPrincipal,
        fdTenureMonths: input.fdTenureMonths,
        fdStartDate: input.fdStartDate,
        fdMaturityDate: input.fdMaturityDate,
        autoAccrueInterest: input.autoAccrueInterest,
        interestLastAccruedDate: input.interestLastAccruedDate || input.lastAccruedDate || today,
        catalogCode: input.catalogCode || null,
        androidPackages: input.androidPackages || [],
        notificationKeywords: input.notificationKeywords || [],
        envelopes: input.envelopes || [],
        autoDebits: input.autoDebits || [],
        payDayOfMonth: input.payDayOfMonth,
        needsBalanceSetup: !!input.needsBalanceSetup
      }, today);
      data.accounts.push(acc);
      data.systemInitialized = true;
      return acc;
    });
  }

  function createAccountFromCatalog(data, code, overrides, catalog, opts) {
    const cat = getCatalog(catalog);
    const item = cat && cat.findByCode(code);
    if (!item) throw new PfmError('CATALOG_NOT_FOUND');
    return createAccount(data, Object.assign({
      pillar: item.pillar,
      subTypeEn: item.subTypeEn, subTypeZh: item.subTypeZh,
      nameEn: item.nameEn, nameZh: item.nameZh,
      currentBalance: 0,
      minBalanceLimit: item.defaultFloor,
      interestMethod: item.interestMethod,
      annualRate: item.defaultRate,
      autoAccrueInterest: item.autoAccrue,
      catalogCode: item.code,
      androidPackages: item.androidPackages.slice(),
      notificationKeywords: item.notificationKeywords.slice()
    }, overrides || {}), opts);
  }

  /** Non-balance settings only. Balance changes go through `adjustBalance` (ledger). */
  function updateAccountSettings(data, id, patch, opts) {
    const today = (opts && opts.today) || todayStr();
    return atomic(data, () => {
      const acc = requireAccount(data, id);
      if (patch.nameEn !== undefined || patch.nameZh !== undefined) {
        const en = String(patch.nameEn ?? acc.nameEn).trim();
        const zh = String(patch.nameZh ?? acc.nameZh).trim();
        if (!en && !zh) throw new PfmError('NAME_REQUIRED');
        acc.nameEn = en || zh; acc.nameZh = zh || en;
      }
      if (patch.subTypeEn !== undefined) acc.subTypeEn = String(patch.subTypeEn).trim() || acc.subTypeEn;
      if (patch.subTypeZh !== undefined) acc.subTypeZh = String(patch.subTypeZh).trim() || acc.subTypeZh;
      if (patch.currentBalance !== undefined) {
        const nextBal = parseNonNegative(patch.currentBalance, 'INVALID_BALANCE');
        if (toCents(nextBal) !== toCents(acc.currentBalance)) {
          postTransactionInternal(data, { type: 'BALANCE_ADJUSTMENT', accountId: acc.id, newBalance: nextBal, date: today }, { today, force: true });
        }
      }
      if (patch.minBalanceLimit !== undefined) acc.minBalanceLimit = parseNonNegative(patch.minBalanceLimit, 'INVALID_BALANCE');
      if (patch.interestMethod !== undefined) {
        if (!INTEREST_METHODS.includes(patch.interestMethod)) throw new PfmError('INVALID_INTEREST_METHOD');
        if (patch.interestMethod !== acc.interestMethod) {
          acc.interestMethod = patch.interestMethod;
          if (acc.interestMethod === 'DAILY_COMPOUND') { acc.interestLastAccruedDate = addDays(today, -1); acc.interestCarry = 0; }
          if (acc.interestMethod === 'ASNB_MIN_MONTHLY') { acc.asnbTrackingYm = ymOf(today); acc.asnbManualLowest = null; }
        }
      }
      if (patch.annualRate !== undefined) {
        const newRate = parseRate(patch.annualRate);
        if (newRate !== acc.annualRate) {
          acc.rateHistory = Array.isArray(acc.rateHistory) ? acc.rateHistory : [];
          if (!acc.rateHistory.length) {
            acc.rateHistory.push({ effectiveDate: acc.createdDate || today, rate: acc.annualRate || 0 });
          }
          acc.rateHistory.push({ effectiveDate: today, rate: newRate });
          acc.annualRate = newRate;
        }
      }
      if (patch.tiers !== undefined) {
        acc.tiers = Array.isArray(patch.tiers) ? patch.tiers.map((t) => ({
          upTo: (t.upTo === null || t.upTo === undefined || t.upTo === '') ? null : parseAmount(t.upTo),
          rate: parseRate(t.rate)
        })) : [];
      }
      if (patch.fdPrincipal !== undefined) acc.fdPrincipal = parseAmount(patch.fdPrincipal);
      if (patch.fdTenureMonths !== undefined) acc.fdTenureMonths = parseTenure(patch.fdTenureMonths);
      if (patch.fdStartDate !== undefined) acc.fdStartDate = parseDate(patch.fdStartDate);
      if (patch.fdMaturityDate !== undefined) acc.fdMaturityDate = parseDate(patch.fdMaturityDate);
      if (patch.autoAccrueInterest !== undefined) {
        const next = !!patch.autoAccrueInterest;
        if (next && !acc.autoAccrueInterest) { acc.interestLastAccruedDate = addDays(today, -1); acc.interestCarry = 0; }
        acc.autoAccrueInterest = next;
      }
      if (patch.lowestMonthlyBalanceOverride !== undefined && (acc.interestMethod === 'ASNB_MIN_MONTHLY' || acc.interestMethod === 'LOWEST_MONTHLY_BALANCE')) {
        const v = patch.lowestMonthlyBalanceOverride;
        acc.asnbManualLowest = (v === null || v === '') ? null : { ym: ymOf(today), value: parseNonNegative(v, 'INVALID_BALANCE') };
      }
      if (patch.androidPackages !== undefined) {
        acc.androidPackages = (Array.isArray(patch.androidPackages) ? patch.androidPackages : String(patch.androidPackages).split(/[\s,;]+/))
          .map((s) => String(s).trim()).filter(Boolean);
      }
      if (patch.payDayOfMonth !== undefined && acc.pillar === 'INCOME_SOURCE') acc.payDayOfMonth = parseDueDay(patch.payDayOfMonth);
      if (patch.envelopes !== undefined) {
        acc.envelopes = patch.envelopes.map((e) => ({
          id: e.id || uid('env'),
          nameEn: String(e.nameEn || e.nameZh || '').trim() || 'Envelope',
          nameZh: String(e.nameZh || e.nameEn || '').trim() || 'Envelope',
          allocated: parseNonNegative(e.allocated ?? 0, 'INVALID_AMOUNT'),
          target: parseNonNegative(e.target ?? 0, 'INVALID_AMOUNT')
        }));
      }
      if (patch.autoDebits !== undefined) {
        acc.autoDebits = patch.autoDebits.map((d) => {
          const ad = {
            id: d.id || uid('ad'),
            nameEn: String(d.nameEn || d.nameZh || '').trim() || 'Auto-debit',
            nameZh: String(d.nameZh || d.nameEn || '').trim() || 'Auto-debit',
            amount: parseAmount(d.amount),
            dayOfMonth: parseDueDay(d.dayOfMonth ?? 1)
          };
          if (d.dueInDays !== undefined && d.dueInDays !== null && Number.isFinite(Number(d.dueInDays))) {
            ad.dueInDays = Number(d.dueInDays);
          }
          return ad;
        });
      }
      acc.isZeroInterestLiquid = acc.pillar === 'ASSET_LIQUID' && acc.interestMethod === 'NONE';
      if (acc.interestMethod === 'ASNB_MIN_MONTHLY' || acc.interestMethod === 'LOWEST_MONTHLY_BALANCE') refreshAsnb(data, acc, today);
      return acc;
    });
  }

  /**
   * Deletes an account. Ledger history is kept (shown as "deleted account"); installment
   * plans that belong to a deleted liability are removed with it.
   */
  function deleteAccount(data, id) {
    return atomic(data, () => {
      const target = requireAccount(data, id);
      data.accounts = data.accounts.filter((a) => a.id !== id);
      data.transactions = data.transactions.filter((t) => t.fromAccountId !== id && t.toAccountId !== id && t.accountId !== id);
      data.installmentPlans = data.installmentPlans.filter((p) => p.liabilityAccountId !== id);
      data.installmentPlans.forEach((p) => {
        if (p.linkedRepaymentAccountId === id) p.linkedRepaymentAccountId = null;
      });
      data.recurringBills = (data.recurringBills || []).filter((b) => b.fromAccountId !== id && b.toAccountId !== id);
      data.asnbSnapshots = data.asnbSnapshots.filter((s) => s.accountId !== id);
      if (data.notificationState && data.notificationState.packageAccountMap) {
        Object.keys(data.notificationState.packageAccountMap).forEach((pkg) => {
          if (data.notificationState.packageAccountMap[pkg] === id) {
            delete data.notificationState.packageAccountMap[pkg];
          }
        });
      }
      if (target.pillar === 'INCOME_SOURCE') {
        const remInc = data.accounts.filter((a) => a.pillar === 'INCOME_SOURCE').reduce((s, a) => s + toCents(a.currentBalance), 0);
        data.netMonthlyIncome = fromCents(remInc);
      }
      return true;
    });
  }

  // ===========================================================================
  // LEDGER
  // ===========================================================================
  /** Money LEAVING an account: asset balance down, liability (amount owed) up. */
  function outflowCents(acc, cents) { return acc.pillar === 'LIABILITY' ? cents : -cents; }
  /** Money ENTERING an account: asset balance up, liability (amount owed) down. */
  function inflowCents(acc, cents) { return acc.pillar === 'LIABILITY' ? -cents : cents; }

  function assertMoneyAccount(acc) {
    if (acc.pillar === 'INCOME_SOURCE') throw new PfmError('INVALID_ACCOUNT_FOR_TX', { accountId: acc.id });
  }

  function findTx(data, id) { return data.transactions.find((t) => t.id === id) || null; }

  function applyEffects(data, effects, sign) {
    effects.forEach((ef) => {
      const acc = findAccount(data, ef.accountId);
      if (!acc) return; // account was deleted: history kept, nothing to move
      if (ef.envelopeId) {
        const env = (acc.envelopes || []).find((e) => e.id === ef.envelopeId);
        if (env) env.allocated = fromCents(Math.max(0, toCents(env.allocated) + sign * ef.deltaCents));
        return;
      }
      acc.currentBalance = fromCents(toCents(acc.currentBalance) + sign * ef.deltaCents);
    });
  }

  function checkBalances(data, effects, opts) {
    if (opts && opts.force) return;
    const projected = {};
    effects.forEach((ef) => {
      if (ef.envelopeId) return;
      const acc = findAccount(data, ef.accountId);
      if (!acc) return;
      projected[acc.id] = (projected[acc.id] ?? toCents(acc.currentBalance)) + ef.deltaCents;
    });
    Object.keys(projected).forEach((id) => {
      const acc = findAccount(data, id);
      const before = toCents(acc.currentBalance);
      const after = projected[id];
      if (after < 0 && after < before) {
        throw new PfmError(acc.pillar === 'LIABILITY' ? 'LIABILITY_OVERPAID' : 'INSUFFICIENT_FUNDS', {
          accountId: id, resultingBalance: fromCents(after)
        });
      }
    });
  }

  /**
   * Posts a transaction. `params` is stored on the record so it can be edited later.
   * opts: { force: allow negative balances, today }
   */
  function postTransactionInternal(data, rawParams, opts) {
    const today = (opts && opts.today) || todayStr();
    const p = Object.assign({}, rawParams);
    if (!TX_TYPES.includes(p.type)) throw new PfmError('UNKNOWN_TX_TYPE');
    const date = p.date ? parseDate(p.date) : today;
    const tx = {
      id: p.id || uid('tx'),
      type: p.type,
      date,
      createdAt: p.createdAt || new Date().toISOString(),
      amount: 0,
      personalAmount: 0,
      fromAccountId: null,
      toAccountId: null,
      categoryId: null,
      envelopeId: null,
      taxCategoryCode: p.taxCategoryCode || null,
      note: String(p.note || '').slice(0, 200),
      source: p.source || 'MANUAL',
      notifHash: p.notifHash || null,
      linkedNotifHashes: Array.isArray(p.linkedNotifHashes) ? p.linkedNotifHashes.slice() : [],
      planId: null,
      scheduleIds: [],
      reimbursementId: p.reimbursementId || null,
      createdReimbursementId: null,
      meta: p.meta || null,
      effects: [],
      params: null,
      legacy: false
    };
    const effects = [];

    switch (p.type) {
      case 'EXPENSE': {
        const amount = parseAmount(p.amount);
        const from = requireAccount(data, p.fromAccountId || p.accountId);
        assertMoneyAccount(from);
        const cents = toCents(amount);
        effects.push({ accountId: from.id, deltaCents: outflowCents(from, cents) });
        if (p.envelopeId) {
          const env = (from.envelopes || []).find((e) => e.id === p.envelopeId);
          if (env) {
            const take = Math.min(toCents(env.allocated), cents);
            if (take > 0) effects.push({ accountId: from.id, envelopeId: env.id, deltaCents: -take });
            tx.envelopeId = env.id;
          }
        }
        const personal = p.personalAmount === undefined || p.personalAmount === null || p.personalAmount === ''
          ? amount : parseNonNegative(p.personalAmount, 'INVALID_AMOUNT');
        tx.amount = amount;
        tx.personalAmount = Math.min(amount, personal);
        tx.fromAccountId = from.id;
        tx.categoryId = p.categoryId || OTHER_CATEGORY_ID;
        tx.descEn = p.descEn || `Expense (${tx.note || tx.categoryId}) paid from ${from.nameEn}`;
        tx.descZh = p.descZh || `支出 (${tx.note || tx.categoryId}) 扣自 ${from.nameZh}`;
        const owedCents = cents - toCents(tx.personalAmount);
        if (owedCents > 0 && p.createReimbursement !== false) {
          const reimbId = p.createdReimbursementId || uid('reimb');
          const debtorName = String(p.debtorName || 'Friend (Split Bill)').trim() || 'Friend (Split Bill)';
          data.reimbursements = Array.isArray(data.reimbursements) ? data.reimbursements : [];
          data.reimbursements.push({
            id: reimbId,
            sourceTxId: tx.id,
            debtorName,
            owedAmount: fromCents(owedCents),
            descEn: `${tx.note || 'Split Bill'} (${from.nameEn})`,
            descZh: `${tx.note || 'AA分账代垫'} (${from.nameZh})`,
            date,
            settled: false
          });
          tx.createdReimbursementId = reimbId;
        }
        break;
      }
      case 'INCOME': {
        const amount = parseAmount(p.amount);
        const to = requireAccount(data, p.toAccountId || p.accountId);
        assertMoneyAccount(to);
        effects.push({ accountId: to.id, deltaCents: inflowCents(to, toCents(amount)) });
        tx.amount = amount;
        tx.toAccountId = to.id;
        tx.fromAccountId = p.incomeSourceId && findAccount(data, p.incomeSourceId) ? p.incomeSourceId : null;
        tx.descEn = p.descEn || `Income credited to ${to.nameEn}`;
        tx.descZh = p.descZh || `收入存入 ${to.nameZh}`;
        break;
      }
      case 'TRANSFER': {
        const amount = parseAmount(p.amount);
        const fee = parseNonNegative(p.transferFee ?? p.fee ?? 0, 'INVALID_FEE');
        const from = requireAccount(data, p.fromAccountId);
        const to = requireAccount(data, p.toAccountId);
        if (from.id === to.id) throw new PfmError('SAME_ACCOUNT');
        assertMoneyAccount(from); assertMoneyAccount(to);
        const cents = toCents(amount);
        const feeCents = toCents(fee);
        effects.push({ accountId: from.id, deltaCents: outflowCents(from, cents + feeCents) });
        effects.push({ accountId: to.id, deltaCents: inflowCents(to, cents) });
        tx.amount = amount;
        tx.transferFee = fee;
        tx.personalAmount = fee;
        tx.fromAccountId = from.id;
        tx.toAccountId = to.id;
        tx.categoryId = fee > 0 ? (p.categoryId || 'cat-fees') : null;
        tx.descEn = p.descEn || `Atomic Transfer: ${from.nameEn} -> ${to.nameEn}${fee > 0 ? ` (Fee RM ${fee.toFixed(2)})` : ' (RM 0 Expense Inflation)'}`;
        tx.descZh = p.descZh || `原子转账：${from.nameZh} -> ${to.nameZh}${fee > 0 ? `（手续费 RM ${fee.toFixed(2)}）` : '（RM 0 费用虚增）'}`;
        break;
      }
      case 'BALANCE_ADJUSTMENT': {
        const acc = requireAccount(data, p.accountId || p.toAccountId);
        const newBal = parseNonNegative(p.newBalance, 'INVALID_BALANCE');
        const prevBal = acc.currentBalance;
        const delta = toCents(newBal) - toCents(prevBal);
        if (delta === 0) throw new PfmError('NO_CHANGE');
        effects.push({ accountId: acc.id, deltaCents: delta });
        tx.amount = fromCents(Math.abs(delta));
        tx.toAccountId = acc.id;
        tx.meta = { previousBalance: prevBal, newBalance: newBal };
        tx.descEn = p.descEn || `Balance Adjustment: ${acc.nameEn} (RM ${prevBal.toFixed(2)} -> RM ${newBal.toFixed(2)})`;
        tx.descZh = p.descZh || `余额调整：${acc.nameZh} (RM ${prevBal.toFixed(2)} -> RM ${newBal.toFixed(2)})`;
        opts = Object.assign({}, opts, { force: true });
        break;
      }
      case 'INTEREST': {
        const amount = parseAmount(p.amount);
        const to = requireAccount(data, p.toAccountId);
        effects.push({ accountId: to.id, deltaCents: inflowCents(to, toCents(amount)) });
        tx.amount = amount;
        tx.toAccountId = to.id;
        tx.source = p.source || 'SYSTEM';
        tx.descEn = p.descEn || `Daily Compound Interest Credited to ${to.nameEn}`;
        tx.descZh = p.descZh || `复利利息入账至 ${to.nameZh}`;
        break;
      }
      case 'INSTALLMENT_PURCHASE': {
        const liab = requireAccount(data, p.liabilityAccountId);
        if (liab.pillar !== 'LIABILITY') throw new PfmError('NOT_A_LIABILITY');
        const plan = buildInstallmentPlan(p, liab.id, today);
        plan.purchaseTxId = tx.id;
        const outstanding = plan.schedules.filter((r) => r.status === 'UNPAID').reduce((s, r) => s + toCents(r.amount), 0);
        if (outstanding <= 0) throw new PfmError('NOTHING_OUTSTANDING');
        effects.push({ accountId: liab.id, deltaCents: outstanding });
        data.installmentPlans.push(plan);
        tx.amount = plan.totalPrincipal;
        tx.toAccountId = liab.id;
        tx.planId = plan.id;
        tx.categoryId = plan.categoryId;
        tx.descEn = p.descEn || `Installment Plan: ${plan.itemName} (${plan.tenureMonths}M on ${liab.nameEn})`;
        tx.descZh = p.descZh || `新增分期计划：${plan.itemName}（${plan.tenureMonths}期 • ${liab.nameZh}）`;
        tx.meta = { outstanding: fromCents(outstanding) };
        break;
      }
      case 'INSTALLMENT_PAYMENT': {
        const from = requireAccount(data, p.fromAccountId);
        if (from.pillar !== 'ASSET_LIQUID' && from.pillar !== 'ASSET_INVESTMENT') throw new PfmError('INVALID_PAYMENT_SOURCE');
        const ids = Array.isArray(p.scheduleIds) ? p.scheduleIds : [];
        if (!ids.length) throw new PfmError('SCHEDULE_NOT_FOUND');

        const matchedPairs = [];
        ids.forEach((sid) => {
          let foundPlan = p.planId ? data.installmentPlans.find((pl) => pl.id === p.planId && (pl.schedules || []).some((x) => x.id === sid)) : null;
          if (!foundPlan) {
            foundPlan = data.installmentPlans.find((pl) => (pl.schedules || []).some((x) => x.id === sid));
          }
          if (!foundPlan) throw new PfmError('PLAN_NOT_FOUND');
          const r = foundPlan.schedules.find((x) => x.id === sid);
          if (!r) throw new PfmError('SCHEDULE_NOT_FOUND');
          if (r.status !== 'UNPAID') throw new PfmError('SCHEDULE_ALREADY_PAID', { number: r.number });
          matchedPairs.push({ plan: foundPlan, row: r });
        });

        const primaryPlan = matchedPairs[0].plan;
        const liab = requireAccount(data, p.liabilityAccountId || p.toAccountId || primaryPlan.liabilityAccountId);
        const rows = matchedPairs.map((m) => m.row);
        const principal = rows.reduce((s, r) => s + toCents(r.principal), 0);
        const fees = rows.reduce((s, r) => s + toCents(r.fee), 0);
        const waive = !!p.waiveFees && rows.length > 1;
        let cash = principal + (waive ? 0 : fees);
        let reduction = principal + fees;
        if (p.customAmount !== undefined && p.customAmount !== null && p.customAmount !== '') {
          cash = toCents(parseAmount(p.customAmount));
          reduction = cash;
        } else if (p.amount !== undefined && p.amount !== null && p.amount !== '') {
          cash = toCents(parseAmount(p.amount));
          reduction = cash;
        }
        effects.push({ accountId: from.id, deltaCents: outflowCents(from, cash) });
        effects.push({ accountId: liab.id, deltaCents: -reduction });
        const touchedPlans = new Set();
        matchedPairs.forEach(({ plan, row }) => {
          row.status = 'PAID';
          row.paid = true;
          row.paidTxId = tx.id;
          row.paidDate = date;
          touchedPlans.add(plan);
        });
        touchedPlans.forEach((pl) => {
          pl.status = pl.schedules.some((r) => r.status === 'UNPAID') ? 'ACTIVE' : 'COMPLETED';
        });
        tx.amount = fromCents(cash);
        tx.fromAccountId = from.id;
        tx.toAccountId = liab.id;
        tx.planId = primaryPlan.id;
        tx.planIds = Array.from(touchedPlans).map((pl) => pl.id);
        tx.scheduleIds = rows.map((r) => r.id);
        tx.descEn = p.descEn || `Installment Repayment: ${from.nameEn} -> ${liab.nameEn} (RM ${fromCents(cash).toFixed(2)})`;
        tx.descZh = p.descZh || `分期还款: ${from.nameZh} -> ${liab.nameZh} (RM ${fromCents(cash).toFixed(2)})`;
        tx.meta = { waivedFees: waive ? fromCents(fees) : 0, earlySettlement: rows.length > 1 };
        break;
      }
      default:
        throw new PfmError('UNKNOWN_TX_TYPE');
    }

    checkBalances(data, effects, opts);
    applyEffects(data, effects, +1);
    tx.effects = effects;
    tx.params = Object.assign({}, p, { id: tx.id, createdAt: tx.createdAt, date });
    if (tx.reimbursementId) {
      const r = data.reimbursements.find((x) => x.id === tx.reimbursementId);
      if (r) { r.settled = true; r.settledTxId = tx.id; }
    }
    data.transactions.push(tx);
    afterLedgerChange(data, effects, date, today);
    return tx;
  }

  function reverseTransactionInternal(data, tx, today) {
    if (tx.type === 'INSTALLMENT_PURCHASE' && tx.planId) {
      const plan = data.installmentPlans.find((pl) => pl.id === tx.planId);
      if (plan && plan.schedules.some((r) => r.status === 'PAID')) throw new PfmError('PLAN_HAS_PAYMENTS');
      data.installmentPlans = data.installmentPlans.filter((pl) => pl.id !== tx.planId);
    }
    if (tx.type === 'INSTALLMENT_PAYMENT') {
      const sIds = Array.isArray(tx.scheduleIds) ? tx.scheduleIds : [];
      (data.installmentPlans || []).forEach((plan) => {
        let touched = false;
        (plan.schedules || []).forEach((r) => {
          if (r.paidTxId === tx.id || (sIds.length && sIds.includes(r.id))) {
            r.status = 'UNPAID';
            r.paid = false;
            delete r.paidTxId;
            delete r.paidDate;
            touched = true;
          }
        });
        if (touched || plan.id === tx.planId) {
          plan.status = plan.schedules.some((r) => r.status === 'UNPAID') ? 'ACTIVE' : 'COMPLETED';
        }
      });
    }
    if (tx.reimbursementId) {
      const r = data.reimbursements.find((x) => x.id === tx.reimbursementId);
      if (r && r.settledTxId === tx.id) {
        r.settled = false;
        delete r.settledTxId;
        delete r.settledDate;
        delete r.settledAccountId;
      }
    }
    if (tx.createdReimbursementId) {
      data.reimbursements = (data.reimbursements || []).filter((x) => x.id !== tx.createdReimbursementId);
    }
    const effects = tx.effects || [];
    applyEffects(data, effects, -1);
    data.transactions = data.transactions.filter((t) => t.id !== tx.id);
    afterLedgerChange(data, effects, tx.date, today);
  }

  function postTransaction(data, params, opts) {
    return atomic(data, () => postTransactionInternal(data, params, opts));
  }

  function deleteTransaction(data, id, opts) {
    const today = (opts && opts.today) || todayStr();
    return atomic(data, () => {
      const tx = findTx(data, id);
      if (!tx) throw new PfmError('TX_NOT_FOUND');
      reverseTransactionInternal(data, tx, today);
      return tx;
    });
  }

  /** Edit = reverse the old effects, then re-post with merged params (all-or-nothing). */
  function editTransaction(data, id, patch, opts) {
    const today = (opts && opts.today) || todayStr();
    return atomic(data, () => {
      const old = findTx(data, id);
      if (!old) throw new PfmError('TX_NOT_FOUND');
      if (old.legacy || !old.params || !EDITABLE_TYPES.includes(old.type)) throw new PfmError('TX_NOT_EDITABLE');
      const normalizedPatch = Object.assign({}, patch);
      const nextType = (normalizedPatch.type && EDITABLE_TYPES.includes(normalizedPatch.type)) ? normalizedPatch.type : old.type;
      if (nextType === 'EXPENSE' && normalizedPatch.accountId && !normalizedPatch.fromAccountId) {
        normalizedPatch.fromAccountId = normalizedPatch.accountId;
      }
      if (nextType === 'INCOME' && normalizedPatch.accountId && !normalizedPatch.toAccountId) {
        normalizedPatch.toAccountId = normalizedPatch.accountId;
      }
      if (normalizedPatch.amount !== undefined && normalizedPatch.personalAmount === undefined &&
          old.params && old.params.personalAmount !== undefined && toCents(old.params.personalAmount) === toCents(old.amount)) {
        normalizedPatch.personalAmount = normalizedPatch.amount;
      }
      const merged = Object.assign({}, old.params, normalizedPatch, {
        id: old.id, createdAt: old.createdAt, type: nextType, source: old.source,
        notifHash: old.notifHash, linkedNotifHashes: old.linkedNotifHashes
      });
      if (nextType === 'INSTALLMENT_PURCHASE') merged.planId = old.planId; // keep plan identity
      if (nextType === 'INSTALLMENT_PAYMENT') {
        merged.scheduleIds = old.scheduleIds;
        merged.planId = old.planId;
        merged.liabilityAccountId = normalizedPatch.toAccountId || old.toAccountId;
      }
      if (nextType !== 'EXPENSE') {
        delete merged.personalAmount;
        delete merged.createdReimbursementId;
      }
      // Self-learning merchant rule when user corrects category on a notification or requests learning
      if (nextType === 'EXPENSE' && normalizedPatch.categoryId &&
          (normalizedPatch.learnRule || (old.source === 'NOTIFICATION' && normalizedPatch.categoryId !== old.categoryId))) {
        learnMerchantCategory(data, merged.note || old.note || '', normalizedPatch.categoryId);
      }
      reverseTransactionInternal(data, old, today);
      return postTransactionInternal(data, merged, opts);
    });
  }

  /**
   * Full Edit / Modify support for an existing InstallmentPlan:
   * Allows modifying itemName, totalPrincipal, tenureMonths, monthlyFee, dueDay,
   * linkedRepaymentAccountId, liabilityAccountId, and categoryId, while automatically
   * recalculating the parent Liability account's currentBalance.
   */
  function editInstallmentPlan(data, planId, patch, opts) {
    const today = (opts && opts.today) || todayStr();
    return atomic(data, () => {
      const plan = data.installmentPlans.find((p) => p.id === planId);
      if (!plan) throw new PfmError('PLAN_NOT_FOUND');

      const oldLiabId = plan.liabilityAccountId;
      const oldLiabAcc = findAccount(data, oldLiabId);
      const oldUnpaidCents = (plan.schedules || []).filter((r) => r.status === 'UNPAID').reduce((s, r) => s + toCents(r.amount), 0);

      if (patch.itemName !== undefined || patch.merchantEn !== undefined || patch.merchantZh !== undefined) {
        const name = String(patch.itemName ?? patch.merchantEn ?? patch.merchantZh ?? '').trim();
        if (!name) throw new PfmError('NAME_REQUIRED');
        plan.itemName = name;
        plan.merchantEn = patch.merchantEn ? String(patch.merchantEn).trim() : name;
        plan.merchantZh = patch.merchantZh ? String(patch.merchantZh).trim() : name;
      }
      if (patch.categoryId !== undefined) {
        plan.categoryId = patch.categoryId || OTHER_CATEGORY_ID;
      }
      if (patch.linkedRepaymentAccountId !== undefined) {
        plan.linkedRepaymentAccountId = patch.linkedRepaymentAccountId || null;
      }
      if (patch.liabilityAccountId !== undefined && patch.liabilityAccountId !== plan.liabilityAccountId) {
        const newLiab = requireAccount(data, patch.liabilityAccountId);
        if (newLiab.pillar !== 'LIABILITY') throw new PfmError('NOT_A_LIABILITY');
        plan.liabilityAccountId = newLiab.id;
      }

      const principalChanged = patch.totalPrincipal !== undefined && toCents(parseAmount(patch.totalPrincipal)) !== toCents(plan.totalPrincipal);
      const tenureChanged = patch.tenureMonths !== undefined && parseTenure(patch.tenureMonths) !== Number(plan.tenureMonths);
      const feeChanged = patch.monthlyFee !== undefined && toCents(parseNonNegative(patch.monthlyFee, 'INVALID_FEE')) !== toCents(plan.monthlyFee || 0);
      const dueDayChanged = patch.dueDay !== undefined && parseDueDay(patch.dueDay) !== Number(plan.dueDay);

      if (dueDayChanged) {
        plan.dueDay = parseDueDay(patch.dueDay);
      }

      if (principalChanged || tenureChanged || feeChanged) {
        const newPrincipal = patch.totalPrincipal !== undefined ? parseAmount(patch.totalPrincipal) : plan.totalPrincipal;
        const newTenure = patch.tenureMonths !== undefined ? parseTenure(patch.tenureMonths) : plan.tenureMonths;
        const newFee = patch.monthlyFee !== undefined ? parseNonNegative(patch.monthlyFee, 'INVALID_FEE') : (plan.monthlyFee || 0);
        const dueDay = plan.dueDay || 5;

        const paidRows = (plan.schedules || []).filter((r) => r.status !== 'UNPAID');
        const oldRows = plan.schedules || [];

        if (paidRows.length === 0) {
          const slices = splitPrincipal(newPrincipal, newTenure);
          const firstRowDate = oldRows[0] && isValidDateStr(oldRows[0].dueDate) ? oldRows[0].dueDate : firstDueDate(plan.startDate || today, dueDay, false);
          let [y, m] = firstRowDate.split('-').map(Number);
          plan.schedules = slices.map((sl, i) => {
            const existing = oldRows[i];
            const row = {
              id: existing ? existing.id : uid('sch'),
              number: i + 1,
              dueDate: dateWithClampedDay(y, m, dueDay),
              principal: sl,
              fee: newFee,
              amount: addMoney(sl, newFee),
              status: 'UNPAID',
              paid: false,
              notes: existing && existing.notes ? existing.notes : ''
            };
            if (m === 12) { y += 1; m = 1; } else { m += 1; }
            return row;
          });
        } else {
          const paidPrincipalCents = paidRows.reduce((s, r) => s + toCents(r.principal), 0);
          const remainingTenure = Math.max(0, newTenure - paidRows.length);
          const remainingPrincipal = fromCents(Math.max(0, toCents(newPrincipal) - paidPrincipalCents));
          const unpaidSlices = remainingTenure > 0 ? splitPrincipal(Math.max(0.01, remainingPrincipal), remainingTenure) : [];
          const lastPaidDate = paidRows[paidRows.length - 1].dueDate || (plan.startDate || today);
          let [y, m] = lastPaidDate.split('-').map(Number);
          if (m === 12) { y += 1; m = 1; } else { m += 1; }
          const existingUnpaid = oldRows.filter((r) => r.status === 'UNPAID');
          const rebuiltUnpaid = remainingPrincipal > 0 ? unpaidSlices.map((sl, idx) => {
            const existing = existingUnpaid[idx];
            const row = {
              id: existing ? existing.id : uid('sch'),
              number: paidRows.length + idx + 1,
              dueDate: dateWithClampedDay(y, m, dueDay),
              principal: sl,
              fee: newFee,
              amount: addMoney(sl, newFee),
              status: 'UNPAID',
              paid: false,
              notes: existing && existing.notes ? existing.notes : ''
            };
            if (m === 12) { y += 1; m = 1; } else { m += 1; }
            return row;
          }) : [];
          plan.schedules = paidRows.map((r, i) => Object.assign({}, r, {
            number: i + 1,
            dueDate: dueDayChanged && isValidDateStr(r.dueDate)
              ? dateWithClampedDay(Number(r.dueDate.slice(0, 4)), Number(r.dueDate.slice(5, 7)), dueDay)
              : r.dueDate
          })).concat(rebuiltUnpaid);
        }

        plan.totalPrincipal = newPrincipal;
        plan.tenureMonths = plan.schedules.length;
        plan.monthlyFee = newFee;
        plan.monthlySlice = plan.schedules[0] ? plan.schedules[0].amount : 0;
      } else if (dueDayChanged) {
        (plan.schedules || []).forEach((r) => {
          if (isValidDateStr(r.dueDate || '')) {
            const [y, m] = r.dueDate.split('-').map(Number);
            r.dueDate = dateWithClampedDay(y, m, plan.dueDay);
          }
        });
      }

      plan.status = (plan.schedules || []).some((r) => r.status === 'UNPAID') ? 'ACTIVE' : 'COMPLETED';
      const newUnpaidCents = (plan.schedules || []).filter((r) => r.status === 'UNPAID').reduce((s, r) => s + toCents(r.amount), 0);

      if (plan.liabilityAccountId !== oldLiabId) {
        if (oldLiabAcc) {
          oldLiabAcc.currentBalance = fromCents(Math.max(0, toCents(oldLiabAcc.currentBalance) - oldUnpaidCents));
        }
        const newLiabAcc = findAccount(data, plan.liabilityAccountId);
        if (newLiabAcc) {
          newLiabAcc.currentBalance = fromCents(Math.max(0, toCents(newLiabAcc.currentBalance) + newUnpaidCents));
        }
      } else if (oldLiabAcc) {
        const deltaCents = newUnpaidCents - oldUnpaidCents;
        oldLiabAcc.currentBalance = fromCents(Math.max(0, toCents(oldLiabAcc.currentBalance) + deltaCents));
      }

      const tx = plan.purchaseTxId && findTx(data, plan.purchaseTxId);
      if (tx) {
        tx.amount = plan.totalPrincipal;
        tx.toAccountId = plan.liabilityAccountId;
        tx.categoryId = plan.categoryId;
        tx.effects = [{ accountId: plan.liabilityAccountId, deltaCents: newUnpaidCents }];
        tx.meta = Object.assign({}, tx.meta || {}, { outstanding: fromCents(newUnpaidCents) });
        if (tx.params) {
          tx.params.itemName = plan.itemName;
          tx.params.categoryId = plan.categoryId;
          tx.params.totalPrincipal = plan.totalPrincipal;
          tx.params.tenureMonths = plan.tenureMonths;
          tx.params.dueDay = plan.dueDay;
          tx.params.liabilityAccountId = plan.liabilityAccountId;
        }
      }
      return plan;
    });
  }

  /** Backward-compatible alias for updatePlanDetails that supports full plan edits. */
  function updatePlanDetails(data, planId, patch, opts) {
    return editInstallmentPlan(data, planId, patch, opts);
  }

  /**
   * Edit an individual monthly bill (InstallmentSchedule row):
   * Allows modifying amount (AmountDue), dueDate, notes, and status ('PENDING'/'UNPAID' vs 'PAID').
   * Automatically recalculates the parent Liability account's currentBalance and plan totals.
   */
  function editInstallmentScheduleRow(data, planId, scheduleId, patch, opts) {
    const today = (opts && opts.today) || todayStr();
    return atomic(data, () => {
      let plan = planId ? data.installmentPlans.find((p) => p.id === planId) : null;
      if (!plan && scheduleId) {
        plan = data.installmentPlans.find((p) => (p.schedules || []).some((s) => s.id === scheduleId));
      }
      if (!plan) throw new PfmError('PLAN_NOT_FOUND');

      const row = (plan.schedules || []).find((s) => s.id === scheduleId || s.number === Number(scheduleId));
      if (!row) throw new PfmError('SCHEDULE_NOT_FOUND');

      const liabAcc = findAccount(data, plan.liabilityAccountId);
      const oldUnpaidCents = (plan.schedules || []).filter((r) => r.status === 'UNPAID').reduce((s, r) => s + toCents(r.amount), 0);

      if (patch.amount !== undefined || patch.amountDue !== undefined) {
        const newAmt = parseAmount(patch.amountDue ?? patch.amount);
        const fee = round2(Number(row.fee || 0));
        row.amount = newAmt;
        if (toCents(newAmt) < toCents(fee)) {
          row.fee = newAmt;
          row.principal = 0;
        } else {
          row.principal = fromCents(Math.max(0, toCents(newAmt) - toCents(fee)));
        }
      }
      if (patch.dueDate !== undefined) {
        row.dueDate = parseDate(patch.dueDate);
      }
      if (patch.notes !== undefined || patch.note !== undefined) {
        row.notes = String(patch.notes ?? patch.note ?? '').trim();
      }
      if (patch.status !== undefined) {
        const st = String(patch.status).toUpperCase();
        if (st === 'PAID') {
          row.status = 'PAID';
          row.paid = true;
          row.paidDate = row.paidDate || today;
        } else if (st === 'PENDING' || st === 'UNPAID') {
          if (row.paidTxId) {
            const paidTx = findTx(data, row.paidTxId);
            if (paidTx) {
              paidTx.scheduleIds = (paidTx.scheduleIds || []).filter((sid) => sid !== row.id);
              const liabEf = (paidTx.effects || []).find((ef) => ef.accountId === plan.liabilityAccountId);
              if (liabEf && liabEf.deltaCents < 0) {
                liabEf.deltaCents = Math.min(0, liabEf.deltaCents + toCents(row.amount));
              }
            }
          }
          row.status = 'UNPAID';
          row.paid = false;
          delete row.paidDate;
          delete row.paidTxId;
        }
      }

      plan.totalPrincipal = fromCents((plan.schedules || []).reduce((s, r) => s + toCents(r.principal), 0));
      plan.monthlySlice = plan.schedules[0] ? plan.schedules[0].amount : 0;
      plan.status = (plan.schedules || []).some((r) => r.status === 'UNPAID') ? 'ACTIVE' : 'COMPLETED';

      const newUnpaidCents = (plan.schedules || []).filter((r) => r.status === 'UNPAID').reduce((s, r) => s + toCents(r.amount), 0);
      const deltaCents = newUnpaidCents - oldUnpaidCents;
      if (liabAcc && deltaCents !== 0) {
        liabAcc.currentBalance = fromCents(Math.max(0, toCents(liabAcc.currentBalance) + deltaCents));
      }

      const tx = plan.purchaseTxId && findTx(data, plan.purchaseTxId);
      if (tx) {
        tx.amount = plan.totalPrincipal;
        tx.effects = [{ accountId: plan.liabilityAccountId, deltaCents: newUnpaidCents }];
        tx.meta = Object.assign({}, tx.meta || {}, { outstanding: fromCents(newUnpaidCents) });
      }
      return { plan, schedule: row };
    });
  }

  /**
   * Delete a single monthly bill row (InstallmentSchedule) or an entire InstallmentPlan,
   * automatically recalculating the parent Liability account's currentBalance.
   */
  function deleteInstallmentScheduleRow(data, planId, scheduleId) {
    return atomic(data, () => {
      let plan = planId ? data.installmentPlans.find((p) => p.id === planId) : null;
      if (!plan && scheduleId) {
        plan = data.installmentPlans.find((p) => (p.schedules || []).some((s) => s.id === scheduleId));
      }
      if (!plan) throw new PfmError('PLAN_NOT_FOUND');

      const row = (plan.schedules || []).find((s) => s.id === scheduleId || s.number === Number(scheduleId));
      if (!row) throw new PfmError('SCHEDULE_NOT_FOUND');

      const liabAcc = findAccount(data, plan.liabilityAccountId);
      if (row.status === 'UNPAID' && liabAcc) {
        liabAcc.currentBalance = fromCents(Math.max(0, toCents(liabAcc.currentBalance) - toCents(row.amount)));
      }

      plan.schedules = (plan.schedules || []).filter((s) => s.id !== row.id);
      if (plan.schedules.length === 0) {
        if (plan.purchaseTxId) {
          data.transactions = data.transactions.filter((t) => t.id !== plan.purchaseTxId);
        }
        data.installmentPlans = data.installmentPlans.filter((p) => p.id !== plan.id);
        return { deletedPlan: true, planId: plan.id };
      }

      plan.schedules.forEach((s, idx) => { s.number = idx + 1; });
      plan.tenureMonths = plan.schedules.length;
      plan.totalPrincipal = fromCents(plan.schedules.reduce((s, r) => s + toCents(r.principal), 0));
      plan.monthlySlice = plan.schedules[0] ? plan.schedules[0].amount : 0;
      plan.status = plan.schedules.some((r) => r.status === 'UNPAID') ? 'ACTIVE' : 'COMPLETED';

      const newUnpaidCents = plan.schedules.filter((r) => r.status === 'UNPAID').reduce((s, r) => s + toCents(r.amount), 0);
      const tx = plan.purchaseTxId && findTx(data, plan.purchaseTxId);
      if (tx) {
        tx.amount = plan.totalPrincipal;
        tx.effects = [{ accountId: plan.liabilityAccountId, deltaCents: newUnpaidCents }];
        tx.meta = Object.assign({}, tx.meta || {}, { outstanding: fromCents(newUnpaidCents) });
      }
      return { deletedPlan: false, plan };
    });
  }

  function deleteInstallmentPlan(data, planId) {
    return atomic(data, () => {
      const plan = data.installmentPlans.find((p) => p.id === planId);
      if (!plan) throw new PfmError('PLAN_NOT_FOUND');
      const unpaidCents = (plan.schedules || []).filter((r) => r.status === 'UNPAID').reduce((s, r) => s + toCents(r.amount), 0);
      const liabAcc = findAccount(data, plan.liabilityAccountId);
      if (liabAcc && unpaidCents > 0) {
        liabAcc.currentBalance = fromCents(Math.max(0, toCents(liabAcc.currentBalance) - unpaidCents));
      }
      if (plan.purchaseTxId) {
        data.transactions = data.transactions.filter((t) => t.id !== plan.purchaseTxId);
      }
      data.installmentPlans = data.installmentPlans.filter((p) => p.id !== planId);
      return true;
    });
  }

  /** Legacy plans or active plans can be removed cleanly via deleteLegacyPlan / deleteInstallmentPlan. */
  function deleteLegacyPlan(data, planId) {
    return deleteInstallmentPlan(data, planId);
  }

  function recomputeTaxBuckets(data, targetYear) {
    const yr = String(targetYear || todayStr().slice(0, 4));
    const buckets = Array.isArray(data.taxBuckets) ? data.taxBuckets : [];
    buckets.forEach((b) => {
      const txCents = (data.transactions || []).reduce((sum, tx) => {
        if (tx.taxCategoryCode !== b.code) return sum;
        if (tx.date && !String(tx.date).startsWith(yr + '-')) return sum;
        const val = tx.type === 'EXPENSE' ? (tx.personalAmount ?? tx.amount) : tx.amount;
        return sum + toCents(val || 0);
      }, 0);
      const baseCents = toCents(b.manualBaseClaimed || 0);
      b.claimed = fromCents(txCents + baseCents);
    });
    return buckets;
  }

  function settleReimbursement(data, reimbId, toAccountId, opts) {
    const today = (opts && opts.today) || todayStr();
    return atomic(data, () => {
      const r = (data.reimbursements || []).find((x) => x.id === reimbId);
      if (!r) throw new PfmError('TX_NOT_FOUND');
      if (r.settled) throw new PfmError('NO_CHANGE');
      const targetAcc = toAccountId
        ? requireAccount(data, toAccountId)
        : (data.accounts || []).find((a) => a.pillar === 'ASSET_LIQUID');
      if (!targetAcc) throw new PfmError('ACCOUNT_NOT_FOUND');
      const tx = postTransactionInternal(data, {
        type: 'INCOME',
        toAccountId: targetAcc.id,
        amount: r.owedAmount,
        date: (opts && opts.date) || today,
        reimbursementId: r.id,
        note: `Split Bill Settled: ${r.debtorName}`,
        descEn: `Reimbursement Settled from ${r.debtorName} -> ${targetAcc.nameEn}`,
        descZh: `收回 ${r.debtorName} AA分账款项 -> ${targetAcc.nameZh}`,
        meta: { isReimbursementSettlement: true, debtorName: r.debtorName }
      }, { today, force: true });
      r.settled = true;
      r.settledTxId = tx.id;
      r.settledAccountId = targetAcc.id;
      r.settledDate = tx.date;
      return { reimbursement: r, tx };
    });
  }

  function upsertCategory(data, input) {
    return atomic(data, () => {
      const nameEn = String(input.nameEn || input.nameZh || '').trim();
      const nameZh = String(input.nameZh || input.nameEn || '').trim();
      if (!nameEn && !nameZh) throw new PfmError('NAME_REQUIRED');
      const budget = parseNonNegative(input.budget ?? 0, 'INVALID_AMOUNT');
      const icon = String(input.icon || '📌').trim() || '📌';
      data.categories = Array.isArray(data.categories) ? data.categories : defaultCategories();
      const existing = input.id ? data.categories.find((c) => c.id === input.id) : null;
      if (existing) {
        existing.nameEn = nameEn;
        existing.nameZh = nameZh;
        existing.budget = budget;
        existing.icon = icon;
        if (input.code) existing.code = String(input.code).trim().toUpperCase().replace(/\s+/g, '_');
        return existing;
      }
      const created = {
        id: input.id || uid('cat'),
        code: String(input.code || nameEn).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 24) || 'CUSTOM',
        nameEn,
        nameZh,
        icon,
        budget
      };
      data.categories.push(created);
      return created;
    });
  }

  function deleteCategory(data, categoryId) {
    return atomic(data, () => {
      if (!categoryId || categoryId === OTHER_CATEGORY_ID || categoryId === 'cat-fees') {
        throw new PfmError('TX_NOT_EDITABLE');
      }
      const exists = (data.categories || []).some((c) => c.id === categoryId);
      if (!exists) throw new PfmError('TX_NOT_FOUND');
      data.categories = data.categories.filter((c) => c.id !== categoryId);
      (data.transactions || []).forEach((tx) => {
        if (tx.categoryId === categoryId) tx.categoryId = OTHER_CATEGORY_ID;
      });
      (data.installmentPlans || []).forEach((p) => {
        if (p.categoryId === categoryId) p.categoryId = OTHER_CATEGORY_ID;
      });
      (data.recurringBills || []).forEach((b) => {
        if (b.categoryId === categoryId) b.categoryId = OTHER_CATEGORY_ID;
      });
      return true;
    });
  }

  function afterLedgerChange(data, effects, txDate, today) {
    const ids = new Set(effects.map((e) => e.accountId));
    ids.forEach((id) => {
      const acc = findAccount(data, id);
      if (acc && (acc.interestMethod === 'ASNB_MIN_MONTHLY' || acc.interestMethod === 'LOWEST_MONTHLY_BALANCE')) refreshAsnb(data, acc, today, txDate);
    });
    recomputeTaxBuckets(data, (today || todayStr()).slice(0, 4));
  }

  // ===========================================================================
  // INSTALLMENTS (penny-exact schedules)
  // ===========================================================================
  /** Splits `principal` into `tenure` slices; the LAST slice absorbs leftover cents. */
  function splitPrincipal(principal, tenure) {
    const total = toCents(principal);
    const base = Math.floor(total / tenure);
    const remainder = total - base * tenure;
    const out = [];
    for (let i = 1; i <= tenure; i++) out.push(fromCents(base + (i === tenure ? remainder : 0)));
    return out;
  }

  function firstDueDate(startDate, dueDay, startNextMonth) {
    const [y, m] = startDate.split('-').map(Number);
    if (!startNextMonth) return dateWithClampedDay(y, m, dueDay);
    return m === 12 ? dateWithClampedDay(y + 1, 1, dueDay) : dateWithClampedDay(y, m + 1, dueDay);
  }

  function buildSchedule(input) {
    const principal = parseAmount(input.totalPrincipal);
    const tenure = parseTenure(input.tenureMonths);
    const fee = parseNonNegative(input.monthlyFee ?? 0, 'INVALID_FEE');
    const startDate = parseDate(input.startDate);
    const dueDay = parseDueDay(input.dueDay);
    const paidCount = input.alreadyPaidCount === undefined || input.alreadyPaidCount === '' ? 0 : Number(input.alreadyPaidCount);
    if (!Number.isInteger(paidCount) || paidCount < 0 || paidCount >= tenure) throw new PfmError('INVALID_PAID_COUNT');
    const slices = splitPrincipal(principal, tenure);
    let [y, m] = (input.firstDueDate || firstDueDate(startDate, dueDay, !!input.startNextMonth)).split('-').map(Number);
    return slices.map((sl, i) => {
      const status = i < paidCount ? 'PAID_BEFORE_APP' : 'UNPAID';
      const row = {
        id: uid('sch'),
        number: i + 1,
        dueDate: dateWithClampedDay(y, m, dueDay),
        principal: sl,
        fee,
        amount: addMoney(sl, fee),
        status,
        paid: status !== 'UNPAID'
      };
      if (m === 12) { y += 1; m = 1; } else { m += 1; }
      return row;
    });
  }

  function buildInstallmentPlan(p, liabilityAccountId, today) {
    const name = String(p.itemName || p.merchantEn || p.merchantZh || '').trim();
    if (!name) throw new PfmError('NAME_REQUIRED');
    const startDate = p.startDate || today;
    const dueDay = parseDueDay(p.dueDay ?? 5);
    const schedules = buildSchedule({
      totalPrincipal: p.totalPrincipal, tenureMonths: p.tenureMonths, monthlyFee: p.monthlyFee,
      startDate, dueDay, alreadyPaidCount: p.alreadyPaidCount, firstDueDate: p.firstDueDate, startNextMonth: p.startNextMonth
    });
    return {
      id: p.planId || uid('plan'),
      liabilityAccountId,
      itemName: name,
      merchantEn: p.merchantEn || name,
      merchantZh: p.merchantZh || name,
      categoryId: p.categoryId || OTHER_CATEGORY_ID,
      totalPrincipal: parseAmount(p.totalPrincipal),
      tenureMonths: parseTenure(p.tenureMonths),
      monthlyFee: parseNonNegative(p.monthlyFee ?? 0, 'INVALID_FEE'),
      monthlySlice: schedules[0] ? schedules[0].amount : 0,
      startDate,
      dueDay,
      alreadyPaidCount: Number(p.alreadyPaidCount || 0),
      linkedRepaymentAccountId: p.linkedRepaymentAccountId || null,
      schedules,
      purchaseTxId: null,
      status: 'ACTIVE',
      createdAt: new Date().toISOString()
    };
  }

  function createInstallmentPurchase(data, input, opts) {
    return postTransaction(data, Object.assign({}, input, { type: 'INSTALLMENT_PURCHASE' }), opts);
  }

  function planSummary(plan) {
    const unpaid = plan.schedules.filter((r) => r.status === 'UNPAID');
    const paid = plan.schedules.filter((r) => r.status !== 'UNPAID');
    return {
      paidCount: paid.length,
      unpaidCount: unpaid.length,
      nextRow: unpaid.slice().sort((a, b) => a.number - b.number)[0] || null,
      remainingAmount: fromCents(unpaid.reduce((s, r) => s + toCents(r.amount), 0)),
      remainingPrincipal: fromCents(unpaid.reduce((s, r) => s + toCents(r.principal), 0)),
      remainingFees: fromCents(unpaid.reduce((s, r) => s + toCents(r.fee), 0))
    };
  }

  /** mode: 'NEXT' (next unpaid month) | 'ALL' (early full settlement). */
  function payInstallment(data, input, opts) {
    const plan = data.installmentPlans.find((p) => p.id === input.planId);
    if (!plan) throw new PfmError('PLAN_NOT_FOUND');
    const sum = planSummary(plan);
    if (!sum.unpaidCount) throw new PfmError('NOTHING_OUTSTANDING');
    const scheduleIds = input.mode === 'ALL'
      ? plan.schedules.filter((r) => r.status === 'UNPAID').map((r) => r.id)
      : (input.scheduleIds && input.scheduleIds.length ? input.scheduleIds : [sum.nextRow.id]);
    return postTransaction(data, {
      type: 'INSTALLMENT_PAYMENT', planId: plan.id, scheduleIds,
      fromAccountId: input.fromAccountId, date: input.date, waiveFees: !!input.waiveFees, note: input.note
    }, opts);
  }

  // ===========================================================================
  // BALANCE HISTORY / ASNB MINIMUM MONTHLY BALANCE
  // ===========================================================================
  /** End-of-day balances (cents) for `acc` on every date in [fromDate, toDate]. */
  function eodSeries(data, acc, fromDate, toDate) {
    const byDate = {};
    let afterTo = 0;
    data.transactions.forEach((tx) => {
      (tx.effects || []).forEach((ef) => {
        if (ef.accountId !== acc.id || ef.envelopeId) return;
        if (tx.date > toDate) afterTo += ef.deltaCents;
        else byDate[tx.date] = (byDate[tx.date] || 0) + ef.deltaCents;
      });
    });
    const out = {};
    let bal = toCents(acc.currentBalance) - afterTo;
    let d = toDate;
    while (d >= fromDate) {
      out[d] = bal;
      bal -= byDate[d] || 0;
      d = addDays(d, -1);
    }
    return out;
  }

  function computeMonthLowest(data, acc, ym, uptoDate) {
    const last = uptoDate && ymOf(uptoDate) === ym ? uptoDate : lastDayOfYm(ym);
    const series = eodSeries(data, acc, `${ym}-01`, last);
    let lowest = Infinity;
    Object.keys(series).forEach((d) => { lowest = Math.min(lowest, series[d]); });
    if (acc.asnbManualLowest && acc.asnbManualLowest.ym === ym) lowest = Math.min(lowest, toCents(acc.asnbManualLowest.value));
    return { lowestCents: Math.max(0, lowest === Infinity ? 0 : lowest), closingCents: series[last] ?? toCents(acc.currentBalance) };
  }

  function asnbDividend(lowest, rate) {
    if (!(lowest > 0) || !(rate > 0)) return 0;
    return round2((lowest * (rate / 100)) / 12);
  }

  function upsertAsnbSnapshot(data, acc, ym) {
    const { lowestCents, closingCents } = computeMonthLowest(data, acc, ym);
    const id = `snap-${acc.id}-${ym}`;
    const snap = {
      id, accountId: acc.id, ym, year: Number(ym.slice(0, 4)), month: Number(ym.slice(5, 7)),
      lowestMonthlyBalance: fromCents(lowestCents), closingBalance: fromCents(closingCents),
      annualRate: acc.annualRate, projectedDividend: asnbDividend(fromCents(lowestCents), acc.annualRate)
    };
    const idx = data.asnbSnapshots.findIndex((s) => s.id === id);
    if (idx >= 0) data.asnbSnapshots[idx] = snap; else data.asnbSnapshots.push(snap);
    return snap;
  }

  /** Month roll-over + recompute current month's lowest balance from the ledger. */
  function refreshAsnb(data, acc, today, changedDate) {
    const effectiveToday = (changedDate && changedDate > today && ymOf(changedDate) === ymOf(today)) ? changedDate : today;
    const curYm = ymOf(effectiveToday);
    const created = [];
    if (!/^\d{4}-\d{2}$/.test(acc.asnbTrackingYm || '')) acc.asnbTrackingYm = curYm;
    let guard = 0;
    while (acc.asnbTrackingYm < curYm && guard < 36) {
      created.push(upsertAsnbSnapshot(data, acc, acc.asnbTrackingYm));
      acc.asnbTrackingYm = nextYm(acc.asnbTrackingYm);
      guard++;
    }
    if (acc.asnbTrackingYm < curYm) acc.asnbTrackingYm = curYm;
    if (acc.asnbManualLowest && acc.asnbManualLowest.ym < curYm) acc.asnbManualLowest = null;
    // Back-dated change into an already-closed month: refresh those snapshots too.
    if (changedDate && ymOf(changedDate) < curYm) {
      data.asnbSnapshots
        .filter((s) => s.accountId === acc.id && s.ym >= ymOf(changedDate) && s.ym < curYm)
        .forEach((s) => upsertAsnbSnapshot(data, acc, s.ym));
    }
    let maxTxDateInMonth = effectiveToday;
    (data.transactions || []).forEach((tx) => {
      if (tx.date && ymOf(tx.date) === curYm && tx.date > maxTxDateInMonth) {
        if ((tx.effects || []).some((ef) => ef.accountId === acc.id)) {
          maxTxDateInMonth = tx.date;
        }
      }
    });
    acc.lowestMonthlyBalance = fromCents(computeMonthLowest(data, acc, curYm, maxTxDateInMonth).lowestCents);
    return created;
  }

  // ===========================================================================
  // LAZY CATCH-UP ENGINE (runs on every app launch / resume)
  // ===========================================================================
  function runCatchUp(data, opts) {
    const today = (opts && opts.today) || todayStr();
    const result = { interest: [], asnbSnapshots: [], changed: false };
    return atomic(data, () => {
      data.accounts.forEach((acc) => {
        if ((acc.interestMethod === 'DAILY_COMPOUND' || acc.interestMethod === 'DYNAMIC_TIERED_RATE') && acc.autoAccrueInterest && (acc.annualRate > 0 || (acc.tiers && acc.tiers.length))) {
          const lastDate = acc.interestLastAccruedDate || acc.lastAccruedDate;
          if (!isValidDateStr(lastDate || '')) {
            acc.interestLastAccruedDate = today;
            acc.lastAccruedDate = today;
            result.changed = true;
            return;
          }
          let start = addDays(lastDate, 1);
          if (start > today) return;
          if (daysBetween(start, today) > 729) start = addDays(today, -729);
          const series = eodSeries(data, acc, start, today);
          let accrued = 0; // fractional cents
          let d = start;
          let days = 0;
          while (d <= today) {
            const base = series[d] ?? toCents(acc.currentBalance);
            if (base > 0) {
              if (acc.interestMethod === 'DYNAMIC_TIERED_RATE' && acc.tiers && acc.tiers.length) {
                let prevCap = 0;
                acc.tiers.forEach((tier) => {
                  const cap = tier.upTo ? toCents(tier.upTo) : Infinity;
                  const slice = Math.max(0, Math.min(base, cap) - prevCap);
                  if (slice > 0) accrued += (slice * ((Number(tier.rate) || 0) / 100)) / 365;
                  prevCap = cap;
                });
              } else {
                const effRate = getEffectiveRate(acc, d);
                accrued += base * (effRate / 100) / 365;
              }
            }
            days++;
            d = addDays(d, 1);
          }
          const withCarry = accrued + (acc.interestCarry || 0);
          const postCents = Math.round(withCarry);
          acc.interestCarry = withCarry - postCents;
          acc.interestLastAccruedDate = today;
          acc.lastAccruedDate = today;
          result.changed = true;
          if (postCents >= 1) {
            const tx = postTransactionInternal(data, {
              type: 'INTEREST', toAccountId: acc.id, amount: fromCents(postCents), date: today, source: 'SYSTEM',
              meta: { fromDate: start, toDate: today, days, annualRate: acc.annualRate, exactAccrued: withCarry / 100 }
            }, { today, force: true });
            result.interest.push({ accountId: acc.id, amount: tx.amount, exactAmount: withCarry / 100, days, fromDate: start, toDate: today });
          }
        }
        if (acc.interestMethod === 'ASNB_MIN_MONTHLY' || acc.interestMethod === 'LOWEST_MONTHLY_BALANCE') {
          const before = acc.lowestMonthlyBalance;
          const beforeYm = acc.asnbTrackingYm;
          const snaps = refreshAsnb(data, acc, today);
          if (snaps.length) result.asnbSnapshots.push(...snaps);
          if (snaps.length || before !== acc.lowestMonthlyBalance || beforeYm !== acc.asnbTrackingYm) result.changed = true;
        }
      });
      return result;
    });
  }

  // ===========================================================================
  // ROLL-UPS (always recomputed from live data — never cached)
  // ===========================================================================
  
  /**
   * Mode B: Direct Manual Monthly Installment Entry (Freedom Mode)
   * Lets user create a 1-month installment entry (e.g. 'This month SPayLater = RM 85.50')
   */
  function createManualMonthlyInstallment(data, input, opts) {
    const today = (opts && opts.today) || todayStr();
    const amount = parseAmount(input.amount);
    const dueDate = parseDate(input.dueDate || today);
    const dueDay = Number(dueDate.split('-')[2]);
    return createInstallmentPurchase(data, {
      liabilityAccountId: input.liabilityAccountId,
      itemName: String(input.itemName || 'Manual Installment').trim() || 'Manual Installment',
      totalPrincipal: amount,
      tenureMonths: 1,
      monthlyFee: 0,
      startDate: input.startDate || dueDate,
      dueDay: dueDay,
      firstDueDate: dueDate,
      categoryId: input.categoryId || OTHER_CATEGORY_ID,
      isManualEntry: true
    }, opts);
  }

  /**
   * Aggregates all unpaid installment schedules due for a month (or all past due + current)
   */
  function getDueInstallments(data, liabilityAccountId, targetYm) {
    const ym = targetYm || ymOf(todayStr());
    const plans = (data.installmentPlans || []).filter(
      (p) => (!liabilityAccountId || p.liabilityAccountId === liabilityAccountId) && p.status !== 'COMPLETED'
    );
    const dueSchedules = [];
    let totalDueCents = 0;

    plans.forEach((p) => {
      (p.schedules || []).forEach((s) => {
        if (s.status === 'UNPAID') {
          const sYm = s.dueDate ? ymOf(s.dueDate) : null;
          if (!sYm || sYm <= ym) {
            dueSchedules.push({
              planId: p.id,
              itemName: p.itemName,
              scheduleId: s.id,
              number: s.number,
              dueDate: s.dueDate,
              amount: s.amount,
              principal: s.principal,
              fee: s.fee,
              isPastDue: sYm && sYm < ym
            });
            totalDueCents += toCents(s.amount);
          }
        }
      });
    });

    return {
      plansCount: plans.length,
      schedules: dueSchedules,
      totalDue: fromCents(totalDueCents),
      totalDueCents
    };
  }

  /**
   * 1-Tap Monthly Repayment & Early Settlement for SPayLater / Liabilities
   */
  function payInstallmentsBatch(data, input, opts) {
    return atomic(data, () => {
      const today = (opts && opts.today) || todayStr();
      const fromAcc = requireAccount(data, input.fromAccountId);
      if (fromAcc.pillar !== 'ASSET_LIQUID' && fromAcc.pillar !== 'ASSET_INVESTMENT') {
        throw new PfmError('INVALID_PAYMENT_SOURCE');
      }
      const liabAcc = requireAccount(data, input.liabilityAccountId);
      if (liabAcc.pillar !== 'LIABILITY') throw new PfmError('NOT_A_LIABILITY');

      const plans = data.installmentPlans.filter((p) => p.liabilityAccountId === liabAcc.id && p.status !== 'COMPLETED');
      let targetSchedules = [];

      if (input.mode === 'ALL') {
        // Early Full Settlement: all unpaid schedules across all active plans for this liability
        plans.forEach((p) => {
          p.schedules.filter((s) => s.status === 'UNPAID').forEach((s) => targetSchedules.push({ plan: p, schedule: s }));
        });
      } else if (Array.isArray(input.scheduleIds) && input.scheduleIds.length > 0) {
        input.scheduleIds.forEach((sid) => {
          for (const p of plans) {
            const s = p.schedules.find((x) => x.id === sid && x.status === 'UNPAID');
            if (s) { targetSchedules.push({ plan: p, schedule: s }); break; }
          }
        });
      } else {
        // Default: pay all unpaid schedules due in or before target month
        const curYm = input.ym || ymOf(today);
        plans.forEach((p) => {
          p.schedules.filter((s) => s.status === 'UNPAID' && (!s.dueDate || ymOf(s.dueDate) <= curYm))
            .forEach((s) => targetSchedules.push({ plan: p, schedule: s }));
        });
      }

      if (!targetSchedules.length) throw new PfmError('NOTHING_OUTSTANDING');

      let totalPrincipalCents = targetSchedules.reduce((sum, item) => sum + toCents(item.schedule.principal), 0);
      let totalFeesCents = targetSchedules.reduce((sum, item) => sum + toCents(item.schedule.fee), 0);
      let totalPayCents = totalPrincipalCents + totalFeesCents;

      if (input.customAmount !== undefined && input.customAmount !== null && input.customAmount !== '') {
        totalPayCents = toCents(parseAmount(input.customAmount));
      }

      const txId = uid('tx');
      const txDate = input.date || today;
      const effects = [
        { accountId: fromAcc.id, deltaCents: -totalPayCents },
        { accountId: liabAcc.id, deltaCents: -totalPayCents }
      ];

      checkBalances(data, effects, opts);
      applyEffects(data, effects, 1);

      const paidScheduleIds = [];
      const paidPlanIds = new Set();
      targetSchedules.forEach(({ plan, schedule }) => {
        schedule.status = 'PAID';
        schedule.paid = true;
        schedule.paidTxId = txId;
        schedule.paidDate = txDate;
        paidScheduleIds.push(schedule.id);
        paidPlanIds.add(plan.id);
        if (!plan.schedules.some((s) => s.status === 'UNPAID')) {
          plan.status = 'COMPLETED';
        }
      });

      const tx = {
        id: txId,
        type: 'INSTALLMENT_PAYMENT',
        source: 'MANUAL',
        date: txDate,
        createdAt: new Date().toISOString(),
        amount: fromCents(totalPayCents),
        personalAmount: 0,
        fromAccountId: fromAcc.id,
        toAccountId: liabAcc.id,
        planId: targetSchedules[0] ? targetSchedules[0].plan.id : null,
        planIds: Array.from(paidPlanIds),
        scheduleIds: paidScheduleIds,
        note: String(input.note || '').slice(0, 200),
        effects,
        params: Object.assign({}, input, {
          id: txId,
          type: 'INSTALLMENT_PAYMENT',
          fromAccountId: fromAcc.id,
          toAccountId: liabAcc.id,
          liabilityAccountId: liabAcc.id,
          planId: targetSchedules[0] ? targetSchedules[0].plan.id : null,
          scheduleIds: paidScheduleIds,
          date: txDate,
          amount: fromCents(totalPayCents)
        }),
        descEn: 'Installment Repayment: ' + fromAcc.nameEn + ' -> ' + liabAcc.nameEn + ' (RM ' + fromCents(totalPayCents).toFixed(2) + ')',
        descZh: '分期还款: ' + fromAcc.nameZh + ' -> ' + liabAcc.nameZh + ' (RM ' + fromCents(totalPayCents).toFixed(2) + ')'
      };

      data.transactions.push(tx);
      afterLedgerChange(data, effects, txDate, today);
      return tx;
    });
  }

  /**
   * Universal Yield Engine: Live yield metrics across all interest-bearing accounts
   */
  function computeYieldMetrics(data, today) {
    const t = today || todayStr();
    const [year, month] = t.split('-').map(Number);
    const curYm = year + '-' + String(month).padStart(2, '0');
    const startOfMonth = curYm + '-01';
    const daysInCurMonth = Math.max(1, daysBetween(startOfMonth, t) + 1);

    let todayReturnCents = 0;
    let exactTodayReturnTotal = 0;
    let monthAccruedCents = 0;
    let ytdEarnedCents = 0;
    let projectedAnnualCents = 0;
    const accountsBreakdown = [];

    (data.transactions || []).forEach((tx) => {
      if (tx.type === 'INTEREST' && tx.date && tx.date.startsWith(year + '-')) {
        ytdEarnedCents += toCents(tx.amount || 0);
      }
    });

    (data.accounts || []).forEach((acc) => {
      const method = acc.interestMethod;
      if (!method || method === 'NONE') return;

      let accTodayCents = 0;
      let accExactDailyYield = 0;
      let accMonthCents = 0;
      let accProjectedAnnualCents = 0;
      let isMatured = false;
      let maturityDate = null;
      let maturityReturnCents = 0;

      const rate = getEffectiveRate(acc, t);
      const balCents = Math.max(0, toCents(acc.currentBalance));
      const balRM = fromCents(balCents);

      if (method === 'DAILY_COMPOUND') {
        accExactDailyYield = (balRM * (rate / 100)) / 365;
        accTodayCents = Math.round(balCents * (rate / 100) / 365);
        accMonthCents = Math.round(accTodayCents * daysInCurMonth);
        accProjectedAnnualCents = Math.round(balCents * (rate / 100));
      } else if (method === 'DYNAMIC_TIERED_RATE') {
        const tiers = (acc.tiers && acc.tiers.length) ? acc.tiers : [{ upTo: null, rate: rate }];
        let dailyTierCents = 0;
        let annualTierCents = 0;
        let prevCapCents = 0;
        let prevCapRM = 0;
        tiers.forEach((tier) => {
          const capCents = tier.upTo ? toCents(tier.upTo) : Infinity;
          const capRM = tier.upTo ? Number(tier.upTo) : Infinity;
          const sliceCents = Math.max(0, Math.min(balCents, capCents) - prevCapCents);
          const sliceRM = Math.max(0, Math.min(balRM, capRM) - prevCapRM);
          if (sliceCents > 0) {
            const tRate = Number(tier.rate) || 0;
            dailyTierCents += (sliceCents * (tRate / 100)) / 365;
            annualTierCents += sliceCents * (tRate / 100);
            accExactDailyYield += (sliceRM * (tRate / 100)) / 365;
          }
          prevCapCents = capCents;
          prevCapRM = capRM;
        });
        accTodayCents = Math.round(dailyTierCents);
        accMonthCents = Math.round(accTodayCents * daysInCurMonth);
        accProjectedAnnualCents = Math.round(annualTierCents);
      } else if (method === 'LOWEST_MONTHLY_BALANCE' || method === 'ASNB_MIN_MONTHLY') {
        const lowestCents = Math.max(0, toCents(acc.lowestMonthlyBalance ?? acc.currentBalance));
        const lowestRM = fromCents(lowestCents);
        const monthDivCents = Math.round((lowestCents * (rate / 100)) / 12);
        accExactDailyYield = (lowestRM * (rate / 100)) / 365;
        accTodayCents = Math.round((lowestCents * (rate / 100)) / 365);
        accMonthCents = monthDivCents;
        accProjectedAnnualCents = Math.round(lowestCents * (rate / 100));
      } else if (method === 'FIXED_MATURITY') {
        const prinCents = toCents(acc.fdPrincipal ?? acc.currentBalance);
        const prinRM = fromCents(prinCents);
        const tenure = acc.fdTenureMonths || 12;
        maturityDate = acc.fdMaturityDate || null;
        isMatured = !!(maturityDate && t >= maturityDate);
        maturityReturnCents = Math.round(prinCents * (rate / 100) * (tenure / 12));
        accExactDailyYield = (prinRM * (rate / 100)) / 365;
        accTodayCents = Math.round(prinCents * (rate / 100) / 365);
        accMonthCents = Math.round(accTodayCents * daysInCurMonth);
        accProjectedAnnualCents = Math.round(prinCents * (rate / 100));
      }

      todayReturnCents += accTodayCents;
      exactTodayReturnTotal += accExactDailyYield;
      monthAccruedCents += accMonthCents;
      projectedAnnualCents += accProjectedAnnualCents;

      accountsBreakdown.push({
        accountId: acc.id,
        nameEn: acc.nameEn,
        nameZh: acc.nameZh,
        pillar: acc.pillar,
        method,
        annualRate: rate,
        balance: fromCents(balCents),
        todayReturn: fromCents(accTodayCents),
        exactDailyYield: accExactDailyYield,
        monthAccrued: fromCents(accMonthCents),
        projectedAnnual: fromCents(accProjectedAnnualCents),
        isMatured,
        maturityDate,
        maturityReturn: fromCents(maturityReturnCents)
      });
    });

    return {
      todayReturn: fromCents(todayReturnCents),
      exactTodayReturn: exactTodayReturnTotal,
      exactDailyYield: exactTodayReturnTotal,
      todayReturnCents,
      monthAccrued: fromCents(monthAccruedCents),
      monthAccruedCents,
      ytdEarned: fromCents(ytdEarnedCents + monthAccruedCents),
      ytdEarnedCents: ytdEarnedCents + monthAccruedCents,
      projectedAnnual: fromCents(projectedAnnualCents),
      projectedAnnualCents,
      accounts: accountsBreakdown
    };
  }

  function safeToSpend(acc) {
    if (!acc || acc.pillar !== 'ASSET_LIQUID') return 0;
    const env = (acc.envelopes || []).reduce((s, e) => s + toCents(e.allocated), 0);
    const debits = (acc.autoDebits || []).reduce((s, d) => s + toCents(d.amount), 0);
    return fromCents(Math.max(0, toCents(acc.currentBalance) - toCents(acc.minBalanceLimit) - env - debits));
  }

  function categorySpend(data, ym) {
    const out = {};
    const add = (catId, key, cents) => {
      const id = catId || OTHER_CATEGORY_ID;
      out[id] = out[id] || { direct: 0, installment: 0 };
      out[id][key] += cents;
    };
    data.transactions.forEach((tx) => {
      if (!tx.date || ymOf(tx.date) !== ym) return;
      if (tx.type === 'EXPENSE') {
        add(tx.categoryId, 'direct', toCents(tx.personalAmount));
      } else if (tx.type === 'TRANSFER' && toCents(tx.transferFee || 0) > 0) {
        add(tx.categoryId || 'cat-fees', 'direct', toCents(tx.transferFee));
      }
    });
    data.installmentPlans.forEach((p) => {
      p.schedules.forEach((r) => { if (r.dueDate && ymOf(r.dueDate) === ym) add(p.categoryId, 'installment', toCents(r.amount)); });
    });
    const res = {};
    Object.keys(out).forEach((k) => {
      res[k] = { direct: fromCents(out[k].direct), installment: fromCents(out[k].installment), total: fromCents(out[k].direct + out[k].installment) };
    });
    return res;
  }

  function prevYm(ym) { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`; }

  function computeRollup(data, today) {
    const t = (typeof today === 'string' ? today : (today && today.today)) || todayStr();
    const ym = ymOf(t);
    const sumBy = (pillar) => data.accounts.filter((a) => a.pillar === pillar).reduce((s, a) => s + toCents(a.currentBalance), 0);
    const liquid = sumBy('ASSET_LIQUID');
    const invest = sumBy('ASSET_INVESTMENT');
    const liab = sumBy('LIABILITY');
    const expectedIncome = sumBy('INCOME_SOURCE');
    const liquidAccs = data.accounts.filter((a) => a.pillar === 'ASSET_LIQUID');
    const safe = liquidAccs.reduce((s, a) => s + toCents(safeToSpend(a)), 0);
    const locked = liquidAccs.reduce((s, a) => s + (a.envelopes || []).reduce((es, e) => es + toCents(e.allocated), 0), 0);
    const cats = categorySpend(data, ym);
    const monthSpend = Object.keys(cats).reduce((s, k) => s + toCents(cats[k].total), 0);
    const monthIncome = data.transactions
      .filter((tx) => tx.type === 'INCOME' && !(tx.meta && tx.meta.isReimbursementSettlement) && tx.date && ymOf(tx.date) === ym)
      .reduce((s, tx) => s + toCents(tx.amount), 0);
    const instDue = data.installmentPlans.reduce((s, p) => s + p.schedules
      .filter((r) => r.dueDate && ymOf(r.dueDate) === ym).reduce((x, r) => x + toCents(r.amount), 0), 0);
    const incomeBase = expectedIncome > 0 ? expectedIncome : toCents(data.netMonthlyIncome || 0);
    return {
      totalLiquid: fromCents(liquid),
      totalInvest: fromCents(invest),
      totalLiab: fromCents(liab),
      netWorth: fromCents(liquid + invest - liab),
      expectedIncome: fromCents(incomeBase),
      monthIncome: fromCents(monthIncome),
      safeToSpend: fromCents(safe),
      lockedEnvelopes: fromCents(locked),
      monthSpend: fromCents(monthSpend),
      monthlyInstallmentDue: fromCents(instDue),
      dsrPercent: incomeBase > 0 ? Math.round((instDue / incomeBase) * 10000) / 100 : 0,
      categories: cats
    };
  }

  function computeAnalytics(data, today) {
    const t = (typeof today === 'string' ? today : (today && today.today)) || todayStr();
    const curYm = ymOf(t);
    const pYm = prevYm(curYm);
    const rollup = computeRollup(data, t);
    const prevCats = categorySpend(data, pYm);
    const prevSpendCents = Object.keys(prevCats).reduce((s, k) => s + toCents(prevCats[k].total), 0);
    const curSpendCents = toCents(rollup.monthSpend);

    // Build 6-month cashflow series (oldest to newest)
    const months = [];
    let mCursor = curYm;
    for (let i = 0; i < 6; i++) { months.unshift(mCursor); mCursor = prevYm(mCursor); }
    const sixMonthCashflow = months.map((ym) => {
      const mCats = categorySpend(data, ym);
      const expenseCents = Object.keys(mCats).reduce((s, k) => s + toCents(mCats[k].total), 0);
      const incomeCents = (data.transactions || [])
        .filter((tx) => tx.type === 'INCOME' && !(tx.meta && tx.meta.isReimbursementSettlement) && tx.date && ymOf(tx.date) === ym)
        .reduce((s, tx) => s + toCents(tx.amount), 0);
      return { ym, income: fromCents(incomeCents), expense: fromCents(expenseCents) };
    });

    // Average monthly spend from non-zero months (or fallback to current month)
    const nonZeroMonths = sixMonthCashflow.filter((m) => m.expense > 0);
    const avgMonthlySpend = nonZeroMonths.length
      ? round2(nonZeroMonths.reduce((s, m) => s + m.expense, 0) / nonZeroMonths.length)
      : rollup.monthSpend;

    const totalAssets = addMoney(rollup.totalLiquid, rollup.totalInvest);
    const liquidRunwayMonths = avgMonthlySpend > 0 ? Math.round((rollup.totalLiquid / avgMonthlySpend) * 10) / 10 : 0;
    const totalRunwayMonths = avgMonthlySpend > 0 ? Math.round((totalAssets / avgMonthlySpend) * 10) / 10 : 0;
    const runwayGrade = avgMonthlySpend <= 0 ? 'NO_DATA' : (totalRunwayMonths >= 6 ? 'STRONG' : (totalRunwayMonths >= 3 ? 'MODERATE' : 'BUILDING'));

    const palette = ['#10b981', '#0ea5e9', '#f59e0b', '#f43f5e', '#8b5cf6', '#14b8a6', '#ec4899', '#64748b'];
    const categoryBreakdown = (data.categories || []).map((c, idx) => {
      const row = rollup.categories[c.id] || { direct: 0, installment: 0, total: 0 };
      const amt = row.total || 0;
      const pct = rollup.monthSpend > 0 ? Math.round((amt / rollup.monthSpend) * 1000) / 10 : 0;
      return {
        categoryId: c.id,
        nameEn: c.nameEn,
        nameZh: c.nameZh,
        icon: c.icon || '📌',
        amount: amt,
        direct: row.direct || 0,
        installment: row.installment || 0,
        budget: c.budget || 0,
        percent: pct,
        color: palette[idx % palette.length]
      };
    }).filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount);

    const deltaCents = curSpendCents - prevSpendCents;
    const deltaPercent = prevSpendCents > 0 ? Math.round((deltaCents / prevSpendCents) * 1000) / 10 : 0;

    return {
      ym: curYm,
      prevYm: pYm,
      totalAssets,
      netWorth: rollup.netWorth,
      avgMonthlySpend,
      liquidRunwayMonths,
      emergencyRunwayMonths: totalRunwayMonths,
      runwayGrade,
      monthComparison: {
        currentMonthSpend: rollup.monthSpend,
        previousMonthSpend: fromCents(prevSpendCents),
        deltaAmount: fromCents(deltaCents),
        deltaPercent
      },
      sixMonthCashflow,
      categoryBreakdown
    };
  }

  // ===========================================================================
  // COMPONENT-LEVEL GUARDRAILS & PROACTIVE SUGGESTIONS (Rules A, B, C)
  // ===========================================================================
  function evaluateGuardrails(data, opts) {
    const today = (opts && opts.today) || todayStr();
    const isZh = (opts && opts.lang ? opts.lang : data.lang) === 'zh-CN';
    const loc = (en, zh) => (isZh ? zh : en);
    const alerts = [];
    const liquidAccs = (data.accounts || []).filter((a) => a.pillar === 'ASSET_LIQUID');

    // RULE A: Static Floor Breach (e.g. Touch 'n Go NFC Card < RM 10.00 or any liquid account < minBalanceLimit)
    liquidAccs.forEach((acc) => {
      if (acc.minBalanceLimit > 0 && toCents(acc.currentBalance) < toCents(acc.minBalanceLimit)) {
        const shortfall = fromCents(toCents(acc.minBalanceLimit) - toCents(acc.currentBalance));
        alerts.push({
          ruleCode: 'RULE_A_STATIC_FLOOR',
          severity: 'HIGH',
          color: 'rose',
          translationKey: 'ALERT.STATIC_FLOOR_BREACH',
          accountId: acc.id,
          accountName: loc(acc.nameEn, acc.nameZh),
          currentBalance: acc.currentBalance,
          minBalanceLimit: acc.minBalanceLimit,
          shortfall,
          title: loc(
            `High-Priority Low-Balance Alert: ${acc.nameEn} (< RM ${acc.minBalanceLimit.toFixed(2)})`,
            `${acc.nameZh} 余额不足高优预警 (< RM ${acc.minBalanceLimit.toFixed(2)})`
          ),
          body: loc(
            `${acc.nameEn} balance (RM ${acc.currentBalance.toFixed(2)}) has dropped below its operational floor of RM ${acc.minBalanceLimit.toFixed(2)}. Please top up at least RM ${shortfall.toFixed(2)} immediately.`,
            `${acc.nameZh} 当前余额 (RM ${acc.currentBalance.toFixed(2)}) 已低于最低安全限额 RM ${acc.minBalanceLimit.toFixed(2)}。请立即充值至少 RM ${shortfall.toFixed(2)}。`
          )
        });
      }
    });

    // RULE B: 7-Day Auto-Debit Look-Ahead + Donor Bank Suggestion
    const [, , curDay] = today.split('-').map(Number);
    const [curY, curM] = today.split('-').map(Number);
    const maxDaysInCurMonth = daysInMonth(curY, curM);

    liquidAccs.forEach((acc) => {
      const envSumCents = (acc.envelopes || []).reduce((s, e) => s + toCents(e.allocated), 0);
      const availableBeforeDebitCents = toCents(acc.currentBalance) - envSumCents;

      (acc.autoDebits || []).forEach((ad) => {
        let daysUntilDue;
        if (ad.dueInDays !== undefined && ad.dueInDays !== null && Number.isFinite(Number(ad.dueInDays))) {
          daysUntilDue = Number(ad.dueInDays);
        } else {
          const dom = Number(ad.dayOfMonth) || 1;
          daysUntilDue = dom >= curDay ? (dom - curDay) : (maxDaysInCurMonth - curDay + dom);
        }

        if (daysUntilDue >= 0 && daysUntilDue <= 7) {
          const adCents = toCents(ad.amount);
          const rawShortfallCents = adCents - availableBeforeDebitCents;
          const floorShortfallCents = (adCents + toCents(acc.minBalanceLimit || 0)) - availableBeforeDebitCents;

          if (rawShortfallCents > 0 || floorShortfallCents > 0) {
            const shortfall = fromCents(rawShortfallCents > 0 ? rawShortfallCents : floorShortfallCents);
            const recommendedWithFloor = fromCents(Math.max(rawShortfallCents, floorShortfallCents));

            // Find best Donor Bank with sufficient unrestricted safe-to-spend balance
            const candidates = liquidAccs
              .filter((other) => other.id !== acc.id)
              .map((other) => ({ acc: other, safe: safeToSpend(other), bal: other.currentBalance }))
              .sort((a, b) => b.safe - a.safe || b.bal - a.bal);

            const donorEntry = candidates.find((c) => toCents(c.safe) >= toCents(shortfall)) || candidates[0] || null;
            const donor = donorEntry ? donorEntry.acc : null;
            const donorName = donor ? loc(donor.nameEn, donor.nameZh) : loc('another bank', '其他富余银行');

            alerts.push({
              ruleCode: 'RULE_B_AUTODEBIT_DONOR_MATCH',
              severity: 'HIGH',
              color: 'amber',
              translationKey: 'ALERT.LOW_AUTODEBIT_BALANCE',
              accountId: acc.id,
              accountName: loc(acc.nameEn, acc.nameZh),
              targetAccountId: acc.id,
              targetAccountName: loc(acc.nameEn, acc.nameZh),
              donorAccountId: donor ? donor.id : null,
              donorAccountName: donorName,
              commitmentName: loc(ad.nameEn, ad.nameZh),
              dueInDays: daysUntilDue,
              requiredAmount: ad.amount,
              currentBalance: acc.currentBalance,
              shortfall,
              recommendedWithFloor,
              title: loc(
                `Auto-Debit Shortfall in ${daysUntilDue} Days (${ad.nameEn})`,
                `未来 ${daysUntilDue} 天自动扣款不足预警 (${ad.nameZh})`
              ),
              body: loc(
                `${acc.nameEn} holds RM ${acc.currentBalance.toFixed(2)}, which is short by RM ${shortfall.toFixed(2)} for upcoming ${ad.nameEn} (RM ${ad.amount.toFixed(2)} due in ${daysUntilDue} days). Recommended Action: Transfer at least RM ${shortfall.toFixed(2)} from ${donorName} to ${acc.nameEn}.`,
                `${acc.nameZh} 当前可用余额为 RM ${acc.currentBalance.toFixed(2)}，距离 ${daysUntilDue} 天后扣款的【${ad.nameZh}】(RM ${ad.amount.toFixed(2)}) 尚缺至少 RM ${shortfall.toFixed(2)}。智能建议：立即从 ${donorName} 转账至少 RM ${shortfall.toFixed(2)} 至 ${acc.nameZh}。`
              )
            });
          }
        }
      });
    });

    // RULE C: Month-End ASNB Idle Cash Sweeper
    const asnb = (data.accounts || []).find((a) => a.interestMethod === 'ASNB_MIN_MONTHLY' || a.interestMethod === 'LOWEST_MONTHLY_BALANCE');
    if (asnb) {
      liquidAccs.filter((a) => a.isZeroInterestLiquid || a.interestMethod === 'NONE').forEach((bank) => {
        const surplus = safeToSpend(bank);
        if (surplus >= 200) {
          const monthlyYield = round2((surplus * ((asnb.annualRate || 4.5) / 100)) / 12);
          alerts.push({
            ruleCode: 'RULE_C_MONTH_END_ASNB_SWEEP',
            severity: 'INFO',
            color: 'emerald',
            translationKey: 'ALERT.IDLE_CASH_SWEEPER',
            accountId: bank.id,
            donorAccountId: bank.id,
            targetAccountId: asnb.id,
            surplusAmount: surplus,
            projectedMonthlyYield: monthlyYield,
            title: loc(
              `Month-End Idle Cash Sweeper: ${bank.nameEn} -> ${asnb.nameEn}`,
              `月末零息闲置资金扫入建议：${bank.nameZh} -> ${asnb.nameZh}`
            ),
            body: loc(
              `${bank.nameEn} holds RM ${surplus.toFixed(2)} in 0% idle cash. Sweep RM ${surplus.toFixed(2)} into ${asnb.nameEn} before the 1st of next month to earn ~RM ${monthlyYield.toFixed(2)}/mo.`,
              `${bank.nameZh} 有 RM ${surplus.toFixed(2)} 零息闲置资金。建议在次月1日前转入 ${asnb.nameZh}，预计每月多赚 RM ${monthlyYield.toFixed(2)}。`
            )
          });
        }
      });
    }

    return alerts;
  }

  // ===========================================================================
  // RECURRING BILLS / SUBSCRIPTIONS & MALAYSIAN SALARY + EPF AUTO-SPLITTER
  // ===========================================================================
  function upsertRecurringBill(data, input) {
    return atomic(data, () => {
      const nameEn = String(input.nameEn || input.nameZh || '').trim();
      const nameZh = String(input.nameZh || input.nameEn || '').trim();
      if (!nameEn && !nameZh) throw new PfmError('NAME_REQUIRED');
      const amount = parseAmount(input.amount);
      const dayOfMonth = parseDueDay(input.dayOfMonth ?? 1);
      const txType = (input.type === 'INCOME' || input.type === 'TRANSFER') ? input.type : 'EXPENSE';
      data.recurringBills = Array.isArray(data.recurringBills) ? data.recurringBills : [];
      const existing = input.id ? data.recurringBills.find((b) => b.id === input.id) : null;
      const record = {
        id: existing ? existing.id : (input.id || uid('rec')),
        nameEn,
        nameZh,
        type: txType,
        amount,
        dayOfMonth,
        fromAccountId: input.fromAccountId || null,
        toAccountId: input.toAccountId || null,
        categoryId: input.categoryId || OTHER_CATEGORY_ID,
        frequency: input.frequency === 'YEARLY' ? 'YEARLY' : 'MONTHLY',
        active: input.active !== false,
        lastPostedYm: existing ? existing.lastPostedYm : (input.lastPostedYm || null)
      };
      if (existing) Object.assign(existing, record);
      else data.recurringBills.push(record);
      return existing || record;
    });
  }

  function deleteRecurringBill(data, billId) {
    return atomic(data, () => {
      data.recurringBills = (data.recurringBills || []).filter((b) => b.id !== billId);
      return true;
    });
  }

  function getPendingRecurringBills(data, today) {
    const t = today || todayStr();
    const curYm = ymOf(t);
    const curDay = Number(t.split('-')[2]);
    return (data.recurringBills || [])
      .filter((b) => b && b.active !== false && b.lastPostedYm !== curYm)
      .map((b) => {
        const diff = Number(b.dayOfMonth || 1) - curDay;
        return Object.assign({}, b, { daysUntilDue: diff, isDueNow: diff <= 3 });
      });
  }

  function postRecurringBill(data, billId, opts) {
    const today = (opts && opts.today) || todayStr();
    return atomic(data, () => {
      const bill = (data.recurringBills || []).find((b) => b.id === billId);
      if (!bill) throw new PfmError('TX_NOT_FOUND');
      const postDate = (opts && opts.date) || today;
      const note = `${bill.nameEn} (Recurring)`;
      let tx;
      if (bill.type === 'INCOME') {
        tx = postTransactionInternal(data, {
          type: 'INCOME',
          toAccountId: bill.toAccountId || bill.fromAccountId,
          amount: bill.amount,
          date: postDate,
          note
        }, { today, force: true });
      } else if (bill.type === 'TRANSFER') {
        tx = postTransactionInternal(data, {
          type: 'TRANSFER',
          fromAccountId: bill.fromAccountId,
          toAccountId: bill.toAccountId,
          amount: bill.amount,
          transferFee: 0,
          date: postDate,
          note
        }, { today, force: true });
      } else {
        tx = postTransactionInternal(data, {
          type: 'EXPENSE',
          fromAccountId: bill.fromAccountId,
          amount: bill.amount,
          categoryId: bill.categoryId || 'cat-bills',
          date: postDate,
          note
        }, { today, force: true });
      }
      bill.lastPostedYm = ymOf(postDate);
      return { bill, tx };
    });
  }

  function creditSalaryWithEpf(data, input, opts) {
    const today = (opts && opts.today) || todayStr();
    return atomic(data, () => {
      const netSalary = parseAmount(input.netSalary);
      const bankAcc = requireAccount(data, input.toAccountId);
      const postDate = parseDate(input.date || today);
      const employeeEpfRate = parseRate(input.employeeEpfRate ?? 11);
      const employerEpfRate = parseRate(input.employerEpfRate ?? 12);
      const grossSalary = input.grossSalary !== undefined && input.grossSalary !== '' && Number(input.grossSalary) > 0
        ? parseAmount(input.grossSalary)
        : netSalary;

      const salaryTx = postTransactionInternal(data, {
        type: 'INCOME',
        toAccountId: bankAcc.id,
        incomeSourceId: input.incomeSourceId || null,
        amount: netSalary,
        date: postDate,
        note: String(input.note || 'Monthly Net Salary').trim(),
        descEn: `Monthly Salary Credited to ${bankAcc.nameEn}`,
        descZh: `月度薪资入账至 ${bankAcc.nameZh}`
      }, { today, force: true });

      let epfTx = null;
      let epfContribution = 0;
      const epfAcc = input.epfAccountId
        ? findAccount(data, input.epfAccountId)
        : (data.accounts || []).find((a) => a.catalogCode === 'EPF' || /epf|kwsp/i.test(a.nameEn || ''));

      if (epfAcc && (employeeEpfRate > 0 || employerEpfRate > 0)) {
        const customEpf = input.customEpfAmount !== undefined && input.customEpfAmount !== '' && Number(input.customEpfAmount) > 0
          ? parseAmount(input.customEpfAmount)
          : null;
        epfContribution = customEpf !== null
          ? customEpf
          : round2(grossSalary * ((employeeEpfRate + employerEpfRate) / 100));
        if (epfContribution > 0) {
          epfTx = postTransactionInternal(data, {
            type: 'INCOME',
            toAccountId: epfAcc.id,
            amount: epfContribution,
            date: postDate,
            note: `EPF (${employeeEpfRate}% + ${employerEpfRate}%)`,
            descEn: `EPF Contribution (${employeeEpfRate}% + ${employerEpfRate}%) -> ${epfAcc.nameEn}`,
            descZh: `EPF 公积金缴纳 (${employeeEpfRate}% + ${employerEpfRate}%) -> ${epfAcc.nameZh}`,
            meta: { isEpfContribution: true, grossSalary, employeeEpfRate, employerEpfRate }
          }, { today, force: true });
        }
      }
      return { salaryTx, epfTx, epfContribution };
    });
  }

  // ===========================================================================
  // SMART MERCHANT AUTO-CATEGORIZATION & SELF-LEARNING ENGINE
  // ===========================================================================
  const MERCHANT_CATEGORY_RULES = [
    {
      categoryId: 'cat-food',
      keywords: [
        '99 speedmart', 'speedmart', 'zus', 'tealive', 'starbucks', 'kfc', 'mcd', 'mcdonald',
        'burger king', 'mamak', 'kopitiam', 'restoran', 'restaurant', 'cafe', 'bistro',
        'grabfood', 'foodpanda', 'shopeefood', 'familymart', 'mynews', '7-eleven', '7 eleven',
        'jaya grocer', 'village grocer', 'lotus', 'aeon', 'mydin', 'nsk', 'econsave',
        'nasi kandar', 'pelita', 'secret recipe', 'mixue', 'chagee', 'oriental kopi', 'bakery', 'sushi', 'ramen', 'dim sum'
      ]
    },
    {
      categoryId: 'cat-transport',
      keywords: [
        'petronas', 'shell', 'caltex', 'bhp', 'petron', 'setel', 'toll', 'duke', 'ldp',
        'akleh', 'smart tunnel', 'rapidkl', 'mrt', 'lrt', 'ktm', 'klia', 'erl',
        'grab ride', 'grabcar', 'indrive', 'maxim', 'parking', 'autopass', 'rfid', 'plus highway'
      ]
    },
    {
      categoryId: 'cat-bills',
      keywords: [
        'tnb', 'tenaga', 'syabas', 'air selangor', 'indah water', 'unifi', 'maxis', 'celcom',
        'digi', 'celcomdigi', 'u mobile', 'umobile', 'yes 5g', 'time dotcom', 'astro',
        'coway', 'cuckoo', 'netflix', 'spotify', 'icloud', 'youtube', 'google one', 'electric', 'water bill'
      ]
    },
    {
      categoryId: 'cat-shopping',
      keywords: [
        'shopee', 'lazada', 'tiktok shop', 'uniqlo', 'h&m', 'zara', 'ikea', 'mr diy', 'mr.diy',
        'daiso', 'watsons', 'guardian', 'caring', 'apple store', 'harvey norman', 'machines', 'decathlon', 'popular'
      ]
    },
    {
      categoryId: 'cat-insurance',
      keywords: [
        'prudential', 'aia', 'great eastern', 'allianz', 'etiqa', 'takaful', 'zurich',
        'tokio marine', 'klinik', 'clinic', 'hospital', 'gleneagles', 'sunway medical', 'pantai', 'pharmacy', 'dental'
      ]
    }
  ];

  function normalizeMerchantKey(str) {
    return String(str || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function learnMerchantCategory(data, merchantOrNote, categoryId) {
    const key = normalizeMerchantKey(merchantOrNote);
    if (!key || !categoryId) return false;
    data.notificationState = Object.assign(defaultNotificationState(), data.notificationState || {});
    data.notificationState.merchantRules = Object.assign({}, data.notificationState.merchantRules || {});
    data.notificationState.merchantRules[key] = categoryId;
    return true;
  }

  function categorizeMerchant(data, merchant, fullText) {
    const validIds = new Set((data.categories || []).map((c) => c.id));
    const merchantKey = normalizeMerchantKey(merchant);
    const fullKey = normalizeMerchantKey(fullText);
    const rules = (data.notificationState && data.notificationState.merchantRules) || {};

    if (merchantKey && rules[merchantKey] && validIds.has(rules[merchantKey])) return rules[merchantKey];
    const matchedLearnedKey = Object.keys(rules).find((k) => k.length >= 3 && (merchantKey.includes(k) || fullKey.includes(k)));
    if (matchedLearnedKey && validIds.has(rules[matchedLearnedKey])) return rules[matchedLearnedKey];

    const combined = `${String(merchant || '')} ${String(fullText || '')}`.toLowerCase();
    for (const rule of MERCHANT_CATEGORY_RULES) {
      if (!validIds.has(rule.categoryId)) continue;
      if (rule.keywords.some((kw) => combined.includes(kw))) return rule.categoryId;
    }

    return OTHER_CATEGORY_ID;
  }

  // ===========================================================================
  // ANDROID NOTIFICATION INGESTION (dedup + collision check + auto-discovery)
  // ===========================================================================
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  const CREDIT_WORDS = ['received', 'receive', 'credited', 'deposit', 'refund', 'cashback received', 'transferred to you', 'money in',
    'diterima', 'terima', 'masuk', 'dikreditkan', '收到', '到账', '存入', '退款'];
  const DEBIT_WORDS = ['paid', 'payment', 'spent', 'debited', 'deducted', 'purchase', 'transfer to', 'transferred', 'reloaded', 'reload', 'sent', 'charged', 'withdraw', 'successful', 'successfully', 'berjaya',
    'duitnow', 'qrpay', 'paydirect', 'rfid', 'auto-debit', 'autodebit', 'billed', 'top-up', 'top up', 'topup', 'sale', 'transaksi', 'bayar', 'tol',
    'bayaran', 'dibayar', 'pembayaran', 'potongan', 'pindahan', '支付', '付款', '扣款', '消费', '转出', '成功'];
  const NON_TX_WORDS = ['otp', 'tac', 'one-time', 'verification code', 'promo', 'voucher', 'cashback voucher', 'spend rm', 'get rm', 'up to rm', 'up to ', 'win ', 'reward', 'enjoy', 'offer', 'kod pengesahan', '验证码', '优惠'];
  const CONFIRMED_TX_VERBS = ['paid', 'deducted', 'spent', 'debited', 'successful', 'successfully', 'transferred', 'reloaded', 'berjaya', 'received', 'credited', 'refund', 'payment', 'purchase', 'sent', 'charged', 'withdraw',
    'duitnow', 'qrpay', 'paydirect', 'rfid', 'auto-debit', 'autodebit', 'billed', 'top-up', 'top up', 'topup', 'sale', 'transaksi', 'bayar', 'tol',
    'diterima', 'dibayar', 'potongan', '支付', '付款', '扣款', '消费', '收到', '到账'];

  function parseNotification(n) {
    const notifObj = typeof n === 'string' ? { text: n } : (n || {});
    const text = `${notifObj.title || ''} ${notifObj.text || ''}`.replace(/\s+/g, ' ').trim();
    const lower = text.toLowerCase();
    const hasConfirmedVerb = CONFIRMED_TX_VERBS.some((v) => lower.includes(v));
    if (NON_TX_WORDS.some((w) => lower.includes(w))) return { isTransaction: false, reason: 'PROMO_OR_OTP', text };
    if (lower.includes('cashback') && !lower.includes('cashback received') && !/\b(?:paid|deducted|spent|debited)\b/.test(lower)) {
      return { isTransaction: false, reason: 'PROMO_OR_OTP', text };
    }
    if (!hasConfirmedVerb) return { isTransaction: false, reason: 'NO_CONFIRMED_VERB', text };
    const m = text.match(/(?:RM|MYR)[\s:]*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i);
    if (!m) return { isTransaction: false, reason: 'NO_AMOUNT', text };
    const amount = round2(Number(m[1].replace(/,/g, '')));
    if (!(amount > 0)) return { isTransaction: false, reason: 'INVALID_AMOUNT', text };

    // Special Case: TnG NFC Card / Touch 'n Go Card Reload -> TRANSFER (NOT an Expense!)
    const isTngCardReload =
      (/\breload(?:ed)?\b/i.test(text) && /\b(?:touch\s*'?n\s*go|tng)\s*(?:nfc\s*)?card\b/i.test(text)) ||
      (/\b(?:touch\s*'?n\s*go|tng)\s*(?:nfc\s*)?card\b/i.test(text) && /\b(?:reload(?:ed)?|top\s*up|充值)\b/i.test(text));
    if (isTngCardReload) {
      return {
        isTransaction: true,
        type: 'TRANSFER',
        direction: 'TRANSFER',
        transferSourceCode: 'TNG_EWALLET',
        transferTargetCode: 'TNG_NFC',
        amount,
        merchant: "Touch 'n Go NFC Card",
        text
      };
    }

    const credit = CREDIT_WORDS.some((w) => lower.includes(w));
    const debit = DEBIT_WORDS.some((w) => lower.includes(w));
    const direction = credit && !debit ? 'CREDIT' : (credit && debit && /received|credited|refund|收到|到账/.test(lower) ? 'CREDIT' : 'DEBIT');
    const mm = text.match(/\b(?:at|to|from|kepada|di|daripada)\s+([A-Za-z0-9&'.\-* ]{2,40})/i);
    const merchant = mm ? mm[1].replace(/\s+(on|for|via|using|with|pada|dengan)\b.*$/i, '').replace(/[.\s]+$/, '').trim() : '';
    return { isTransaction: true, type: direction === 'CREDIT' ? 'INCOME' : 'EXPENSE', amount, direction, merchant, text };
  }

  function pruneDedup(ns, nowMs) {
    Object.keys(ns.dedup).forEach((h) => { if (nowMs - ns.dedup[h] > 24 * 3600 * 1000) delete ns.dedup[h]; });
  }

  function findTngEwalletAccount(data) {
    return data.accounts.find((a) =>
      a.catalogCode === 'TNG_EWALLET' ||
      a.id === 'tng-ewallet' ||
      (a.androidPackages || []).includes('my.com.tngdigital.ewallet') ||
      (/touch\s*'?n\s*go|tng/i.test(a.nameEn || '') && !/nfc|\bcard\b/i.test(a.nameEn || ''))
    ) || null;
  }

  function findTngNfcAccount(data) {
    return data.accounts.find((a) =>
      a.catalogCode === 'TNG_NFC' ||
      a.id === 'tng-nfc' ||
      /nfc|\bcard\b/i.test(a.nameEn || '') ||
      /实体卡|nfc/i.test(a.nameZh || '')
    ) || null;
  }

  const PKG_KEYWORD_HINTS = {
    'my.com.tngdigital.ewallet': ['tng_ewallet', "touch 'n go", 'touch n go', 'tng', 'ewallet', '电子钱包'],
    'com.maybank2u.life': ['maybank', 'mae', 'm2u', '马来亚'],
    'com.maybank2u.m2umobile': ['maybank', 'mae', 'm2u', '马来亚'],
    'com.cimbmalaysia': ['cimb', 'octo', '联昌'],
    'my.com.cimb.octo': ['cimb', 'octo', '联昌'],
    'com.cimb.cimbocto': ['cimb', 'octo', '联昌'],
    'my.com.gxbank.app': ['gxbank', 'gx bank'],
    'com.gxbank.app': ['gxbank', 'gx bank'],
    'com.rytbank.app': ['ryt', 'ryt bank'],
    'my.com.ytl.rytbank': ['ryt', 'ryt bank'],
    'com.shopee.my': ['spaylater', 'shopee'],
    'com.grabtaxi.passenger': ['grab', 'grabpay'],
    'my.com.myboost': ['boost'],
    'my.com.boostbank.app': ['boost bank'],
    'my.com.aeonbank.app': ['aeon bank', 'aeon'],
    'my.com.publicbank.pbengage': ['public bank', 'pbe', '大众银行'],
    'com.pbebank.pbengage': ['public bank', 'pbe', '大众银行'],
    'my.com.hongleongconnect.mobilebanking': ['hong leong', 'hlb', '丰隆'],
    'my.com.hongleongconnect.mobileconnect': ['hong leong', 'hlb', '丰隆'],
    'com.rhbgroup.rhbmobilebanking': ['rhb', '兴业'],
    'com.ambank.ambankonline': ['ambank', '大马银行'],
    'com.bankislam.bimbmobile': ['bank islam', '伊斯兰'],
    'com.bigpayme.bigpay': ['bigpay']
  };

  function matchAccountForPackage(data, pkg, text, catalog) {
    if (pkg && data.notificationState && data.notificationState.packageAccountMap && data.notificationState.packageAccountMap[pkg]) {
      const mapped = findAccount(data, data.notificationState.packageAccountMap[pkg]);
      if (mapped) return mapped;
    }
    const accs = pkg ? data.accounts.filter((a) => (a.androidPackages || []).includes(pkg)) : [];
    if (accs.length === 1) return accs[0];
    if (accs.length > 1) {
      const lower = String(text || '').toLowerCase();
      let best = accs[0]; let bestScore = -1;
      accs.forEach((a) => {
        const kws = (a.notificationKeywords || []).concat([a.nameEn.toLowerCase()]);
        const score = kws.reduce((s, k) => s + (k && lower.includes(String(k).toLowerCase()) ? String(k).length : 0), 0);
        if (score > bestScore) { best = a; bestScore = score; }
      });
      return best;
    }
    // Match against catalog code or account name keywords when user created account manually without androidPackages array
    const cat = getCatalog(catalog);
    const catItem = (pkg || text) && cat ? cat.matchNotification(pkg, text) : null;
    if (catItem) {
      const byCode = data.accounts.find((a) => a.catalogCode === catItem.code);
      if (byCode) return byCode;
    }
    if (pkg && PKG_KEYWORD_HINTS[pkg]) {
      const hints = PKG_KEYWORD_HINTS[pkg];
      const byHint = data.accounts.find((a) => {
        if (a.pillar === 'INCOME_SOURCE') return false;
        const hay = `${a.catalogCode || ''} ${a.nameEn || ''} ${a.nameZh || ''} ${a.subTypeEn || ''}`.toLowerCase();
        if (pkg === 'my.com.tngdigital.ewallet' && /nfc/.test(hay)) return false;
        return hints.some((h) => hay.includes(h));
      });
      if (byHint) return byHint;
    }
    // Fallback when packageName is omitted or matches account name in notification text
    const lower = String(text || '').toLowerCase();
    for (const a of data.accounts) {
      if (a.pillar === 'INCOME_SOURCE') continue;
      const kws = (a.notificationKeywords || []).concat([a.nameEn, a.nameZh]);
      if (kws.some((k) => k && String(k).trim().length >= 3 && lower.includes(String(k).toLowerCase()))) return a;
    }
    if (!pkg) {
      const tng = findTngEwalletAccount(data);
      if (tng) return tng;
      const firstLiquid = data.accounts.find((a) => a.pillar === 'ASSET_LIQUID');
      if (firstLiquid) return firstLiquid;
    }
    return null;
  }

  /**
   * notif: { packageName, title, text, postedAt (ms epoch) } or string
   * Returns { status, txId?, accountId?, txType?, hash, catalogCode? }
   * status: DUPLICATE | IGNORED_NON_TX | IGNORED_PACKAGE | LINKED | POSTED | DISCOVERY | AUTO_CREATED | UNMAPPED
   */
  function ingestNotification(data, rawNotif, opts) {
    const notif = typeof rawNotif === 'string' ? { text: rawNotif } : (rawNotif || {});
    const catalog = getCatalog(opts && opts.catalog);
    const today = (opts && opts.today) || todayStr();
    return atomic(data, () => {
      data.notificationState = Object.assign(defaultNotificationState(), data.notificationState || {});
      const ns = data.notificationState;
      const pkg = String(notif.packageName || 'my.com.tngdigital.ewallet');
      const postedAt = Number(notif.postedAt) || Date.now();
      pruneDedup(ns, postedAt);
      if (pkg === 'com.mypfm.app' || ns.ignoredPackages.includes(pkg)) return { status: 'IGNORED_PACKAGE' };

      const parsed = parseNotification(notif);
      if (!parsed.isTransaction) return { status: 'IGNORED_NON_TX' };

      // 1) Anti-double-deduct: hash(package + amount + merchant + 2-minute bucket).
      //    The previous bucket is also checked so a duplicate straddling a bucket edge is caught.
      const bucket = Math.floor(postedAt / DEDUP_WINDOW_MS);
      const keyBase = `${pkg}|${toCents(parsed.amount)}|${parsed.merchant.toLowerCase()}|${parsed.direction}|`;
      const hash = fnv1a(keyBase + bucket);
      const prevHash = fnv1a(keyBase + (bucket - 1));
      if (ns.dedup[hash] || ns.dedup[prevHash]) return { status: 'DUPLICATE', hash };
      ns.dedup[hash] = postedAt;

      const logEntry = {
        id: uid('ntf'), hash, packageName: pkg, title: String(notif.title || '').slice(0, 120), text: String(notif.text || '').slice(0, 300),
        amount: parsed.amount, direction: parsed.direction, merchant: parsed.merchant, postedAt, status: null, txId: null, accountId: null
      };
      const pushLog = (status, extra) => {
        Object.assign(logEntry, { status }, extra || {});
        ns.inbox.unshift(logEntry);
        ns.inbox = ns.inbox.slice(0, 100);
      };

      const postedDate = todayStr(new Date(postedAt));

      // Special Case: TnG NFC Card Reload -> Atomic TRANSFER from TnG eWallet to TnG NFC Card
      if (parsed.direction === 'TRANSFER' && parsed.transferTargetCode === 'TNG_NFC') {
        let fromAcc = findTngEwalletAccount(data) || matchAccountForPackage(data, pkg, parsed.text, catalog);
        let toAcc = findTngNfcAccount(data);
        if (opts && opts.autoCreateIfUnmapped && catalog) {
          if (!fromAcc) fromAcc = createAccountFromCatalog(data, 'TNG_EWALLET', { currentBalance: 0, needsBalanceSetup: true }, catalog, { today });
          if (!toAcc) toAcc = createAccountFromCatalog(data, 'TNG_NFC', { currentBalance: 0, needsBalanceSetup: true }, catalog, { today });
        }
        if (fromAcc && toAcc && fromAcc.id !== toAcc.id) {
          const tx = postTransactionInternal(data, {
            type: 'TRANSFER',
            fromAccountId: fromAcc.id,
            toAccountId: toAcc.id,
            amount: parsed.amount,
            transferFee: 0,
            date: postedDate,
            note: "Touch 'n Go NFC Card Reload",
            source: 'NOTIFICATION',
            notifHash: hash
          }, { today, force: true });
          pushLog('POSTED', { txId: tx.id, accountId: fromAcc.id, toAccountId: toAcc.id, txType: 'TRANSFER' });
          return { status: 'POSTED', txType: 'TRANSFER', txId: tx.id, accountId: fromAcc.id, toAccountId: toAcc.id, hash };
        }
      }

      let acc = matchAccountForPackage(data, notif.packageName ? pkg : '', parsed.text, catalog);
      if (!acc && opts && opts.autoCreateIfUnmapped) {
        const item = catalog ? catalog.matchNotification(pkg, parsed.text) : null;
        if (item) {
          acc = createAccountFromCatalog(data, item.code, { currentBalance: 0, needsBalanceSetup: true }, catalog, { today });
        } else {
          acc = data.accounts.find((a) => a.pillar === 'ASSET_LIQUID') || data.accounts.find((a) => a.pillar === 'LIABILITY') || null;
        }
      }
      if (!acc) {
        const item = catalog ? catalog.matchNotification(pkg, parsed.text) : null;
        if (item) {
          if (data.settings && data.settings.autoCreateFromNotifications && !data.accounts.some((a) => a.catalogCode === item.code)) {
            const created = createAccountFromCatalog(data, item.code, { needsBalanceSetup: true }, catalog, { today });
            pushLog('AUTO_CREATED', { accountId: created.id, catalogCode: item.code });
            return { status: 'AUTO_CREATED', accountId: created.id, catalogCode: item.code, hash };
          }
          if (!ns.pendingDiscoveries.some((d) => d.catalogCode === item.code)) {
            ns.pendingDiscoveries.push({ id: uid('disc'), catalogCode: item.code, packageName: pkg, amount: parsed.amount, direction: parsed.direction, merchant: parsed.merchant, postedAt });
          }
          pushLog('DISCOVERY', { catalogCode: item.code });
          return { status: 'DISCOVERY', catalogCode: item.code, hash };
        }
        const existing = ns.unmappedApps.find((u) => u.packageName === pkg);
        if (existing) { existing.count += 1; existing.sample = logEntry.text || logEntry.title; existing.lastSeen = postedAt; }
        else ns.unmappedApps.push({ packageName: pkg, count: 1, sample: logEntry.text || logEntry.title, lastSeen: postedAt });
        pushLog('UNMAPPED');
        return { status: 'UNMAPPED', hash };
      }

      // 2) Manual-vs-auto collision: same account + same amount recorded manually within 5 minutes.
      const amountCents = toCents(parsed.amount);
      const collision = data.transactions.find((tx) => tx.source === 'MANUAL'
        && (tx.fromAccountId === acc.id || tx.toAccountId === acc.id)
        && toCents(tx.amount) === amountCents
        && Math.abs(new Date(tx.createdAt).getTime() - postedAt) <= COLLISION_WINDOW_MS
        && !(tx.linkedNotifHashes || []).length);
      if (collision) {
        collision.linkedNotifHashes = (collision.linkedNotifHashes || []).concat([hash]);
        pushLog('LINKED', { txId: collision.id, accountId: acc.id });
        return { status: 'LINKED', txId: collision.id, accountId: acc.id, hash };
      }

      // 3) Post. Bank notifications reflect money that already moved, so negative balances are allowed.
      const autoCategoryId = parsed.direction === 'CREDIT' ? null : categorizeMerchant(data, parsed.merchant, parsed.text);
      const tx = postTransactionInternal(data, parsed.direction === 'CREDIT'
        ? { type: 'INCOME', toAccountId: acc.id, amount: parsed.amount, date: postedDate, note: parsed.merchant || logEntry.title, source: 'NOTIFICATION', notifHash: hash }
        : { type: 'EXPENSE', fromAccountId: acc.id, amount: parsed.amount, categoryId: autoCategoryId || OTHER_CATEGORY_ID, date: postedDate, note: parsed.merchant || logEntry.title, source: 'NOTIFICATION', notifHash: hash },
      { today, force: true });
      pushLog('POSTED', { txId: tx.id, accountId: acc.id, txType: tx.type, categoryId: tx.categoryId });
      return { status: 'POSTED', txType: tx.type, txId: tx.id, accountId: acc.id, categoryId: tx.categoryId, hash };
    });
  }

  function dismissDiscovery(data, catalogCode) {
    data.notificationState.pendingDiscoveries = data.notificationState.pendingDiscoveries.filter((d) => d.catalogCode !== catalogCode);
  }
  function linkPackageToAccount(data, pkg, accountId) {
    return atomic(data, () => {
      const acc = requireAccount(data, accountId);
      if (!acc.androidPackages.includes(pkg)) acc.androidPackages.push(pkg);
      data.notificationState = Object.assign(defaultNotificationState(), data.notificationState || {});
      data.notificationState.packageAccountMap = Object.assign({}, data.notificationState.packageAccountMap || {}, { [pkg]: acc.id });
      data.notificationState.unmappedApps = data.notificationState.unmappedApps.filter((u) => u.packageName !== pkg);
      return acc;
    });
  }
  function setPackageAccountMapping(data, pkg, accountId) {
    return atomic(data, () => {
      data.notificationState = Object.assign(defaultNotificationState(), data.notificationState || {});
      data.notificationState.packageAccountMap = Object.assign({}, data.notificationState.packageAccountMap || {});
      if (!accountId) {
        delete data.notificationState.packageAccountMap[pkg];
        data.accounts.forEach((a) => {
          a.androidPackages = (a.androidPackages || []).filter((p) => p !== pkg);
        });
        return null;
      }
      const acc = requireAccount(data, accountId);
      data.accounts.forEach((a) => {
        if (a.id !== acc.id) a.androidPackages = (a.androidPackages || []).filter((p) => p !== pkg);
      });
      if (!(acc.androidPackages || []).includes(pkg)) {
        acc.androidPackages = (acc.androidPackages || []).concat([pkg]);
      }
      data.notificationState.packageAccountMap[pkg] = acc.id;
      return acc;
    });
  }
  function ignorePackage(data, pkg) {
    const ns = data.notificationState;
    if (!ns.ignoredPackages.includes(pkg)) ns.ignoredPackages.push(pkg);
    ns.unmappedApps = ns.unmappedApps.filter((u) => u.packageName !== pkg);
  }

  // ===========================================================================
  // MIGRATION (v1/v2 → v3) + NORMALISATION — never drops user records
  // ===========================================================================
  function migrateLegacyTransaction(data, tx) {
    const out = Object.assign({}, tx);
    out.id = out.id || uid('tx');
    out.legacy = true;
    out.effects = [];
    out.params = null;
    out.source = 'MANUAL';
    out.createdAt = out.createdAt || `${out.date || '1970-01-01'}T00:00:00.000Z`;
    out.amount = round2(out.amount || 0);
    out.personalAmount = round2(out.personalAmount || 0);
    out.linkedNotifHashes = [];
    const byName = (name) => data.accounts.find((a) => a.nameEn === name) || null;
    const desc = String(out.descEn || '');
    // Old app descriptions are reconstructable: link categories & accounts where possible.
    if (out.type === 'EXPENSE') {
      const m = desc.match(/^Expense \((.+)\) paid from (.+)$/);
      if (m) {
        const cat = data.categories.find((c) => c.nameEn === m[1]);
        const acc = byName(m[2]);
        out.categoryId = cat ? cat.id : OTHER_CATEGORY_ID;
        if (acc) {
          out.fromAccountId = acc.id;
          out.effects = [{ accountId: acc.id, deltaCents: outflowCents(acc, toCents(out.amount)) }];
          out.reconstructed = true;
        }
      } else if (!LEGACY_SEED_IDS.transactions.includes(out.id)) {
        out.categoryId = OTHER_CATEGORY_ID;
      }
    } else if (out.type === 'TRANSFER') {
      const m = desc.match(/^Atomic Transfer: (.+) -> (.+) \(RM 0 Expense Inflation\)$/);
      if (m) {
        const from = byName(m[1]);
        const to = byName(m[2]);
        if (from && to) {
          out.fromAccountId = from.id; out.toAccountId = to.id;
          out.effects = [
            { accountId: from.id, deltaCents: outflowCents(from, toCents(out.amount)) },
            { accountId: to.id, deltaCents: inflowCents(to, toCents(out.amount)) }
          ];
          out.reconstructed = true;
        }
      }
    }
    return out;
  }

  function migrateLegacyPlan(data, p) {
    const spay = data.accounts.find((a) => a.id === 'spaylater') || data.accounts.find((a) => a.pillar === 'LIABILITY');
    const schedules = (p.schedules || []).map((s, i) => ({
      id: s.id || uid('sch'),
      number: s.number || i + 1,
      dueDate: isValidDateStr(s.dueDate || '') ? s.dueDate : null,
      principal: round2(s.principal ?? s.amount ?? 0),
      fee: round2(s.fee || 0),
      amount: round2(s.amount || 0),
      status: s.status || (s.paid ? 'PAID_BEFORE_APP' : 'UNPAID')
    }));
    return {
      id: p.id || uid('plan'),
      liabilityAccountId: p.liabilityAccountId || (spay ? spay.id : null),
      itemName: p.itemName || p.merchantEn || p.merchantZh || 'Installment',
      categoryId: p.categoryId || (data.categories.some((c) => c.id === 'cat-shopping') ? 'cat-shopping' : OTHER_CATEGORY_ID),
      totalPrincipal: round2(p.totalPrincipal || schedules.reduce((s, r) => s + r.principal, 0)),
      tenureMonths: p.tenureMonths || schedules.length,
      monthlyFee: round2(p.monthlyFee || 0),
      startDate: p.startDate || null,
      dueDay: p.dueDay || null,
      alreadyPaidCount: 0,
      schedules,
      purchaseTxId: p.purchaseTxId || null,
      status: schedules.some((r) => r.status === 'UNPAID') ? 'ACTIVE' : 'COMPLETED',
      legacy: true,
      createdAt: p.createdAt || new Date().toISOString()
    };
  }

  /**
   * Normalises any saved data (v1/v2/v3) into the v3 shape. Idempotent.
   * Returns { data, migrated: boolean, fromVersion }.
   */
  function normalizeData(raw, opts) {
    const today = (opts && opts.today) || todayStr();
    const src = raw && typeof raw === 'object' ? raw : {};
    const fromVersion = Number(src.schemaVersion) || 2;
    const data = createEmptyData();
    data.lang = src.lang === 'zh-CN' ? 'zh-CN' : 'en';
    data.netMonthlyIncome = Number.isFinite(Number(src.netMonthlyIncome)) ? round2(src.netMonthlyIncome) : 0;
    data.accounts = (Array.isArray(src.accounts) ? src.accounts : []).map((a) => normalizeAccount(a, today));
    if (Array.isArray(src.categories) && src.categories.length) {
      const defIcons = { 'cat-food': '🍜', 'cat-transport': '🚗', 'cat-shopping': '🛍️', 'cat-bills': '⚡', 'cat-insurance': '🛡️', 'cat-fees': '🏦', [OTHER_CATEGORY_ID]: '📌' };
      data.categories = src.categories.map((c) => ({
        id: c.id || uid('cat'), code: c.code || 'CUSTOM',
        nameEn: c.nameEn || c.nameZh || 'Category', nameZh: c.nameZh || c.nameEn || 'Category',
        icon: c.icon || defIcons[c.id] || '📌',
        budget: Number.isFinite(Number(c.budget)) && Number(c.budget) >= 0 ? round2(c.budget) : 0
      }));
      if (!data.categories.some((c) => c.id === OTHER_CATEGORY_ID)) data.categories.push(defaultCategories().find((c) => c.id === OTHER_CATEGORY_ID));
    }
    data.reimbursements = Array.isArray(src.reimbursements) ? src.reimbursements.map((r) => Object.assign({ id: r.id || uid('reimb') }, r)) : [];
    data.recurringBills = Array.isArray(src.recurringBills) ? src.recurringBills.map((b) => Object.assign({ id: b.id || uid('rec'), active: b.active !== false }, b)) : [];
    data.taxBuckets = Array.isArray(src.taxBuckets) && src.taxBuckets.length ? src.taxBuckets.filter((b) => b && b.code) : defaultTaxBuckets();
    data.asnbSnapshots = Array.isArray(src.asnbSnapshots) ? src.asnbSnapshots.map((s) => Object.assign({ id: s.id || uid('snap') }, s)) : [];
    data.settings = Object.assign(defaultSettings(), src.settings || {});
    data.notificationState = Object.assign(defaultNotificationState(), src.notificationState || {});

    if (fromVersion < 3) {
      data.transactions = (Array.isArray(src.transactions) ? src.transactions : []).map((t) => migrateLegacyTransaction(data, t));
      data.installmentPlans = (Array.isArray(src.installmentPlans) ? src.installmentPlans : []).map((p) => migrateLegacyPlan(data, p));
      // Preserve the stored ASNB "lowest this month" — the old ledger had no history to recompute it.
      data.accounts.forEach((a) => {
        if (a.interestMethod === 'ASNB_MIN_MONTHLY') {
          a.asnbTrackingYm = ymOf(today);
          a.asnbManualLowest = { ym: ymOf(today), value: round2(Math.max(0, a.lowestMonthlyBalance ?? a.currentBalance)) };
        }
        if (a.pillar === 'INCOME_SOURCE' && !(Number(data.netMonthlyIncome) > 0)) data.netMonthlyIncome = a.currentBalance;
        // Map well-known legacy accounts to the catalog so notifications can find them.
        const cat = getCatalog();
        if (cat && !a.catalogCode) {
          const guess = { gxbank: 'GXBANK', 'tng-ewallet': 'TNG_EWALLET', 'tng-nfc': 'TNG_NFC', spaylater: 'SPAYLATER', 'asnb-fixed': 'ASNB_ASM' }[a.id];
          const item = guess && cat.findByCode(guess);
          if (item) {
            a.catalogCode = item.code;
            if (!a.androidPackages.length) a.androidPackages = item.androidPackages.slice();
            if (!a.notificationKeywords.length) a.notificationKeywords = item.notificationKeywords.slice();
          }
        }
      });
    } else {
      data.transactions = (Array.isArray(src.transactions) ? src.transactions : []).map((t) => Object.assign({
        effects: [], linkedNotifHashes: [], scheduleIds: [], source: 'MANUAL'
      }, t));
      data.installmentPlans = (Array.isArray(src.installmentPlans) ? src.installmentPlans : []).map((p) => Object.assign({ schedules: [] }, p));
    }

    data.systemInitialized = src.systemInitialized === true || src.SYSTEM_INITIALIZED === true || data.accounts.length > 0;
    data.schemaVersion = SCHEMA_VERSION;
    return { data, migrated: fromVersion < SCHEMA_VERSION, fromVersion };
  }

  /** Lists leftover records from the OLD built-in demo seed that still exist in the data. */
  function findLegacyDemoRecords(data) {
    return {
      transactions: data.transactions.filter((t) => LEGACY_SEED_IDS.transactions.includes(t.id)).map((t) => t.id),
      installmentPlans: data.installmentPlans.filter((p) => LEGACY_SEED_IDS.installmentPlans.includes(p.id)).map((p) => p.id),
      reimbursements: data.reimbursements.filter((r) => LEGACY_SEED_IDS.reimbursements.includes(r.id)).map((r) => r.id),
      asnbSnapshots: data.asnbSnapshots.filter((s) => LEGACY_SEED_IDS.asnbSnapshots.includes(s.id)).map((s) => s.id),
      accounts: data.accounts.filter((a) => LEGACY_SEED_IDS.accounts.includes(a.id)).map((a) => a.id)
    };
  }

  /** Removes old demo records (NOT accounts — the user deletes those individually). */
  function removeLegacyDemoRecords(data) {
    return atomic(data, () => {
      const f = findLegacyDemoRecords(data);
      data.transactions = data.transactions.filter((t) => !f.transactions.includes(t.id));
      data.installmentPlans = data.installmentPlans.filter((p) => !f.installmentPlans.includes(p.id));
      data.reimbursements = data.reimbursements.filter((r) => !f.reimbursements.includes(r.id));
      data.asnbSnapshots = data.asnbSnapshots.filter((s) => !f.asnbSnapshots.includes(s.id));
      return f;
    });
  }

  // ===========================================================================
  // OPTIONAL DEMO DATA (only loaded when the user explicitly taps "Load Demo Data")
  // ===========================================================================
  function buildDemoData(opts) {
    const today = (opts && opts.today) || todayStr();
    const data = createEmptyData();
    data.systemInitialized = true;
    data.lang = (opts && opts.lang) || 'en';
    const cat = getCatalog(opts && opts.catalog);
    const mk = (code, over) => createAccountFromCatalog(data, code, over, cat, { today });
    const maybank = mk('MAYBANK', { nameEn: 'Demo Maybank Savings', nameZh: '演示 Maybank 储蓄账户', currentBalance: 1800, minBalanceLimit: 20 });
    mk('GXBANK', { nameEn: 'Demo GXBank', nameZh: '演示 GXBank', currentBalance: 3650 });
    mk('TNG_EWALLET', { nameEn: "Demo Touch 'n Go eWallet", nameZh: '演示 TNG 电子钱包', currentBalance: 150, minBalanceLimit: 20 });
    mk('TNG_NFC', { nameEn: 'Demo TNG NFC Card', nameZh: '演示 TNG NFC 卡', currentBalance: 6.5 });
    mk('ASNB_ASM', { nameEn: 'Demo ASNB ASM', nameZh: '演示 ASNB ASM', currentBalance: 13000 });
    const spay = mk('SPAYLATER', { nameEn: 'Demo SPayLater', nameZh: '演示 SPayLater', currentBalance: 0 });
    createAccount(data, { pillar: 'INCOME_SOURCE', subTypeEn: 'Monthly Salary', subTypeZh: '主业固定薪资', nameEn: 'Demo Net Salary', nameZh: '演示 税后薪资', currentBalance: 5000, payDayOfMonth: 25 }, { today });
    updateAccountSettings(data, maybank.id, {
      envelopes: [{ nameEn: 'Road Tax & Insurance', nameZh: '路税与车险信封', allocated: 300, target: 600 }],
      autoDebits: [{ nameEn: 'Medical Insurance', nameZh: '医疗保险扣款', amount: 250, dayOfMonth: 22 }]
    }, { today });
    data.categories.find((c) => c.id === 'cat-food').budget = 800;
    data.categories.find((c) => c.id === 'cat-shopping').budget = 600;
    data.categories.find((c) => c.id === 'cat-transport').budget = 400;
    createInstallmentPurchase(data, {
      liabilityAccountId: spay.id, itemName: 'Wireless Earbuds', totalPrincipal: 100, tenureMonths: 3,
      monthlyFee: 0, startDate: today, dueDay: 5, categoryId: 'cat-shopping'
    }, { today });
    postTransaction(data, { type: 'EXPENSE', fromAccountId: maybank.id, amount: 23.5, categoryId: 'cat-food', note: 'Lunch', date: today }, { today });
    upsertRecurringBill(data, { nameEn: 'Unifi Fibre 300Mbps', nameZh: 'Unifi 光纤宽带月费', type: 'EXPENSE', amount: 139, dayOfMonth: 18, fromAccountId: maybank.id, categoryId: 'cat-bills' });
    return data;
  }

  return {
    SCHEMA_VERSION, PILLARS, INTEREST_METHODS, TX_TYPES, EDITABLE_TYPES, ERROR_CODES, OTHER_CATEGORY_ID, LEGACY_SEED_IDS,
    PfmError,
    // money / validation / dates
    toCents, fromCents, round2, addMoney, parseAmount, parseNonNegative, parseTenure, parseRate, parseDueDay, parseDate,
    todayStr, addDays, daysBetween, isValidDateStr, ymOf, uid, clone,
    // data lifecycle
    createEmptyData, normalizeData, buildDemoData, findLegacyDemoRecords, removeLegacyDemoRecords, defaultCategories,
    // accounts
    createAccount, createAccountFromCatalog, updateAccountSettings, deleteAccount, findAccount,
    // ledger, categories, tax & reimbursements
    postTransaction, deleteTransaction, editTransaction, findTx, atomic,
    settleReimbursement, recomputeTaxBuckets, upsertCategory, deleteCategory,
    // installments
    splitPrincipal, buildSchedule, createInstallmentPurchase, createManualMonthlyInstallment, getDueInstallments, payInstallment, payInstallmentsBatch, planSummary,
    editInstallmentPlan, editInstallmentScheduleRow, deleteInstallmentScheduleRow, deleteInstallmentPlan, updatePlanDetails, deleteLegacyPlan,
    // recurring & payroll
    upsertRecurringBill, deleteRecurringBill, getPendingRecurringBills, postRecurringBill, creditSalaryWithEpf,
    // interest / ASNB
    getEffectiveRate, computeYieldMetrics, runCatchUp, refreshAsnb, eodSeries, asnbDividend,
    // roll-ups, analytics & guardrails
    safeToSpend, categorySpend, computeRollup, computeAnalytics, evaluateGuardrails,
    // notifications & smart categorization
    parseNotification, matchAccountForPackage, ingestNotification, dismissDiscovery, linkPackageToAccount, setPackageAccountMapping, ignorePackage, fnv1a,
    MERCHANT_CATEGORY_RULES, categorizeMerchant, learnMerchantCategory
  };
});

