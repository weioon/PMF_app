using System;
using System.Collections.Generic;
using System.Linq;
using Pfm.Application.DTOs;
using Pfm.Application.Interfaces;
using Pfm.Domain.Entities;
using Pfm.Domain.Enums;
using Pfm.Domain.Exceptions;

namespace Pfm.Application.Services
{
    /// <summary>
    /// Enforces Non-Negotiable Financial Domain Invariant #2:
    /// Dynamic 4-Pillar Scalability (Unlimited User Freedom) + Real-Time Roll-Up Summary Views
    /// across ASSET_LIQUID, ASSET_INVESTMENT, LIABILITY, and INCOME_SOURCE.
    /// </summary>
    public class PillarRollUpService : IPillarRollUpService
    {
        private readonly IPfmDataStore _store;
        private readonly IDoubleEntryLedgerService _ledgerService;
        private readonly IInstallmentEngineService _installmentService;
        private readonly IInvestmentYieldService _yieldService;
        private readonly IGuardrailRuleEngine _ruleEngine;

        public PillarRollUpService(
            IPfmDataStore store,
            IDoubleEntryLedgerService ledgerService,
            IInstallmentEngineService installmentService,
            IInvestmentYieldService yieldService,
            IGuardrailRuleEngine ruleEngine)
        {
            _store = store ?? throw new ArgumentNullException(nameof(store));
            _ledgerService = ledgerService ?? throw new ArgumentNullException(nameof(ledgerService));
            _installmentService = installmentService ?? throw new ArgumentNullException(nameof(installmentService));
            _yieldService = yieldService ?? throw new ArgumentNullException(nameof(yieldService));
            _ruleEngine = ruleEngine ?? throw new ArgumentNullException(nameof(ruleEngine));
        }

        public AccountSubType CreateCustomSubType(
            PillarType pillar,
            string code,
            string nameEn,
            string nameZh,
            int sortOrder = 100)
        {
            if (string.IsNullOrWhiteSpace(nameEn) && string.IsNullOrWhiteSpace(nameZh))
            {
                throw new DomainInvariantException(
                    "SUBTYPE_NAME_REQUIRED",
                    "Sub-type name is required in English or Mandarin.",
                    "必须提供英文或中文的子类别名称。");
            }

            var subType = new AccountSubType
            {
                Id = Guid.NewGuid(),
                Pillar = pillar,
                Code = string.IsNullOrWhiteSpace(code) ? Guid.NewGuid().ToString("N").Substring(0, 8).ToUpperInvariant() : code,
                NameEn = string.IsNullOrWhiteSpace(nameEn) ? nameZh : nameEn,
                NameZh = string.IsNullOrWhiteSpace(nameZh) ? nameEn : nameZh,
                IsSystemSeeded = false,
                SortOrder = sortOrder
            };

            _store.AccountSubTypes.Add(subType);
            return subType;
        }

        public Account CreateCustomAccount(
            Guid subTypeId,
            string nameEn,
            string nameZh,
            decimal openingBalance,
            decimal minBalanceLimit = 0m,
            InterestCalculationMethod interestMethod = InterestCalculationMethod.NONE,
            decimal annualInterestRate = 0m,
            LiabilityType liabilityType = LiabilityType.NONE,
            bool isZeroInterestLiquidAccount = false)
        {
            var subType = _store.AccountSubTypes.FirstOrDefault(s => s.Id == subTypeId);
            if (subType == null)
            {
                throw new DomainInvariantException(
                    "SUBTYPE_NOT_FOUND",
                    "Account sub-type was not found.",
                    "未找到所属账户子类别。");
            }

            var account = new Account
            {
                Id = Guid.NewGuid(),
                AccountSubTypeId = subType.Id,
                AccountSubType = subType,
                Pillar = subType.Pillar,
                NameEn = string.IsNullOrWhiteSpace(nameEn) ? nameZh : nameEn,
                NameZh = string.IsNullOrWhiteSpace(nameZh) ? nameEn : nameZh,
                Currency = "MYR",
                CurrentBalance = Math.Round(openingBalance, 2, MidpointRounding.AwayFromZero),
                MinBalanceLimit = Math.Round(minBalanceLimit, 2, MidpointRounding.AwayFromZero),
                InterestMethod = interestMethod,
                AnnualInterestRate = annualInterestRate,
                LiabilityType = liabilityType,
                IsZeroInterestLiquidAccount = isZeroInterestLiquidAccount,
                IsActive = true
            };

            _store.Accounts.Add(account);
            if (!subType.Accounts.Contains(account))
            {
                subType.Accounts.Add(account);
            }

            return account;
        }

