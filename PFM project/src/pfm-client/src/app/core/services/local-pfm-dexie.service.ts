import { Injectable } from '@angular/core';
import Dexie, { Table } from 'dexie';
import { AccountItem, InstallmentPlanItem } from '../features/dashboard/pfm-dashboard.component';

export interface LocalTransactionItem {
  id: string;
  date: string;
  type: 'EXPENSE' | 'INCOME' | 'TRANSFER' | 'INSTALLMENT';
  amount: number;
  personalAmount: number;
  descEn: string;
  descZh: string;
}

export interface LocalAsnbSnapshotItem {
  id: string;
  accountId: string;
  year: number;
  month: number;
  lowestMonthlyBalance: number;
  closingBalance: number;
  annualRate: number;
}

/**
 * Standalone On-Device IndexedDB Database powered by Dexie.js.
 * Ensures 100% offline execution on Android when PC / VS Code is turned off,
 * and preserves all recorded financial data across PWA / Capacitor APK updates.
 */
@Injectable({ providedIn: 'root' })
export class LocalPfmDexieDb extends Dexie {
  accounts!: Table<AccountItem, string>;
  transactions!: Table<LocalTransactionItem, string>;
  asnbSnapshots!: Table<LocalAsnbSnapshotItem, string>;
  installments!: Table<InstallmentPlanItem, string>;

  constructor() {
    super('MyPfmIndexedDb');
    this.version(2).stores({
      accounts: 'id, pillar',
      transactions: 'id, date, type',
      asnbSnapshots: 'id, accountId, [year+month]',
      installments: 'id'
    });
  }

  async exportBackupJson(): Promise<string> {
    const [accounts, transactions, asnbSnapshots, installmentPlans] = await Promise.all([
      this.accounts.toArray(),
      this.transactions.toArray(),
      this.asnbSnapshots.toArray(),
      this.installments.toArray()
    ]);

    return JSON.stringify(
      {
        app: 'MyPFM-Standalone-Local',
        schemaVersion: 2,
        exportedAtUtc: new Date().toISOString(),
        currency: 'MYR',
        data: {
          accounts,
          transactions,
          asnbSnapshots,
          installmentPlans
        }
      },
      null,
      2
    );
  }

  async importBackupJson(jsonString: string): Promise<void> {
    const parsed = JSON.parse(jsonString);
    const data = parsed?.data ?? parsed;
    if (!data || !Array.isArray(data.accounts)) {
      throw new Error('Invalid MyPFM JSON backup format.');
    }

    await this.transaction('rw', this.accounts, this.transactions, this.asnbSnapshots, this.installments, async () => {
      await this.accounts.clear();
      await this.accounts.bulkPut(data.accounts);

      if (Array.isArray(data.transactions)) {
        await this.transactions.clear();
        await this.transactions.bulkPut(data.transactions);
      }
      if (Array.isArray(data.asnbSnapshots)) {
        await this.asnbSnapshots.clear();
        await this.asnbSnapshots.bulkPut(data.asnbSnapshots);
      }
      if (Array.isArray(data.installmentPlans)) {
        await this.installments.clear();
        await this.installments.bulkPut(data.installmentPlans);
      }
    });
  }
}

