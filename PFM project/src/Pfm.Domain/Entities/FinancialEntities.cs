using System;
using System.Collections.Generic;
using Pfm.Domain.Common;
using Pfm.Domain.Enums;

namespace Pfm.Domain.Entities
{
    /// <summary>
    /// User-extensible or system-seeded sub-type under one of the 4 immutable Pillars.
    /// Examples:
    /// - ASSET_LIQUID: Commercial Banks, Digital Banks, e-Wallets, Touch 'n Go NFC Card, Cash
    /// - ASSET_INVESTMENT: ASNB Fixed-Price, ASNB Variable, Fixed Deposit, Stocks/ETF, EPF
    /// - LIABILITY: SPayLater / BNPL, Credit Card, Car Loan, Personal Loan, Mortgage
    /// - INCOME_SOURCE: Salary, Freelance, Dividend Payout, Cashback
    /// </summary>
    public class AccountSubType : BilingualEntity
    {
        public PillarType Pillar { get; set; }
        public string Code { get; set; } = string.Empty;
        public bool IsSystemSeeded { get; set; }
        public int SortOrder { get; set; }

        public List<Account> Accounts { get; set; } = new List<Account>();
    }

    /// <summary>
    /// Represents a financial account, card, wallet, investment fund, liability, or income source.
    /// All monetary amounts use decimal (mapped to DECIMAL(18, 2) in SQL).
    /// </summary>
    public class Account : BilingualEntity
    {
        public Guid AccountSubTypeId { get; set; }
        public AccountSubType? AccountSubType { get; set; }

        public PillarType Pillar { get; set; }
        public string Currency { get; set; } = "MYR";

        /// <summary>
        /// Current balance in MYR (DECIMAL(18,2)).
        /// For ASSET_LIQUID and ASSET_INVESTMENT: positive asset balance.
        /// For LIABILITY: total outstanding liability balance owed.
        /// For INCOME_SOURCE: cumulative income received from this source.
        /// </summary>
        public decimal CurrentBalance { get; set; }

        /// <summary>
        /// Rule A (Operational Floor): Minimum required balance before triggering an immediate warning
        /// (e.g., RM 10.00 on Touch 'n Go NFC Card for toll/parking gates, or RM 20.00 bank floor).
        /// </summary>
        public decimal MinBalanceLimit { get; set; }

        /// <summary>
        /// Rule B (Auto-Debit Look-Ahead): Number of days ahead to check upcoming auto-debits & installments.
        /// Defaults to 7 days.
        /// </summary>
        public int LookAheadAlertDays { get; set; } = 7;

        /// <summary>
        /// Yield calculation method (NONE, ASNB_MIN_MONTHLY, DAILY_COMPOUND, FIXED_MATURITY).
        /// </summary>
        public InterestCalculationMethod InterestMethod { get; set; } = InterestCalculationMethod.NONE;

        /// <summary>
        /// Annual interest/dividend rate percentage (e.g., 4.25m for 4.25% p.a.).
        /// </summary>
        public decimal AnnualInterestRate { get; set; }

        /// <summary>
        /// Specific liability behavior when Pillar == LIABILITY.
        /// </summary>
        public LiabilityType LiabilityType { get; set; } = LiabilityType.NONE;

        /// <summary>
        /// Optional credit limit for Credit Cards or SPayLater (DECIMAL(18,2)).
        /// </summary>
        public decimal CreditLimit { get; set; }

        /// <summary>
        /// Credit card statement closing day of month (1..31).
        /// </summary>
        public int? StatementClosingDay { get; set; }

        /// <summary>
        /// Credit card or loan payment due day of month (1..31).
        /// </summary>
        public int? PaymentDueDay { get; set; }

        /// <summary>
        /// Rule C (Idle Cash Sweeper): Marks a 0% or low-interest CASA bank account whose surplus cash
        /// above all VirtualEnvelopes, MinBalanceLimit, and UpcomingAutoDebits can be swept to ASNB between the 25th-31st.
        /// </summary>
        public bool IsZeroInterestLiquidAccount { get; set; }

        public bool IsActive { get; set; } = true;

        public List<VirtualEnvelope> VirtualEnvelopes { get; set; } = new List<VirtualEnvelope>();
        public List<RecurringAutoDebit> RecurringAutoDebits { get; set; } = new List<RecurringAutoDebit>();
        public List<MonthlyAccountSnapshot> MonthlySnapshots { get; set; } = new List<MonthlyAccountSnapshot>();
        public List<InstallmentPlan> LiabilityInstallmentPlans { get; set; } = new List<InstallmentPlan>();
    }

    /// <summary>
    /// Virtual Envelope (Sinking Fund) inside a physical liquid bank account
    /// (e.g., Road Tax / 路税, Car Maintenance / 汽车保养, Emergency Fund / 紧急备用金).
    /// Locks funds away from UnrestrictedSpendableBalance without requiring a separate bank account.
    /// </summary>
    public class VirtualEnvelope : BilingualEntity
    {
        public Guid AccountId { get; set; }
        public Account? Account { get; set; }

