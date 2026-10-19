using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Pfm.Application.DTOs;
using Pfm.Application.Interfaces;
using Pfm.Domain.Entities;
using Pfm.Domain.Enums;
using Pfm.Domain.Exceptions;

namespace Pfm.Application.Services
{
    /// <summary>
    /// Enforces Non-Negotiable Financial Domain Invariant #4:
    /// - Installment & Liability Engine (SPayLater, Credit Card EPP, Loans)
    /// - Creating an RM 150 SPayLater 3-month purchase immediately increases SPayLater total liability by RM 150,
    ///   generates 3 monthly InstallmentSchedules (RM 50/month), and only counts RM 50 against the current month's cashflow budget.
    /// - Distinguishes Credit Card Statement Float from Amortized Installments.
    /// - Calculates Debt Service Ratio (DSR %) = (Total Monthly Debt & BNPL Repayments / Net Monthly Income) * 100.
    /// </summary>
    public class InstallmentEngineService : IInstallmentEngineService
    {
        private readonly IPfmDataStore _store;
        private readonly IInvestmentYieldService _yieldService;

        public InstallmentEngineService(IPfmDataStore store, IInvestmentYieldService yieldService)
        {
            _store = store ?? throw new ArgumentNullException(nameof(store));
            _yieldService = yieldService ?? throw new ArgumentNullException(nameof(yieldService));
        }

