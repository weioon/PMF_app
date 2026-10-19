using System;
using System.Collections.Generic;
using System.Linq;
using Pfm.Application.DTOs;
using Pfm.Application.Interfaces;
using Pfm.Domain.Entities;
using Pfm.Domain.Enums;

namespace Pfm.Application.Services
{
    /// <summary>
    /// Enforces Non-Negotiable Financial Domain Invariant #6:
    /// Component-Level Guardrails & Proactive Suggestions (Bilingual EN & zh-CN):
    /// - Rule A (Operational Floor): Immediate alert if an account drops below MinBalanceLimit
    ///   (e.g., Touch 'n Go NFC Card < RM 10.00 for toll/parking gates).
    /// - Rule B (Auto-Debit Look-Ahead): Alert if an account balance is below
    ///   MinBalanceLimit + UpcomingAutoDebits + LinkedInstallments due within LookAheadAlertDays.
    ///   Automatically queries other ASSET_LIQUID accounts with surplus funds (e.g., Bank B) to suggest an exact transfer amount.
    /// - Rule C (Idle Cash Sweeper): Between the 25th and last day of the month, if a 0%-interest bank account holds
    ///   excess cash above all buffers/envelopes/auto-debits, suggests transferring the surplus to ASNB before the 1st of next month.
    /// - Rule D (Velocity / Overspending Cap): Suggests concrete daily spending caps when a category spikes.
    /// </summary>
    public class GuardrailRuleEngine : IGuardrailRuleEngine
    {
        private readonly IPfmDataStore _store;
        private readonly IDoubleEntryLedgerService _ledgerService;
        private readonly IInvestmentYieldService _yieldService;

        public GuardrailRuleEngine(
            IPfmDataStore store,
            IDoubleEntryLedgerService ledgerService,
            IInvestmentYieldService yieldService)
        {
            _store = store ?? throw new ArgumentNullException(nameof(store));
            _ledgerService = ledgerService ?? throw new ArgumentNullException(nameof(ledgerService));
            _yieldService = yieldService ?? throw new ArgumentNullException(nameof(yieldService));
        }

        public IReadOnlyList<FinancialAlertDto> EvaluateAllRules(DateTime evaluationDate)
        {
            var alerts = new List<FinancialAlertDto>();

            var liquidAccounts = _store.Accounts
                .Where(a => a.Pillar == PillarType.ASSET_LIQUID && a.IsActive)
                .ToList();

            foreach (var account in liquidAccounts)
            {
                var floorAlert = EvaluateStaticFloorAlert(account.Id);
                if (floorAlert != null)
                {
                    alerts.Add(floorAlert);
                }

                var autoDebitAlert = EvaluateAutoDebitLookAheadAlert(account.Id, evaluationDate);
                if (autoDebitAlert != null)
                {
                    alerts.Add(autoDebitAlert);
                }
            }

            alerts.AddRange(EvaluateIdleCashSweeperAlerts(evaluationDate));
            alerts.AddRange(EvaluateVelocityOverspendingAlerts(evaluationDate));

            return alerts;
        }

        /// <summary>
        /// Rule A (Static Operational Floor):
        /// Immediate alert if Account.CurrentBalance < Account.MinBalanceLimit
        /// (e.g., Touch 'n Go NFC Card drops below RM 10.00 needed for toll/parking gates).
        /// </summary>
        public FinancialAlertDto? EvaluateStaticFloorAlert(Guid accountId)
        {
            var account = _store.Accounts.FirstOrDefault(a => a.Id == accountId && a.IsActive);
            if (account == null || account.Pillar != PillarType.ASSET_LIQUID || account.MinBalanceLimit <= 0m)
            {
                return null;
            }

            if (account.CurrentBalance >= account.MinBalanceLimit)
            {
                return null;
            }

            decimal shortfall = Math.Round(account.MinBalanceLimit - account.CurrentBalance, 2, MidpointRounding.AwayFromZero);

            return new FinancialAlertDto
            {
                RuleCode = AlertRuleCode.RULE_A_STATIC_FLOOR,
                Severity = AlertSeverity.CRITICAL,
                PrimaryAccountId = account.Id,
                SuggestedTransferAmount = shortfall,
                TranslationKey = "ALERT.STATIC_FLOOR_BREACH",
                TranslationParams = new Dictionary<string, string>
                {
                    ["accountNameEn"] = account.NameEn,
                    ["accountNameZh"] = account.NameZh,
                    ["currentBalance"] = account.CurrentBalance.ToString("F2"),
                    ["minLimit"] = account.MinBalanceLimit.ToString("F2"),
                    ["shortfall"] = shortfall.ToString("F2")
                },
                TitleEn = $"{account.NameEn} Low Balance Alert",
                TitleZh = $"{account.NameZh} 余额不足预警",
                MessageEn = $"{account.NameEn} balance (RM {account.CurrentBalance:F2}) has dropped below its operational floor of RM {account.MinBalanceLimit:F2}. Please top up at least RM {shortfall:F2} immediately (e.g., for toll/parking gates).",
                MessageZh = $"{account.NameZh} 当前余额 (RM {account.CurrentBalance:F2}) 已低于最低安全限额 RM {account.MinBalanceLimit:F2}。请立即充值至少 RM {shortfall:F2}，以免影响过路费或停车刷卡。"
            };
        }