        /// <summary>
        /// Amount currently locked inside this virtual envelope (DECIMAL(18,2)).
        /// </summary>
        public decimal AllocatedBalance { get; set; }

        /// <summary>
        /// Target sinking fund goal amount (DECIMAL(18,2)).
        /// </summary>
        public decimal TargetAmount { get; set; }

        public DateTime? TargetDate { get; set; }
        public bool IsActive { get; set; } = true;
    }

    /// <summary>
    /// Spending or income category with optional monthly budget for velocity/overspending tracking.
    /// </summary>
    public class TransactionCategory : BilingualEntity
    {
        public string Code { get; set; } = string.Empty;
        public TransactionType ApplicableType { get; set; } = TransactionType.EXPENSE;
        public decimal MonthlyBudgetLimit { get; set; }
        public bool IsSystemFeeCategory { get; set; }
    }

    /// <summary>
    /// Malaysian LHDN Annual Tax Relief Bucket (e.g., Lifestyle RM 2,500, Sports RM 1,000, Medical RM 10,000).
    /// </summary>
    public class TaxReliefBucket : BilingualEntity
    {
        public int TaxYear { get; set; }
        public string Code { get; set; } = string.Empty;
        public decimal AnnualCap { get; set; }
        public string DescriptionEn { get; set; } = string.Empty;
        public string DescriptionZh { get; set; } = string.Empty;
    }

    /// <summary>
    /// Immutable Double-Entry Ledger Transaction record.
    /// Supports EXPENSE (with optional Split Bill & Tax Relief), INCOME, and TRANSFER (with optional TransferFee).
    /// </summary>
    public class LedgerTransaction : BaseEntity
    {
        public DateTime TransactionDate { get; set; }
        public TransactionType Type { get; set; }

        public Guid? SourceAccountId { get; set; }
        public Account? SourceAccount { get; set; }

        public Guid? DestinationAccountId { get; set; }
        public Account? DestinationAccount { get; set; }

        public Guid? CategoryId { get; set; }
        public TransactionCategory? Category { get; set; }

        /// <summary>
        /// Full amount debited/credited on the account (DECIMAL(18,2)).
        /// For EXPENSE with Split Bill: TotalAmount == PersonalAmount + ReceivableAmount.
        /// </summary>
        public decimal TotalAmount { get; set; }

        /// <summary>
        /// Portion that counts toward the user's personal category budget (DECIMAL(18,2)).
        /// For TRANSFER transactions, PersonalAmount is strictly 0.00m so transfers never inflate expenses.
        /// </summary>
        public decimal PersonalAmount { get; set; }

        /// <summary>
        /// Portion owed by friends in a split bill (DECIMAL(18,2)). Excluded from personal budget.
        /// </summary>
        public decimal ReceivableAmount { get; set; }

        /// <summary>
        /// Optional fee on a TRANSFER transaction (DECIMAL(18,2)).
        /// When > 0, generates a linked fee EXPENSE record so only the fee counts as an expense.
        /// </summary>
        public decimal TransferFee { get; set; }

        public Guid? LinkedFeeTransactionId { get; set; }

        public Guid? TaxReliefBucketId { get; set; }
        public TaxReliefBucket? TaxReliefBucket { get; set; }
        public string? ReceiptAttachmentUrl { get; set; }

        public Guid? InstallmentPlanId { get; set; }
        public Guid? InstallmentScheduleId { get; set; }

        /// <summary>
        /// True when an expense is paid via a Credit Card and earmarked for 100% statement payoff
        /// (Statement Float), distinguishing it from amortized Credit Card EPP or SPayLater installments.
        /// </summary>
        public bool IsCreditCardStatementFloat { get; set; }

        /// <summary>
        /// True when this transaction settles a friend's PendingReimbursement so it never inflates income or expense.
        /// </summary>
        public bool IsReimbursementSettlement { get; set; }

        public string DescriptionEn { get; set; } = string.Empty;
        public string DescriptionZh { get; set; } = string.Empty;

        public PendingReimbursement? PendingReimbursement { get; set; }
    }

    /// <summary>
    /// Tracks money owed by friends/colleagues from a Split Bill expense.
    /// </summary>
    public class PendingReimbursement : BaseEntity
    {
        public Guid OriginalTransactionId { get; set; }
        public LedgerTransaction? OriginalTransaction { get; set; }

        public string DebtorName { get; set; } = string.Empty;
        public decimal OwedAmount { get; set; }
        public decimal SettledAmount { get; set; }
        public ReimbursementStatus Status { get; set; } = ReimbursementStatus.PENDING;

        public Guid? SettlementTransactionId { get; set; }
        public DateTime? SettledAtUtc { get; set; }

        public decimal RemainingAmount => Math.Max(0m, OwedAmount - SettledAmount);
    }

