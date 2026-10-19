using System;
using System.Collections.Generic;
using Pfm.Domain.Enums;

namespace Pfm.Application.DTOs
{
    public class CreateExpenseRequest
    {
        public DateTime TransactionDate { get; set; } = DateTime.UtcNow;
        public Guid SourceAccountId { get; set; }
        public Guid CategoryId { get; set; }
        public decimal TotalAmount { get; set; }

        /// <summary>
        /// Optional: If splitting a bill with friends, specify the ReceivableAmount owed by friends.
        /// PersonalAmount will automatically be computed as TotalAmount - ReceivableAmount.
        /// </summary>
        public decimal ReceivableAmount { get; set; }
        public string? DebtorName { get; set; }

        /// <summary>
        /// Optional Tax Relief tagging (e.g., Lifestyle, Sports, Medical).
        /// </summary>
        public Guid? TaxReliefBucketId { get; set; }
        public string? ReceiptAttachmentUrl { get; set; }

        public string DescriptionEn { get; set; } = string.Empty;
        public string DescriptionZh { get; set; } = string.Empty;
    }

    public class CreateIncomeRequest
    {
        public DateTime TransactionDate { get; set; } = DateTime.UtcNow;
        public Guid SourceIncomeAccountId { get; set; }
        public Guid DestinationLiquidAccountId { get; set; }
        public Guid? CategoryId { get; set; }
        public decimal Amount { get; set; }
        public string DescriptionEn { get; set; } = string.Empty;
        public string DescriptionZh { get; set; } = string.Empty;
    }

    public class CreateTransferRequest
    {
        public DateTime TransactionDate { get; set; } = DateTime.UtcNow;
        public Guid SourceAccountId { get; set; }
        public Guid DestinationAccountId { get; set; }
        public decimal Amount { get; set; }

        /// <summary>
        /// Optional transfer fee (DECIMAL(18,2)).
        /// The transfer Amount itself NEVER inflates monthly expenses; only TransferFee (if > 0) logs as a fee expense.
        /// </summary>
        public decimal TransferFee { get; set; }

        public string DescriptionEn { get; set; } = string.Empty;
        public string DescriptionZh { get; set; } = string.Empty;
    }

    public class TransferResultDto
    {
        public Pfm.Domain.Entities.LedgerTransaction TransferTransaction { get; set; } = null!;
        public Pfm.Domain.Entities.LedgerTransaction? FeeTransaction { get; set; }
        public FinancialAlertDto? DepositTimingTip { get; set; }
    }

    public class SettleReimbursementRequest
    {
        public Guid PendingReimbursementId { get; set; }
        public Guid DestinationLiquidAccountId { get; set; }
        public decimal SettlementAmount { get; set; }
        public DateTime SettlementDate { get; set; } = DateTime.UtcNow;
    }

    public class CreateInstallmentPurchaseRequest
    {
        public Guid LiabilityAccountId { get; set; }
        public Guid? LinkedRepaymentAccountId { get; set; }
        public Guid CategoryId { get; set; }
        public string MerchantOrTitleEn { get; set; } = string.Empty;
        public string MerchantOrTitleZh { get; set; } = string.Empty;
        public decimal TotalPrincipal { get; set; }
        public decimal TotalInterestOrFee { get; set; }
        public int TenureMonths { get; set; }
        public DateTime PurchaseDate { get; set; } = DateTime.UtcNow;
    }

    public class InstallmentPlanProgressDto
    {
        public Guid PlanId { get; set; }
        public string MerchantOrTitleEn { get; set; } = string.Empty;
        public string MerchantOrTitleZh { get; set; } = string.Empty;
        public decimal TotalPayable { get; set; }
        public decimal MonthlyInstallmentAmount { get; set; }
        public int PaidMonthsCount { get; set; }
        public int TotalTenureMonths { get; set; }
        public decimal RemainingBalance { get; set; }
        public string ProgressLabelEn { get; set; } = string.Empty;
        public string ProgressLabelZh { get; set; } = string.Empty;
    }

    public class DsrSummaryDto
    {
        public decimal NetMonthlyIncome { get; set; }
        public decimal MonthlyInstallmentAndLoanRepayments { get; set; }
        public decimal CreditCardStatementFloatTotal { get; set; }
        public decimal DsrPercentage { get; set; }
        public string StatusEn { get; set; } = string.Empty;
        public string StatusZh { get; set; } = string.Empty;
    }

