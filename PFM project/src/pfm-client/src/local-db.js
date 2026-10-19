/**
 * MyPFM Local IndexedDB Database & Offline-First Domain Engine (Dexie-style Schema)
 * ---------------------------------------------------------------------------------
 * Runs 100% locally on the user's Android device (Capacitor APK or Standalone PWA)
 * with zero dependency on any PC localhost server.
 *
 * Persistence Architecture:
 * 1. Primary Store: IndexedDB (`MyPfmIndexedDb` v2) with object stores:
 *    - `accounts`: 4-Pillar accounts, balances, floors, virtual envelopes, auto-debits
 *    - `transactions`: Strict Double-Entry Ledger transactions (EXPENSE, INCOME, TRANSFER)
 *    - `asnbSnapshots`: ASNB Minimum Monthly Balance snapshots (Day 1..End tracking)
 *    - `installments`: SPayLater / Credit Card EPP / Loan amortized schedules
 *    - `categories`: Monthly category budgets and direct/installment rollup tracking
 *    - `reimbursements`: Pending friend split-bill receivables
 *    - `taxBuckets`: LHDN Malaysia annual tax relief buckets
 *    - `meta`: App settings, language preference, schema version
 * 2. Mirror Store: `localStorage` (`mypfm_data_v2`) kept in sync for instant synchronous boot
 *    and backward compatibility across code updates.
 * 3. JSON Backup / Restore: Full single-file `.json` export & import with validation.
 */
(function (global) {
  'use strict';

  const DB_NAME = 'MyPfmIndexedDb';
  const DB_VERSION = 2;
  const LOCAL_STORAGE_KEY = 'mypfm_data_v2';

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
      this.dbPromise = new Promise((resolve, reject) => {
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
      try {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(stateSnapshot));
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
          { key: 'lang', value: stateSnapshot.lang || 'en' },
          { key: 'netMonthlyIncome', value: stateSnapshot.netMonthlyIncome || 5000 },
          { key: 'updatedAtUtc', value: new Date().toISOString() }
        ])
      ]);
    }

    async loadFullState() {
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

        if (accounts && accounts.length > 0) {
          const metaMap = {};
          (meta || []).forEach((m) => { metaMap[m.key] = m.value; });
          return {
            accounts,
            transactions: transactions || [],
            asnbSnapshots: asnbSnapshots || [],
            installmentPlans: installmentPlans || [],
            categories: categories || [],
            reimbursements: reimbursements || [],
            taxBuckets: taxBuckets || [],
            lang: metaMap.lang || 'en',
            netMonthlyIncome: metaMap.netMonthlyIncome || 5000
          };
        }
      }

      // Fallback to localStorage if IndexedDB is empty on first upgrade
      try {
        const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          await this.saveFullState(parsed);
          return parsed;
        }
      } catch (e) {}

      return null;
    }

    exportBackupJson(stateSnapshot) {
      const payload = {
        app: 'MyPFM-Standalone-Local',
        schemaVersion: DB_VERSION,
        exportedAtUtc: new Date().toISOString(),
        currency: 'MYR',
        data: {
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
      if (!data || !Array.isArray(data.accounts) || data.accounts.length === 0) {
        throw new Error('Invalid MyPFM backup file: missing accounts array.');
      }
      return data;
    }
  }

  // ===========================================================================
  // STANDALONE CLIENT-SIDE DOMAIN ENGINE (100% Parity with C# Clean Architecture)
  // ===========================================================================
  const PfmDomainEngine = {
    roundRM(val) {
      return Math.round((Number(val) + Number.EPSILON) * 100) / 100;
    },

    // Invariant #3: UnrestrictedSpendableBalance = CurrentBalance - MinBalanceLimit - Sum(Envelopes) - Sum(UpcomingAutoDebits) - Sum(LinkedInstallments)
    calculateUnrestrictedSpendableBalance(account, installmentPlans = []) {
      if (!account || account.pillar !== 'ASSET_LIQUID') return 0;
      const envSum = (account.envelopes || []).reduce((s, e) => s + Number(e.allocated || e.allocatedBalance || 0), 0);
      const debitSum = (account.autoDebits || []).reduce((s, d) => s + Number(d.amount || 0), 0);
      const linkedInstSum = (installmentPlans || [])
        .filter((p) => p.linkedRepaymentAccountId === account.id)
        .reduce((s, p) => {
          const nextUnpaid = (p.schedules || []).find((sc) => !sc.paid);
          return s + (nextUnpaid ? Number(nextUnpaid.amount || 0) : 0);
        }, 0);
      const raw = Number(account.currentBalance || 0) - Number(account.minBalanceLimit || 0) - envSum - debitSum - linkedInstSum;
      return Math.max(0, this.roundRM(raw));
    },

    // Invariant #5: ASNB Minimum Monthly Balance Dividend = (LowestMonthlyBalance * (AnnualRate / 100)) / 12
    calculateAsnbMonthlyDividend(lowestMonthlyBalance, annualRatePercent) {
      if (lowestMonthlyBalance <= 0 || annualRatePercent <= 0) return 0;
      return this.roundRM((Number(lowestMonthlyBalance) * (Number(annualRatePercent) / 100)) / 12);
    },

    // Invariant #5: Daily Compounding Interest = EndOfDayBalance * (AnnualRate / 100 / 365) * days
    calculateDailyCompoundInterest(balance, annualRatePercent, days = 1) {
      if (balance <= 0 || annualRatePercent <= 0 || days <= 0) return 0;
      return this.roundRM(Number(balance) * (Number(annualRatePercent) / 100 / 365) * days);
    },

    // Update ASNB Lowest Monthly Balance when balance changes on a given day of month
    updateAsnbSnapshotOnBalanceChange(account, prevBalance, newBalance, txDate = new Date()) {
      if (!account || account.interestMethod !== 'ASNB_MIN_MONTHLY') return null;
      const day = txDate.getDate();
      const currentLowest = Number(account.lowestMonthlyBalance ?? prevBalance);

      if (day === 1) {
        if (newBalance > prevBalance && currentLowest === prevBalance) {
          account.lowestMonthlyBalance = this.roundRM(newBalance);
        } else if (newBalance < currentLowest) {
          account.lowestMonthlyBalance = this.roundRM(newBalance);
        }
      } else {
        // After Day 1: withdrawals below LowestMonthlyBalance reduce it for the whole month;
        // deposits after Day 1 do NOT increase current month's LowestMonthlyBalance.
        if (newBalance < currentLowest) {
          account.lowestMonthlyBalance = this.roundRM(newBalance);
        }
      }

      if (newBalance > prevBalance && day > 1) {
        const depositAmt = this.roundRM(newBalance - prevBalance);
        const missedDiv = this.calculateAsnbMonthlyDividend(depositAmt, account.annualRate || 4.5);
        return {
          ruleCode: 'ASNB_DEPOSIT_TIMING_TIP',
          depositAmount: depositAmt,
          dayOfMonth: day,
          missedDividend: missedDiv
        };
      }
      return null;
    }
  };

  global.PfmLocalDb = new PfmLocalDatabase();
  global.PfmDomainEngine = PfmDomainEngine;
})(window);