        private struct PillarColumnInfo
        {
            public PillarType Pillar;
            public string NameEn;
            public string NameZh;

            public PillarColumnInfo(PillarType pillar, string nameEn, string nameZh)
            {
                Pillar = pillar;
                NameEn = nameEn;
                NameZh = nameZh;
            }
        }

        public DashboardRollUpResponseDto GetDashboardRollUp(DateTime asOfDate)
        {
            var pillarDefinitions = new[]
            {
                new PillarColumnInfo(PillarType.ASSET_LIQUID, "Liquid Assets", "流动资产 (现金 / 银行 / 电子钱包)"),
                new PillarColumnInfo(PillarType.ASSET_INVESTMENT, "Investment Assets", "投资资产 (ASNB / 定存 / 基金)"),
                new PillarColumnInfo(PillarType.LIABILITY, "Liabilities & Credit", "负债与信贷 (SPayLater / 信用卡 / 贷款)"),
                new PillarColumnInfo(PillarType.INCOME_SOURCE, "Income Sources", "收入来源 (薪资 / 兼职 / 分红)")
            };

            var pillarRollUps = new List<PillarRollUpDto>();

            foreach (var def in pillarDefinitions)
            {
                var subTypes = _store.AccountSubTypes
                    .Where(st => st.Pillar == def.Pillar)
                    .OrderBy(st => st.SortOrder)
                    .ToList();

                var subTypeDtos = new List<SubTypeRollUpDto>();

                foreach (var st in subTypes)
                {
                    var accounts = _store.Accounts
                        .Where(a => a.AccountSubTypeId == st.Id && a.IsActive)
                        .ToList();

                    var accountDtos = new List<AccountSummaryDto>();

                    foreach (var acc in accounts)
                    {
                        DateTime windowEnd = asOfDate.Date.AddDays(acc.LookAheadAlertDays);

                        decimal envelopesLocked = _store.VirtualEnvelopes
                            .Where(e => e.AccountId == acc.Id && e.IsActive)
                            .Sum(e => e.AllocatedBalance);

                        decimal upcomingAutoDebits = _store.RecurringAutoDebits
                            .Where(d => d.AccountId == acc.Id &&
                                        d.IsActive &&
                                        d.NextDueDate.Date >= asOfDate.Date &&
                                        d.NextDueDate.Date <= windowEnd)
                            .Sum(d => d.Amount);

                        var linkedPlanIds = _store.InstallmentPlans
                            .Where(p => p.LinkedRepaymentAccountId == acc.Id && p.IsActive)
                            .Select(p => p.Id)
                            .ToHashSet();

                        decimal linkedInstallmentsDue = _store.InstallmentSchedules
                            .Where(s => linkedPlanIds.Contains(s.InstallmentPlanId) &&
                                        s.Status != InstallmentStatus.PAID &&
                                        s.DueDate.Date >= asOfDate.Date &&
                                        s.DueDate.Date <= windowEnd)
                            .Sum(s => s.TotalDue);

                        decimal unrestricted = acc.Pillar == PillarType.ASSET_LIQUID
                            ? _ledgerService.CalculateUnrestrictedSpendableBalance(acc.Id, asOfDate)
                            : 0m;

                        decimal monthlyYield = 0m;
                        if (acc.InterestMethod == InterestCalculationMethod.ASNB_MIN_MONTHLY)
                        {
                            var snap = _yieldService.EnsureMonthlySnapshot(acc.Id, asOfDate.Year, asOfDate.Month);
                            monthlyYield = snap.AccruedDividendOrInterest;
                        }
                        else if (acc.InterestMethod == InterestCalculationMethod.DAILY_COMPOUND)
                        {
                            monthlyYield = _yieldService.CalculateDailyCompoundInterest(
                                acc.CurrentBalance, acc.AnnualInterestRate, DateTime.DaysInMonth(asOfDate.Year, asOfDate.Month));
                        }

                        decimal monthlyInstallmentCommitment = 0m;
                        if (acc.Pillar == PillarType.LIABILITY)
                        {
                            var planIds = _store.InstallmentPlans
                                .Where(p => p.LiabilityAccountId == acc.Id && p.IsActive)
                                .Select(p => p.Id)
                                .ToHashSet();

                            monthlyInstallmentCommitment = _store.InstallmentSchedules
                                .Where(s => planIds.Contains(s.InstallmentPlanId) &&
                                            s.DueDate.Year == asOfDate.Year &&
                                            s.DueDate.Month == asOfDate.Month)
                                .Sum(s => s.TotalDue);
                        }

                        accountDtos.Add(new AccountSummaryDto
                        {
                            AccountId = acc.Id,
                            Pillar = acc.Pillar,
                            NameEn = acc.NameEn,
                            NameZh = acc.NameZh,
                            CurrentBalance = acc.CurrentBalance,
                            MinBalanceLimit = acc.MinBalanceLimit,
                            VirtualEnvelopesLockedBalance = envelopesLocked,
                            UpcomingAutoDebitsInWindow = upcomingAutoDebits,
                            LinkedInstallmentsInWindow = linkedInstallmentsDue,
                            UnrestrictedSpendableBalance = unrestricted,
                            MonthlyAccruedYield = monthlyYield,
                            MonthlyInstallmentCommitment = monthlyInstallmentCommitment
                        });
                    }

                    subTypeDtos.Add(new SubTypeRollUpDto
                    {
                        SubTypeId = st.Id,
                        Code = st.Code,
                        NameEn = st.NameEn,
                        NameZh = st.NameZh,
                        TotalBalance = accountDtos.Sum(a => a.CurrentBalance),
                        TotalUnrestrictedSpendable = accountDtos.Sum(a => a.UnrestrictedSpendableBalance),
                        TotalLockedInEnvelopes = accountDtos.Sum(a => a.VirtualEnvelopesLockedBalance),
                        TotalMonthlyYield = accountDtos.Sum(a => a.MonthlyAccruedYield),
                        TotalMonthlyInstallmentCommitment = accountDtos.Sum(a => a.MonthlyInstallmentCommitment),
                        Accounts = accountDtos
                    });
                }

                pillarRollUps.Add(new PillarRollUpDto
                {
                    Pillar = def.Pillar,
                    NameEn = def.NameEn,
                    NameZh = def.NameZh,
                    TotalBalance = subTypeDtos.Sum(s => s.TotalBalance),
                    TotalUnrestrictedSpendable = subTypeDtos.Sum(s => s.TotalUnrestrictedSpendable),
                    TotalLockedInEnvelopes = subTypeDtos.Sum(s => s.TotalLockedInEnvelopes),
                    TotalMonthlyYield = subTypeDtos.Sum(s => s.TotalMonthlyYield),
                    TotalMonthlyInstallmentCommitment = subTypeDtos.Sum(s => s.TotalMonthlyInstallmentCommitment),
                    SubTypes = subTypeDtos
                });
            }

            var liquidPillar = pillarRollUps.First(p => p.Pillar == PillarType.ASSET_LIQUID);
            var investmentPillar = pillarRollUps.First(p => p.Pillar == PillarType.ASSET_INVESTMENT);
            var liabilityPillar = pillarRollUps.First(p => p.Pillar == PillarType.LIABILITY);

            decimal totalLiquid = liquidPillar.TotalBalance;
            decimal totalInvestment = investmentPillar.TotalBalance;
            decimal totalLiability = liabilityPillar.TotalBalance;
            decimal netWorth = Math.Round((totalLiquid + totalInvestment) - totalLiability, 2, MidpointRounding.AwayFromZero);

            decimal totalMonthlyYieldAll = liquidPillar.TotalMonthlyYield + investmentPillar.TotalMonthlyYield;
            decimal projectedAnnualYield = Math.Round(totalMonthlyYieldAll * 12m, 2, MidpointRounding.AwayFromZero);

            decimal pendingReceivables = _store.PendingReimbursements
                .Where(r => r.Status != ReimbursementStatus.SETTLED)
                .Sum(r => r.RemainingAmount);

            return new DashboardRollUpResponseDto
            {
                AsOfDate = asOfDate,
                NetWorth = netWorth,
                TotalLiquidAssets = totalLiquid,
                TotalUnrestrictedSafeToSpend = liquidPillar.TotalUnrestrictedSpendable,
                TotalLockedInVirtualEnvelopes = liquidPillar.TotalLockedInEnvelopes,
                TotalInvestmentAssets = totalInvestment,
                TotalProjectedAnnualYield = projectedAnnualYield,
                TotalLiabilities = totalLiability,
                TotalMonthlyInstallmentCommitments = liabilityPillar.TotalMonthlyInstallmentCommitment,
                CurrentMonthPersonalExpenseTotal = _ledgerService.GetMonthlyPersonalExpenseTotal(asOfDate.Year, asOfDate.Month),
                TotalPendingReimbursementsReceivable = Math.Round(pendingReceivables, 2, MidpointRounding.AwayFromZero),
                DsrSummary = _installmentService.CalculateDebtServiceRatio(asOfDate.Year, asOfDate.Month),
                Pillars = pillarRollUps,
                ActiveAlerts = _ruleEngine.EvaluateAllRules(asOfDate).ToList(),
                TaxReliefSummaries = _ledgerService.GetTaxReliefSummary(asOfDate.Year).ToList()
            };
        }