        /// <summary>
        /// Rule B (Auto-Debit Look-Ahead):
        /// Checks if Account.CurrentBalance < MinBalanceLimit + UpcomingAutoDebits + LinkedInstallments due within LookAheadAlertDays.
        /// Queries other ASSET_LIQUID accounts with surplus UnrestrictedSpendableBalance to suggest an exact transfer amount.
        /// </summary>
        public FinancialAlertDto? EvaluateAutoDebitLookAheadAlert(Guid accountId, DateTime evaluationDate)
        {
            var account = _store.Accounts.FirstOrDefault(a => a.Id == accountId && a.IsActive);
            if (account == null || account.Pillar != PillarType.ASSET_LIQUID)
            {
                return null;
            }

            DateTime windowEnd = evaluationDate.Date.AddDays(account.LookAheadAlertDays);

            var dueAutoDebits = _store.RecurringAutoDebits
                .Where(d => d.AccountId == account.Id &&
                            d.IsActive &&
                            d.NextDueDate.Date >= evaluationDate.Date &&
                            d.NextDueDate.Date <= windowEnd)
                .ToList();

            var linkedPlanIds = _store.InstallmentPlans
                .Where(p => p.LinkedRepaymentAccountId == account.Id && p.IsActive)
                .ToDictionary(p => p.Id, p => p);

            var dueInstallments = _store.InstallmentSchedules
                .Where(s => linkedPlanIds.ContainsKey(s.InstallmentPlanId) &&
                            s.Status != InstallmentStatus.PAID &&
                            s.DueDate.Date >= evaluationDate.Date &&
                            s.DueDate.Date <= windowEnd)
                .ToList();

            decimal autoDebitTotal = dueAutoDebits.Sum(d => d.Amount);
            decimal installmentTotal = dueInstallments.Sum(s => s.TotalDue);
            decimal totalCommitments = autoDebitTotal + installmentTotal;

            if (totalCommitments <= 0m)
            {
                return null;
            }

            decimal requiredBalance = Math.Round(account.MinBalanceLimit + totalCommitments, 2, MidpointRounding.AwayFromZero);
            if (account.CurrentBalance >= requiredBalance)
            {
                return null;
            }

            decimal shortfall = Math.Round(requiredBalance - account.CurrentBalance, 2, MidpointRounding.AwayFromZero);

            var commitmentNamesEn = dueAutoDebits.Select(d => d.NameEn)
                .Concat(dueInstallments.Select(s => linkedPlanIds[s.InstallmentPlanId].MerchantOrTitleEn))
                .ToList();
            var commitmentNamesZh = dueAutoDebits.Select(d => d.NameZh)
                .Concat(dueInstallments.Select(s => linkedPlanIds[s.InstallmentPlanId].MerchantOrTitleZh))
                .ToList();

            string commitmentsEn = string.Join(", ", commitmentNamesEn);
            string commitmentsZh = string.Join("、", commitmentNamesZh);

            // Automatically query other ASSET_LIQUID accounts with surplus UnrestrictedSpendableBalance >= shortfall,
            // prioritizing 0%-interest reserve accounts (e.g., Bank B) before interest-bearing accounts.
            var candidateSurplusAccount = _store.Accounts
                .Where(a => a.Pillar == PillarType.ASSET_LIQUID && a.IsActive && a.Id != account.Id)
                .Select(a => new
                {
                    Account = a,
                    Surplus = _ledgerService.CalculateUnrestrictedSpendableBalance(a.Id, evaluationDate)
                })
                .Where(x => x.Surplus >= shortfall)
                .OrderByDescending(x => x.Account.IsZeroInterestLiquidAccount)
                .ThenByDescending(x => x.Surplus)
                .FirstOrDefault();

            string surplusNameEn = candidateSurplusAccount?.Account.NameEn ?? "another liquid account";
            string surplusNameZh = candidateSurplusAccount?.Account.NameZh ?? "其他流动资金账户";

            return new FinancialAlertDto
            {
                RuleCode = AlertRuleCode.RULE_B_AUTODEBIT_LOOKAHEAD,
                Severity = AlertSeverity.WARNING,
                PrimaryAccountId = account.Id,
                SuggestedCounterpartyAccountId = candidateSurplusAccount?.Account.Id,
                SuggestedTransferAmount = shortfall,
                TranslationKey = "ALERT.LOW_AUTODEBIT_BALANCE",
                TranslationParams = new Dictionary<string, string>
                {
                    ["accountNameEn"] = account.NameEn,
                    ["accountNameZh"] = account.NameZh,
                    ["commitmentsEn"] = commitmentsEn,
                    ["commitmentsZh"] = commitmentsZh,
                    ["requiredAmount"] = requiredBalance.ToString("F2"),
                    ["currentBalance"] = account.CurrentBalance.ToString("F2"),
                    ["shortfall"] = shortfall.ToString("F2"),
                    ["lookAheadDays"] = account.LookAheadAlertDays.ToString(),
                    ["surplusAccountNameEn"] = surplusNameEn,
                    ["surplusAccountNameZh"] = surplusNameZh
                },
                TitleEn = "Upcoming Auto-Debit Shortfall Warning",
                TitleZh = "自动扣款余额不足提醒",
                MessageEn = $"{account.NameEn} requires RM {requiredBalance:F2} (including RM {account.MinBalanceLimit:F2} floor) for upcoming {commitmentsEn} within {account.LookAheadAlertDays} days, but currently holds RM {account.CurrentBalance:F2}. Suggested Action: Transfer RM {shortfall:F2} from {surplusNameEn} to {account.NameEn}.",
                MessageZh = $"{account.NameZh} 在未来 {account.LookAheadAlertDays} 天内需扣款【{commitmentsZh}】共需 RM {requiredBalance:F2}（含最低安全限额 RM {account.MinBalanceLimit:F2}），当前余额仅为 RM {account.CurrentBalance:F2}。智能建议：立即从 {surplusNameZh} 转入 RM {shortfall:F2} 至 {account.NameZh}。"
            };
        }

