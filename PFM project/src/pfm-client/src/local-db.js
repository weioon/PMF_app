/**
 * MyPFM Local IndexedDB Database & Offline-First Domain Engine (Dexie-style Schema)
 * ---------------------------------------------------------------------------------
 * Runs 100% locally on the user's Android device (Capacitor APK or Standalone PWA)
 * with zero dependency on any PC localhost server.
 *
 * Persistence Architecture:
 * 1. Primary Store: IndexedDB (`MyPfmIndexedDb` v3) with object stores:
 *    - `accounts`: 4-Pillar accounts, balances, floors, virtual envelopes, auto-debits
 *    - `transactions`: Strict Double-Entry Ledger transactions (EXPENSE, INCOME, TRANSFER)
 *    - `asnbSnapshots`: ASNB Minimum Monthly Balance snapshots (Day 1..End tracking)
 *    - `installments`: SPayLater / Credit Card EPP / Loan amortized schedules
 *    - `categories`: Monthly category budgets and direct/installment rollup tracking
 *    - `reimbursements`: Pending friend split-bill receivables
 *    - `taxBuckets`: LHDN Malaysia annual tax relief buckets
 *    - `meta`: App settings, systemInitialized flag, language preference, schema version
 * 2. Mirror Store: `localStorage` (`mypfm_data_v2`) kept in sync for instant synchronous boot
 *    and backward compatibility across code updates.
 * 3. JSON Backup / Restore: Full single-file `.json` export & import with validation.
 * 4. Storage Eviction Protection: Calls `navigator.storage.persist()` on database initialization.
 */