        public IReadOnlyList<CategoryRollUpSummaryDto> GetCategoryRollUpSummaries(
            int year,
            int month,
            DateTime? asOfDate = null)
        {
            DateTime evalDate = asOfDate ?? new DateTime(year, month, Math.Min(15, DateTime.DaysInMonth(year, month)));
            int daysInMonth = DateTime.DaysInMonth(year, month);
            int remainingDays = Math.Max(1, daysInMonth - evalDate.Day);

            var expenseCategories = _store.TransactionCategories
                .Where(c => c.ApplicableType == TransactionType.EXPENSE)
                .OrderBy(c => c.Code)
                .ToList();

            var planById = _store.InstallmentPlans.ToDictionary(p => p.Id, p => p);
            var results = new List<CategoryRollUpSummaryDto>();

            foreach (var cat in expenseCategories)
            {
                var directTxs = _store.LedgerTransactions
                    .Where(t => t.Type == TransactionType.EXPENSE &&
                                t.CategoryId == cat.Id &&
                                t.TransactionDate.Year == year &&
                                t.TransactionDate.Month == month &&
                                !t.InstallmentScheduleId.HasValue)
                    .ToList();

                decimal directPersonal = directTxs.Sum(t => t.PersonalAmount);

                decimal installmentSlices = _store.InstallmentSchedules
                    .Where(s => s.DueDate.Year == year &&
                                s.DueDate.Month == month &&
                                planById.ContainsKey(s.InstallmentPlanId) &&
                                planById[s.InstallmentPlanId].CategoryId == cat.Id)
                    .Sum(s => s.TotalDue);

                decimal totalCommitted = Math.Round(directPersonal + installmentSlices, 2, MidpointRounding.AwayFromZero);
                decimal remainingBudget = Math.Max(0m, Math.Round(cat.MonthlyBudgetLimit - totalCommitted, 2, MidpointRounding.AwayFromZero));
                decimal utilizationPct = cat.MonthlyBudgetLimit > 0m
                    ? Math.Round((totalCommitted / cat.MonthlyBudgetLimit) * 100m, 2, MidpointRounding.AwayFromZero)
                    : 0m;
                decimal dailyCap = Math.Round(remainingBudget / remainingDays, 2, MidpointRounding.AwayFromZero);

                results.Add(new CategoryRollUpSummaryDto
                {
                    CategoryId = cat.Id,
                    Code = cat.Code,
                    NameEn = cat.NameEn,
                    NameZh = cat.NameZh,
                    MonthlyBudgetLimit = cat.MonthlyBudgetLimit,
                    DirectPersonalSpent = Math.Round(directPersonal, 2, MidpointRounding.AwayFromZero),
                    MonthlyInstallmentSliceSpent = Math.Round(installmentSlices, 2, MidpointRounding.AwayFromZero),
                    TotalMonthlyCategoryCommitment = totalCommitted,
                    RemainingBudget = remainingBudget,
                    UtilizationPercentage = utilizationPct,
                    RecommendedDailyCap = dailyCap,
                    TransactionCount = directTxs.Count
                });
            }

            return results;
        }