    public class AsnbDividendSummaryDto
    {
        public Guid AccountId { get; set; }
        public string AccountNameEn { get; set; } = string.Empty;
        public string AccountNameZh { get; set; } = string.Empty;
        public int Year { get; set; }
        public int Month { get; set; }
        public decimal CurrentBalance { get; set; }
        public decimal LowestMonthlyBalance { get; set; }
        public decimal AnnualDividendRate { get; set; }
        public decimal CurrentMonthAccruedDividend { get; set; }
        public decimal YearToDateAccruedDividend { get; set; }
        public decimal ProjectedFullYearDividend { get; set; }
        public FinancialAlertDto? DepositTimingTip { get; set; }
    }

    public class TaxReliefSummaryDto
    {
        public Guid BucketId { get; set; }
        public int TaxYear { get; set; }
        public string Code { get; set; } = string.Empty;
        public string NameEn { get; set; } = string.Empty;
        public string NameZh { get; set; } = string.Empty;
        public decimal AnnualCap { get; set; }
        public decimal ClaimedAmount { get; set; }
        public decimal RemainingCap { get; set; }
        public decimal UtilizationPercentage { get; set; }
    }

    public class FinancialAlertDto
    {
        public AlertRuleCode RuleCode { get; set; }
        public AlertSeverity Severity { get; set; }
        public Guid? PrimaryAccountId { get; set; }
        public Guid? SuggestedCounterpartyAccountId { get; set; }
        public decimal? SuggestedTransferAmount { get; set; }
        public string TranslationKey { get; set; } = string.Empty;
        public Dictionary<string, string> TranslationParams { get; set; } = new Dictionary<string, string>();
        public string TitleEn { get; set; } = string.Empty;
        public string TitleZh { get; set; } = string.Empty;
        public string MessageEn { get; set; } = string.Empty;
        public string MessageZh { get; set; } = string.Empty;
    }

    public class AccountSummaryDto
    {
        public Guid AccountId { get; set; }
        public PillarType Pillar { get; set; }
        public string NameEn { get; set; } = string.Empty;
        public string NameZh { get; set; } = string.Empty;
        public decimal CurrentBalance { get; set; }
        public decimal MinBalanceLimit { get; set; }
        public decimal VirtualEnvelopesLockedBalance { get; set; }
        public decimal UpcomingAutoDebitsInWindow { get; set; }
        public decimal LinkedInstallmentsInWindow { get; set; }
        public decimal UnrestrictedSpendableBalance { get; set; }
        public decimal MonthlyAccruedYield { get; set; }
        public decimal MonthlyInstallmentCommitment { get; set; }
    }

    public class SubTypeRollUpDto
    {
        public Guid SubTypeId { get; set; }
        public string Code { get; set; } = string.Empty;
        public string NameEn { get; set; } = string.Empty;
        public string NameZh { get; set; } = string.Empty;
        public decimal TotalBalance { get; set; }
        public decimal TotalUnrestrictedSpendable { get; set; }
        public decimal TotalLockedInEnvelopes { get; set; }
        public decimal TotalMonthlyYield { get; set; }
        public decimal TotalMonthlyInstallmentCommitment { get; set; }
        public List<AccountSummaryDto> Accounts { get; set; } = new List<AccountSummaryDto>();
    }

    public class PillarRollUpDto
    {
        public PillarType Pillar { get; set; }
        public string NameEn { get; set; } = string.Empty;
        public string NameZh { get; set; } = string.Empty;
        public decimal TotalBalance { get; set; }
        public decimal TotalUnrestrictedSpendable { get; set; }
        public decimal TotalLockedInEnvelopes { get; set; }
        public decimal TotalMonthlyYield { get; set; }
        public decimal TotalMonthlyInstallmentCommitment { get; set; }
        public List<SubTypeRollUpDto> SubTypes { get; set; } = new List<SubTypeRollUpDto>();
    }