        /// <summary>
        /// Rule C (Month-End Idle Cash Sweeper):
        /// Between the 25th and the last day of the month, checks 0%-interest liquid bank accounts for excess
        /// UnrestrictedSpendableBalance above buffers/envelopes/auto-debits and suggests sweeping to ASNB before the 1st.
        /// </summary>
        public IReadOnlyList<FinancialAlertDto> EvaluateIdleCashSweeperAlerts(
            DateTime evaluationDate,
            decimal idleSweepThreshold = 100.00m)
        {
            var results = new List<FinancialAlertDto>();

            // Rule C triggers between the 25th and the last day of the calendar month
            if (evaluationDate.Day < 25)
            {
                return results;
            }

            var targetAsnbAccount = _store.Accounts
                .FirstOrDefault(a => a.Pillar == PillarType.ASSET_INVESTMENT &&
                                     a.InterestMethod == InterestCalculationMethod.ASNB_MIN_MONTHLY &&
                                     a.IsActive);

            if (targetAsnbAccount == null)
            {
                return results;
            }

            var zeroInterestAccounts = _store.Accounts
                .Where(a => a.Pillar == PillarType.ASSET_LIQUID &&
                            a.IsZeroInterestLiquidAccount &&
                            a.IsActive)
                .ToList();

            foreach (var sourceAccount in zeroInterestAccounts)
            {
                decimal surplusCash = _ledgerService.CalculateUnrestrictedSpendableBalance(sourceAccount.Id, evaluationDate);
                if (surplusCash >= idleSweepThreshold)
                {
                    decimal projectedMonthlyDividend = _yieldService.CalculateAsnbMonthlyDividend(
                        surplusCash, targetAsnbAccount.AnnualInterestRate);

                    results.Add(new FinancialAlertDto
                    {
                        RuleCode = AlertRuleCode.RULE_C_IDLE_CASH_SWEEPER,
                        Severity = AlertSeverity.INFO,
                        PrimaryAccountId = sourceAccount.Id,
                        SuggestedCounterpartyAccountId = targetAsnbAccount.Id,
                        SuggestedTransferAmount = surplusCash,
                        TranslationKey = "ALERT.IDLE_CASH_SWEEPER",
                        TranslationParams = new Dictionary<string, string>
                        {
                            ["sourceAccountNameEn"] = sourceAccount.NameEn,
                            ["sourceAccountNameZh"] = sourceAccount.NameZh,
                            ["asnbAccountNameEn"] = targetAsnbAccount.NameEn,
                            ["asnbAccountNameZh"] = targetAsnbAccount.NameZh,
                            ["surplusAmount"] = surplusCash.ToString("F2"),
                            ["projectedMonthlyYield"] = projectedMonthlyDividend.ToString("F2"),
                            ["annualRate"] = targetAsnbAccount.AnnualInterestRate.ToString("F2")
                        },
                        TitleEn = "Month-End ASNB Idle Cash Sweeper",
                        TitleZh = "月末闲置资金转入 ASNB 智能建议",
                        MessageEn = $"After locking Virtual Envelopes, operational floor, and upcoming auto-debits, {sourceAccount.NameEn} holds RM {surplusCash:F2} in 0% idle cash. Sweep RM {surplusCash:F2} into {targetAsnbAccount.NameEn} before the 1st of next month to capture ~RM {projectedMonthlyDividend:F2}/month in dividends ({targetAsnbAccount.AnnualInterestRate:F2}% p.a.).",
                        MessageZh = $"扣除所有专属储蓄信封、最低安全限额及近期自动扣款后，{sourceAccount.NameZh} 仍有 RM {surplusCash:F2} 零息闲置资金。建议在次月1日前转入 {targetAsnbAccount.NameZh}，即可享受整月全额分红（按年化 {targetAsnbAccount.AnnualInterestRate:F2}% 预计每月多赚 RM {projectedMonthlyDividend:F2}）。"
                    });
                }
            }

            return results;
        }

