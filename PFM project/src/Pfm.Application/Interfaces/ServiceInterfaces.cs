using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Pfm.Application.DTOs;
using Pfm.Domain.Entities;
using Pfm.Domain.Enums;

namespace Pfm.Application.Interfaces
{
    /// <summary>
    /// Persistence abstraction for the Clean Architecture Application layer.
    /// Supports both EF Core (SQLite / PostgreSQL / SQL Server) and deterministic in-memory unit test stores.
    /// </summary>
    public interface IPfmDataStore
    {
        IList<AccountSubType> AccountSubTypes { get; }
        IList<Account> Accounts { get; }
        IList<VirtualEnvelope> VirtualEnvelopes { get; }
        IList<TransactionCategory> TransactionCategories { get; }
        IList<TaxReliefBucket> TaxReliefBuckets { get; }
        IList<LedgerTransaction> LedgerTransactions { get; }
        IList<PendingReimbursement> PendingReimbursements { get; }
        IList<InstallmentPlan> InstallmentPlans { get; }
        IList<InstallmentSchedule> InstallmentSchedules { get; }
        IList<RecurringAutoDebit> RecurringAutoDebits { get; }
        IList<MonthlyAccountSnapshot> MonthlyAccountSnapshots { get; }
        IList<FinancialAlert> FinancialAlerts { get; }

        Task ExecuteInTransactionAsync(Func<Task> action, CancellationToken cancellationToken = default);
        Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
    }

    public interface IDoubleEntryLedgerService
    {
        Task<LedgerTransaction> RecordExpenseAsync(CreateExpenseRequest request, CancellationToken cancellationToken = default);
        Task<LedgerTransaction> RecordIncomeAsync(CreateIncomeRequest request, CancellationToken cancellationToken = default);
        Task<TransferResultDto> RecordTransferAsync(
            CreateTransferRequest request, CancellationToken cancellationToken = default);
        Task<PendingReimbursement> SettleReimbursementAsync(SettleReimbursementRequest request, CancellationToken cancellationToken = default);
        Task<VirtualEnvelope> AllocateToVirtualEnvelopeAsync(
            Guid accountId, string nameEn, string nameZh, decimal amountToLock, decimal targetAmount, DateTime? targetDate = null, CancellationToken cancellationToken = default);
        decimal CalculateUnrestrictedSpendableBalance(Guid accountId, DateTime asOfDate);
        decimal GetMonthlyPersonalExpenseTotal(int year, int month);
        IReadOnlyList<TaxReliefSummaryDto> GetTaxReliefSummary(int taxYear);
    }

    public interface IInstallmentEngineService
    {
        Task<InstallmentPlan> CreateInstallmentPurchaseAsync(
            CreateInstallmentPurchaseRequest request, CancellationToken cancellationToken = default);
        Task<InstallmentSchedule> PayInstallmentScheduleAsync(
            Guid scheduleId, Guid sourceLiquidAccountId, DateTime paymentDate, CancellationToken cancellationToken = default);
        InstallmentPlanProgressDto GetInstallmentPlanProgress(Guid planId);
        decimal GetMonthlyInstallmentCashflowCommitment(int year, int month);
        DsrSummaryDto CalculateDebtServiceRatio(int year, int month, decimal? overrideNetMonthlyIncome = null);
    }

    public interface IInvestmentYieldService
    {
        MonthlyAccountSnapshot EnsureMonthlySnapshot(Guid accountId, int year, int month, decimal? initialOpeningBalance = null);
        FinancialAlertDto? OnAccountBalanceChanged(Guid accountId, decimal previousBalance, decimal newBalance, DateTime transactionDate);
        decimal CalculateAsnbMonthlyDividend(decimal lowestMonthlyBalance, decimal annualRatePercent);
        decimal CalculateDailyCompoundInterest(decimal endOfDayBalance, decimal annualRatePercent, int days = 1);
        AsnbDividendSummaryDto GetAsnbDividendProjection(Guid accountId, DateTime asOfDate);
    }

    public interface IGuardrailRuleEngine
    {
        IReadOnlyList<FinancialAlertDto> EvaluateAllRules(DateTime evaluationDate);
        FinancialAlertDto? EvaluateStaticFloorAlert(Guid accountId);
        FinancialAlertDto? EvaluateAutoDebitLookAheadAlert(Guid accountId, DateTime evaluationDate);
        IReadOnlyList<FinancialAlertDto> EvaluateIdleCashSweeperAlerts(DateTime evaluationDate, decimal idleSweepThreshold = 100.00m);
        IReadOnlyList<FinancialAlertDto> EvaluateVelocityOverspendingAlerts(DateTime evaluationDate);
    }

    public interface IPillarRollUpService
    {
        AccountSubType CreateCustomSubType(PillarType pillar, string code, string nameEn, string nameZh, int sortOrder = 100);
        Account CreateCustomAccount(
            Guid subTypeId,
            string nameEn,
            string nameZh,
            decimal openingBalance,
            decimal minBalanceLimit = 0m,
            InterestCalculationMethod interestMethod = InterestCalculationMethod.NONE,
            decimal annualInterestRate = 0m,
            LiabilityType liabilityType = LiabilityType.NONE,
            bool isZeroInterestLiquidAccount = false);
        DashboardRollUpResponseDto GetDashboardRollUp(DateTime asOfDate);
        IReadOnlyList<CategoryRollUpSummaryDto> GetCategoryRollUpSummaries(int year, int month, DateTime? asOfDate = null);
        CashflowProjectionCalendarResponseDto Get30DayCashflowProjectionCalendar(DateTime startDate, decimal expectedMonthlySalaryInflow = 0m, int salaryCreditDayOfMonth = 25);
        IReadOnlyList<VirtualEnvelopeSummaryDto> GetVirtualEnvelopes(Guid? accountId = null);
        IReadOnlyList<PendingReimbursementSummaryDto> GetPendingReimbursements(bool includeSettled = true);
    }
}