    public class DashboardRollUpResponseDto
    {
        public DateTime AsOfDate { get; set; }
        public decimal NetWorth { get; set; }
        public decimal TotalLiquidAssets { get; set; }
        public decimal TotalUnrestrictedSafeToSpend { get; set; }
        public decimal TotalLockedInVirtualEnvelopes { get; set; }
        public decimal TotalInvestmentAssets { get; set; }
        public decimal TotalProjectedAnnualYield { get; set; }
        public decimal TotalLiabilities { get; set; }
        public decimal TotalMonthlyInstallmentCommitments { get; set; }
        public decimal CurrentMonthPersonalExpenseTotal { get; set; }
        public decimal TotalPendingReimbursementsReceivable { get; set; }
        public DsrSummaryDto DsrSummary { get; set; } = new DsrSummaryDto();
        public List<PillarRollUpDto> Pillars { get; set; } = new List<PillarRollUpDto>();
        public List<FinancialAlertDto> ActiveAlerts { get; set; } = new List<FinancialAlertDto>();
        public List<TaxReliefSummaryDto> TaxReliefSummaries { get; set; } = new List<TaxReliefSummaryDto>();
    }

    public class CategoryRollUpSummaryDto
    {
        public Guid CategoryId { get; set; }
        public string Code { get; set; } = string.Empty;
        public string NameEn { get; set; } = string.Empty;
        public string NameZh { get; set; } = string.Empty;
        public decimal MonthlyBudgetLimit { get; set; }
        public decimal DirectPersonalSpent { get; set; }
        public decimal MonthlyInstallmentSliceSpent { get; set; }
        public decimal TotalMonthlyCategoryCommitment { get; set; }
        public decimal RemainingBudget { get; set; }
        public decimal UtilizationPercentage { get; set; }
        public decimal RecommendedDailyCap { get; set; }
        public int TransactionCount { get; set; }
    }

    public class CashflowCalendarEventDto
    {
        public string EventType { get; set; } = string.Empty; // AUTO_DEBIT, INSTALLMENT_DUE, SALARY_INFLOW, ASNB_SWEEP_WINDOW
        public Guid? AccountId { get; set; }
        public string AccountNameEn { get; set; } = string.Empty;
        public string AccountNameZh { get; set; } = string.Empty;
        public string TitleEn { get; set; } = string.Empty;
        public string TitleZh { get; set; } = string.Empty;
        public decimal Amount { get; set; }
        public bool IsInflow { get; set; }
    }

    public class CashflowProjectionDayDto
    {
        public DateTime Date { get; set; }
        public int DayOffset { get; set; }
        public decimal TotalInflows { get; set; }
        public decimal TotalOutflows { get; set; }
        public decimal ProjectedTotalLiquidBalance { get; set; }
        public decimal ProjectedUnrestrictedSafeToSpend { get; set; }
        public bool HasShortfallWarning { get; set; }
        public string? WarningEn { get; set; }
        public string? WarningZh { get; set; }
        public List<CashflowCalendarEventDto> Events { get; set; } = new List<CashflowCalendarEventDto>();
    }

    public class CashflowProjectionCalendarResponseDto
    {
        public DateTime StartDate { get; set; }
        public DateTime EndDate { get; set; }
        public decimal OpeningLiquidBalance { get; set; }
        public decimal OpeningSafeToSpend { get; set; }
        public decimal Total30DayScheduledOutflows { get; set; }
        public decimal Total30DayExpectedInflows { get; set; }
        public decimal LowestProjectedLiquidBalance { get; set; }
        public DateTime LowestBalanceDate { get; set; }
        public List<CashflowProjectionDayDto> Days { get; set; } = new List<CashflowProjectionDayDto>();
    }

    public class VirtualEnvelopeSummaryDto
    {
        public Guid EnvelopeId { get; set; }
        public Guid AccountId { get; set; }
        public string AccountNameEn { get; set; } = string.Empty;
        public string AccountNameZh { get; set; } = string.Empty;
        public string NameEn { get; set; } = string.Empty;
        public string NameZh { get; set; } = string.Empty;
        public decimal AllocatedBalance { get; set; }
        public decimal TargetAmount { get; set; }
        public decimal ProgressPercentage { get; set; }
        public DateTime? TargetDate { get; set; }
    }

    public class PendingReimbursementSummaryDto
    {
        public Guid ReimbursementId { get; set; }
        public Guid OriginalTransactionId { get; set; }
        public DateTime TransactionDate { get; set; }
        public string DebtorName { get; set; } = string.Empty;
        public string DescriptionEn { get; set; } = string.Empty;
        public string DescriptionZh { get; set; } = string.Empty;
        public decimal OwedAmount { get; set; }
        public decimal SettledAmount { get; set; }
        public decimal RemainingAmount { get; set; }
        public ReimbursementStatus Status { get; set; }
    }
}
