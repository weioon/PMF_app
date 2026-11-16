/**
 * Senior QA Automation & Financial Systems Audit Suite
 * 7-Point Verification & Bug-Hunting Protocol
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const Catalog = require('../src/pfm-catalog.js');
const Engine = require('../src/pfm-engine.js');
const { PfmLocalDatabase } = require('../src/local-db.js');

let passed = 0;
let failed = 0;

function verify(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}\n         -> ${err.message}`);
  }
}

async function verifyAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}\n         -> ${err.message}`);
  }
}

function createMockBrowserStorageEnv() {
  const lsStore = new Map();
  const localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => lsStore.set(k, String(v)),
    removeItem: (k) => lsStore.delete(k),
    clear: () => lsStore.clear()
  };

  global.window = {
    localStorage,
    PfmCatalog: Catalog,
    navigator: {
      storage: {
        persist: async () => true,
        persisted: async () => true
      }
    },
    indexedDB: null
  };
  global.localStorage = localStorage;
  global.navigator = global.window.navigator;
  return { localStorage, lsStore };
}

(async () => {
  console.log('======================================================================');
  console.log(' MYPFM 7-POINT FINANCIAL SYSTEMS & QA AUTOMATION AUDIT SUITE');
  console.log('======================================================================\n');

  // =========================================================================
  // 1. DATA PERSISTENCE & NO-RESEEDING STRESS TEST
  // =========================================================================
  console.log('--- 1. DATA PERSISTENCE & NO-RESEEDING STRESS TEST ---');

  await verifyAsync('Test 1.1: Delete all pre-existing/dummy accounts (GXBank, etc.), create custom "Bank A" (RM 500), reload app -> "Bank A" remains RM 500 and ZERO dummy accounts return', async () => {
    createMockBrowserStorageEnv();
    const db = new PfmLocalDatabase();

    // Start with demo state containing GXBank & dummy accounts
    const state = Engine.buildDemoData({ catalog: Catalog, today: '2026-10-20' });
    assert(state.accounts.some(a => a.catalogCode === 'GXBANK' || a.nameEn.includes('GXBank')), 'Initial demo state has GXBank');

    // Delete all existing dummy accounts
    for (const acc of [...state.accounts]) {
      Engine.deleteAccount(state, acc.id, { mode: 'CASCADE', today: '2026-10-20' });
    }
    assert.strictEqual(state.accounts.length, 0, 'All dummy accounts deleted');

    // Create custom "Bank A" with RM 500
    const bankA = Engine.createAccount(state, {
      id: 'bank-a',
      pillar: 'ASSET_LIQUID',
      nameEn: 'Bank A',
      nameZh: 'A银行',
      currentBalance: 500
    }, { today: '2026-10-20' });
    assert.strictEqual(state.accounts.length, 1);
    assert.strictEqual(bankA.currentBalance, 500);

    // Save to storage and simulate full app reload
    await db.saveFullState(state);
    const dbReloaded = new PfmLocalDatabase();
    const loaded = await dbReloaded.loadFullState();

    assert(loaded !== null, 'Reloaded state must not be null');
    assert.strictEqual(loaded.systemInitialized, true, 'systemInitialized must be true');
    assert.strictEqual(loaded.accounts.length, 1, 'Exactly 1 account must exist after reload');
    assert.strictEqual(loaded.accounts[0].id, 'bank-a', 'Account ID must be bank-a');
    assert.strictEqual(loaded.accounts[0].nameEn, 'Bank A', 'Account name must be Bank A');
    assert.strictEqual(loaded.accounts[0].currentBalance, 500, 'Bank A balance must remain RM 500.00');
    assert(!loaded.accounts.some(a => a.id === 'gxbank' || a.catalogCode === 'GXBANK'), 'ZERO dummy accounts (GXBank) may come back');
  });

  await verifyAsync('Test 1.2: Delete ALL accounts (0 accounts left) and reload -> remains 0 accounts without re-seeding dummy data', async () => {
    createMockBrowserStorageEnv();
    const db = new PfmLocalDatabase();
    const emptyState = Engine.createEmptyData();
    await db.saveFullState(emptyState);

    const loaded = await db.loadFullState();
    assert(loaded !== null, 'Empty initialized state must be returned');
    assert.strictEqual(loaded.systemInitialized, true, 'systemInitialized must remain true');
    assert.strictEqual(loaded.SYSTEM_INITIALIZED, true, 'SYSTEM_INITIALIZED must remain true');
    assert(Array.isArray(loaded.accounts) && loaded.accounts.length === 0, 'Accounts array must remain empty []');
  });

  await verifyAsync('Test 1.3: SYSTEM_INITIALIZED is persisted synchronously before async operations complete (race condition immunity)', async () => {
    const { localStorage } = createMockBrowserStorageEnv();
    const db = new PfmLocalDatabase();
    assert.strictEqual(localStorage.getItem('SYSTEM_INITIALIZED'), null, 'Initially null on clean storage');

    // Do not await saveFullState before checking synchronous flag
    const savePromise = db.saveFullState({ accounts: [{ id: 'bank-a', currentBalance: 500 }], transactions: [] });
    assert.strictEqual(localStorage.getItem('SYSTEM_INITIALIZED'), 'true', 'SYSTEM_INITIALIZED set synchronously before async Promise resolves');
    await savePromise;
  });

  await verifyAsync('Test 1.5: Legacy v2.0 dummy seed accounts cached on phone from older APK build are automatically purged on load', async () => {
    const { localStorage } = createMockBrowserStorageEnv();
    const legacyV2PhonePayload = {
      accounts: [
        { id: 'bank-a', nameEn: 'Bank A (Maybank Main CASA)', currentBalance: 180 },
        { id: 'bank-b', nameEn: 'Bank B (CIMB Reserve CASA)', currentBalance: 1500 },
        { id: 'gxbank', nameEn: 'GXBank Daily Interest Account', currentBalance: 3650 },
        { id: 'tng-ewallet', nameEn: "Touch 'n Go eWallet", currentBalance: 150 },
        { id: 'tng-nfc', nameEn: "Touch 'n Go NFC Card", currentBalance: 6.5 },
        { id: 'asnb-fixed', nameEn: 'ASNB ASM Fixed-Price Fund', currentBalance: 13000 },
        { id: 'spaylater', nameEn: 'SPayLater (Shopee BNPL)', currentBalance: 100 },
        { id: 'cc-visa', nameEn: 'Maybank Visa Cashback Card', currentBalance: 320 },
        { id: 'income-salary', nameEn: 'Primary Employer Net Salary', currentBalance: 5000 }
      ],
      transactions: [{ id: 'tx-1' }, { id: 'tx-2' }, { id: 'tx-3' }],
      installmentPlans: [{ id: 'plan-spay-1' }],
      reimbursements: [{ id: 'reimb-1' }],
      asnbSnapshots: [{ id: 'snap-2026-10' }]
    };
    localStorage.setItem('mypfm_data_v2', JSON.stringify(legacyV2PhonePayload));

    const db = new PfmLocalDatabase();
    const loaded = await db.loadFullState();
    assert.strictEqual(loaded.accounts.length, 0, 'All 9 leftover v2.0 dummy accounts must be purged automatically');
    assert.strictEqual(loaded.transactions.length, 0, 'All leftover v2.0 dummy transactions must be purged');
    assert.strictEqual(loaded.installmentPlans.length, 0, 'All leftover v2.0 dummy installment plans must be purged');
  });

  verify('Test 1.4: Editing or deleting an account cascades linked transactions, installments, and snapshots cleanly without crashing Dashboard Roll-Up', () => {
    createMockBrowserStorageEnv();
    const state = Engine.buildDemoData({ catalog: Catalog, today: '2026-10-20' });
    const gxAcc = state.accounts.find(a => a.catalogCode === 'GXBANK');
    const spayAcc = state.accounts.find(a => a.catalogCode === 'SPAYLATER');
    assert(gxAcc && spayAcc, 'Demo GXBank and SPayLater exist');

    state.asnbSnapshots.push({ id: 'snap-test', accountId: gxAcc.id, lowestMonthlyBalance: 100 });

    // Edit account first
    const updated = Engine.updateAccountSettings(state, gxAcc.id, {
      nameEn: 'GXBank Edited',
      currentBalance: 4000
    }, { today: '2026-10-20' });
    assert.strictEqual(updated.nameEn, 'GXBank Edited');
    assert.strictEqual(updated.currentBalance, 4000);

    // Delete account with CASCADE
    Engine.deleteAccount(state, gxAcc.id, { mode: 'CASCADE', today: '2026-10-20' });
    assert(!state.accounts.some(a => a.id === gxAcc.id), 'Account removed');
    assert(!state.transactions.some(t => t.fromAccountId === gxAcc.id || t.toAccountId === gxAcc.id), 'Linked transactions cascaded');
    assert(!state.asnbSnapshots.some(s => s.accountId === gxAcc.id), 'Linked snapshots cascaded');

    // Delete liability account and verify its installment plans cascade
    Engine.deleteAccount(state, spayAcc.id, { mode: 'CASCADE', today: '2026-10-20' });
    assert.strictEqual(state.installmentPlans.filter(p => p.liabilityAccountId === spayAcc.id).length, 0, 'Linked installment plans cascaded');

    // Verify Roll-Up KPIs have no NaN
    const rollup = Engine.computeRollup(state, { today: '2026-10-20' });
    const yieldMetrics = Engine.computeYieldMetrics(state, '2026-10-20');
    assert(!Number.isNaN(rollup.netWorth), 'Rollup netWorth is not NaN');
    assert(!Number.isNaN(rollup.dsrPercent), 'Rollup dsrPercent is not NaN');
    assert(!Number.isNaN(yieldMetrics.todayReturn), 'Yield todayReturn is not NaN');
  });

  // =========================================================================
  // 2. DOUBLE-ENTRY LEDGER & BALANCE REVERSAL AUDIT
  // =========================================================================
  console.log('\n--- 2. DOUBLE-ENTRY LEDGER & BALANCE REVERSAL AUDIT ---');

  verify('Bug Check 2.A (Transfer Atomicity with TransferFee): Transfer RM 200 Bank A -> ASNB with RM 1.00 fee -> Bank A -201, ASNB +200, Monthly Expenses +1.00 only', () => {
    const state = Engine.createEmptyData();
    Engine.createAccount(state, { id: 'bank-a', pillar: 'ASSET_LIQUID', nameEn: 'Bank A', currentBalance: 1000 }, { today: '2026-10-15' });
    Engine.createAccount(state, { id: 'asnb-1', pillar: 'ASSET_INVESTMENT', nameEn: 'ASNB ASM', currentBalance: 5000, interestMethod: 'LOWEST_MONTHLY_BALANCE', annualRate: 5.0 }, { today: '2026-10-15' });

    const tx = Engine.postTransaction(state, {
      type: 'TRANSFER',
      date: '2026-10-15',
      amount: 200,
      transferFee: 1.00,
      fromAccountId: 'bank-a',
      toAccountId: 'asnb-1',
      note: 'Transfer to ASNB with RM 1 fee'
    }, { today: '2026-10-15' });

    const bankA = state.accounts.find(a => a.id === 'bank-a');
    const asnb = state.accounts.find(a => a.id === 'asnb-1');
    const rollup = Engine.computeRollup(state, { today: '2026-10-15' });

    assert.strictEqual(bankA.currentBalance, 799.00, 'Bank A must decrease by RM 201.00 (1000 -> 799)');
    assert.strictEqual(asnb.currentBalance, 5200.00, 'ASNB must increase by RM 200.00 (5000 -> 5200)');
    assert.strictEqual(rollup.monthSpend, 1.00, 'Monthly Expenses must only increase by RM 1.00 (the transfer fee), NOT RM 201.00');
    assert.strictEqual(tx.personalAmount, 1.00, 'Transfer personalAmount tracks only the RM 1.00 fee');
  });

  verify('Bug Check 2.B & 2.C (Edit Mutation & Delete Reversal): Expense RM 20 on Bank A (500->480), Edit to RM 35 on Touch \'n Go eWallet (Bank A->500, TnG -35), Delete RM 35 Expense (TnG restored)', () => {
    const state = Engine.createEmptyData();
    Engine.createAccount(state, { id: 'bank-a', pillar: 'ASSET_LIQUID', nameEn: 'Bank A', currentBalance: 500 }, { today: '2026-10-16' });
    Engine.createAccount(state, { id: 'tng-ewallet', pillar: 'ASSET_LIQUID', nameEn: "Touch 'n Go eWallet", currentBalance: 200 }, { today: '2026-10-16' });

    // Step 1: Create Expense of RM 20 on Bank A
    const tx = Engine.postTransaction(state, {
      type: 'EXPENSE',
      date: '2026-10-16',
      amount: 20,
      fromAccountId: 'bank-a',
      categoryId: 'cat-food',
      note: 'Lunch'
    }, { today: '2026-10-16' });
    assert.strictEqual(state.accounts.find(a => a.id === 'bank-a').currentBalance, 480.00, 'Bank A is 480 after RM 20 expense');
    assert.strictEqual(state.accounts.find(a => a.id === 'tng-ewallet').currentBalance, 200.00, 'TnG eWallet untouched at 200');

    // Step 2 (Bug Check B): Edit that same Expense to RM 35 and change account from Bank A to Touch 'n Go eWallet
    Engine.editTransaction(state, tx.id, {
      amount: 35,
      fromAccountId: 'tng-ewallet'
    }, { today: '2026-10-16' });
    assert.strictEqual(state.accounts.find(a => a.id === 'bank-a').currentBalance, 500.00, 'Bank A refunded back to RM 500.00');
    assert.strictEqual(state.accounts.find(a => a.id === 'tng-ewallet').currentBalance, 165.00, 'TnG eWallet deducted by RM 35.00 (200 -> 165)');

    // Step 3 (Bug Check C): Delete the RM 35 Expense and verify TnG eWallet returns to its exact original balance
    Engine.deleteTransaction(state, tx.id, { today: '2026-10-16' });
    assert.strictEqual(state.accounts.find(a => a.id === 'tng-ewallet').currentBalance, 200.00, 'TnG eWallet restored to exact original RM 200.00');
    assert.strictEqual(state.accounts.find(a => a.id === 'bank-a').currentBalance, 500.00, 'Bank A remains RM 500.00');
  });

  verify('Bug Check 2.D (Reclassify Expense -> Transfer & Edit Batch Installment Payment in History Inspector)', () => {
    const state = Engine.createEmptyData();
    Engine.createAccount(state, { id: 'bank-a', pillar: 'ASSET_LIQUID', nameEn: 'Bank A', currentBalance: 1000 }, { today: '2026-11-10' });
    Engine.createAccount(state, { id: 'bank-b', pillar: 'ASSET_LIQUID', nameEn: 'Bank B', currentBalance: 500 }, { today: '2026-11-10' });
    Engine.createAccount(state, { id: 'spaylater', pillar: 'LIABILITY', nameEn: 'SPayLater', currentBalance: 0 }, { today: '2026-11-10' });

    // 1. Create an Expense of RM 100 on Bank A (1000 -> 900), then reclassify it to a Transfer from Bank A -> Bank B (RM 100)
    const expTx = Engine.postTransaction(state, {
      type: 'EXPENSE',
      fromAccountId: 'bank-a',
      amount: 100,
      date: '2026-11-10',
      note: 'Misclassified transfer'
    }, { today: '2026-11-10' });
    assert.strictEqual(state.accounts.find(a => a.id === 'bank-a').currentBalance, 900.00);
    assert.strictEqual(state.accounts.find(a => a.id === 'bank-b').currentBalance, 500.00);

    const reclassified = Engine.editTransaction(state, expTx.id, {
      type: 'TRANSFER',
      fromAccountId: 'bank-a',
      toAccountId: 'bank-b',
      amount: 100,
      transferFee: 0
    }, { today: '2026-11-10' });
    assert.strictEqual(reclassified.type, 'TRANSFER', 'Transaction reclassified to TRANSFER');
    assert.strictEqual(state.accounts.find(a => a.id === 'bank-a').currentBalance, 900.00, 'Bank A remains 900 (-100)');
    assert.strictEqual(state.accounts.find(a => a.id === 'bank-b').currentBalance, 600.00, 'Bank B increased to 600 (+100)');
    assert.strictEqual(Engine.computeRollup(state, { today: '2026-11-10' }).monthSpend, 0.00, 'Monthly expense is now RM 0.00 after reclassifying to transfer');

    // 2. Create a batch installment payment on Bank A, then edit it in History to pay from Bank B instead
    Engine.createManualMonthlyInstallment(state, {
      liabilityAccountId: 'spaylater',
      itemName: 'Nov SPayLater Bill',
      amount: 80.00,
      dueDate: '2026-11-10'
    }, { today: '2026-11-10' });
    const batchPayTx = Engine.payInstallmentsBatch(state, {
      fromAccountId: 'bank-a',
      liabilityAccountId: 'spaylater',
      mode: 'CURRENT',
      ym: '2026-11',
      date: '2026-11-10'
    }, { today: '2026-11-10' });
    assert.strictEqual(state.accounts.find(a => a.id === 'bank-a').currentBalance, 820.00, 'Bank A paid RM 80 (900 -> 820)');
    assert.strictEqual(state.accounts.find(a => a.id === 'spaylater').currentBalance, 0.00, 'SPayLater settled to RM 0');

    Engine.editTransaction(state, batchPayTx.id, {
      fromAccountId: 'bank-b',
      amount: 80.00
    }, { today: '2026-11-10' });
    assert.strictEqual(state.accounts.find(a => a.id === 'bank-a').currentBalance, 900.00, 'Bank A refunded back to 900');
    assert.strictEqual(state.accounts.find(a => a.id === 'bank-b').currentBalance, 520.00, 'Bank B deducted by 80 (600 -> 520)');
    assert.strictEqual(state.accounts.find(a => a.id === 'spaylater').currentBalance, 0.00, 'SPayLater remains settled at RM 0');
  });

  // =========================================================================
  // 3. SPAYLATER & INSTALLMENT ENGINE EDGE-CASE TEST
  // =========================================================================
  console.log('\n--- 3. SPAYLATER & INSTALLMENT ENGINE EDGE-CASE TEST ---');

  verify('Test 3.1 (Penny-Rounding Accuracy): Split RM 100.00 across 3 months -> [33.33, 33.33, 33.34], exact sum = 100.00', () => {
    const slices = Engine.splitPrincipal(100.00, 3);
    assert.deepStrictEqual(slices, [33.33, 33.33, 33.34], 'Slices must be 33.33, 33.33, 33.34');
    const sum = Number(slices.reduce((a, b) => a + b, 0).toFixed(2));
    assert.strictEqual(sum, 100.00, 'Sum of slices must equal exact RM 100.00');
  });

  verify('Test 3.2, 3.3, 3.4 (Stacking Plans, Batch Repayment, Duplicate Payment Block, & Delete Repayment Reversal)', () => {
    const state = Engine.createEmptyData();
    Engine.createAccount(state, { id: 'bank-a', pillar: 'ASSET_LIQUID', nameEn: 'Bank A', currentBalance: 500.00 }, { today: '2026-10-15' });
    Engine.createAccount(state, { id: 'spaylater', pillar: 'LIABILITY', nameEn: 'SPayLater', currentBalance: 0.00 }, { today: '2026-10-15' });

    const currentYm = '2026-10';

    // Test 3.2: Add 3-month RM 150 plan (RM 50/mo) AND a manual RM 85.50 entry for current month under SPayLater
    const txA = Engine.createInstallmentPurchase(state, {
      liabilityAccountId: 'spaylater',
      itemName: 'Headphones 3M',
      totalPrincipal: 150.00,
      tenureMonths: 3,
      monthlyFee: 0,
      startDate: '2026-10-15',
      dueDay: 10
    }, { today: '2026-10-15' });

    const txB = Engine.createManualMonthlyInstallment(state, {
      liabilityAccountId: 'spaylater',
      itemName: 'Manual Bill Entry',
      amount: 85.50,
      dueDate: '2026-10-15'
    }, { today: '2026-10-15' });

    const planA = state.installmentPlans.find(p => p.id === txA.planId);
    const planB = state.installmentPlans.find(p => p.id === txB.planId);

    const spayAcc = state.accounts.find(a => a.id === 'spaylater');
    const dueBefore = Engine.getDueInstallments(state, 'spaylater', currentYm);
    assert.strictEqual(spayAcc.currentBalance, 235.50, 'Total Debt must be RM 235.50');
    assert.strictEqual(dueBefore.totalDue, 135.50, 'Current Month Due must be RM 135.50 (50.00 + 85.50)');

    // Test 3.3: Execute "Pay This Month's Installment" (RM 135.50) from Bank A -> SPayLater
    const payTx = Engine.payInstallmentsBatch(state, {
      fromAccountId: 'bank-a',
      liabilityAccountId: 'spaylater',
      mode: 'MONTH',
      ym: currentYm,
      date: '2026-10-18'
    }, { today: '2026-10-18' });

    assert.strictEqual(payTx.amount, 135.50, 'Paid RM 135.50');
    assert.strictEqual(state.accounts.find(a => a.id === 'bank-a').currentBalance, 364.50, 'Bank A decreased by RM 135.50 (500 -> 364.50)');
    assert.strictEqual(state.accounts.find(a => a.id === 'spaylater').currentBalance, 100.00, 'SPayLater total debt dropped to RM 100.00');
    assert.strictEqual(planA.schedules[0].status, 'PAID', 'Plan A Slice #1 marked PAID');
    assert.strictEqual(planB.schedules[0].status, 'PAID', 'Plan B Slice #1 marked PAID');

    const dueAfterPay = Engine.getDueInstallments(state, 'spaylater', currentYm);
    assert.strictEqual(dueAfterPay.totalDue, 0.00, 'Current Month Due is now RM 0.00');

    // Verify paying a second time for the current month is blocked (throws NOTHING_OUTSTANDING)
    assert.throws(() => {
      Engine.payInstallmentsBatch(state, {
        fromAccountId: 'bank-a',
        liabilityAccountId: 'spaylater',
        mode: 'MONTH',
        ym: currentYm,
        date: '2026-10-18'
      }, { today: '2026-10-18' });
    }, /NOTHING_OUTSTANDING/, 'Second payment attempt for same month is blocked with NOTHING_OUTSTANDING');

    // Test 3.4: Delete the repayment transaction -> verify schedule rows revert from PAID back to UNPAID and liability restores to RM 235.50
    Engine.deleteTransaction(state, payTx.id, { today: '2026-10-18' });
    const restoredPlanA = state.installmentPlans.find(p => p.id === txA.planId);
    const restoredPlanB = state.installmentPlans.find(p => p.id === txB.planId);
    assert.strictEqual(state.accounts.find(a => a.id === 'bank-a').currentBalance, 500.00, 'Bank A restored to RM 500.00');
    assert.strictEqual(state.accounts.find(a => a.id === 'spaylater').currentBalance, 235.50, 'SPayLater restored to RM 235.50');
    assert.strictEqual(restoredPlanA.schedules[0].status, 'UNPAID', 'Plan A Slice #1 reverted to UNPAID');
    assert.strictEqual(restoredPlanB.schedules[0].status, 'UNPAID', 'Plan B Slice #1 reverted to UNPAID');
    assert.strictEqual(restoredPlanB.status, 'ACTIVE', 'Plan B status reverted from COMPLETED back to ACTIVE');
  });

  verify('Test 3.5 (Module 1 - Edit Existing InstallmentPlan & Individual Monthly Bill Row with Automatic Liability Recalculation)', () => {
    const state = Engine.createEmptyData();
    Engine.createAccount(state, { id: 'bank-a', pillar: 'ASSET_LIQUID', nameEn: 'Bank A', currentBalance: 1000.00 }, { today: '2026-11-01' });
    Engine.createAccount(state, { id: 'spaylater', pillar: 'LIABILITY', nameEn: 'SPayLater', currentBalance: 0.00 }, { today: '2026-11-01' });

    // Create 3-month RM 150 SPayLater plan (Nov, Dec, Jan = RM 50.00 each)
    const tx = Engine.createInstallmentPurchase(state, {
      liabilityAccountId: 'spaylater',
      itemName: 'Shopee Monitor',
      totalPrincipal: 150.00,
      tenureMonths: 3,
      monthlyFee: 0,
      startDate: '2026-11-01',
      dueDay: 10
    }, { today: '2026-11-01' });
    const plan = state.installmentPlans.find(p => p.id === tx.planId);
    const spay = state.accounts.find(a => a.id === 'spaylater');
    assert.strictEqual(spay.currentBalance, 150.00, 'Initial SPayLater balance is RM 150.00');

    // 1. Edit December's individual bill row (Slice #2) from RM 50.00 to RM 85.00 (+RM 35.00) and add notes
    const decSliceId = plan.schedules[1].id;
    Engine.editInstallmentScheduleRow(state, plan.id, decSliceId, {
      amountDue: 85.00,
      dueDate: '2026-12-12',
      notes: 'Added December promo adjustment +RM 35',
      status: 'PENDING'
    }, { today: '2026-11-01' });

    assert.strictEqual(plan.schedules[1].amount, 85.00, 'December bill updated to RM 85.00');
    assert.strictEqual(plan.schedules[1].dueDate, '2026-12-12', 'December due date updated to 2026-12-12');
    assert.strictEqual(plan.schedules[1].notes, 'Added December promo adjustment +RM 35', 'December notes saved');
    assert.strictEqual(spay.currentBalance, 185.00, 'Parent SPayLater balance automatically recalculated to RM 185.00 (+RM 35.00)');

    // 2. Edit November's individual bill row (Slice #1) status from PENDING to PAID -> SPayLater drops by RM 50.00 to RM 135.00
    Engine.editInstallmentScheduleRow(state, plan.id, plan.schedules[0].id, {
      status: 'PAID'
    }, { today: '2026-11-10' });
    assert.strictEqual(spay.currentBalance, 135.00, 'Marking Nov slice PAID reduces SPayLater balance to RM 135.00');

    // 3. Edit the parent InstallmentPlan metadata & linked auto-debit account
    Engine.editInstallmentPlan(state, plan.id, {
      itemName: 'Shopee 4K Monitor Pro',
      dueDay: 15,
      linkedRepaymentAccountId: 'bank-a'
    }, { today: '2026-11-10' });
    assert.strictEqual(plan.itemName, 'Shopee 4K Monitor Pro');
    assert.strictEqual(plan.dueDay, 15);
    assert.strictEqual(plan.linkedRepaymentAccountId, 'bank-a');

    // 4. Delete the January bill slice (Slice #3, RM 50.00 UNPAID) -> SPayLater drops from RM 135.00 to RM 85.00
    Engine.deleteInstallmentScheduleRow(state, plan.id, plan.schedules[2].id);
    assert.strictEqual(plan.schedules.length, 2, '2 slices remain');
    assert.strictEqual(spay.currentBalance, 85.00, 'SPayLater balance automatically drops to RM 85.00');

    // 5. Delete the entire InstallmentPlan -> SPayLater drops to RM 0.00
    Engine.deleteInstallmentPlan(state, plan.id);
    assert.strictEqual(state.installmentPlans.length, 0, 'Plan deleted');
    assert.strictEqual(spay.currentBalance, 0.00, 'SPayLater balance recalculated to RM 0.00');
  });

  // =========================================================================
  // 4. UNIVERSAL YIELD ENGINE & ASNB DIVIDEND MATH VERIFICATION
  // =========================================================================
  console.log('\n--- 4. UNIVERSAL YIELD ENGINE & ASNB DIVIDEND MATH VERIFICATION ---');

  verify('Bug Check 4.A (ASNB Lowest Balance Logic): Day 1 RM 5,000 -> Day 5 +RM 1,000 (Bal 6,000) -> Day 20 -RM 500 (Bal 5,500) => Lowest remains RM 5,000; Day 25 -RM 2,000 (Bal 3,500) => Lowest drops to RM 3,500', () => {
    const state = Engine.createEmptyData();
    Engine.createAccount(state, {
      id: 'bank-a',
      pillar: 'ASSET_LIQUID',
      nameEn: 'Bank A',
      currentBalance: 10000
    }, { today: '2026-10-01' });
    const asnb = Engine.createAccount(state, {
      id: 'asnb-fixed',
      pillar: 'ASSET_INVESTMENT',
      nameEn: 'ASNB ASM',
      currentBalance: 5000,
      lowestMonthlyBalance: 5000,
      interestMethod: 'LOWEST_MONTHLY_BALANCE',
      annualRate: 5.0
    }, { today: '2026-10-01' });

    // Day 5: Deposit RM 1,000 (Balance = RM 6,000)
    Engine.postTransaction(state, {
      type: 'TRANSFER',
      date: '2026-10-05',
      amount: 1000,
      fromAccountId: 'bank-a',
      toAccountId: 'asnb-fixed',
      note: 'Day 5 Deposit'
    }, { today: '2026-10-05' });
    assert.strictEqual(asnb.currentBalance, 6000);
    assert.strictEqual(asnb.lowestMonthlyBalance, 5000, 'After Day 5 deposit (+1000), lowestMonthlyBalance must remain RM 5,000');

    // Day 20: Withdraw RM 500 (Balance = RM 5,500)
    Engine.postTransaction(state, {
      type: 'TRANSFER',
      date: '2026-10-20',
      amount: 500,
      fromAccountId: 'asnb-fixed',
      toAccountId: 'bank-a',
      note: 'Day 20 Withdrawal'
    }, { today: '2026-10-20' });
    assert.strictEqual(asnb.currentBalance, 5500);
    assert.strictEqual(asnb.lowestMonthlyBalance, 5000, 'After Day 20 withdrawal (-500 to 5,500), lowestMonthlyBalance must STILL remain RM 5,000 (NOT 5,500 or 6,000)');

    // Day 25: Withdraw RM 2,000 (Balance = RM 3,500)
    Engine.postTransaction(state, {
      type: 'TRANSFER',
      date: '2026-10-25',
      amount: 2000,
      fromAccountId: 'asnb-fixed',
      toAccountId: 'bank-a',
      note: 'Day 25 Withdrawal'
    }, { today: '2026-10-25' });
    assert.strictEqual(asnb.currentBalance, 3500);
    assert.strictEqual(asnb.lowestMonthlyBalance, 3500, 'After Day 25 withdrawal (-2000 to 3,500), lowestMonthlyBalance must drop to RM 3,500');
  });

  verify('Bug Check 4.B (Lazy Catch-Up Calculation): 5 days of inactivity on DAILY_COMPOUND (3.0% p.a. on RM 10,000) accrues exact 5 days once, and 0 when reopened 10 minutes later', () => {
    const state = Engine.createEmptyData();
    const ryt = Engine.createAccount(state, {
      id: 'ryt-bank',
      pillar: 'ASSET_LIQUID',
      nameEn: 'Ryt Bank',
      currentBalance: 10000,
      interestMethod: 'DAILY_COMPOUND',
      annualRate: 3.0,
      autoAccrueInterest: true,
      interestLastAccruedDate: '2026-10-15'
    }, { today: '2026-10-15' });

    // Simulate opening app 5 days later on 2026-10-20
    const res1 = Engine.runCatchUp(state, { today: '2026-10-20' });
    assert.strictEqual(res1.interest.length, 1, 'Accrued 1 catch-up entry');
    assert.strictEqual(res1.interest[0].days, 5, 'Accrued exactly 5 days of interest');
    const expectedExact = 5 * (10000 * (0.03 / 365)); // 4.10958904109589
    assert(Math.abs(res1.interest[0].exactAmount - expectedExact) < 1e-9, 'Exact 5-day interest matches formula');
    assert.strictEqual(res1.interest[0].amount, 4.11, 'Posted cent-rounded amount is RM 4.11');
    assert.strictEqual(ryt.currentBalance, 10004.11, 'Balance updated to RM 10,004.11');

    // Simulate closing and reopening the app 10 minutes later on the same day (2026-10-20)
    const res2 = Engine.runCatchUp(state, { today: '2026-10-20' });
    assert.strictEqual(res2.interest.length, 0, 'Zero double-counting on same day reopen');
    assert.strictEqual(ryt.currentBalance, 10004.11, 'Balance remains RM 10,004.11');
  });

  verify('Bug Check 4.C (Tiered Rate Math): DYNAMIC_TIERED_RATE (First RM 20k @ 3.8%, >RM 20k @ 3.0%) with RM 25,000 -> blended daily yield = (20000*0.038/365) + (5000*0.030/365)', () => {
    const state = Engine.createEmptyData();
    Engine.createAccount(state, {
      id: 'tiered-bank',
      pillar: 'ASSET_LIQUID',
      nameEn: 'Ryt Bank Tiered',
      currentBalance: 25000,
      interestMethod: 'DYNAMIC_TIERED_RATE',
      tiers: [
        { upTo: 20000, rate: 3.8 },
        { upTo: null, rate: 3.0 }
      ]
    }, { today: '2026-10-20' });

    const metrics = Engine.computeYieldMetrics(state, '2026-10-20');
    const expectedExactDaily = (20000 * 0.038 / 365) + (5000 * 0.030 / 365); // 2.493150684931507
    assert(Math.abs(metrics.exactDailyYield - expectedExactDaily) < 1e-9, `Exact daily yield ${metrics.exactDailyYield} must equal ${expectedExactDaily}`);
    assert.strictEqual(metrics.todayReturn, 2.49, 'Rounded daily return is RM 2.49');
  });

  // =========================================================================
  // 5. GUARDRAIL ALERTS & NOTIFICATION PARSER COLLISION TEST
  // =========================================================================
  console.log('\n--- 5. GUARDRAIL ALERTS & NOTIFICATION PARSER COLLISION TEST ---');

  verify('Test 5.1 (Static Floor): Deduct Touch \'n Go NFC Card from RM 12.00 to RM 8.50 (Limit: RM 10.00) -> triggers high-priority low-balance alert', () => {
    const state = Engine.createEmptyData();
    Engine.createAccount(state, {
      id: 'tng-nfc',
      pillar: 'ASSET_LIQUID',
      nameEn: "Touch 'n Go NFC Card",
      currentBalance: 12.00,
      minBalanceLimit: 10.00
    }, { today: '2026-10-20' });

    Engine.postTransaction(state, {
      type: 'EXPENSE',
      date: '2026-10-20',
      amount: 3.50,
      fromAccountId: 'tng-nfc',
      note: 'DUKE Highway Toll'
    }, { today: '2026-10-20' });

    const tngNfc = state.accounts.find(a => a.id === 'tng-nfc');
    assert.strictEqual(tngNfc.currentBalance, 8.50, 'TnG NFC balance dropped to RM 8.50');

    const alerts = Engine.evaluateGuardrails(state, { today: '2026-10-20' });
    const floorAlert = alerts.find(a => a.ruleCode === 'RULE_A_STATIC_FLOOR' && a.accountId === 'tng-nfc');
    assert(floorAlert, 'RULE_A_STATIC_FLOOR alert must trigger immediately');
    assert.strictEqual(floorAlert.severity, 'HIGH', 'Alert severity must be HIGH');
    assert.strictEqual(floorAlert.shortfall, 1.50, 'Shortfall below RM 10.00 floor is RM 1.50');
  });

  verify('Test 5.2 (Auto-Debit Look-Ahead + Donor Bank Suggestion): Bank A RM 210.00 with RM 250.00 Insurance Auto-Debit due in 5 days + Bank B RM 1,500.00 -> recommends transferring at least RM 40.00 from Bank B to Bank A', () => {
    const state = Engine.createEmptyData();
    Engine.createAccount(state, {
      id: 'bank-a',
      pillar: 'ASSET_LIQUID',
      nameEn: 'Bank A',
      currentBalance: 210.00,
      minBalanceLimit: 0,
      autoDebits: [
        { id: 'ad-ins', nameEn: 'Insurance Auto-Debit', nameZh: '保险自动扣款', amount: 250.00, dueInDays: 5 }
      ]
    }, { today: '2026-10-20' });
    Engine.createAccount(state, {
      id: 'bank-b',
      pillar: 'ASSET_LIQUID',
      nameEn: 'Bank B',
      currentBalance: 1500.00,
      minBalanceLimit: 0
    }, { today: '2026-10-20' });

    const alerts = Engine.evaluateGuardrails(state, { today: '2026-10-20' });
    const ruleB = alerts.find(a => a.ruleCode === 'RULE_B_AUTODEBIT_DONOR_MATCH' && a.accountId === 'bank-a');
    assert(ruleB, 'RULE_B_AUTODEBIT_DONOR_MATCH alert must trigger');
    assert.strictEqual(ruleB.shortfall, 40.00, 'Minimum shortfall to cover RM 250.00 auto-debit from RM 210.00 is RM 40.00');
    assert.strictEqual(ruleB.donorAccountId, 'bank-b', 'Donor bank must be Bank B');
    assert(ruleB.body.includes('RM 40.00') && ruleB.body.includes('Bank B') && ruleB.body.includes('Bank A'), 'Alert message explicitly recommends transferring RM 40.00 from Bank B to Bank A');
  });

  verify('Test 5.3 (Notification Anti-Spam, Deduplication, Promo Ignore, & TnG NFC Reload Transfer Detection)', () => {
    const state = Engine.createEmptyData();
    Engine.createAccount(state, {
      id: 'tng-ewallet',
      pillar: 'ASSET_LIQUID',
      catalogCode: 'TNG_EWALLET',
      nameEn: "Touch 'n Go eWallet",
      currentBalance: 200.00,
      androidPackages: ['my.com.tngdigital.ewallet']
    }, { today: '2026-10-20' });
    Engine.createAccount(state, {
      id: 'tng-nfc',
      pillar: 'ASSET_LIQUID',
      catalogCode: 'TNG_NFC',
      nameEn: "Touch 'n Go NFC Card",
      currentBalance: 10.00
    }, { today: '2026-10-20' });

    const baseTs = 1760950000000;

    // 1. Valid TnG eWallet payment ("You have paid RM 15.00 to 99 SPEEDMART") -> deducts RM 15.00 once
    const n1 = Engine.ingestNotification(state, {
      packageName: 'my.com.tngdigital.ewallet',
      title: 'Payment Successful',
      text: 'You have paid RM 15.00 to 99 SPEEDMART',
      postedAt: baseTs
    }, { today: '2026-10-20', catalog: Catalog });
    assert.strictEqual(n1.status, 'POSTED', 'Notification 1 posted');
    assert.strictEqual(n1.txType, 'EXPENSE', 'Notification 1 recorded as EXPENSE');
    assert.strictEqual(state.accounts.find(a => a.id === 'tng-ewallet').currentBalance, 185.00, 'TnG eWallet deducted by RM 15.00 once (200 -> 185)');

    // 2. Exact same notification fired 2 seconds later -> BLOCKED by deduplication
    const n2 = Engine.ingestNotification(state, {
      packageName: 'my.com.tngdigital.ewallet',
      title: 'Payment Successful',
      text: 'You have paid RM 15.00 to 99 SPEEDMART',
      postedAt: baseTs + 2000
    }, { today: '2026-10-20', catalog: Catalog });
    assert.strictEqual(n2.status, 'DUPLICATE', 'Duplicate notification blocked');
    assert.strictEqual(state.accounts.find(a => a.id === 'tng-ewallet').currentBalance, 185.00, 'Balance unchanged at RM 185.00');

    // 3. Promo notification ("Spend RM 15 and get RM 3 cashback voucher!") -> IGNORED
    const n3 = Engine.ingestNotification(state, {
      packageName: 'my.com.tngdigital.ewallet',
      title: 'Cashback Promo',
      text: 'Spend RM 15 and get RM 3 cashback voucher!',
      postedAt: baseTs + 5000
    }, { today: '2026-10-20', catalog: Catalog });
    assert.strictEqual(n3.status, 'IGNORED_NON_TX', 'Promo notification ignored');
    assert.strictEqual(state.accounts.find(a => a.id === 'tng-ewallet').currentBalance, 185.00, 'Balance unchanged at RM 185.00');

    // 4. TnG NFC reload notification ("Successfully reloaded RM 50.00 to your Touch 'n Go card") -> creates TRANSFER from TnG eWallet to TnG NFC Card (NOT an Expense)
    const n4 = Engine.ingestNotification(state, {
      packageName: 'my.com.tngdigital.ewallet',
      title: 'SOS Balance / NFC Reload',
      text: "Successfully reloaded RM 50.00 to your Touch 'n Go card",
      postedAt: baseTs + 10000
    }, { today: '2026-10-20', catalog: Catalog });
    assert.strictEqual(n4.status, 'POSTED', 'TnG NFC Reload notification posted');
    assert.strictEqual(n4.txType, 'TRANSFER', 'Reload notification must create a TRANSFER (NOT an EXPENSE)');
    assert.strictEqual(n4.accountId, 'tng-ewallet', 'Source is TnG eWallet');
    assert.strictEqual(n4.toAccountId, 'tng-nfc', 'Destination is TnG NFC Card');
    assert.strictEqual(state.accounts.find(a => a.id === 'tng-ewallet').currentBalance, 135.00, 'TnG eWallet decreased by RM 50.00 (185 -> 135)');
    assert.strictEqual(state.accounts.find(a => a.id === 'tng-nfc').currentBalance, 60.00, 'TnG NFC Card increased by RM 50.00 (10 -> 60)');
  });

  verify('Test 5.4 (Smart Merchant Auto-Categorization + Self-Learning Notification Rules)', () => {
    const state = Engine.createEmptyData();
    Engine.createAccountFromCatalog(state, 'TNG_EWALLET', { currentBalance: 500 }, Catalog, { today: '2026-11-16' });
    const baseTs = 1763300000000;

    // 1. Built-in Malaysian Merchant Dictionary: 99 SPEEDMART -> cat-food, PETRONAS -> cat-transport
    const r1 = Engine.ingestNotification(state, {
      packageName: 'my.com.tngdigital.ewallet',
      title: 'Payment Successful',
      text: 'You have paid RM 14.20 to 99 SPEEDMART',
      postedAt: baseTs
    }, { today: '2026-11-16', catalog: Catalog });
    assert.strictEqual(r1.categoryId, 'cat-food', '99 SPEEDMART auto-categorized into cat-food');

    const r2 = Engine.ingestNotification(state, {
      packageName: 'my.com.tngdigital.ewallet',
      title: 'Payment Successful',
      text: 'You have paid RM 50.00 at PETRONAS SETEL',
      postedAt: baseTs + 5000
    }, { today: '2026-11-16', catalog: Catalog });
    assert.strictEqual(r2.categoryId, 'cat-transport', 'PETRONAS SETEL auto-categorized into cat-transport');

    // 2. Self-Learning Rule: Unknown merchant defaults to cat-other, user edits to cat-shopping -> next tx auto-matches cat-shopping
    const r3 = Engine.ingestNotification(state, {
      packageName: 'my.com.tngdigital.ewallet',
      title: 'Payment Successful',
      text: 'You have paid RM 25.00 to KEDAI BUKU BESTARI',
      postedAt: baseTs + 10000
    }, { today: '2026-11-16', catalog: Catalog });
    assert.strictEqual(r3.categoryId, Engine.OTHER_CATEGORY_ID, 'Unknown merchant starts in cat-other');

    Engine.editTransaction(state, r3.txId, { categoryId: 'cat-shopping', learnRule: true }, { today: '2026-11-16' });

    const r4 = Engine.ingestNotification(state, {
      packageName: 'my.com.tngdigital.ewallet',
      title: 'Payment Successful',
      text: 'You have paid RM 18.00 to KEDAI BUKU BESTARI',
      postedAt: baseTs + 15000
    }, { today: '2026-11-16', catalog: Catalog });
    assert.strictEqual(r4.categoryId, 'cat-shopping', 'Self-learned merchant rule automatically applies cat-shopping on next notification');
  });

  verify('Test 2.E & 6.2 (Split-Bill AA Settlement, LHDN Tax Tagging, Category CRUD, Analytics Runway, Recurring Bills & Salary+EPF)', () => {
    const state = Engine.createEmptyData();
    const bank = Engine.createAccount(state, {
      id: 'bank-main', pillar: 'ASSET_LIQUID', nameEn: 'Maybank Main', currentBalance: 2000,
      envelopes: [{ id: 'env-tech', nameEn: 'Tech Fund', allocated: 500, target: 1000 }]
    }, { today: '2026-11-16' });
    const epf = Engine.createAccountFromCatalog(state, 'EPF', { currentBalance: 10000 }, Catalog, { today: '2026-11-16' });

    // 1. Split Bill RM 120 (My share RM 40 + Ali owes RM 80) + LHDN Lifestyle + Envelope deduction
    const splitTx = Engine.postTransaction(state, {
      type: 'EXPENSE',
      fromAccountId: bank.id,
      amount: 120,
      personalAmount: 40,
      debtorName: 'Ali',
      envelopeId: 'env-tech',
      taxCategoryCode: 'LHDN_LIFESTYLE',
      categoryId: 'cat-shopping',
      note: 'Router & Keyboard',
      date: '2026-11-16'
    }, { today: '2026-11-16' });

    assert.strictEqual(bank.currentBalance, 1880.00, 'Bank decreased by full RM 120');
    assert.strictEqual(bank.envelopes[0].allocated, 380.00, 'Envelope decreased by RM 120 (500 -> 380)');
    assert.strictEqual(state.taxBuckets.find(b => b.code === 'LHDN_LIFESTYLE').claimed, 40.00, 'LHDN claimed RM 40 personal share');
    assert.strictEqual(state.reimbursements.length, 1, 'Reimbursement created automatically');
    assert.strictEqual(state.reimbursements[0].owedAmount, 80.00, 'Ali owes exact RM 80.00');

    // Settle Ali's RM 80 back into Maybank atomically
    Engine.settleReimbursement(state, state.reimbursements[0].id, bank.id, { today: '2026-11-16' });
    assert.strictEqual(bank.currentBalance, 1960.00, 'Bank credited RM 80.00 back from Ali');
    assert.strictEqual(state.reimbursements[0].settled, true, 'Reimbursement marked settled');
    const rollupAfterSettle = Engine.computeRollup(state, { today: '2026-11-16' });
    assert.strictEqual(rollupAfterSettle.monthSpend, 40.00, 'Monthly spend remains true personal RM 40');
    assert.strictEqual(rollupAfterSettle.monthIncome, 0.00, 'Reimbursement settlement does not falsely inflate earned monthIncome');

    // 2. Custom Category CRUD + reassign orphaned tx on delete
    const customCat = Engine.upsertCategory(state, { nameEn: 'Gadgets', nameZh: '数码', icon: '💻', budget: 500 });
    assert.strictEqual(customCat.budget, 500.00);
    Engine.editTransaction(state, splitTx.id, { categoryId: customCat.id }, { today: '2026-11-16' });
    Engine.deleteCategory(state, customCat.id);
    assert.strictEqual(Engine.findTx(state, splitTx.id).categoryId, Engine.OTHER_CATEGORY_ID, 'Deleted category reassigns transactions to Other');

    // 3. Recurring Bill & Malaysian Salary + EPF Auto-Credit
    const bill = Engine.upsertRecurringBill(state, { nameEn: 'Unifi', nameZh: 'Unifi', type: 'EXPENSE', amount: 100, dayOfMonth: 18, fromAccountId: bank.id, categoryId: 'cat-bills' });
    Engine.postRecurringBill(state, bill.id, { today: '2026-11-16', date: '2026-11-16' });
    assert.strictEqual(bank.currentBalance, 1860.00, 'Recurring Unifi RM 100 deducted');
    assert.strictEqual(Engine.getPendingRecurringBills(state, '2026-11-16').length, 0, 'Posted bill no longer pending for 2026-11');

    const payRes = Engine.creditSalaryWithEpf(state, {
      netSalary: 4000,
      grossSalary: 5000,
      toAccountId: bank.id,
      epfAccountId: epf.id,
      employeeEpfRate: 11,
      employerEpfRate: 13,
      date: '2026-11-25'
    }, { today: '2026-11-16' });
    assert.strictEqual(bank.currentBalance, 5860.00, 'Net Salary +RM 4,000 credited to bank');
    assert.strictEqual(payRes.epfContribution, 1200.00, 'EPF 24% of RM 5,000 = RM 1,200');
    assert.strictEqual(epf.currentBalance, 11200.00, 'EPF account increased by RM 1,200');

    // 4. Analytics & Emergency Runway
    const analytics = Engine.computeAnalytics(state, '2026-11-16');
    assert(analytics.emergencyRunwayMonths > 0 && Number.isFinite(analytics.emergencyRunwayMonths), 'Emergency runway calculated cleanly');
    assert.strictEqual(analytics.sixMonthCashflow.length, 6, '6-month cashflow series generated');
  });

  // =========================================================================
  // 6. UI / UX & ANGULAR REACTIVITY / ZERO-DIVISION AUDIT
  // =========================================================================
  console.log('\n--- 6. UI / UX & ANGULAR REACTIVITY AUDIT ---');

  verify('Test 6.1: DOM & Engine Zero-State Audit (0 Income DSR %, 0 Budget Category, 0 Tax Cap, 0 Transactions, 0 Accounts -> zero NaN/Infinity)', () => {
    const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');

    // Verify no unguarded division-by-zero patterns exist in index.html
    assert(html.includes('state.netMonthlyIncome > 0 ? ((monthlyInstCommitment / state.netMonthlyIncome) * 100).toFixed(2) : \'0.00\''), 'DSR % guards against netMonthlyIncome === 0');
    assert(html.includes('c.budget > 0 ? Math.min(100, Math.round((totalCommitted / c.budget) * 100)) : 0'), 'Category budget % guards against c.budget === 0');
    assert(html.includes('b.cap > 0 ? Math.min(100, Math.round((b.claimed / b.cap) * 100)) : 0'), 'Tax bucket % guards against b.cap === 0');
    assert(html.includes('function evaluateLocalizedAlerts()'), 'evaluateLocalizedAlerts() is defined in index.html');
    assert(html.includes('function todayStr('), 'todayStr() is defined in global scope of index.html');
    assert(html.includes('if (!Number.isFinite(amt) || amt <= 0)'), 'Numpad form blocks 0 or negative transaction amounts');
    assert(html.includes('id="tx-confirmation-modal"'), 'Pre-submission confirmation modal exists in index.html');
    assert(html.includes('id="view-history"'), 'Dedicated Transaction History view exists in index.html');
    assert(html.includes('id="edit-installment-plan-modal"'), 'Edit Installment Plan modal exists in index.html');
    assert(html.includes('id="edit-schedule-bill-modal"'), 'Edit Monthly Bill modal exists in index.html');
    assert(html.includes('id="tx-inspect-modal"'), 'Historical Transaction Inspect/Edit/Delete modal exists in index.html');
    assert(html.includes('id="analytics-visual-row"'), 'Visual Analytics SVG charts exist in index.html');
    assert(html.includes('id="btn-privacy-toggle"'), 'Privacy blur toggle exists in index.html');
    assert(html.includes('id="category-edit-modal"'), 'Category CRUD modal exists in index.html');
    assert(html.includes('id="recurring-bill-modal"'), 'Recurring Bill modal exists in index.html');
    assert(html.includes('id="salary-credit-modal"'), 'Salary & EPF credit modal exists in index.html');
    assert(html.includes('id="np-chk-split"'), 'Numpad Split Bill toggle exists in index.html');
    assert(html.includes('function simulatePaymentNotification('), 'Notification simulator exists in index.html');

    // Also test Engine.computeRollup on a completely empty state (0 income, 0 accounts, 0 transactions)
    const emptyState = Engine.createEmptyData();
    emptyState.netMonthlyIncome = 0;
    const rollup = Engine.computeRollup(emptyState, { today: '2026-10-20' });
    assert.strictEqual(rollup.dsrPercent, 0, 'Rollup DSR % is 0 when income is 0 (no NaN/Infinity)');
    assert.strictEqual(rollup.netWorth, 0, 'Rollup Net Worth is 0 when accounts are empty');
  });

  // =========================================================================
  // 7. BILINGUAL (en & zh-CN) KEY PARITY AUDIT
  // =========================================================================
  console.log('\n--- 7. BILINGUAL (en & zh-CN) KEY PARITY AUDIT ---');

  verify('Test 7.1: en.json and zh-CN.json have 100% key parity, non-empty values, and matching {{interpolation}} placeholder sets', () => {
    const enJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/assets/i18n/en.json'), 'utf8'));
    const zhJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/assets/i18n/zh-CN.json'), 'utf8'));

    function flatten(obj, prefix = '') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          Object.assign(out, flatten(v, key));
        } else {
          out[key] = v;
        }
      }
      return out;
    }

    const enFlat = flatten(enJson);
    const zhFlat = flatten(zhJson);
    const enKeys = Object.keys(enFlat).sort();
    const zhKeys = Object.keys(zhFlat).sort();

    const missingInZh = enKeys.filter(k => !(k in zhFlat));
    const missingInEn = zhKeys.filter(k => !(k in enFlat));

    assert.deepStrictEqual(missingInZh, [], `Keys missing in zh-CN.json: ${missingInZh.join(', ')}`);
    assert.deepStrictEqual(missingInEn, [], `Keys missing in en.json: ${missingInEn.join(', ')}`);

    for (const k of enKeys) {
      assert(typeof enFlat[k] === 'string' && enFlat[k].trim().length > 0, `Empty en.json value for ${k}`);
      assert(typeof zhFlat[k] === 'string' && zhFlat[k].trim().length > 0, `Empty zh-CN.json value for ${k}`);

      const enPlaceholders = Array.from(new Set(enFlat[k].match(/\{\{[^}]+\}\}/g) || [])).sort();
      const zhPlaceholders = Array.from(new Set(zhFlat[k].match(/\{\{[^}]+\}\}/g) || [])).sort();
      assert.deepStrictEqual(enPlaceholders, zhPlaceholders, `Placeholder mismatch in key ${k}: EN=${enPlaceholders} vs ZH=${zhPlaceholders}`);
    }
  });

  verify('Test 7.2: Inline I18N.en and I18N["zh-CN"] dictionaries in index.html have 100% key parity and all translate pipes in Angular templates exist in en.json & zh-CN.json', () => {
    const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
    const i18nMatch = html.match(/const I18N = (\{[\s\S]*?\n    \});/);
    assert(i18nMatch, 'Found inline I18N object in index.html');
    const i18nObj = vm.runInNewContext(`(${i18nMatch[1]})`);

    function flattenKeys(obj, prefix = '') {
      let keys = [];
      for (const [k, v] of Object.entries(obj)) {
        const pathKey = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          keys = keys.concat(flattenKeys(v, pathKey));
        } else {
          keys.push(pathKey);
        }
      }
      return keys.sort();
    }

    const enInlineKeys = flattenKeys(i18nObj.en);
    const zhInlineKeys = flattenKeys(i18nObj['zh-CN']);

    assert.deepStrictEqual(enInlineKeys, zhInlineKeys, 'Inline I18N.en and I18N["zh-CN"] nested keys match 100%');

    // Check Angular template translate pipes
    const ngHtml = fs.readFileSync(path.join(__dirname, '../src/app/features/dashboard/pfm-dashboard.component.html'), 'utf8');
    const enJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/assets/i18n/en.json'), 'utf8'));
    const pipeMatches = [...ngHtml.matchAll(/['"]([A-Z0-9_.]+)['"]\s*\|\s*translate/g)].map(m => m[1]);
    for (const keyPath of pipeMatches) {
      const val = keyPath.split('.').reduce((o, k) => (o ? o[k] : undefined), enJson);
      assert(val !== undefined, `Angular template key ${keyPath} exists in en.json & zh-CN.json`);
    }
  });

  console.log('\n======================================================================');
  console.log(` AUDIT COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================================');
  if (failed > 0) process.exit(1);
})();