        /// <summary>
        /// Rule D (Category Velocity / Overspending Cap):
        /// Detects when category spending exceeds pro-rated monthly pace and recommends a concrete daily spending cap.
        /// </summary>
        public IReadOnlyList<FinancialAlertDto> EvaluateVelocityOverspendingAlerts(DateTime evaluationDate)
        {
            var results = new List<FinancialAlertDto>();
            int daysInMonth = DateTime.DaysInMonth(evaluationDate.Year, evaluationDate.Month);
            int elapsedDays = Math.Max(1, evaluationDate.Day);
            int remainingDays = Math.Max(1, daysInMonth - evaluationDate.Day);
            decimal monthProgressRatio = (decimal)elapsedDays / daysInMonth;

            var budgetedCategories = _store.TransactionCategories
                .Where(c => c.ApplicableType == TransactionType.EXPENSE && c.MonthlyBudgetLimit > 0m)
                .ToList();

            foreach (var category in budgetedCategories)
            {
                decimal spentSoFar = _store.LedgerTransactions
                    .Where(t => t.Type == TransactionType.EXPENSE &&
                                t.CategoryId == category.Id &&
                                t.TransactionDate.Year == evaluationDate.Year &&
                                t.TransactionDate.Month == evaluationDate.Month)
                    .Sum(t => t.PersonalAmount);

                decimal spendRatio = spentSoFar / category.MonthlyBudgetLimit;

                // Trigger velocity warning if user has consumed >= 80% of budget or exceeds pro-rated pace by > 25%
                if (spendRatio >= 0.80m || (spendRatio - monthProgressRatio) >= 0.25m)
                {
                    decimal remainingBudget = Math.Max(0m, category.MonthlyBudgetLimit - spentSoFar);
                    decimal recommendedDailyCap = Math.Round(remainingBudget / remainingDays, 2, MidpointRounding.AwayFromZero);

                    results.Add(new FinancialAlertDto
                    {
                        RuleCode = AlertRuleCode.RULE_D_VELOCITY_OVERSPEND_CAP,
                        Severity = spendRatio >= 1.0m ? AlertSeverity.CRITICAL : AlertSeverity.WARNING,
                        TranslationKey = "ALERT.VELOCITY_OVERSPEND_CAP",
                        TranslationParams = new Dictionary<string, string>
                        {
                            ["categoryNameEn"] = category.NameEn,
                            ["categoryNameZh"] = category.NameZh,
                            ["spentAmount"] = spentSoFar.ToString("F2"),
                            ["budgetLimit"] = category.MonthlyBudgetLimit.ToString("F2"),
                            ["remainingDays"] = remainingDays.ToString(),
                            ["dailyCap"] = recommendedDailyCap.ToString("F2")
                        },
                        TitleEn = $"{category.NameEn} Spending Velocity Alert",
                        TitleZh = $"{category.NameZh} 消费超速预警与每日限额建议",
                        MessageEn = $"You have spent RM {spentSoFar:F2} of your RM {category.MonthlyBudgetLimit:F2} {category.NameEn} budget. To stay on track for the remaining {remainingDays} days of the month, cap daily {category.NameEn} spending at RM {recommendedDailyCap:F2}/day.",
                        MessageZh = $"本月【{category.NameZh}】已消费 RM {spentSoFar:F2}（预算 RM {category.MonthlyBudgetLimit:F2}）。在剩余的 {remainingDays} 天内，建议将该类别每日消费控制在 RM {recommendedDailyCap:F2}/天 以内。"
                    });
                }
            }

            return results;
        }
    }
}

