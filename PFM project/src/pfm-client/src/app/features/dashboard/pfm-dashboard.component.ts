import { Component, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

export type LanguageCode = 'en' | 'zh-CN';
export type PillarKey = 'ASSET_LIQUID' | 'ASSET_INVESTMENT' | 'LIABILITY' | 'INCOME_SOURCE';

export interface VirtualEnvelopeItem {
  id: string;
  nameEn: string;
  nameZh: string;
  allocatedBalance: number;
  targetAmount: number;
}

export interface AutoDebitItem {
  id: string;
  nameEn: string;
  nameZh: string;
  amount: number;
  dueInDays: number;
}

export interface AccountItem {
  id: string;
  pillar: PillarKey;
  subTypeEn: string;
  subTypeZh: string;
  nameEn: string;
  nameZh: string;
  currentBalance: number;
  minBalanceLimit: number;
  interestMethod: 'NONE' | 'ASNB_MIN_MONTHLY' | 'DAILY_COMPOUND';
  annualRate: number;
  lowestMonthlyBalance?: number;
  isZeroInterestLiquid?: boolean;
  envelopes: VirtualEnvelopeItem[];
  autoDebits: AutoDebitItem[];
}

export interface InstallmentPlanItem {
  id: string;
  merchantEn: string;
  merchantZh: string;
  totalPrincipal: number;
  tenureMonths: number;
  monthlySlice: number;
  paidCount: number;
  schedules: { number: number; dueDate: string; amount: number; paid: boolean }[];
}

@Component({
  selector: 'app-pfm-root',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './pfm-dashboard.component.html'
})
export class PfmDashboardComponent {
  readonly currentLang = signal<LanguageCode>('en');
  readonly activeTab = signal<'dashboard' | 'envelopes' | 'ledger' | 'installments' | 'asnb' | 'tax'>('dashboard');

  constructor(private readonly translate: TranslateService) {
    this.translate.setDefaultLang('en');
    this.translate.use('en');
  }

  toggleLanguage(lang?: LanguageCode): void {
    const next: LanguageCode = lang ?? (this.currentLang() === 'en' ? 'zh-CN' : 'en');
    this.currentLang.set(next);
    this.translate.use(next);
  }

  // Invariant #3: UnrestrictedSpendableBalance = CurrentBalance - MinBalanceLimit - Sum(Envelopes) - Sum(UpcomingAutoDebits)
  calculateSafeToSpend(acc: AccountItem): number {
    if (acc.pillar !== 'ASSET_LIQUID') return 0;
    const lockedEnv = acc.envelopes.reduce((s, e) => s + e.allocatedBalance, 0);
    const upcomingDebits = acc.autoDebits.filter(d => d.dueInDays <= 7).reduce((s, d) => s + d.amount, 0);
    return Math.max(0, Number((acc.currentBalance - acc.minBalanceLimit - lockedEnv - upcomingDebits).toFixed(2)));
  }

  // Invariant #5: ASNB MonthlyDividend = (LowestMonthlyBalance * (AnnualRate / 100)) / 12
  calculateAsnbMonthlyDividend(lowestBalance: number, annualRate: number): number {
    return Number(((lowestBalance * (annualRate / 100)) / 12).toFixed(2));
  }

  // Invariant #5: DailyCompound = EndOfDayBalance * (AnnualRate / 100 / 365)
  calculateDailyCompound(balance: number, annualRate: number, days = 1): number {
    return Number((balance * (annualRate / 100 / 365) * days).toFixed(2));
  }
}

