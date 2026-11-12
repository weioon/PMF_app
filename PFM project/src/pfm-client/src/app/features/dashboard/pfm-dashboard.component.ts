import { Component, signal } from '@angular/core';
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
  interestMethod: 'NONE' | 'ASNB_MIN_MONTHLY' | 'LOWEST_MONTHLY_BALANCE' | 'DAILY_COMPOUND' | 'FIXED_MATURITY' | 'DYNAMIC_TIERED_RATE';
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
    const lockedEnv = (acc.envelopes || []).reduce((s, e) => s + (Number(e.allocatedBalance) || 0), 0);
    const upcomingDebits = (acc.autoDebits || []).filter(d => d.dueInDays <= 7).reduce((s, d) => s + (Number(d.amount) || 0), 0);
    return Math.max(0, Number(((Number(acc.currentBalance) || 0) - (Number(acc.minBalanceLimit) || 0) - lockedEnv - upcomingDebits).toFixed(2)));
  }

  // Invariant #5: ASNB MonthlyDividend = (LowestMonthlyBalance * (AnnualRate / 100)) / 12
  calculateAsnbMonthlyDividend(lowestBalance: number, annualRate: number): number {
    return Number((((Number(lowestBalance) || 0) * ((Number(annualRate) || 0) / 100)) / 12).toFixed(2));
  }

  // Invariant #5: DailyCompound = EndOfDayBalance * (AnnualRate / 100 / 365)
  calculateDailyCompound(balance: number, annualRate: number, days = 1): number {
    return Number(((Number(balance) || 0) * ((Number(annualRate) || 0) / 100 / 365) * days).toFixed(2));
  }

  // Safe DSR % computation guarding against 0 or negative monthly income
  calculateDsrPercentage(monthlyDebtCommitment: number, netMonthlyIncome: number): number {
    if (!netMonthlyIncome || netMonthlyIncome <= 0) return 0;
    return Number((((Number(monthlyDebtCommitment) || 0) / netMonthlyIncome) * 100).toFixed(2));
  }
}
