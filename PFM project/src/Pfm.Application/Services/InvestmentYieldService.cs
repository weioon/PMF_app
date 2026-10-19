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
    /// Enforces Non-Negotiable Financial Domain Invariant #5:
    /// - ASNB_MIN_MONTHLY: Tracks the lowest balance held between Day 1 and the last day of each calendar month.
    ///   MonthlyDividend = (LowestMonthlyBalance * (AnnualRate / 100)) / 12.
    /// - Emits a Smart Deposit Timing Tip if a user deposits into ASNB after the 1st of the month.
    /// - DAILY_COMPOUND: Calculates daily interest EndOfDayBalance * (AnnualRate / 100 / 365).
    /// </summary>
    public class InvestmentYieldService : IInvestmentYieldService
    {
        private readonly IPfmDataStore _store;

        public InvestmentYieldService(IPfmDataStore store)
        {
            _store = store ?? throw new ArgumentNullException(nameof(store));
        }

        public MonthlyAccountSnapshot EnsureMonthlySnapshot(
            Guid accountId,
            int year,
            int month,
            decimal? initialOpeningBalance = null)
        {
            var account = _store.Accounts.FirstOrDefault(a => a.Id == accountId);
            if (account == null)
            {
                throw new DomainInvariantException(
                    "ACCOUNT_NOT_FOUND",
                    "Account was not found for monthly snapshot.",
                    "未找到需要生成月度快照的账户。");
            }

            var existing = _store.MonthlyAccountSnapshots.FirstOrDefault(
                s => s.AccountId == accountId && s.Year == year && s.Month == month);

            if (existing != null)
            {
                return existing;
            }

            decimal opening = initialOpeningBalance ?? account.CurrentBalance;
            decimal dividend = account.InterestMethod == InterestCalculationMethod.ASNB_MIN_MONTHLY
                ? CalculateAsnbMonthlyDividend(opening, account.AnnualInterestRate)
                : account.InterestMethod == InterestCalculationMethod.DAILY_COMPOUND
                    ? CalculateDailyCompoundInterest(opening, account.AnnualInterestRate, DateTime.DaysInMonth(year, month))
                    : 0m;

            var snapshot = new MonthlyAccountSnapshot
            {
                Id = Guid.NewGuid(),
                AccountId = accountId,
                Account = account,
                Year = year,
                Month = month,
                OpeningBalance = Math.Round(opening, 2, MidpointRounding.AwayFromZero),
                LowestMonthlyBalance = Math.Round(opening, 2, MidpointRounding.AwayFromZero),
                ClosingBalance = Math.Round(account.CurrentBalance, 2, MidpointRounding.AwayFromZero),
                AppliedAnnualRate = account.AnnualInterestRate,
                AccruedDividendOrInterest = dividend
            };

            _store.MonthlyAccountSnapshots.Add(snapshot);
            if (!account.MonthlySnapshots.Contains(snapshot))
            {
                account.MonthlySnapshots.Add(snapshot);
            }

            return snapshot;
        }

        public FinancialAlertDto? OnAccountBalanceChanged(
            Guid accountId,
            decimal previousBalance,
            decimal newBalance,
            DateTime transactionDate)
        {
            var account = _store.Accounts.FirstOrDefault(a => a.Id == accountId);
            if (account == null) return null;

            int year = transactionDate.Year;
            int month = transactionDate.Month;

            var snapshot = EnsureMonthlySnapshot(accountId, year, month, previousBalance);
            snapshot.ClosingBalance = Math.Round(newBalance, 2, MidpointRounding.AwayFromZero);

            if (account.InterestMethod == InterestCalculationMethod.ASNB_MIN_MONTHLY)
            {
                if (transactionDate.Day == 1)
                {
                    // On the 1st of the month, deposits increase the Day-1 baseline if no lower balance occurred after Day 1
                    if (newBalance > previousBalance && snapshot.LowestMonthlyBalance == previousBalance)
                    {
                        snapshot.LowestMonthlyBalance = Math.Round(newBalance, 2, MidpointRounding.AwayFromZero);
                    }
                    else if (newBalance < snapshot.LowestMonthlyBalance)
                    {
                        snapshot.LowestMonthlyBalance = Math.Round(newBalance, 2, MidpointRounding.AwayFromZero);
                    }
                }
                else
                {
                    // After the 1st of the month:
                    // - Any withdrawal that drops NewBalance below LowestMonthlyBalance reduces LowestMonthlyBalance for the entire month!
                    // - Any deposit after the 1st does NOT increase LowestMonthlyBalance for the current month (because Day 1 balance was lower).
                    if (newBalance < snapshot.LowestMonthlyBalance)
                    {
                        snapshot.LowestMonthlyBalance = Math.Round(newBalance, 2, MidpointRounding.AwayFromZero);
                    }
                }

                snapshot.AccruedDividendOrInterest = CalculateAsnbMonthlyDividend(
                    snapshot.LowestMonthlyBalance, account.AnnualInterestRate);
                snapshot.UpdatedAtUtc = DateTime.UtcNow;

                // Smart Deposit Timing Tip: If user deposited into ASNB after the 1st of the month
                if (newBalance > previousBalance && transactionDate.Day > 1)
                {
                    decimal depositAmount = Math.Round(newBalance - previousBalance, 2, MidpointRounding.AwayFromZero);
                    decimal missedCurrentMonthDividend = CalculateAsnbMonthlyDividend(depositAmount, account.AnnualInterestRate);

                    var tip = new FinancialAlertDto
                    {
                        RuleCode = AlertRuleCode.ASNB_DEPOSIT_TIMING_TIP,
                        Severity = AlertSeverity.INFO,
                        PrimaryAccountId = account.Id,
                        TranslationKey = "ALERT.ASNB_DEPOSIT_TIMING_TIP",
                        TranslationParams = new Dictionary<string, string>
                        {
                            ["accountNameEn"] = account.NameEn,
                            ["accountNameZh"] = account.NameZh,
                            ["depositAmount"] = depositAmount.ToString("F2"),
                            ["dayOfMonth"] = transactionDate.Day.ToString(),
                            ["missedDividend"] = missedCurrentMonthDividend.ToString("F2")
                        },
                        TitleEn = "ASNB Deposit Timing Tip (Minimum Monthly Balance Rule)",
                        TitleZh = "ASNB 存入时间理财提示（每月最低余额分红规则）",
                        MessageEn = $"You deposited RM {depositAmount:F2} into {account.NameEn} on Day {transactionDate.Day}. Because ASNB calculates monthly dividends on the lowest balance held between Day 1 and month-end (RM {snapshot.LowestMonthlyBalance:F2}), this deposit will start earning full monthly dividends (~RM {missedCurrentMonthDividend:F2}/mo) from next month. Tip: Transfer between the 25th and last day of the month!",
                        MessageZh = $"您于本月第 {transactionDate.Day} 日向 {account.NameZh} 存入了 RM {depositAmount:F2}。由于 ASNB 按每月1日至月末的最低余额 (RM {snapshot.LowestMonthlyBalance:F2}) 计算当月分红，该笔资金将从下月1日起正式计入全月分红基数（预计每月约 RM {missedCurrentMonthDividend:F2}）。小贴士：建议在每月25日至月末之间转入 ASNB！"
                    };

                    return tip;
                }
            }
            else if (account.InterestMethod == InterestCalculationMethod.DAILY_COMPOUND)
            {
                snapshot.LowestMonthlyBalance = Math.Min(snapshot.LowestMonthlyBalance, Math.Round(newBalance, 2, MidpointRounding.AwayFromZero));
                int daysInMonth = DateTime.DaysInMonth(year, month);
                snapshot.AccruedDividendOrInterest = CalculateDailyCompoundInterest(
                    snapshot.ClosingBalance, account.AnnualInterestRate, daysInMonth);
                snapshot.UpdatedAtUtc = DateTime.UtcNow;
            }

            return null;
        }

        /// <summary>
        /// Invariant #5 Formula:
        /// MonthlyDividend = (LowestMonthlyBalance * (AnnualRate / 100)) / 12
        /// </summary>
        public decimal CalculateAsnbMonthlyDividend(decimal lowestMonthlyBalance, decimal annualRatePercent)
        {
            if (lowestMonthlyBalance <= 0m || annualRatePercent <= 0m) return 0m;
            decimal raw = (lowestMonthlyBalance * (annualRatePercent / 100m)) / 12m;
            return Math.Round(raw, 2, MidpointRounding.AwayFromZero);
        }

        /// <summary>
        /// Invariant #5 Formula:
        /// DailyInterest = EndOfDayBalance * (AnnualRate / 100 / 365)
        /// </summary>
        public decimal CalculateDailyCompoundInterest(decimal endOfDayBalance, decimal annualRatePercent, int days = 1)
        {
            if (endOfDayBalance <= 0m || annualRatePercent <= 0m || days <= 0) return 0m;
            decimal dailyRate = (annualRatePercent / 100m) / 365m;
            decimal raw = endOfDayBalance * dailyRate * days;
            return Math.Round(raw, 2, MidpointRounding.AwayFromZero);
        }

        public AsnbDividendSummaryDto GetAsnbDividendProjection(Guid accountId, DateTime asOfDate)
        {
            var account = _store.Accounts.FirstOrDefault(a => a.Id == accountId);
            if (account == null)
            {
                throw new DomainInvariantException(
                    "ACCOUNT_NOT_FOUND",
                    "ASNB account was not found.",
                    "未找到 ASNB 投资账户。");
            }

            var currentSnapshot = EnsureMonthlySnapshot(accountId, asOfDate.Year, asOfDate.Month);

            var snapshotsForYear = _store.MonthlyAccountSnapshots
                .Where(s => s.AccountId == accountId && s.Year == asOfDate.Year && s.Month <= asOfDate.Month)
                .ToList();

            decimal ytdAccrued = snapshotsForYear.Sum(s => s.AccruedDividendOrInterest);
            int remainingMonths = 12 - asOfDate.Month;
            decimal futureMonthlyDividend = CalculateAsnbMonthlyDividend(account.CurrentBalance, account.AnnualInterestRate);
            decimal projectedFullYear = Math.Round(ytdAccrued + (remainingMonths * futureMonthlyDividend), 2, MidpointRounding.AwayFromZero);

            return new AsnbDividendSummaryDto
            {
                AccountId = account.Id,
                AccountNameEn = account.NameEn,
                AccountNameZh = account.NameZh,
                Year = asOfDate.Year,
                Month = asOfDate.Month,
                CurrentBalance = account.CurrentBalance,
                LowestMonthlyBalance = currentSnapshot.LowestMonthlyBalance,
                AnnualDividendRate = account.AnnualInterestRate,
                CurrentMonthAccruedDividend = currentSnapshot.AccruedDividendOrInterest,
                YearToDateAccruedDividend = Math.Round(ytdAccrued, 2, MidpointRounding.AwayFromZero),
                ProjectedFullYearDividend = projectedFullYear
            };
        }
    }
}