        public CashflowProjectionCalendarResponseDto Get30DayCashflowProjectionCalendar(
            DateTime startDate,
            decimal expectedMonthlySalaryInflow = 0m,
            int salaryCreditDayOfMonth = 25)
        {
            DateTime startDay = startDate.Date;
            DateTime endDay = startDay.AddDays(29);

            var liquidAccounts = _store.Accounts
                .Where(a => a.Pillar == PillarType.ASSET_LIQUID && a.IsActive)
                .ToList();

            decimal openingLiquid = liquidAccounts.Sum(a => a.CurrentBalance);
            decimal totalFloorsAndEnvelopes = liquidAccounts.Sum(a => a.MinBalanceLimit)
                + _store.VirtualEnvelopes.Where(e => e.IsActive).Sum(e => e.AllocatedBalance);
            decimal openingSafeToSpend = liquidAccounts.Sum(a => _ledgerService.CalculateUnrestrictedSpendableBalance(a.Id, startDay));

            var accountById = _store.Accounts.ToDictionary(a => a.Id, a => a);
            var planById = _store.InstallmentPlans.ToDictionary(p => p.Id, p => p);

            decimal runningLiquid = openingLiquid;
            decimal lowestBalance = openingLiquid;
            DateTime lowestDate = startDay;
            decimal totalOutflows30 = 0m;
            decimal totalInflows30 = 0m;

            var days = new List<CashflowProjectionDayDto>();

            for (int offset = 0; offset < 30; offset++)
            {
                DateTime currentDay = startDay.AddDays(offset);
                var dayEvents = new List<CashflowCalendarEventDto>();

                // 1. Recurring Auto-Debits due on this calendar date or matching BillingDayOfMonth
                var dueDebits = _store.RecurringAutoDebits
                    .Where(d => d.IsActive &&
                                (d.NextDueDate.Date == currentDay ||
                                 (offset > 0 && d.BillingDayOfMonth == currentDay.Day && d.NextDueDate.Date < startDay)))
                    .ToList();

                foreach (var debit in dueDebits)
                {
                    Account? acc = accountById.ContainsKey(debit.AccountId) ? accountById[debit.AccountId] : null;
                    dayEvents.Add(new CashflowCalendarEventDto
                    {
                        EventType = "AUTO_DEBIT",
                        AccountId = debit.AccountId,
                        AccountNameEn = acc != null ? acc.NameEn : "Liquid Account",
                        AccountNameZh = acc != null ? acc.NameZh : "流动资金账户",
                        TitleEn = $"Auto-Debit: {debit.NameEn}",
                        TitleZh = $"自动扣款：{debit.NameZh}",
                        Amount = debit.Amount,
                        IsInflow = false
                    });
                }

                // 2. Unpaid InstallmentSchedules due on this date
                var dueSchedules = _store.InstallmentSchedules
                    .Where(s => s.Status != InstallmentStatus.PAID && s.DueDate.Date == currentDay)
                    .ToList();

                foreach (var sched in dueSchedules)
                {
                    InstallmentPlan? plan = planById.ContainsKey(sched.InstallmentPlanId) ? planById[sched.InstallmentPlanId] : null;
                    Guid? repAccId = plan != null ? plan.LinkedRepaymentAccountId : null;
                    Account? repAcc = (repAccId.HasValue && accountById.ContainsKey(repAccId.Value)) ? accountById[repAccId.Value] : null;

                    dayEvents.Add(new CashflowCalendarEventDto
                    {
                        EventType = "INSTALLMENT_DUE",
                        AccountId = repAccId,
                        AccountNameEn = repAcc != null ? repAcc.NameEn : "Repayment Account",
                        AccountNameZh = repAcc != null ? repAcc.NameZh : "还款账户",
                        TitleEn = plan != null
                            ? $"{plan.MerchantOrTitleEn} ({sched.InstallmentNumber}/{plan.TenureMonths})"
                            : $"Installment #{sched.InstallmentNumber}",
                        TitleZh = plan != null
                            ? $"分期还款：{plan.MerchantOrTitleZh} (第 {sched.InstallmentNumber}/{plan.TenureMonths} 期)"
                            : $"分期账单第 {sched.InstallmentNumber} 期",
                        Amount = sched.TotalDue,
                        IsInflow = false
                    });
                }

                // 3. Optional Projected Monthly Salary Inflow on salaryCreditDayOfMonth
                if (expectedMonthlySalaryInflow > 0m && currentDay.Day == salaryCreditDayOfMonth)
                {
                    dayEvents.Add(new CashflowCalendarEventDto
                    {
                        EventType = "SALARY_INFLOW",
                        TitleEn = "Projected Monthly Salary Inflow",
                        TitleZh = "预计每月薪资入账",
                        Amount = expectedMonthlySalaryInflow,
                        IsInflow = true
                    });
                }

                decimal dayInflows = dayEvents.Where(e => e.IsInflow).Sum(e => e.Amount);
                decimal dayOutflows = dayEvents.Where(e => !e.IsInflow).Sum(e => e.Amount);

                totalInflows30 += dayInflows;
                totalOutflows30 += dayOutflows;

                runningLiquid = Math.Round(runningLiquid + dayInflows - dayOutflows, 2, MidpointRounding.AwayFromZero);
                decimal projectedSafe = Math.Max(0m, Math.Round(runningLiquid - totalFloorsAndEnvelopes, 2, MidpointRounding.AwayFromZero));

                if (runningLiquid < lowestBalance)
                {
                    lowestBalance = runningLiquid;
                    lowestDate = currentDay;
                }

                bool hasWarning = runningLiquid < totalFloorsAndEnvelopes;

                days.Add(new CashflowProjectionDayDto
                {
                    Date = currentDay,
                    DayOffset = offset,
                    TotalInflows = dayInflows,
                    TotalOutflows = dayOutflows,
                    ProjectedTotalLiquidBalance = runningLiquid,
                    ProjectedUnrestrictedSafeToSpend = projectedSafe,
                    HasShortfallWarning = hasWarning,
                    WarningEn = hasWarning
                        ? $"Projected liquid balance (RM {runningLiquid:F2}) dips below locked envelopes + operational floors (RM {totalFloorsAndEnvelopes:F2})."
                        : null,
                    WarningZh = hasWarning
                        ? $"预计流动资金余额 (RM {runningLiquid:F2}) 将低于储蓄信封与最低安全限额总和 (RM {totalFloorsAndEnvelopes:F2})。"
                        : null,
                    Events = dayEvents
                });
            }

            return new CashflowProjectionCalendarResponseDto
            {
                StartDate = startDay,
                EndDate = endDay,
                OpeningLiquidBalance = Math.Round(openingLiquid, 2, MidpointRounding.AwayFromZero),
                OpeningSafeToSpend = Math.Round(openingSafeToSpend, 2, MidpointRounding.AwayFromZero),
                Total30DayScheduledOutflows = Math.Round(totalOutflows30, 2, MidpointRounding.AwayFromZero),
                Total30DayExpectedInflows = Math.Round(totalInflows30, 2, MidpointRounding.AwayFromZero),
                LowestProjectedLiquidBalance = Math.Round(lowestBalance, 2, MidpointRounding.AwayFromZero),
                LowestBalanceDate = lowestDate,
                Days = days
            };
        }