        public async Task<InstallmentPlan> CreateInstallmentPurchaseAsync(
            CreateInstallmentPurchaseRequest request,
            CancellationToken cancellationToken = default)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));
            if (request.TotalPrincipal <= 0m)
            {
                throw new DomainInvariantException(
                    "INVALID_INSTALLMENT_PRINCIPAL",
                    "Installment purchase principal must be greater than RM 0.00.",
                    "分期付款本金必须大于 RM 0.00。");
            }

            if (request.TenureMonths < 1 || request.TenureMonths > 480)
            {
                throw new DomainInvariantException(
                    "INVALID_INSTALLMENT_TENURE",
                    "Installment tenure must be between 1 and 480 months.",
                    "分期期数必须介于 1 至 480 个月之间。");
            }

            var liabilityAccount = _store.Accounts.FirstOrDefault(a => a.Id == request.LiabilityAccountId);
            if (liabilityAccount == null || liabilityAccount.Pillar != PillarType.LIABILITY)
            {
                throw new DomainInvariantException(
                    "INVALID_LIABILITY_ACCOUNT",
                    "Installment purchases must be linked to a Liability account (e.g., SPayLater, Credit Card EPP, or Loan).",
                    "分期消费必须关联至负债账户（例如 SPayLater、信用卡分期或贷款）。");
            }

            InstallmentPlan? createdPlan = null;

            await _store.ExecuteInTransactionAsync(async () =>
            {
                decimal totalPrincipal = Math.Round(request.TotalPrincipal, 2, MidpointRounding.AwayFromZero);
                decimal totalInterest = Math.Round(Math.Max(0m, request.TotalInterestOrFee), 2, MidpointRounding.AwayFromZero);
                decimal totalPayable = totalPrincipal + totalInterest;

                // Immediately increase LiabilityAccount.CurrentBalance by the full payable amount (e.g., RM 150.00)
                liabilityAccount.CurrentBalance = Math.Round(liabilityAccount.CurrentBalance + totalPayable, 2, MidpointRounding.AwayFromZero);
                liabilityAccount.UpdatedAtUtc = DateTime.UtcNow;

                decimal baseMonthlyPrincipal = Math.Floor((totalPrincipal / request.TenureMonths) * 100m) / 100m;
                decimal baseMonthlyInterest = Math.Floor((totalInterest / request.TenureMonths) * 100m) / 100m;
                decimal baseMonthlyTotal = baseMonthlyPrincipal + baseMonthlyInterest;

                createdPlan = new InstallmentPlan
                {
                    Id = Guid.NewGuid(),
                    LiabilityAccountId = liabilityAccount.Id,
                    LiabilityAccount = liabilityAccount,
                    LinkedRepaymentAccountId = request.LinkedRepaymentAccountId,
                    CategoryId = request.CategoryId,
                    MerchantOrTitleEn = request.MerchantOrTitleEn,
                    MerchantOrTitleZh = string.IsNullOrWhiteSpace(request.MerchantOrTitleZh) ? request.MerchantOrTitleEn : request.MerchantOrTitleZh,
                    TotalPrincipal = totalPrincipal,
                    TotalInterestOrFee = totalInterest,
                    TenureMonths = request.TenureMonths,
                    MonthlyInstallmentAmount = baseMonthlyTotal,
                    StartDate = request.PurchaseDate.Date,
                    IsActive = true
                };

                decimal accumulatedPrincipal = 0m;
                decimal accumulatedInterest = 0m;

                for (int i = 1; i <= request.TenureMonths; i++)
                {
                    bool isLastMonth = i == request.TenureMonths;
                    decimal slicePrincipal = isLastMonth
                        ? Math.Round(totalPrincipal - accumulatedPrincipal, 2, MidpointRounding.AwayFromZero)
                        : baseMonthlyPrincipal;
                    decimal sliceInterest = isLastMonth
                        ? Math.Round(totalInterest - accumulatedInterest, 2, MidpointRounding.AwayFromZero)
                        : baseMonthlyInterest;

                    accumulatedPrincipal += slicePrincipal;
                    accumulatedInterest += sliceInterest;

                    // First installment falls in the current month (StartDate), subsequent slices +1 month each
                    DateTime dueDate = request.PurchaseDate.Date.AddMonths(i - 1);

                    var schedule = new InstallmentSchedule
                    {
                        Id = Guid.NewGuid(),
                        InstallmentPlanId = createdPlan.Id,
                        InstallmentPlan = createdPlan,
                        InstallmentNumber = i,
                        DueDate = dueDate,
                        PrincipalPortion = slicePrincipal,
                        InterestOrFeePortion = sliceInterest,
                        TotalDue = slicePrincipal + sliceInterest,
                        Status = i == 1 ? InstallmentStatus.DUE : InstallmentStatus.UPCOMING
                    };

                    createdPlan.Schedules.Add(schedule);
                    _store.InstallmentSchedules.Add(schedule);
                }

                _store.InstallmentPlans.Add(createdPlan);
                if (!liabilityAccount.LiabilityInstallmentPlans.Contains(createdPlan))
                {
                    liabilityAccount.LiabilityInstallmentPlans.Add(createdPlan);
                }

                await _store.SaveChangesAsync(cancellationToken);
            }, cancellationToken);

            return createdPlan!;
        }

        public async Task<InstallmentSchedule> PayInstallmentScheduleAsync(
            Guid scheduleId,
            Guid sourceLiquidAccountId,
            DateTime paymentDate,
            CancellationToken cancellationToken = default)
        {
            var schedule = _store.InstallmentSchedules.FirstOrDefault(s => s.Id == scheduleId);
            if (schedule == null)
            {
                throw new DomainInvariantException(
                    "SCHEDULE_NOT_FOUND",
                    "Installment schedule record was not found.",
                    "未找到该期分期账单记录。");
            }

            if (schedule.Status == InstallmentStatus.PAID)
            {
                throw new DomainInvariantException(
                    "SCHEDULE_ALREADY_PAID",
                    "This installment schedule has already been paid.",
                    "该期分期账单已结清。");
            }

            var plan = _store.InstallmentPlans.FirstOrDefault(p => p.Id == schedule.InstallmentPlanId);
            var liabilityAccount = plan != null
                ? _store.Accounts.FirstOrDefault(a => a.Id == plan.LiabilityAccountId)
                : null;
            var sourceLiquidAccount = _store.Accounts.FirstOrDefault(a => a.Id == sourceLiquidAccountId);

            if (plan == null || liabilityAccount == null || sourceLiquidAccount == null || sourceLiquidAccount.Pillar != PillarType.ASSET_LIQUID)
            {
                throw new DomainInvariantException(
                    "INVALID_INSTALLMENT_REPAYMENT_ACCOUNTS",
                    "Valid source liquid account and liability account are required to pay an installment.",
                    "偿还分期账单需要有效的流动资产扣款账户与负债账户。");
            }

            if (sourceLiquidAccount.CurrentBalance < schedule.TotalDue)
            {
                throw new DomainInvariantException(
                    "INSUFFICIENT_FUNDS_FOR_INSTALLMENT",
                    $"Insufficient balance in {sourceLiquidAccount.NameEn} to pay installment of RM {schedule.TotalDue:F2}.",
                    $"{sourceLiquidAccount.NameZh} 余额不足以偿还本期分期款项 RM {schedule.TotalDue:F2}。");
            }

            await _store.ExecuteInTransactionAsync(async () =>
            {
                decimal prevLiquidBalance = sourceLiquidAccount.CurrentBalance;

                sourceLiquidAccount.CurrentBalance = Math.Round(sourceLiquidAccount.CurrentBalance - schedule.TotalDue, 2, MidpointRounding.AwayFromZero);
                sourceLiquidAccount.UpdatedAtUtc = DateTime.UtcNow;

                liabilityAccount.CurrentBalance = Math.Round(Math.Max(0m, liabilityAccount.CurrentBalance - schedule.TotalDue), 2, MidpointRounding.AwayFromZero);
                liabilityAccount.UpdatedAtUtc = DateTime.UtcNow;

                schedule.Status = InstallmentStatus.PAID;
                schedule.PaidAtUtc = paymentDate;

                var paymentTx = new LedgerTransaction
                {
                    Id = Guid.NewGuid(),
                    TransactionDate = paymentDate,
                    Type = TransactionType.TRANSFER,
                    SourceAccountId = sourceLiquidAccount.Id,
                    SourceAccount = sourceLiquidAccount,
                    DestinationAccountId = liabilityAccount.Id,
                    DestinationAccount = liabilityAccount,
                    CategoryId = plan.CategoryId,
                    InstallmentPlanId = plan.Id,
                    InstallmentScheduleId = schedule.Id,
                    TotalAmount = schedule.TotalDue,
                    PersonalAmount = 0m, // Monthly installment slice is already counted via InstallmentSchedule for the month
                    ReceivableAmount = 0m,
                    DescriptionEn = $"{plan.MerchantOrTitleEn} (Installment {schedule.InstallmentNumber}/{plan.TenureMonths})",
                    DescriptionZh = $"{plan.MerchantOrTitleZh} (分期付款第 {schedule.InstallmentNumber}/{plan.TenureMonths} 期)"
                };

                schedule.PaymentTransactionId = paymentTx.Id;
                _store.LedgerTransactions.Add(paymentTx);

                bool allPaid = _store.InstallmentSchedules
                    .Where(s => s.InstallmentPlanId == plan.Id)
                    .All(s => s.Status == InstallmentStatus.PAID);
                if (allPaid)
                {
                    plan.IsActive = false;
                }

                _yieldService.OnAccountBalanceChanged(sourceLiquidAccount.Id, prevLiquidBalance, sourceLiquidAccount.CurrentBalance, paymentDate);
                await _store.SaveChangesAsync(cancellationToken);
            }, cancellationToken);

            return schedule;
        }

        public InstallmentPlanProgressDto GetInstallmentPlanProgress(Guid planId)
        {
            var plan = _store.InstallmentPlans.FirstOrDefault(p => p.Id == planId);
            if (plan == null)
            {
                throw new DomainInvariantException(
                    "INSTALLMENT_PLAN_NOT_FOUND",
                    "Installment plan was not found.",
                    "未找到分期付款计划。");
            }

            var schedules = _store.InstallmentSchedules
                .Where(s => s.InstallmentPlanId == plan.Id)
                .OrderBy(s => s.InstallmentNumber)
                .ToList();

            int paidCount = schedules.Count(s => s.Status == InstallmentStatus.PAID);
            decimal remainingBalance = schedules
                .Where(s => s.Status != InstallmentStatus.PAID)
                .Sum(s => s.TotalDue);

            return new InstallmentPlanProgressDto
            {
                PlanId = plan.Id,
                MerchantOrTitleEn = plan.MerchantOrTitleEn,
                MerchantOrTitleZh = plan.MerchantOrTitleZh,
                TotalPayable = plan.TotalPayable,
                MonthlyInstallmentAmount = plan.MonthlyInstallmentAmount,
                PaidMonthsCount = paidCount,
                TotalTenureMonths = plan.TenureMonths,
                RemainingBalance = remainingBalance,
                ProgressLabelEn = $"{paidCount} of {plan.TenureMonths} paid, RM {remainingBalance:F2} remaining",
                ProgressLabelZh = $"分期付款计划 ({plan.MerchantOrTitleZh} {plan.TenureMonths}期)：已还 {paidCount}/{plan.TenureMonths} 期，剩余 RM {remainingBalance:F2}"
            };
        }

        public decimal GetMonthlyInstallmentCashflowCommitment(int year, int month)
        {
            return _store.InstallmentSchedules
                .Where(s => s.DueDate.Year == year && s.DueDate.Month == month)
                .Sum(s => s.TotalDue);
        }

        /// <summary>
        /// Invariant #4 Formula:
        /// DSR (%) = (Total Monthly Debt & BNPL Repayments / Net Monthly Income) * 100
        /// Also reports Credit Card Statement Float separately so users clearly see 100% payoff float vs amortized debt.
        /// </summary>
        public DsrSummaryDto CalculateDebtServiceRatio(int year, int month, decimal? overrideNetMonthlyIncome = null)
        {
            decimal netMonthlyIncome = overrideNetMonthlyIncome ?? _store.LedgerTransactions
                .Where(t => t.Type == TransactionType.INCOME &&
                            t.TransactionDate.Year == year &&
                            t.TransactionDate.Month == month)
                .Sum(t => t.TotalAmount);

            decimal monthlyDebtRepayments = GetMonthlyInstallmentCashflowCommitment(year, month);

            decimal statementFloatTotal = _store.Accounts
                .Where(a => a.Pillar == PillarType.LIABILITY &&
                            a.LiabilityType == LiabilityType.CREDIT_CARD_STATEMENT &&
                            a.IsActive)
                .Sum(a => a.CurrentBalance);

            decimal dsrPercent = netMonthlyIncome > 0m
                ? Math.Round((monthlyDebtRepayments / netMonthlyIncome) * 100m, 2, MidpointRounding.AwayFromZero)
                : 0m;

            string statusEn;
            string statusZh;

            if (dsrPercent <= 30m)
            {
                statusEn = "Healthy Debt Service Ratio (<= 30%)";
                statusZh = "债务偿还比率健康 (<= 30%)";
            }
            else if (dsrPercent <= 50m)
            {
                statusEn = "Moderate Debt Service Ratio (30% - 50%)";
                statusZh = "债务偿还比率适中 (30% - 50%)";
            }
            else
            {
                statusEn = "High Debt Service Ratio Warning (> 50%)";
                statusZh = "高债务偿还比率预警 (> 50%)";
            }

            return new DsrSummaryDto
            {
                NetMonthlyIncome = Math.Round(netMonthlyIncome, 2, MidpointRounding.AwayFromZero),
                MonthlyInstallmentAndLoanRepayments = Math.Round(monthlyDebtRepayments, 2, MidpointRounding.AwayFromZero),
                CreditCardStatementFloatTotal = Math.Round(statementFloatTotal, 2, MidpointRounding.AwayFromZero),
                DsrPercentage = dsrPercent,
                StatusEn = statusEn,
                StatusZh = statusZh
            };
        }
    }
}