    /// <summary>
    /// Represents an amortized liability purchase or loan (e.g., SPayLater RM 150 over 3 months, Credit Card EPP, Car Loan).
    /// Immediately increases LiabilityAccount.CurrentBalance by TotalPrincipal + TotalInterestOrFee,
    /// while spreading monthly cashflow budget impact across InstallmentSchedules.
    /// </summary>
    public class InstallmentPlan : BaseEntity
    {
        public Guid LiabilityAccountId { get; set; }
        public Account? LiabilityAccount { get; set; }

        /// <summary>
        /// Optional liquid bank account from which monthly repayments are deducted (used by Rule B Look-Ahead).
        /// </summary>
        public Guid? LinkedRepaymentAccountId { get; set; }
        public Account? LinkedRepaymentAccount { get; set; }

        public Guid CategoryId { get; set; }
        public TransactionCategory? Category { get; set; }

        public string MerchantOrTitleEn { get; set; } = string.Empty;
        public string MerchantOrTitleZh { get; set; } = string.Empty;

        public decimal TotalPrincipal { get; set; }
        public decimal TotalInterestOrFee { get; set; }
        public decimal TotalPayable => TotalPrincipal + TotalInterestOrFee;

        public int TenureMonths { get; set; }
        public decimal MonthlyInstallmentAmount { get; set; }
        public DateTime StartDate { get; set; }
        public bool IsActive { get; set; } = true;

        public List<InstallmentSchedule> Schedules { get; set; } = new List<InstallmentSchedule>();
    }

    /// <summary>
    /// Individual monthly installment slice generated for an InstallmentPlan.
    /// Only the slice due in a given month counts toward that month's cashflow budget.
    /// </summary>
    public class InstallmentSchedule : BaseEntity
    {
        public Guid InstallmentPlanId { get; set; }
        public InstallmentPlan? InstallmentPlan { get; set; }

        public int InstallmentNumber { get; set; }
        public DateTime DueDate { get; set; }

        public decimal PrincipalPortion { get; set; }
        public decimal InterestOrFeePortion { get; set; }
        public decimal TotalDue { get; set; }

        public InstallmentStatus Status { get; set; } = InstallmentStatus.UPCOMING;
        public DateTime? PaidAtUtc { get; set; }
        public Guid? PaymentTransactionId { get; set; }
    }

    /// <summary>
    /// Scheduled recurring auto-debit commitment on a liquid account (e.g., Monthly Insurance RM 250 on Bank A).
    /// Checked by Rule B (Auto-Debit Look-Ahead) and deducted from UnrestrictedSpendableBalance when within window.
    /// </summary>
    public class RecurringAutoDebit : BilingualEntity
    {
        public Guid AccountId { get; set; }
        public Account? Account { get; set; }

        public Guid? CategoryId { get; set; }
        public TransactionCategory? Category { get; set; }

        public decimal Amount { get; set; }
        public int BillingDayOfMonth { get; set; }
        public DateTime NextDueDate { get; set; }
        public bool IsActive { get; set; } = true;
    }

    /// <summary>
    /// Tracks monthly opening, lowest (Day 1..End of Month for ASNB), and closing balances
    /// along with accrued monthly dividends/interest.
    /// </summary>
    public class MonthlyAccountSnapshot : BaseEntity
    {
        public Guid AccountId { get; set; }
        public Account? Account { get; set; }

        public int Year { get; set; }
        public int Month { get; set; }

        public decimal OpeningBalance { get; set; }

        /// <summary>
        /// For ASNB_MIN_MONTHLY: The lowest balance held between Day 1 and the last day of the calendar month.
        /// MonthlyDividend = Round((LowestMonthlyBalance * (AppliedAnnualRate / 100)) / 12, 2).
        /// </summary>
        public decimal LowestMonthlyBalance { get; set; }

        public decimal ClosingBalance { get; set; }
        public decimal AppliedAnnualRate { get; set; }
        public decimal AccruedDividendOrInterest { get; set; }
    }

    /// <summary>
    /// Persisted or evaluated bilingual financial warning / proactive suggestion generated by the Rule Engine.
    /// </summary>
    public class FinancialAlert : BaseEntity
    {
        public AlertRuleCode RuleCode { get; set; }
        public AlertSeverity Severity { get; set; }
        public Guid? PrimaryAccountId { get; set; }
        public Guid? SuggestedCounterpartyAccountId { get; set; }
        public decimal? SuggestedTransferAmount { get; set; }

        public string TranslationKey { get; set; } = string.Empty;
        public string TitleEn { get; set; } = string.Empty;
        public string TitleZh { get; set; } = string.Empty;
        public string MessageEn { get; set; } = string.Empty;
        public string MessageZh { get; set; } = string.Empty;
        public string ParametersJson { get; set; } = "{}";

        public DateTime GeneratedAtUtc { get; set; } = DateTime.UtcNow;
        public bool IsAcknowledged { get; set; }
    }
}