(function (global) {
  'use strict';

  const DB_NAME = 'MyPfmIndexedDb';
  const DB_VERSION = 3;
  const LOCAL_STORAGE_KEY = 'mypfm_data_v2';
  const DUMMY_PURGED_KEY = 'MYPFM_V3_DUMMY_PURGED';

  const LEGACY_DUMMY_ACCOUNT_IDS = new Set([
    'bank-a', 'bank-b', 'gxbank', 'tng-ewallet', 'tng-nfc',
    'asnb-fixed', 'spaylater', 'cc-visa', 'income-salary'
  ]);
  const LEGACY_DUMMY_ACCOUNT_NAMES = new Set([
    'Bank A (Maybank Main CASA)',
    'Bank B (CIMB Reserve CASA)',
    'GXBank Daily Interest Account',
    'ASNB ASM Fixed-Price Fund',
    'SPayLater (Shopee BNPL)',
    'Maybank Visa Cashback Card',
    'Primary Employer Net Salary'
  ]);
  const LEGACY_DUMMY_TX_IDS = new Set(['tx-1', 'tx-2', 'tx-3']);
  const LEGACY_DUMMY_PLAN_IDS = new Set(['plan-spay-1']);
  const LEGACY_DUMMY_REIMB_IDS = new Set(['reimb-1']);
  const LEGACY_DUMMY_SNAP_IDS = new Set(['snap-2026-10']);

  function purgeLegacyDummyRecords(stateObj) {
    if (!stateObj || typeof stateObj !== 'object') return { purged: false, data: stateObj };

    const beforeAccLen = Array.isArray(stateObj.accounts) ? stateObj.accounts.length : 0;
    const beforeTxLen = Array.isArray(stateObj.transactions) ? stateObj.transactions.length : 0;

    const hasV2DummySignature = Array.isArray(stateObj.accounts) && stateObj.accounts.some(
      (a) => a && LEGACY_DUMMY_ACCOUNT_NAMES.has(a.nameEn)
    );

    if (Array.isArray(stateObj.accounts)) {
      stateObj.accounts = stateObj.accounts.filter((a) => {
        if (!a) return false;
        if (LEGACY_DUMMY_ACCOUNT_NAMES.has(a.nameEn)) return false;
        if (hasV2DummySignature && LEGACY_DUMMY_ACCOUNT_IDS.has(a.id)) return false;
        return true;
      });
    }
    if (Array.isArray(stateObj.transactions)) {
      stateObj.transactions = stateObj.transactions.filter((t) => t && !LEGACY_DUMMY_TX_IDS.has(t.id));
    }
    if (Array.isArray(stateObj.installmentPlans)) {
      stateObj.installmentPlans = stateObj.installmentPlans.filter((p) => p && !LEGACY_DUMMY_PLAN_IDS.has(p.id));
    }
    if (Array.isArray(stateObj.reimbursements)) {
      stateObj.reimbursements = stateObj.reimbursements.filter((r) => r && !LEGACY_DUMMY_REIMB_IDS.has(r.id));
    }
    if (Array.isArray(stateObj.asnbSnapshots)) {
      stateObj.asnbSnapshots = stateObj.asnbSnapshots.filter((s) => s && !LEGACY_DUMMY_SNAP_IDS.has(s.id));
    }

    const afterAccLen = Array.isArray(stateObj.accounts) ? stateObj.accounts.length : 0;
    const afterTxLen = Array.isArray(stateObj.transactions) ? stateObj.transactions.length : 0;
    const wasPurged = beforeAccLen !== afterAccLen || beforeTxLen !== afterTxLen || hasV2DummySignature;

    stateObj.v3DummyPurged = true;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(DUMMY_PURGED_KEY, 'true');
      }
    } catch (e) {}

    return { purged: wasPurged, data: stateObj };
  }

  const STORES = [
    { name: 'accounts', keyPath: 'id' },
    { name: 'transactions', keyPath: 'id' },
    { name: 'asnbSnapshots', keyPath: 'id' },
    { name: 'installments', keyPath: 'id' },
    { name: 'categories', keyPath: 'id' },
    { name: 'reimbursements', keyPath: 'id' },
    { name: 'taxBuckets', keyPath: 'code' },
    { name: 'meta', keyPath: 'key' }
  ];

  class PfmLocalDatabase {
    constructor() {
      this.dbPromise = null;
    }

    open() {
      if (this.dbPromise) return this.dbPromise;

      // Call navigator.storage.persist() on Android WebView / PWA to guarantee eviction protection
      if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then((persisted) => {
          if (persisted) {
            console.log('[MyPFM Storage] Storage successfully marked as persistent (immune to eviction).');
          } else {
            console.log('[MyPFM Storage] Storage persistence requested (best effort).');
          }
        }).catch((err) => {
          console.warn('[MyPFM Storage] navigator.storage.persist() call failed:', err);
        });
      }

      this.dbPromise = new Promise((resolve) => {
        if (!('indexedDB' in global)) {
          resolve(null);
          return;
        }
        const request = global.indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          STORES.forEach((s) => {
            if (!db.objectStoreNames.contains(s.name)) {
              db.createObjectStore(s.name, { keyPath: s.keyPath });
            }
          });
        };
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = () => resolve(null);
      });
      return this.dbPromise;
    }

    async getAll(storeName) {
      const db = await this.open();
      if (!db) return [];
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        } catch (e) {
          resolve([]);
        }
      });
    }

    async putAll(storeName, items) {
      const db = await this.open();
      if (!db || !Array.isArray(items)) return;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          store.clear();
          items.forEach((item) => store.put(item));
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch (e) {
          resolve(false);
        }
      });
    }

    async saveFullState(stateSnapshot) {
      if (!stateSnapshot) return;
      const nowIso = new Date().toISOString();
      stateSnapshot.systemInitialized = true;
      stateSnapshot.SYSTEM_INITIALIZED = true;
      stateSnapshot.v3DummyPurged = true;
      stateSnapshot.savedAt = nowIso;

      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('SYSTEM_INITIALIZED', 'true');
          localStorage.setItem(DUMMY_PURGED_KEY, 'true');
          localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(stateSnapshot));
        }
      } catch (e) {}

      const db = await this.open();
      if (!db) return;

      await Promise.all([
        this.putAll('accounts', stateSnapshot.accounts || []),
        this.putAll('transactions', stateSnapshot.transactions || []),
        this.putAll('asnbSnapshots', stateSnapshot.asnbSnapshots || []),
        this.putAll('installments', stateSnapshot.installmentPlans || []),
        this.putAll('categories', stateSnapshot.categories || []),
        this.putAll('reimbursements', stateSnapshot.reimbursements || []),
        this.putAll('taxBuckets', stateSnapshot.taxBuckets || []),
        this.putAll('meta', [
          { key: 'systemInitialized', value: true },
          { key: 'SYSTEM_INITIALIZED', value: true },
          { key: 'lang', value: stateSnapshot.lang || 'en' },
          { key: 'netMonthlyIncome', value: stateSnapshot.netMonthlyIncome ?? 5000 },
          { key: 'updatedAtUtc', value: nowIso }
        ])
      ]);
    }

    async loadFullState() {
      let lsParsed = null;
      try {
        if (typeof localStorage !== 'undefined') {
          const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
          if (raw) {
            const p = JSON.parse(raw);
            if (p && (p.systemInitialized === true || p.SYSTEM_INITIALIZED === true || localStorage.getItem('SYSTEM_INITIALIZED') === 'true' || Array.isArray(p.accounts))) {
              purgeLegacyDummyRecords(p);
              p.systemInitialized = true;
              p.SYSTEM_INITIALIZED = true;
              lsParsed = p;
            }
          }
        }
      } catch (e) {}

      const db = await this.open();
      if (db) {
        const [
          accounts,
          transactions,
          asnbSnapshots,
          installmentPlans,
          categories,
          reimbursements,
          taxBuckets,
          meta
        ] = await Promise.all([
          this.getAll('accounts'),
          this.getAll('transactions'),
          this.getAll('asnbSnapshots'),
          this.getAll('installments'),
          this.getAll('categories'),
          this.getAll('reimbursements'),
          this.getAll('taxBuckets'),
          this.getAll('meta')
        ]);

        const metaMap = {};
        (meta || []).forEach((m) => { metaMap[m.key] = m.value; });

        const isInit = metaMap.systemInitialized === true || metaMap.systemInitialized === 'true' || metaMap.SYSTEM_INITIALIZED === true || (accounts && accounts.length > 0);

        if (isInit) {
          // If synchronous localStorage has a newer timestamp than async IndexedDB (e.g., rapid reload), prefer localStorage
          if (lsParsed && lsParsed.savedAt && metaMap.updatedAtUtc && lsParsed.savedAt > metaMap.updatedAtUtc) {
            await this.saveFullState(lsParsed);
            return lsParsed;
          }
          const loadedState = {
            systemInitialized: true,
            SYSTEM_INITIALIZED: true,
            v3DummyPurged: metaMap.v3DummyPurged === true,
            accounts: accounts || [],
            transactions: transactions || [],
            asnbSnapshots: asnbSnapshots || [],
            installmentPlans: installmentPlans || [],
            categories: categories || [],
            reimbursements: reimbursements || [],
            taxBuckets: taxBuckets || [],
            lang: metaMap.lang || 'en',
            netMonthlyIncome: metaMap.netMonthlyIncome ?? 0
          };
          const purgeRes = purgeLegacyDummyRecords(loadedState);
          if (purgeRes.purged) {
            await this.saveFullState(loadedState);
          }
          return loadedState;
        }
      }

      if (lsParsed) {
        await this.saveFullState(lsParsed);
        return lsParsed;
      }

      // Brand new install: return uninitialized state (does not force dummy accounts)
      return {
        systemInitialized: false,
        SYSTEM_INITIALIZED: false,
        accounts: [],
        transactions: [],
        asnbSnapshots: [],
        installmentPlans: [],
        categories: [],
        reimbursements: [],
        taxBuckets: [],
        lang: 'en',
        netMonthlyIncome: 5000
      };
    }

    async clearAllData() {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(LOCAL_STORAGE_KEY);
          localStorage.setItem('SYSTEM_INITIALIZED', 'true');
        }
      } catch (e) {}

      const db = await this.open();
      if (!db) return true;

      await Promise.all([
        this.putAll('accounts', []),
        this.putAll('transactions', []),
        this.putAll('asnbSnapshots', []),
        this.putAll('installments', []),
        this.putAll('categories', []),
        this.putAll('reimbursements', []),
        this.putAll('taxBuckets', []),
        this.putAll('meta', [
          { key: 'systemInitialized', value: true },
          { key: 'SYSTEM_INITIALIZED', value: true },
          { key: 'updatedAtUtc', value: new Date().toISOString() }
        ])
      ]);
      return true;
    }

    exportBackupJson(stateSnapshot) {
      const payload = {
        app: 'MyPFM-Standalone-Local',
        schemaVersion: DB_VERSION,
        exportedAtUtc: new Date().toISOString(),
        currency: 'MYR',
        data: {
          systemInitialized: true,
          lang: stateSnapshot.lang || 'en',
          netMonthlyIncome: stateSnapshot.netMonthlyIncome || 5000,
          accounts: stateSnapshot.accounts || [],
          transactions: stateSnapshot.transactions || [],
          asnbSnapshots: stateSnapshot.asnbSnapshots || [],
          installmentPlans: stateSnapshot.installmentPlans || [],
          categories: stateSnapshot.categories || [],
          reimbursements: stateSnapshot.reimbursements || [],
          taxBuckets: stateSnapshot.taxBuckets || []
        }
      };
      return JSON.stringify(payload, null, 2);
    }

    validateAndExtractBackup(jsonString) {
      const parsed = JSON.parse(jsonString);
      const data = parsed && parsed.data ? parsed.data : parsed;
      if (!data || !Array.isArray(data.accounts)) {
        throw new Error('Invalid MyPFM backup file: missing accounts array.');
      }
      data.systemInitialized = true;
      return data;
    }
  }

  // ===========================================================================
  // STANDALONE CLIENT-SIDE DOMAIN ENGINE (Parity with clean architecture)
  // ===========================================================================
  const PfmDomainEngine = {
    roundRM(val) {
      return Math.round((Number(val) + Number.EPSILON) * 100) / 100;
    },

    calculateUnrestrictedSpendableBalance(account, installmentPlans = []) {
      if (!account || account.pillar !== 'ASSET_LIQUID') return 0;
      const envSum = (account.envelopes || []).reduce((s, e) => s + Number(e.allocated || e.allocatedBalance || 0), 0);
      const debitSum = (account.autoDebits || []).reduce((s, d) => s + Number(d.amount || 0), 0);
      const linkedInstSum = (installmentPlans || [])
        .filter((p) => p.linkedRepaymentAccountId === account.id || p.liabilityAccountId === account.id)
        .reduce((s, p) => {
          const nextUnpaid = (p.schedules || []).find((sc) => sc.status === 'UNPAID' || !sc.paid);
          return s + (nextUnpaid ? Number(nextUnpaid.amount || 0) : 0);
        }, 0);
      const raw = Number(account.currentBalance || 0) - Number(account.minBalanceLimit || 0) - envSum - debitSum - linkedInstSum;
      return Math.max(0, this.roundRM(raw));
    },

    calculateAsnbMonthlyDividend(lowestMonthlyBalance, annualRatePercent) {
      if (lowestMonthlyBalance <= 0 || annualRatePercent <= 0) return 0;
      return this.roundRM((Number(lowestMonthlyBalance) * (Number(annualRatePercent) / 100)) / 12);
    },

    calculateDailyCompoundInterest(balance, annualRatePercent, days = 1) {
      if (balance <= 0 || annualRatePercent <= 0 || days <= 0) return 0;
      return this.roundRM(Number(balance) * (Number(annualRatePercent) / 100 / 365) * days);
    }
  };

  global.PfmLocalDb = new PfmLocalDatabase();
  global.PfmLocalDatabase = PfmLocalDatabase;
  global.PfmDomainEngine = PfmDomainEngine;
  if (typeof module === 'object' && module.exports) {
    module.exports = { PfmLocalDatabase, PfmLocalDb: global.PfmLocalDb, PfmDomainEngine };
  }
})(typeof window !== 'undefined' ? window : globalThis);
