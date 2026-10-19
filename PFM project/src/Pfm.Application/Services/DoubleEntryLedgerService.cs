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
    /// Enforces Non-Negotiable Financial Domain Invariants #1, #3, and #7:
    /// - Strict Double-Entry Ledger (EXPENSE, INCOME, TRANSFER with optional TransferFee)
    /// - Virtual Envelopes (Sinking Funds) locking funds inside physical bank accounts
    /// - UnrestrictedSpendableBalance = CurrentBalance - MinBalanceLimit - Sum(VirtualEnvelopes.AllocatedBalance) - Sum(UpcomingAutoDebits) - Sum(LinkedInstallments)
    /// - Split Bill Pending Reimbursements & Tax Relief Tagging
    /// </summary>
    public class DoubleEntryLedgerService : IDoubleEntryLedgerService
    {
        private readonly IPfmDataStore _store;
        private readonly IInvestmentYieldService _yieldService;

        public DoubleEntryLedgerService(IPfmDataStore store, IInvestmentYieldService yieldService)
        {
            _store = store ?? throw new ArgumentNullException(nameof(store));
            _yieldService = yieldService ?? throw new ArgumentNullException(nameof(yieldService));
        }

        public async Task<LedgerTransaction> RecordExpenseAsync(
            CreateExpenseRequest request,
            CancellationToken cancellationToken = default)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));
            if (request.TotalAmount <= 0m)
            {
                throw new DomainInvariantException(
                    "INVALID_EXPENSE_AMOUNT",
                    "Expense total amount must be greater than RM 0.00.",
                    "支出总金额必须大于 RM 0.00。");
            }

            if (request.ReceivableAmount < 0m || request.ReceivableAmount > request.TotalAmount)
            {
                throw new DomainInvariantException(
                    "INVALID_SPLIT_BILL_AMOUNT",
                    "Split bill receivable amount must be between RM 0.00 and TotalAmount.",
                    "AA分账待收回金额必须介于 RM 0.00 与总金额之间。");
            }

            var sourceAccount = _store.Accounts.FirstOrDefault(a => a.Id == request.SourceAccountId);
            if (sourceAccount == null)
            {
                throw new DomainInvariantException(
                    "SOURCE_ACCOUNT_NOT_FOUND",
                    "Source account was not found.",
                    "未找到付款账户。");
            }

            LedgerTransaction? createdTx = null;

            await _store.ExecuteInTransactionAsync(async () =>
            {
                decimal previousBalance = sourceAccount.CurrentBalance;
                decimal totalRounded = Math.Round(request.TotalAmount, 2, MidpointRounding.AwayFromZero);
                decimal receivableRounded = Math.Round(request.ReceivableAmount, 2, MidpointRounding.AwayFromZero);
                decimal personalRounded = Math.Round(totalRounded - receivableRounded, 2, MidpointRounding.AwayFromZero);

                bool isCreditCardFloat = false;

                if (sourceAccount.Pillar == PillarType.ASSET_LIQUID)
                {
                    if (sourceAccount.CurrentBalance < totalRounded)
                    {
                        throw new DomainInvariantException(
                            "INSUFFICIENT_FUNDS",
                            $"Insufficient balance in {sourceAccount.NameEn} (Available: RM {sourceAccount.CurrentBalance:F2}, Required: RM {totalRounded:F2}).",
                            $"{sourceAccount.NameZh} 余额不足（可用：RM {sourceAccount.CurrentBalance:F2}，需支付：RM {totalRounded:F2}）。");
                    }

                    sourceAccount.CurrentBalance = Math.Round(sourceAccount.CurrentBalance - totalRounded, 2, MidpointRounding.AwayFromZero);
                }
                else if (sourceAccount.Pillar == PillarType.LIABILITY)
                {
                    // Paying with a Credit Card (Statement Float): increases liability balance and earmarks 100% payoff on statement due date
                    sourceAccount.CurrentBalance = Math.Round(sourceAccount.CurrentBalance + totalRounded, 2, MidpointRounding.AwayFromZero);
                    isCreditCardFloat = sourceAccount.LiabilityType == LiabilityType.CREDIT_CARD_STATEMENT;
                }
                else
                {
                    throw new DomainInvariantException(
                        "INVALID_EXPENSE_SOURCE_PILLAR",
                        "Expenses can only be paid from a Liquid Asset or Liability (Credit Card) account.",
                        "日常支出只能从流动资产账户或负债（信用卡）账户扣除。");
                }

                sourceAccount.UpdatedAtUtc = DateTime.UtcNow;

                createdTx = new LedgerTransaction
                {
                    Id = Guid.NewGuid(),
                    TransactionDate = request.TransactionDate,
                    Type = TransactionType.EXPENSE,
                    SourceAccountId = sourceAccount.Id,
                    SourceAccount = sourceAccount,
                    CategoryId = request.CategoryId,
                    TotalAmount = totalRounded,
                    PersonalAmount = personalRounded,
                    ReceivableAmount = receivableRounded,
                    TaxReliefBucketId = request.TaxReliefBucketId,
                    ReceiptAttachmentUrl = request.ReceiptAttachmentUrl,
                    IsCreditCardStatementFloat = isCreditCardFloat,
                    DescriptionEn = request.DescriptionEn,
                    DescriptionZh = string.IsNullOrWhiteSpace(request.DescriptionZh) ? request.DescriptionEn : request.DescriptionZh
                };

                _store.LedgerTransactions.Add(createdTx);

                if (receivableRounded > 0m)
                {
                    var reimbursement = new PendingReimbursement
                    {
                        Id = Guid.NewGuid(),
                        OriginalTransactionId = createdTx.Id,
                        OriginalTransaction = createdTx,
                        DebtorName = string.IsNullOrWhiteSpace(request.DebtorName) ? "Friends / Group" : request.DebtorName!,
                        OwedAmount = receivableRounded,
                        SettledAmount = 0m,
                        Status = ReimbursementStatus.PENDING
                    };

                    createdTx.PendingReimbursement = reimbursement;
                    _store.PendingReimbursements.Add(reimbursement);
                }

                _yieldService.OnAccountBalanceChanged(sourceAccount.Id, previousBalance, sourceAccount.CurrentBalance, request.TransactionDate);
                await _store.SaveChangesAsync(cancellationToken);
            }, cancellationToken);

            return createdTx!;
        }

        public async Task<LedgerTransaction> RecordIncomeAsync(
            CreateIncomeRequest request,
            CancellationToken cancellationToken = default)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));
            if (request.Amount <= 0m)
            {
                throw new DomainInvariantException(
                    "INVALID_INCOME_AMOUNT",
                    "Income amount must be greater than RM 0.00.",
                    "收入金额必须大于 RM 0.00。");
            }

            var incomeSourceAccount = _store.Accounts.FirstOrDefault(a => a.Id == request.SourceIncomeAccountId);
            var destinationAccount = _store.Accounts.FirstOrDefault(a => a.Id == request.DestinationLiquidAccountId);

            if (incomeSourceAccount == null || incomeSourceAccount.Pillar != PillarType.INCOME_SOURCE)
            {
                throw new DomainInvariantException(
                    "INVALID_INCOME_SOURCE",
                    "Source account must belong to the INCOME_SOURCE pillar.",
                    "收入来源账户必须属于【收入来源】支柱。");
            }

            if (destinationAccount == null ||
                (destinationAccount.Pillar != PillarType.ASSET_LIQUID && destinationAccount.Pillar != PillarType.ASSET_INVESTMENT))
            {
                throw new DomainInvariantException(
                    "INVALID_INCOME_DESTINATION",
                    "Destination account must be a Liquid Asset or Investment Asset account.",
                    "收款账户必须是流动资产或投资资产账户。");
            }

            LedgerTransaction? createdTx = null;

            await _store.ExecuteInTransactionAsync(async () =>
            {
                decimal amountRounded = Math.Round(request.Amount, 2, MidpointRounding.AwayFromZero);
                decimal prevDestBalance = destinationAccount.CurrentBalance;

                // Double-Entry Invariant for INCOME:
                // Increases DestinationAccount.CurrentBalance AND increases IncomeSource total.
                destinationAccount.CurrentBalance = Math.Round(destinationAccount.CurrentBalance + amountRounded, 2, MidpointRounding.AwayFromZero);
                destinationAccount.UpdatedAtUtc = DateTime.UtcNow;

                incomeSourceAccount.CurrentBalance = Math.Round(incomeSourceAccount.CurrentBalance + amountRounded, 2, MidpointRounding.AwayFromZero);
                incomeSourceAccount.UpdatedAtUtc = DateTime.UtcNow;

                createdTx = new LedgerTransaction
                {
                    Id = Guid.NewGuid(),
                    TransactionDate = request.TransactionDate,
                    Type = TransactionType.INCOME,
                    SourceAccountId = incomeSourceAccount.Id,
                    SourceAccount = incomeSourceAccount,
                    DestinationAccountId = destinationAccount.Id,
                    DestinationAccount = destinationAccount,
                    CategoryId = request.CategoryId,
                    TotalAmount = amountRounded,
                    PersonalAmount = amountRounded,
                    ReceivableAmount = 0m,
                    DescriptionEn = request.DescriptionEn,
                    DescriptionZh = string.IsNullOrWhiteSpace(request.DescriptionZh) ? request.DescriptionEn : request.DescriptionZh
                };

                _store.LedgerTransactions.Add(createdTx);

                _yieldService.OnAccountBalanceChanged(destinationAccount.Id, prevDestBalance, destinationAccount.CurrentBalance, request.TransactionDate);
                await _store.SaveChangesAsync(cancellationToken);
            }, cancellationToken);

            return createdTx!;
        }

        public async Task<TransferResultDto> RecordTransferAsync(
            CreateTransferRequest request,
            CancellationToken cancellationToken = default)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));
            if (request.Amount <= 0m)
            {
                throw new DomainInvariantException(
                    "INVALID_TRANSFER_AMOUNT",
                    "Transfer amount must be greater than RM 0.00.",
                    "转账金额必须大于 RM 0.00。");
            }

            if (request.TransferFee < 0m)
            {
                throw new DomainInvariantException(
                    "INVALID_TRANSFER_FEE",
                    "Transfer fee cannot be negative.",
                    "转账手续费不能为负数。");
            }

            if (request.SourceAccountId == request.DestinationAccountId)
            {
                throw new DomainInvariantException(
                    "SAME_ACCOUNT_TRANSFER",
                    "Source and destination accounts cannot be identical.",
                    "转出账户与转入账户不能相同。");
            }

            var sourceAccount = _store.Accounts.FirstOrDefault(a => a.Id == request.SourceAccountId);
            var destinationAccount = _store.Accounts.FirstOrDefault(a => a.Id == request.DestinationAccountId);

            if (sourceAccount == null || destinationAccount == null)
            {
                throw new DomainInvariantException(
                    "TRANSFER_ACCOUNT_NOT_FOUND",
                    "Both source and destination accounts must exist.",
                    "转出账户与转入账户必须存在。");
            }

            LedgerTransaction? transferTx = null;
            LedgerTransaction? feeTx = null;
            FinancialAlertDto? timingTip = null;

            await _store.ExecuteInTransactionAsync(async () =>
            {
                decimal amountRounded = Math.Round(request.Amount, 2, MidpointRounding.AwayFromZero);
                decimal feeRounded = Math.Round(request.TransferFee, 2, MidpointRounding.AwayFromZero);
                decimal totalSourceDeduction = amountRounded + feeRounded;

                if (sourceAccount.CurrentBalance < totalSourceDeduction)
                {
                    throw new DomainInvariantException(
                        "INSUFFICIENT_TRANSFER_FUNDS",
                        $"Insufficient funds in {sourceAccount.NameEn} to transfer RM {amountRounded:F2} + fee RM {feeRounded:F2}.",
                        $"{sourceAccount.NameZh} 余额不足以转出 RM {amountRounded:F2} 及手续费 RM {feeRounded:F2}。");
                }

                decimal prevSourceBalance = sourceAccount.CurrentBalance;
                decimal prevDestBalance = destinationAccount.CurrentBalance;

                // Atomic Double-Entry Transfer:
                // Decreases SourceAccount.CurrentBalance by Amount + Fee
                sourceAccount.CurrentBalance = Math.Round(sourceAccount.CurrentBalance - totalSourceDeduction, 2, MidpointRounding.AwayFromZero);
                sourceAccount.UpdatedAtUtc = DateTime.UtcNow;

                // If DestinationAccount is a LIABILITY (paying off Credit Card statement or loan), decrease liability owed;
                // otherwise increase asset balance.
                if (destinationAccount.Pillar == PillarType.LIABILITY)
                {
                    destinationAccount.CurrentBalance = Math.Round(Math.Max(0m, destinationAccount.CurrentBalance - amountRounded), 2, MidpointRounding.AwayFromZero);
                }
                else
                {
                    destinationAccount.CurrentBalance = Math.Round(destinationAccount.CurrentBalance + amountRounded, 2, MidpointRounding.AwayFromZero);
                }
                destinationAccount.UpdatedAtUtc = DateTime.UtcNow;

                // Strict Invariant: Transfer itself has PersonalAmount = 0m so it NEVER inflates monthly expenses!
                transferTx = new LedgerTransaction
                {
                    Id = Guid.NewGuid(),
                    TransactionDate = request.TransactionDate,
                    Type = TransactionType.TRANSFER,
                    SourceAccountId = sourceAccount.Id,
                    SourceAccount = sourceAccount,
                    DestinationAccountId = destinationAccount.Id,
                    DestinationAccount = destinationAccount,
                    TotalAmount = amountRounded,
                    PersonalAmount = 0m,
                    ReceivableAmount = 0m,
                    TransferFee = feeRounded,
                    DescriptionEn = string.IsNullOrWhiteSpace(request.DescriptionEn)
                        ? $"Transfer from {sourceAccount.NameEn} to {destinationAccount.NameEn}"
                        : request.DescriptionEn,
                    DescriptionZh = string.IsNullOrWhiteSpace(request.DescriptionZh)
                        ? $"从 {sourceAccount.NameZh} 转账至 {destinationAccount.NameZh}"
                        : request.DescriptionZh
                };

                _store.LedgerTransactions.Add(transferTx);

                // Optional TransferFee logs as a separate linked EXPENSE so only the fee counts toward monthly expenses
                if (feeRounded > 0m)
                {
                    var feeCategory = _store.TransactionCategories.FirstOrDefault(c => c.IsSystemFeeCategory)
                                      ?? _store.TransactionCategories.FirstOrDefault();

                    feeTx = new LedgerTransaction
                    {
                        Id = Guid.NewGuid(),
                        TransactionDate = request.TransactionDate,
                        Type = TransactionType.EXPENSE,
                        SourceAccountId = sourceAccount.Id,
                        SourceAccount = sourceAccount,
                        CategoryId = feeCategory?.Id,
                        Category = feeCategory,
                        TotalAmount = feeRounded,
                        PersonalAmount = feeRounded,
                        ReceivableAmount = 0m,
                        DescriptionEn = $"Transfer Fee ({sourceAccount.NameEn} -> {destinationAccount.NameEn})",
                        DescriptionZh = $"转账手续费 ({sourceAccount.NameZh} -> {destinationAccount.NameZh})"
                    };

                    transferTx.LinkedFeeTransactionId = feeTx.Id;
                    _store.LedgerTransactions.Add(feeTx);
                }

                _yieldService.OnAccountBalanceChanged(sourceAccount.Id, prevSourceBalance, sourceAccount.CurrentBalance, request.TransactionDate);
                timingTip = _yieldService.OnAccountBalanceChanged(destinationAccount.Id, prevDestBalance, destinationAccount.CurrentBalance, request.TransactionDate);

                await _store.SaveChangesAsync(cancellationToken);
            }, cancellationToken);

            return new TransferResultDto
            {
                TransferTransaction = transferTx!,
                FeeTransaction = feeTx,
                DepositTimingTip = timingTip
            };
        }

        public async Task<PendingReimbursement> SettleReimbursementAsync(
            SettleReimbursementRequest request,
            CancellationToken cancellationToken = default)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));

            var reimbursement = _store.PendingReimbursements.FirstOrDefault(r => r.Id == request.PendingReimbursementId);
            if (reimbursement == null)
            {
                throw new DomainInvariantException(
                    "REIMBURSEMENT_NOT_FOUND",
                    "Pending reimbursement record was not found.",
                    "未找到待收回的AA分账记录。");
            }

            var destinationAccount = _store.Accounts.FirstOrDefault(a => a.Id == request.DestinationLiquidAccountId);
            if (destinationAccount == null || destinationAccount.Pillar != PillarType.ASSET_LIQUID)
            {
                throw new DomainInvariantException(
                    "INVALID_SETTLEMENT_ACCOUNT",
                    "Reimbursement settlement must be deposited into a Liquid Asset account.",
                    "朋友归还的分账款项必须存入流动资产账户。");
            }

            decimal settleAmount = Math.Round(request.SettlementAmount, 2, MidpointRounding.AwayFromZero);
            if (settleAmount <= 0m || settleAmount > reimbursement.RemainingAmount)
            {
                throw new DomainInvariantException(
                    "INVALID_SETTLEMENT_AMOUNT",
                    $"Settlement amount must be between RM 0.01 and remaining owed RM {reimbursement.RemainingAmount:F2}.",
                    $"结清金额必须介于 RM 0.01 与剩余待收金额 RM {reimbursement.RemainingAmount:F2} 之间。");
            }

            await _store.ExecuteInTransactionAsync(async () =>
            {
                decimal prevBalance = destinationAccount.CurrentBalance;
                destinationAccount.CurrentBalance = Math.Round(destinationAccount.CurrentBalance + settleAmount, 2, MidpointRounding.AwayFromZero);
                destinationAccount.UpdatedAtUtc = DateTime.UtcNow;

                reimbursement.SettledAmount = Math.Round(reimbursement.SettledAmount + settleAmount, 2, MidpointRounding.AwayFromZero);
                reimbursement.Status = reimbursement.SettledAmount >= reimbursement.OwedAmount
                    ? ReimbursementStatus.SETTLED
                    : ReimbursementStatus.PARTIALLY_SETTLED;
                reimbursement.SettledAtUtc = request.SettlementDate;

                // Log as a TRANSFER with IsReimbursementSettlement = true and PersonalAmount = 0m
                // so settling a split bill NEVER inflates personal income or personal expenses!
                var settlementTx = new LedgerTransaction
                {
                    Id = Guid.NewGuid(),
                    TransactionDate = request.SettlementDate,
                    Type = TransactionType.TRANSFER,
                    DestinationAccountId = destinationAccount.Id,
                    DestinationAccount = destinationAccount,
                    TotalAmount = settleAmount,
                    PersonalAmount = 0m,
                    ReceivableAmount = 0m,
                    IsReimbursementSettlement = true,
                    DescriptionEn = $"Split Bill Settlement from {reimbursement.DebtorName}",
                    DescriptionZh = $"收到 {reimbursement.DebtorName} 归还的分账款项"
                };

                reimbursement.SettlementTransactionId = settlementTx.Id;
                _store.LedgerTransactions.Add(settlementTx);

                _yieldService.OnAccountBalanceChanged(destinationAccount.Id, prevBalance, destinationAccount.CurrentBalance, request.SettlementDate);
                await _store.SaveChangesAsync(cancellationToken);
            }, cancellationToken);

            return reimbursement;
        }

        public async Task<VirtualEnvelope> AllocateToVirtualEnvelopeAsync(
            Guid accountId,
            string nameEn,
            string nameZh,
            decimal amountToLock,
            decimal targetAmount,
            DateTime? targetDate = null,
            CancellationToken cancellationToken = default)
        {
            var account = _store.Accounts.FirstOrDefault(a => a.Id == accountId);
            if (account == null || account.Pillar != PillarType.ASSET_LIQUID)
            {
                throw new DomainInvariantException(
                    "INVALID_ENVELOPE_ACCOUNT",
                    "Virtual Envelopes can only be created inside a physical Liquid Asset account.",
                    "专属储蓄信封（专项基金）只能创建在流动资产账户内。");
            }

            decimal roundedLock = Math.Round(amountToLock, 2, MidpointRounding.AwayFromZero);
            decimal availableToLock = CalculateUnrestrictedSpendableBalance(accountId, DateTime.UtcNow);
            if (roundedLock < 0m || roundedLock > availableToLock)
            {
                throw new DomainInvariantException(
                    "INSUFFICIENT_UNRESTRICTED_BALANCE_FOR_ENVELOPE",
                    $"Cannot lock RM {roundedLock:F2} into Virtual Envelope '{nameEn}'. Unrestricted spendable balance is only RM {availableToLock:F2}.",
                    $"无法将 RM {roundedLock:F2} 锁定至储蓄信封“{nameZh}”。当前可自由支配余额仅为 RM {availableToLock:F2}。");
            }

            VirtualEnvelope? envelope = null;

            await _store.ExecuteInTransactionAsync(async () =>
            {
                envelope = _store.VirtualEnvelopes.FirstOrDefault(
                    e => e.AccountId == accountId &&
                         e.NameEn.Equals(nameEn, StringComparison.OrdinalIgnoreCase) &&
                         e.IsActive);

                if (envelope == null)
                {
                    envelope = new VirtualEnvelope
                    {
                        Id = Guid.NewGuid(),
                        AccountId = accountId,
                        Account = account,
                        NameEn = nameEn,
                        NameZh = string.IsNullOrWhiteSpace(nameZh) ? nameEn : nameZh,
                        AllocatedBalance = roundedLock,
                        TargetAmount = Math.Round(targetAmount, 2, MidpointRounding.AwayFromZero),
                        TargetDate = targetDate,
                        IsActive = true
                    };
                    _store.VirtualEnvelopes.Add(envelope);
                    if (!account.VirtualEnvelopes.Contains(envelope))
                    {
                        account.VirtualEnvelopes.Add(envelope);
                    }
                }
                else
                {
                    envelope.AllocatedBalance = Math.Round(envelope.AllocatedBalance + roundedLock, 2, MidpointRounding.AwayFromZero);
                    if (targetAmount > 0m)
                    {
                        envelope.TargetAmount = Math.Round(targetAmount, 2, MidpointRounding.AwayFromZero);
                    }
                    envelope.UpdatedAtUtc = DateTime.UtcNow;
                }

                await _store.SaveChangesAsync(cancellationToken);
            }, cancellationToken);

            return envelope!;
        }

        /// <summary>
        /// Invariant #3 Formula:
        /// UnrestrictedSpendableBalance = CurrentBalance - MinBalanceLimit - Sum(VirtualEnvelopes.AllocatedBalance) - Sum(UpcomingAutoDebits) - Sum(LinkedInstallments)
        /// </summary>
        public decimal CalculateUnrestrictedSpendableBalance(Guid accountId, DateTime asOfDate)
        {
            var account = _store.Accounts.FirstOrDefault(a => a.Id == accountId);
            if (account == null || account.Pillar != PillarType.ASSET_LIQUID)
            {
                return 0m;
            }

            DateTime lookAheadEnd = asOfDate.Date.AddDays(account.LookAheadAlertDays);

            decimal lockedInEnvelopes = _store.VirtualEnvelopes
                .Where(e => e.AccountId == accountId && e.IsActive)
                .Sum(e => e.AllocatedBalance);

            decimal upcomingAutoDebits = _store.RecurringAutoDebits
                .Where(d => d.AccountId == accountId &&
                            d.IsActive &&
                            d.NextDueDate.Date >= asOfDate.Date &&
                            d.NextDueDate.Date <= lookAheadEnd)
                .Sum(d => d.Amount);

            var linkedPlanIds = _store.InstallmentPlans
                .Where(p => p.LinkedRepaymentAccountId == accountId && p.IsActive)
                .Select(p => p.Id)
                .ToHashSet();

            decimal linkedInstallmentsDue = _store.InstallmentSchedules
                .Where(s => linkedPlanIds.Contains(s.InstallmentPlanId) &&
                            s.Status != InstallmentStatus.PAID &&
                            s.DueDate.Date >= asOfDate.Date &&
                            s.DueDate.Date <= lookAheadEnd)
                .Sum(s => s.TotalDue);

            decimal rawUnrestricted = account.CurrentBalance
                                      - account.MinBalanceLimit
                                      - lockedInEnvelopes
                                      - upcomingAutoDebits
                                      - linkedInstallmentsDue;

            return Math.Max(0m, Math.Round(rawUnrestricted, 2, MidpointRounding.AwayFromZero));
        }

        /// <summary>
        /// Computes total personal expenses for the given calendar month:
        /// Sums EXPENSE.PersonalAmount (excluding friend split-bill receivables and excluding all transfers)
        /// PLUS scheduled monthly InstallmentSchedule slices due in that month.
        /// </summary>
        public decimal GetMonthlyPersonalExpenseTotal(int year, int month)
        {
            decimal directPersonalExpenses = _store.LedgerTransactions
                .Where(t => t.Type == TransactionType.EXPENSE &&
                            t.TransactionDate.Year == year &&
                            t.TransactionDate.Month == month &&
                            !t.InstallmentScheduleId.HasValue)
                .Sum(t => t.PersonalAmount);

            decimal installmentSlicesForMonth = _store.InstallmentSchedules
                .Where(s => s.DueDate.Year == year && s.DueDate.Month == month)
                .Sum(s => s.TotalDue);

            return Math.Round(directPersonalExpenses + installmentSlicesForMonth, 2, MidpointRounding.AwayFromZero);
        }

        public IReadOnlyList<TaxReliefSummaryDto> GetTaxReliefSummary(int taxYear)
        {
            var buckets = _store.TaxReliefBuckets
                .Where(b => b.TaxYear == taxYear)
                .OrderBy(b => b.Code)
                .ToList();

            var results = new List<TaxReliefSummaryDto>();

            foreach (var bucket in buckets)
            {
                decimal claimed = _store.LedgerTransactions
                    .Where(t => t.Type == TransactionType.EXPENSE &&
                                t.TaxReliefBucketId == bucket.Id &&
                                t.TransactionDate.Year == taxYear)
                    .Sum(t => t.PersonalAmount);

                decimal effectiveClaimed = Math.Min(bucket.AnnualCap, Math.Round(claimed, 2, MidpointRounding.AwayFromZero));
                decimal remaining = Math.Max(0m, bucket.AnnualCap - effectiveClaimed);
                decimal pct = bucket.AnnualCap > 0m
                    ? Math.Round((effectiveClaimed / bucket.AnnualCap) * 100m, 2, MidpointRounding.AwayFromZero)
                    : 0m;

                results.Add(new TaxReliefSummaryDto
                {
                    BucketId = bucket.Id,
                    TaxYear = bucket.TaxYear,
                    Code = bucket.Code,
                    NameEn = bucket.NameEn,
                    NameZh = bucket.NameZh,
                    AnnualCap = bucket.AnnualCap,
                    ClaimedAmount = effectiveClaimed,
                    RemainingCap = remaining,
                    UtilizationPercentage = pct
                });
            }

            return results;
        }
    }
}