        public IReadOnlyList<VirtualEnvelopeSummaryDto> GetVirtualEnvelopes(Guid? accountId = null)
        {
            var accountById = _store.Accounts.ToDictionary(a => a.Id, a => a);

            return _store.VirtualEnvelopes
                .Where(e => e.IsActive && (!accountId.HasValue || e.AccountId == accountId.Value))
                .Select(e =>
                {
                    Account? acc = accountById.ContainsKey(e.AccountId) ? accountById[e.AccountId] : null;
                    decimal pct = e.TargetAmount > 0m
                        ? Math.Round((e.AllocatedBalance / e.TargetAmount) * 100m, 2, MidpointRounding.AwayFromZero)
                        : 100m;
                    return new VirtualEnvelopeSummaryDto
                    {
                        EnvelopeId = e.Id,
                        AccountId = e.AccountId,
                        AccountNameEn = acc != null ? acc.NameEn : string.Empty,
                        AccountNameZh = acc != null ? acc.NameZh : string.Empty,
                        NameEn = e.NameEn,
                        NameZh = e.NameZh,
                        AllocatedBalance = e.AllocatedBalance,
                        TargetAmount = e.TargetAmount,
                        ProgressPercentage = pct,
                        TargetDate = e.TargetDate
                    };
                })
                .ToList();
        }

        public IReadOnlyList<PendingReimbursementSummaryDto> GetPendingReimbursements(bool includeSettled = true)
        {
            var txById = _store.LedgerTransactions.ToDictionary(t => t.Id, t => t);

            return _store.PendingReimbursements
                .Where(r => includeSettled || r.Status != ReimbursementStatus.SETTLED)
                .Select(r =>
                {
                    LedgerTransaction? tx = txById.ContainsKey(r.OriginalTransactionId) ? txById[r.OriginalTransactionId] : null;
                    return new PendingReimbursementSummaryDto
                    {
                        ReimbursementId = r.Id,
                        OriginalTransactionId = r.OriginalTransactionId,
                        TransactionDate = tx != null ? tx.TransactionDate : r.CreatedAtUtc,
                        DebtorName = r.DebtorName,
                        DescriptionEn = tx != null ? tx.DescriptionEn : "Split Bill Expense",
                        DescriptionZh = tx != null ? tx.DescriptionZh : "AA 分账支出",
                        OwedAmount = r.OwedAmount,
                        SettledAmount = r.SettledAmount,
                        RemainingAmount = r.RemainingAmount,
                        Status = r.Status
                    };
                })
                .ToList();
        }
    }
}
