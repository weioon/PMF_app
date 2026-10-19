using System;
using System.Collections.Generic;
using Pfm.Application.DTOs;
using Pfm.Application.Interfaces;

namespace Pfm.Application.Services
{
    /// <summary>
    /// Dedicated ASNB Minimum Monthly Balance Dividend Calculator & Daily Compounding Engine.
    /// Enforces Invariant #5:
    /// - ASNB_MIN_MONTHLY: Tracks the lowest balance held between Day 1 and the last day of each calendar month.
    ///   MonthlyDividend = (LowestMonthlyBalance * (AnnualRate / 100)) / 12.
    /// - DAILY_COMPOUND: Calculates daily interest = EndOfDayBalance * (AnnualRate / 100 / 365).
    /// - Emits a Smart Deposit Timing Tip when a transfer into ASNB occurs after the 1st of the month.
    /// </summary>
    public class AsnbMinimumMonthlyBalanceDividendCalculator : InvestmentYieldService
    {
        public AsnbMinimumMonthlyBalanceDividendCalculator(IPfmDataStore store) : base(store)
        {
        }
    }

    /// <summary>
    /// Dedicated Installment Schedule Generator for SPayLater, Credit Card EPP, and Term Loans.
    /// Enforces Invariant #4:
    /// - Immediately adds total liability (e.g., RM 150.00) to the liability account.
    /// - Generates N monthly InstallmentSchedule records (e.g., 3 x RM 50.00/month).
    /// - Counts only the current month's RM 50.00 installment against the monthly cashflow budget.
    /// - Calculates Debt Service Ratio (DSR %) and tracks repayment progress ("1 of 3 paid, RM 100.00 remaining").
    /// </summary>
    public class InstallmentScheduleGenerator : InstallmentEngineService
    {
        public InstallmentScheduleGenerator(IPfmDataStore store, IInvestmentYieldService yieldService)
            : base(store, yieldService)
        {
        }
    }

    /// <summary>
    /// Dedicated Account Guardrail & Proactive Suggestion Service.
    /// Enforces Invariant #6:
    /// - Rule A (Static Operational Floor): Immediate alert if Touch 'n Go NFC Card drops below RM 10.00.
    /// - Rule B (Auto-Debit Look-Ahead): Immediate alert if Bank A drops below MinBalanceLimit + RM 250.00 Insurance Auto-Debit
    ///   + LinkedInstallments due within LookAheadAlertDays, automatically identifying Bank B as the surplus donor account.
    /// - Rule C (Month-End Idle Cash Sweeper): Between 25th-31st, suggests sweeping excess 0% bank cash to ASNB before the 1st.
    /// - Rule D (Velocity / Overspending Cap): Recommends concrete daily spending caps when a category spikes.
    /// </summary>
    public class AccountGuardrailService : GuardrailRuleEngine
    {
        public AccountGuardrailService(
            IPfmDataStore store,
            IDoubleEntryLedgerService ledgerService,
            IInvestmentYieldService yieldService)
            : base(store, ledgerService, yieldService)
        {
        }
    }
}

