using System;
using System.Linq;
using System.Threading.Tasks;
using Pfm.Application.DTOs;
using Pfm.Application.Services;
using Pfm.Domain.Entities;
using Pfm.Domain.Enums;
using Pfm.Infrastructure.Persistence;
using Pfm.Infrastructure.Persistence.Seed;

namespace Pfm.UnitTests
{
    /// <summary>
    /// Comprehensive Unit Test Suite verifying all 7 Non-Negotiable Financial Domain Invariants
    /// and Bilingual (English en & Mandarin zh-CN) outputs.
    /// Can be executed via xUnit (`dotnet test`) or directly as a standalone test runner.
    /// </summary>
    public class FinancialDomainInvariantTests
    {
        private sealed class SutContext
        {
            public InMemoryPfmDataStore Store { get; set; } = null!;
            public InvestmentYieldService YieldSvc { get; set; } = null!;
            public DoubleEntryLedgerService LedgerSvc { get; set; } = null!;
            public InstallmentEngineService InstallmentSvc { get; set; } = null!;
            public GuardrailRuleEngine RuleEngine { get; set; } = null!;
            public PillarRollUpService RollUpSvc { get; set; } = null!;
        }

        private static SutContext CreateSystemUnderTest()
        {
            var store = new InMemoryPfmDataStore();
            BilingualDatabaseSeeder.SeedDefaultData(store, 2026);

            var yieldSvc = new InvestmentYieldService(store);
            var ledgerSvc = new DoubleEntryLedgerService(store, yieldSvc);
            var installmentSvc = new InstallmentEngineService(store, yieldSvc);
            var ruleEngine = new GuardrailRuleEngine(store, ledgerSvc, yieldSvc);
            var rollUpSvc = new PillarRollUpService(store, ledgerSvc, installmentSvc, yieldSvc, ruleEngine);

            return new SutContext
            {
                Store = store,
                YieldSvc = yieldSvc,
                LedgerSvc = ledgerSvc,
                InstallmentSvc = installmentSvc,
                RuleEngine = ruleEngine,
                RollUpSvc = rollUpSvc
            };
        }

        public static async Task Test1_DoubleEntry_Transfer_And_Fee_Never_Inflate_Principal_Expenses()
        {
            var sut = CreateSystemUnderTest();
            var store = sut.Store;
            var ledgerSvc = sut.LedgerSvc;
            DateTime txDate = new DateTime(2026, 10, 1, 10, 0, 0);

            var bankA = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountBankAId);
            var asnb = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountAsnbFixedId);

            decimal initialBankA = bankA.CurrentBalance; // RM 2000.00
            decimal initialAsnb = asnb.CurrentBalance;   // RM 12000.00

            // Transfer RM 500.00 from Bank A to ASNB with RM 1.00 TransferFee
            var transferResult = await ledgerSvc.RecordTransferAsync(new CreateTransferRequest
            {
                TransactionDate = txDate,
                SourceAccountId = bankA.Id,
                DestinationAccountId = asnb.Id,
                Amount = 500.00m,
                TransferFee = 1.00m,
                DescriptionEn = "Monthly ASNB Investment Transfer",
                DescriptionZh = "每月 ASNB 投资转账"
            });

            AssertEqual(initialBankA - 501.00m, bankA.CurrentBalance, "Bank A balance should decrease by RM 500.00 + RM 1.00 fee");
            AssertEqual(initialAsnb + 500.00m, asnb.CurrentBalance, "ASNB balance should increase by RM 500.00");
            AssertEqual(0.00m, transferResult.TransferTransaction.PersonalAmount, "Transfer PersonalAmount must be RM 0.00");
            AssertNotNull(transferResult.FeeTransaction, "Fee transaction should be generated when TransferFee > 0");
            AssertEqual(1.00m, transferResult.FeeTransaction!.PersonalAmount, "Fee transaction PersonalAmount should be RM 1.00");

            // Monthly expense total MUST only include the RM 1.00 fee, NEVER the RM 500.00 transfer!
            decimal monthlyExpenses = ledgerSvc.GetMonthlyPersonalExpenseTotal(2026, 10);
            AssertEqual(1.00m, monthlyExpenses, "Monthly expenses must only equal the RM 1.00 transfer fee, never the RM 500.00 transfer principal");
        }

        public static async Task Test2_VirtualEnvelopes_And_UnrestrictedSpendableBalance_Formula()
        {
            var sut = CreateSystemUnderTest();
            var store = sut.Store;
            var ledgerSvc = sut.LedgerSvc;
            DateTime evalDate = new DateTime(2026, 10, 10);

            var bankA = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountBankAId);
            // Bank A starts with CurrentBalance = RM 2000.00, MinBalanceLimit = RM 20.00

            // Lock RM 300.00 in Road Tax (路税) and RM 450.00 in Car Maintenance (汽车保养)
            await ledgerSvc.AllocateToVirtualEnvelopeAsync(bankA.Id, "Road Tax & Insurance", "路税与车险基金", 300.00m, 600.00m);
            await ledgerSvc.AllocateToVirtualEnvelopeAsync(bankA.Id, "Car Maintenance Sinking Fund", "汽车定期保养基金", 450.00m, 1000.00m);

            // Schedule an upcoming RM 250.00 Insurance Auto-Debit due in 4 days (within 7-day LookAhead window)
            store.RecurringAutoDebits.Add(new RecurringAutoDebit
            {
                Id = Guid.NewGuid(),
                AccountId = bankA.Id,
                CategoryId = BilingualDatabaseSeeder.CategoryInsuranceId,
                NameEn = "AIA Medical Insurance Auto-Debit",
                NameZh = "AIA 医疗保险自动扣款",
                Amount = 250.00m,
                BillingDayOfMonth = 14,
                NextDueDate = evalDate.AddDays(4),
                IsActive = true
            });

            // Formula: UnrestrictedSpendableBalance = 2000.00 - 20.00 (MinLimit) - (300.00 + 450.00 Envelopes) - 250.00 (AutoDebit) = RM 980.00
            decimal safeToSpend = ledgerSvc.CalculateUnrestrictedSpendableBalance(bankA.Id, evalDate);
            AssertEqual(980.00m, safeToSpend, "UnrestrictedSpendableBalance formula must deduct MinBalanceLimit, VirtualEnvelopes, and UpcomingAutoDebits");
        }

        public static async Task Test3_SplitBill_PendingReimbursement_And_TaxRelief_Tracking()
        {
            var sut = CreateSystemUnderTest();
            var store = sut.Store;
            var ledgerSvc = sut.LedgerSvc;
            DateTime txDate = new DateTime(2026, 10, 12);

            var bankA = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountBankAId);
            decimal startBalance = bankA.CurrentBalance; // RM 2000.00

            // User pays RM 80.00 group dinner bill where RM 60.00 is owed by friends, PersonalAmount = RM 20.00
            var splitExpense = await ledgerSvc.RecordExpenseAsync(new CreateExpenseRequest
            {
                TransactionDate = txDate,
                SourceAccountId = bankA.Id,
                CategoryId = BilingualDatabaseSeeder.CategoryFoodDiningId,
                TotalAmount = 80.00m,
                ReceivableAmount = 60.00m,
                DebtorName = "Jason & Mei Ling",
                DescriptionEn = "Hotpot Group Dinner",
                DescriptionZh = "火锅聚餐 AA 分账"
            });

            AssertEqual(startBalance - 80.00m, bankA.CurrentBalance, "Physical bank balance drops by full RM 80.00 paid at counter");
            AssertEqual(20.00m, splitExpense.PersonalAmount, "PersonalAmount must be RM 20.00");
            AssertEqual(60.00m, splitExpense.ReceivableAmount, "ReceivableAmount must be RM 60.00");
            AssertEqual(20.00m, ledgerSvc.GetMonthlyPersonalExpenseTotal(2026, 10), "Personal monthly budget only counts RM 20.00, not RM 80.00");

            // Settle RM 60.00 from friends into Bank A
            var settled = await ledgerSvc.SettleReimbursementAsync(new SettleReimbursementRequest
            {
                PendingReimbursementId = splitExpense.PendingReimbursement!.Id,
                DestinationLiquidAccountId = bankA.Id,
                SettlementAmount = 60.00m,
                SettlementDate = txDate.AddDays(1)
            });

            AssertEqual(ReimbursementStatus.SETTLED, settled.Status, "Reimbursement should be marked SETTLED");
            AssertEqual(startBalance - 20.00m, bankA.CurrentBalance, "After RM 60.00 settlement, net Bank A deduction is RM 20.00");
            AssertEqual(20.00m, ledgerSvc.GetMonthlyPersonalExpenseTotal(2026, 10), "Settling reimbursement does not distort personal expenses");

            // Record a Tax-Relief tagged Lifestyle purchase of RM 1,200.00 (Cap RM 2,500.00)
            await ledgerSvc.RecordExpenseAsync(new CreateExpenseRequest
            {
                TransactionDate = txDate,
                SourceAccountId = bankA.Id,
                CategoryId = BilingualDatabaseSeeder.CategoryShoppingElectronicsId,
                TotalAmount = 1200.00m,
                ReceivableAmount = 0m,
                TaxReliefBucketId = BilingualDatabaseSeeder.TaxReliefLifestyleId,
                ReceiptAttachmentUrl = "receipts/2026/ipad-lifestyle-receipt.pdf",
                DescriptionEn = "Tablet for Reading & Work",
                DescriptionZh = "阅读与办公平板电脑"
            });

            var lifestyleBucket = ledgerSvc.GetTaxReliefSummary(2026)
                .First(b => b.BucketId == BilingualDatabaseSeeder.TaxReliefLifestyleId);
            AssertEqual(1200.00m, lifestyleBucket.ClaimedAmount, "Lifestyle tax relief claimed should be RM 1,200.00");
            AssertEqual(1300.00m, lifestyleBucket.RemainingCap, "Lifestyle tax relief remaining cap should be RM 1,300.00");
            AssertEqual(48.00m, lifestyleBucket.UtilizationPercentage, "Lifestyle utilization should be 48%");
        }

        public static async Task Test4_SPayLater_InstallmentEngine_And_DSR_Calculation()
        {
            var sut = CreateSystemUnderTest();
            var store = sut.Store;
            var ledgerSvc = sut.LedgerSvc;
            var installmentSvc = sut.InstallmentSvc;
            DateTime octDate = new DateTime(2026, 10, 5);

            // Log RM 5,000.00 Net Monthly Salary Income in October 2026
            await ledgerSvc.RecordIncomeAsync(new CreateIncomeRequest
            {
                TransactionDate = new DateTime(2026, 10, 1),
                SourceIncomeAccountId = BilingualDatabaseSeeder.AccountSalaryIncomeId,
                DestinationLiquidAccountId = BilingualDatabaseSeeder.AccountBankAId,
                CategoryId = BilingualDatabaseSeeder.CategorySalaryIncomeId,
                Amount = 5000.00m,
                DescriptionEn = "October Net Salary",
                DescriptionZh = "10月份净薪资"
            });

            var spayLater = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountSpayLaterId);
            AssertEqual(0.00m, spayLater.CurrentBalance, "SPayLater starts at RM 0.00");

            // Create RM 150.00 SPayLater 3-month purchase (RM 50.00/month)
            var plan = await installmentSvc.CreateInstallmentPurchaseAsync(new CreateInstallmentPurchaseRequest
            {
                LiabilityAccountId = spayLater.Id,
                LinkedRepaymentAccountId = BilingualDatabaseSeeder.AccountBankAId,
                CategoryId = BilingualDatabaseSeeder.CategoryShoppingElectronicsId,
                MerchantOrTitleEn = "Shopee Wireless Earbuds",
                MerchantOrTitleZh = "Shopee 无线蓝牙耳机",
                TotalPrincipal = 150.00m,
                TotalInterestOrFee = 0.00m,
                TenureMonths = 3,
                PurchaseDate = octDate
            });

            // Invariant #4 verification:
            // 1. Total SPayLater liability immediately increases by RM 150.00
            AssertEqual(150.00m, spayLater.CurrentBalance, "SPayLater total liability must immediately increase by RM 150.00");
            // 2. Generates 3 monthly schedules of RM 50.00 each
            AssertEqual(3, plan.Schedules.Count, "Must generate 3 monthly InstallmentSchedules");
            AssertEqual(50.00m, plan.Schedules[0].TotalDue, "Month 1 installment due is RM 50.00");
            AssertEqual(50.00m, plan.Schedules[1].TotalDue, "Month 2 installment due is RM 50.00");
            AssertEqual(50.00m, plan.Schedules[2].TotalDue, "Month 3 installment due is RM 50.00");
            // 3. Only RM 50.00 counts against October's monthly cashflow budget!
            AssertEqual(50.00m, ledgerSvc.GetMonthlyPersonalExpenseTotal(2026, 10), "Only RM 50.00 counts against October's monthly budget");

            // Pay the 1st installment of RM 50.00 from Bank A
            await installmentSvc.PayInstallmentScheduleAsync(plan.Schedules[0].Id, BilingualDatabaseSeeder.AccountBankAId, octDate.AddDays(5));

            var progress = installmentSvc.GetInstallmentPlanProgress(plan.Id);
            AssertEqual(1, progress.PaidMonthsCount, "1 installment paid");
            AssertEqual(100.00m, progress.RemainingBalance, "RM 100.00 remaining on SPayLater plan");
            AssertTrue(progress.ProgressLabelEn.Contains("1 of 3 paid, RM 100.00 remaining"), "English progress label must match");
            AssertTrue(progress.ProgressLabelZh.Contains("已还 1/3 期，剩余 RM 100.00"), "Mandarin progress label must match");

            // DSR (%) = (50.00 / 5000.00) * 100 = 1.00%
            var dsr = installmentSvc.CalculateDebtServiceRatio(2026, 10);
            AssertEqual(1.00m, dsr.DsrPercentage, "DSR % for RM 50 commitment on RM 5,000 income must be 1.00%");
        }

        public static async Task Test5_ASNB_MinimumMonthlyBalance_And_TimingTip_And_DailyCompound()
        {
            var sut = CreateSystemUnderTest();
            var store = sut.Store;
            var yieldSvc = sut.YieldSvc;
            var ledgerSvc = sut.LedgerSvc;

            var asnb = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountAsnbFixedId);
            var bankA = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountBankAId);
            // ASNB starts at RM 12,000.00 at 4.50% p.a.
            // Day 1 snapshot: LowestMonthlyBalance = RM 12,000.00 -> MonthlyDividend = (12000 * 0.045) / 12 = RM 45.00
            var octSnapshot = yieldSvc.EnsureMonthlySnapshot(asnb.Id, 2026, 10, 12000.00m);
            AssertEqual(45.00m, octSnapshot.AccruedDividendOrInterest, "ASNB monthly dividend on RM 12,000 at 4.50% p.a. is RM 45.00");

            // User transfers RM 1,000.00 into ASNB on October 10 (after the 1st of the month)
            var depositResult = await ledgerSvc.RecordTransferAsync(new CreateTransferRequest
            {
                TransactionDate = new DateTime(2026, 10, 10),
                SourceAccountId = bankA.Id,
                DestinationAccountId = asnb.Id,
                Amount = 1000.00m,
                TransferFee = 0m
            });
            var timingTip = depositResult.DepositTimingTip;

            // Because deposit happened on Day 10 (> Day 1), October's LowestMonthlyBalance remains RM 12,000.00!
            AssertEqual(13000.00m, asnb.CurrentBalance, "ASNB current balance is now RM 13,000.00");
            AssertEqual(12000.00m, octSnapshot.LowestMonthlyBalance, "ASNB October LowestMonthlyBalance remains RM 12,000.00");
            AssertEqual(45.00m, octSnapshot.AccruedDividendOrInterest, "ASNB October dividend stays RM 45.00");
            AssertNotNull(timingTip, "Deposit after the 1st of the month must emit ASNB Deposit Timing Tip");
            AssertTrue(timingTip!.TitleZh.Contains("ASNB 存入时间理财提示"), "Mandarin ASNB timing tip title must be present");

            // If user withdraws RM 3,000.00 from ASNB on October 20 (bringing balance down to RM 10,000.00),
            // LowestMonthlyBalance drops to RM 10,000.00 -> MonthlyDividend = (10000 * 0.045) / 12 = RM 37.50
            await ledgerSvc.RecordTransferAsync(new CreateTransferRequest
            {
                TransactionDate = new DateTime(2026, 10, 20),
                SourceAccountId = asnb.Id,
                DestinationAccountId = bankA.Id,
                Amount = 3000.00m,
                TransferFee = 0m
            });

            AssertEqual(10000.00m, octSnapshot.LowestMonthlyBalance, "Withdrawal drops LowestMonthlyBalance to RM 10,000.00");
            AssertEqual(37.50m, octSnapshot.AccruedDividendOrInterest, "Updated ASNB monthly dividend on RM 10,000.00 is RM 37.50");

            // Daily Compounding check: RM 3,650.00 at 3.00% p.a. for 1 day = 3650 * (0.03 / 365) = RM 0.30/day
            decimal oneDayInterest = yieldSvc.CalculateDailyCompoundInterest(3650.00m, 3.00m, 1);
            AssertEqual(0.30m, oneDayInterest, "Daily interest on RM 3,650 at 3.00% p.a. is RM 0.30");
        }

        public static async Task Test6_Guardrails_RuleA_Floor_RuleB_AutoDebit_And_RuleC_IdleCashSweeper()
        {
            var sut = CreateSystemUnderTest();
            var store = sut.Store;
            var ledgerSvc = sut.LedgerSvc;
            var ruleEngine = sut.RuleEngine;

            // 1. Rule A: Touch 'n Go NFC Card drops below RM 10.00 operational floor
            var tngNfc = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountTngNfcCardId);
            // Starts at RM 25.00, MinBalanceLimit = RM 10.00. Spend RM 18.50 on tolls -> balance becomes RM 6.50
            await ledgerSvc.RecordExpenseAsync(new CreateExpenseRequest
            {
                TransactionDate = new DateTime(2026, 10, 15),
                SourceAccountId = tngNfc.Id,
                CategoryId = BilingualDatabaseSeeder.CategoryTransportTollId,
                TotalAmount = 18.50m,
                DescriptionEn = "DUKE & SMART Highway Tolls",
                DescriptionZh = "DUKE 与 SMART 大道过路费"
            });

            var ruleAAlert = ruleEngine.EvaluateStaticFloorAlert(tngNfc.Id);
            AssertNotNull(ruleAAlert, "Rule A must trigger when Touch 'n Go NFC Card drops to RM 6.50 (< RM 10.00 floor)");
            AssertEqual(3.50m, ruleAAlert!.SuggestedTransferAmount ?? 0m, "Rule A shortfall to reach RM 10.00 floor is RM 3.50");
            AssertTrue(ruleAAlert.TitleZh.Contains("Touch 'n Go NFC 实体卡 余额不足预警"), "Rule A Mandarin title must render accurately");

            // 2. Rule B: Bank A has RM 180.00, MinBalanceLimit RM 20.00, and RM 250.00 Insurance Auto-Debit due in 3 days.
            // Required = RM 20 + RM 250 = RM 270. Shortfall = RM 270 - RM 180 = RM 90.00.
            // Bank B has RM 1,500.00 surplus and should be automatically suggested as the transfer source!
            var bankA = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountBankAId);
            var bankB = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountBankBId);
            bankA.CurrentBalance = 180.00m;

            DateTime checkDate = new DateTime(2026, 10, 15);
            store.RecurringAutoDebits.Add(new RecurringAutoDebit
            {
                Id = Guid.NewGuid(),
                AccountId = bankA.Id,
                CategoryId = BilingualDatabaseSeeder.CategoryInsuranceId,
                NameEn = "Prudential Medical Insurance",
                NameZh = "保诚医疗保险自动扣款",
                Amount = 250.00m,
                BillingDayOfMonth = 18,
                NextDueDate = checkDate.AddDays(3),
                IsActive = true
            });

            var ruleBAlert = ruleEngine.EvaluateAutoDebitLookAheadAlert(bankA.Id, checkDate);
            AssertNotNull(ruleBAlert, "Rule B must trigger when Bank A is short for upcoming RM 250 auto-debit");
            AssertEqual(90.00m, ruleBAlert!.SuggestedTransferAmount ?? 0m, "Rule B must suggest exact shortfall transfer of RM 90.00");
            AssertEqual(bankB.Id, ruleBAlert.SuggestedCounterpartyAccountId ?? Guid.Empty, "Rule B must automatically identify Bank B as surplus counterparty");
            AssertTrue(ruleBAlert.TitleZh.Contains("自动扣款余额不足提醒"), "Rule B Mandarin title must match");

            // 3. Rule C: Month-End Idle Cash Sweeper (evaluated on October 28, between 25th and 31st)
            // Bank B has RM 1,500.00 (0% interest CASA) and RM 20.00 MinBalanceLimit -> RM 1,480.00 idle cash surplus!
            DateTime monthEndDate = new DateTime(2026, 10, 28);
            var sweeperAlerts = ruleEngine.EvaluateIdleCashSweeperAlerts(monthEndDate);
            var bankBSweep = sweeperAlerts.FirstOrDefault(a => a.PrimaryAccountId == bankB.Id);
            AssertNotNull(bankBSweep, "Rule C must suggest sweeping Bank B's idle cash to ASNB between the 25th and 31st");
            AssertEqual(1480.00m, bankBSweep!.SuggestedTransferAmount ?? 0m, "Rule C should suggest sweeping RM 1,480.00 surplus from Bank B");
            AssertEqual(BilingualDatabaseSeeder.AccountAsnbFixedId, bankBSweep.SuggestedCounterpartyAccountId ?? Guid.Empty, "Rule C target must be ASNB");
        }

        public static void Test7_Dynamic_4Pillar_CustomSubTypes_And_RollUp_Aggregation()
        {
            var sut = CreateSystemUnderTest();
            var rollUpSvc = sut.RollUpSvc;

            // User creates a custom sub-type under ASSET_INVESTMENT ("Gold Investment Account / 黄金投资账户")
            var goldSubType = rollUpSvc.CreateCustomSubType(
                PillarType.ASSET_INVESTMENT,
                "GOLD_BULLION",
                "Gold Bullion & Kijang Emas",
                "黄金与 Kijang Emas 投资",
                sortOrder: 10);

            var maybankGold = rollUpSvc.CreateCustomAccount(
                goldSubType.Id,
                "Maybank Gold Investment Account (MGIA)",
                "Maybank 黄金投资账户 (MGIA)",
                openingBalance: 4500.00m);

            var dashboard = rollUpSvc.GetDashboardRollUp(new DateTime(2026, 10, 28));

            AssertEqual(4, dashboard.Pillars.Count, "Dashboard must always roll up into the 4 core Pillars");
            var invPillar = dashboard.Pillars.First(p => p.Pillar == PillarType.ASSET_INVESTMENT);
            AssertTrue(invPillar.SubTypes.Any(st => st.SubTypeId == goldSubType.Id), "Custom Gold sub-type must appear in Investment Pillar roll-up");
            AssertEqual(16500.00m, invPillar.TotalBalance, "Investment Pillar total must equal RM 12,000 ASNB + RM 4,500 Gold = RM 16,500.00");
        }

        public static async Task Test8_Phase2_SpecializedCalculators_And_GuardrailService()
        {
            var store = new InMemoryPfmDataStore();
            BilingualDatabaseSeeder.SeedDefaultData(store, 2026);

            var asnbCalculator = new AsnbMinimumMonthlyBalanceDividendCalculator(store);
            var ledgerService = new DoubleEntryLedgerService(store, asnbCalculator);
            var scheduleGenerator = new InstallmentScheduleGenerator(store, asnbCalculator);
            var guardrailService = new AccountGuardrailService(store, ledgerService, asnbCalculator);

            // 1. Verify AsnbMinimumMonthlyBalanceDividendCalculator:
            // RM 12,000.00 lowest balance at 4.50% p.a. -> RM 45.00/month, RM 540.00/year
            decimal monthlyDiv = asnbCalculator.CalculateAsnbMonthlyDividend(12000.00m, 4.50m);
            AssertEqual(45.00m, monthlyDiv, "AsnbMinimumMonthlyBalanceDividendCalculator must compute RM 45.00/month on RM 12,000 at 4.50%");
            var projection = asnbCalculator.GetAsnbDividendProjection(BilingualDatabaseSeeder.AccountAsnbFixedId, new DateTime(2026, 1, 15));
            AssertEqual(540.00m, projection.ProjectedFullYearDividend, "Full-year projected ASNB dividend must be RM 540.00");

            // 2. Verify InstallmentScheduleGenerator with 3-month RM 150.00 SPayLater case:
            var spayLater = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountSpayLaterId);
            var plan = await scheduleGenerator.CreateInstallmentPurchaseAsync(new CreateInstallmentPurchaseRequest
            {
                LiabilityAccountId = spayLater.Id,
                LinkedRepaymentAccountId = BilingualDatabaseSeeder.AccountBankAId,
                CategoryId = BilingualDatabaseSeeder.CategoryShoppingElectronicsId,
                MerchantOrTitleEn = "SPayLater 3-Month Case",
                MerchantOrTitleZh = "SPayLater 3期测试案例",
                TotalPrincipal = 150.00m,
                TotalInterestOrFee = 0.00m,
                TenureMonths = 3,
                PurchaseDate = new DateTime(2026, 10, 5)
            });

            AssertEqual(150.00m, spayLater.CurrentBalance, "SPayLater liability balance must immediately be RM 150.00");
            AssertEqual(3, plan.Schedules.Count, "InstallmentScheduleGenerator must generate 3 schedules");
            AssertEqual(50.00m, scheduleGenerator.GetMonthlyInstallmentCashflowCommitment(2026, 10), "Monthly cashflow commitment for Oct 2026 must be RM 50.00");

            // 3. Verify AccountGuardrailService:
            // Case A: Touch 'n Go NFC Card < RM 10.00 (spend RM 18.50 from RM 25.00 -> RM 6.50)
            var tngNfc = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountTngNfcCardId);
            tngNfc.CurrentBalance = 6.50m;
            var tngAlert = guardrailService.EvaluateStaticFloorAlert(tngNfc.Id);
            AssertNotNull(tngAlert, "AccountGuardrailService must alert when Touch 'n Go NFC Card < RM 10.00");
            AssertEqual(3.50m, tngAlert!.SuggestedTransferAmount ?? 0m, "Touch 'n Go NFC top-up shortfall must be RM 3.50");

            // Case B: Bank A < RM 250.00 Insurance Auto-Debit (+ RM 20.00 floor + RM 50.00 linked SPayLater installment = RM 320.00 required,
            // or test pure RM 250.00 Insurance auto-debit when SPayLater is not due in window)
            var bankA = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountBankAId);
            var bankB = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountBankBId);
            bankA.CurrentBalance = 180.00m;

            DateTime evalDate = new DateTime(2026, 10, 15);
            store.RecurringAutoDebits.Add(new RecurringAutoDebit
            {
                Id = Guid.NewGuid(),
                AccountId = bankA.Id,
                CategoryId = BilingualDatabaseSeeder.CategoryInsuranceId,
                NameEn = "Monthly Insurance Auto-Debit",
                NameZh = "每月医疗保险自动扣款",
                Amount = 250.00m,
                BillingDayOfMonth = 18,
                NextDueDate = evalDate.AddDays(3),
                IsActive = true
            });

            var autoDebitAlert = guardrailService.EvaluateAutoDebitLookAheadAlert(bankA.Id, evalDate);
            AssertNotNull(autoDebitAlert, "AccountGuardrailService must trigger Auto-Debit Look-Ahead Alert when Bank A < RM 250 Insurance commitment + floor");
            AssertEqual(90.00m, autoDebitAlert!.SuggestedTransferAmount ?? 0m, "Shortfall for RM 250 Insurance + RM 20 floor with RM 180 balance is RM 90.00");
            AssertEqual(bankB.Id, autoDebitAlert.SuggestedCounterpartyAccountId ?? Guid.Empty, "AccountGuardrailService must suggest Bank B as the donor account");
        }

        public static async Task Test9_Phase3_CategoryRollUps_30DayCashflowCalendar_Envelopes_Reimbursements_And_LocalizedAlerts()
        {
            var sut = CreateSystemUnderTest();
            var store = sut.Store;
            var ledgerSvc = sut.LedgerSvc;
            var installmentSvc = sut.InstallmentSvc;
            var rollUpSvc = sut.RollUpSvc;
            var ruleEngine = sut.RuleEngine;

            DateTime startDate = new DateTime(2026, 10, 15);

            // 1. Allocate Virtual Envelope inside Bank A (RM 300 Road Tax)
            await ledgerSvc.AllocateToVirtualEnvelopeAsync(
                BilingualDatabaseSeeder.AccountBankAId,
                "Road Tax & Car Insurance",
                "路税与车险专项信封",
                300.00m,
                600.00m);

            var envelopes = rollUpSvc.GetVirtualEnvelopes(BilingualDatabaseSeeder.AccountBankAId);
            AssertEqual(1, envelopes.Count, "VirtualEnvelopes endpoint query must return 1 envelope for Bank A");
            AssertEqual(300.00m, envelopes[0].AllocatedBalance, "Envelope allocated balance must be RM 300.00");
            AssertEqual(50.00m, envelopes[0].ProgressPercentage, "Envelope progress percentage on RM 300 / RM 600 must be 50%");

            // 2. Record Split-Bill Expense (RM 80 total, RM 20 personal, RM 60 friend receivable) + SPayLater RM 150 3-month plan
            await ledgerSvc.RecordExpenseAsync(new CreateExpenseRequest
            {
                TransactionDate = startDate,
                SourceAccountId = BilingualDatabaseSeeder.AccountBankAId,
                CategoryId = BilingualDatabaseSeeder.CategoryShoppingElectronicsId,
                TotalAmount = 80.00m,
                ReceivableAmount = 60.00m,
                DebtorName = "Alex Tan",
                DescriptionEn = "Shared Tech Accessories",
                DescriptionZh = "合买数码配件"
            });

            await installmentSvc.CreateInstallmentPurchaseAsync(new CreateInstallmentPurchaseRequest
            {
                LiabilityAccountId = BilingualDatabaseSeeder.AccountSpayLaterId,
                LinkedRepaymentAccountId = BilingualDatabaseSeeder.AccountBankAId,
                CategoryId = BilingualDatabaseSeeder.CategoryShoppingElectronicsId,
                MerchantOrTitleEn = "SPayLater Monitor Stand",
                MerchantOrTitleZh = "SPayLater 显示器支架",
                TotalPrincipal = 150.00m,
                TotalInterestOrFee = 0m,
                TenureMonths = 3,
                PurchaseDate = startDate
            });

            // 3. Verify Category Roll-Up Summary for Shopping (RM 20 direct personal + RM 50 monthly SPayLater slice = RM 70.00)
            var categoryRollUps = rollUpSvc.GetCategoryRollUpSummaries(2026, 10, startDate);
            var shoppingRollUp = categoryRollUps.First(c => c.CategoryId == BilingualDatabaseSeeder.CategoryShoppingElectronicsId);
            AssertEqual(20.00m, shoppingRollUp.DirectPersonalSpent, "Category direct personal spend must exclude RM 60 friend receivable");
            AssertEqual(50.00m, shoppingRollUp.MonthlyInstallmentSliceSpent, "Category installment slice must only count RM 50.00 for October");
            AssertEqual(70.00m, shoppingRollUp.TotalMonthlyCategoryCommitment, "Total monthly category commitment must be RM 70.00");

            // 4. Verify Pending Reimbursements query
            var pendingList = rollUpSvc.GetPendingReimbursements(includeSettled: false);
            AssertEqual(1, pendingList.Count, "PendingReimbursements query must return 1 unsettled record");
            AssertEqual(60.00m, pendingList[0].RemainingAmount, "Pending reimbursement remaining amount must be RM 60.00");

            // 5. Schedule RM 250.00 Insurance Auto-Debit due in 3 days and verify 30-Day Cashflow Projection Calendar
            store.RecurringAutoDebits.Add(new RecurringAutoDebit
            {
                Id = Guid.NewGuid(),
                AccountId = BilingualDatabaseSeeder.AccountBankAId,
                CategoryId = BilingualDatabaseSeeder.CategoryInsuranceId,
                NameEn = "AIA Medical Insurance",
                NameZh = "AIA 医疗保险自动扣款",
                Amount = 250.00m,
                BillingDayOfMonth = 18,
                NextDueDate = startDate.AddDays(3),
                IsActive = true
            });

            var calendar = rollUpSvc.Get30DayCashflowProjectionCalendar(
                startDate,
                expectedMonthlySalaryInflow: 5000.00m,
                salaryCreditDayOfMonth: 25);

            AssertEqual(30, calendar.Days.Count, "30-Day Cashflow Projection Calendar must return exactly 30 daily entries");
            AssertTrue(calendar.Total30DayScheduledOutflows >= 300.00m, "30-day scheduled outflows must include RM 250 auto-debit + RM 50 installment");
            AssertEqual(5000.00m, calendar.Total30DayExpectedInflows, "30-day expected inflows must include RM 5,000 salary credit on the 25th");

            // 6. Verify Financial Health Alerts carry localized parameters in both English (en) and Mandarin (zh-CN)
            var tngNfc = store.Accounts.First(a => a.Id == BilingualDatabaseSeeder.AccountTngNfcCardId);
            tngNfc.CurrentBalance = 6.50m;
            var alerts = ruleEngine.EvaluateAllRules(new DateTime(2026, 10, 28));
            AssertTrue(alerts.Count >= 2, "Must generate active financial health alerts");
            foreach (var alert in alerts)
            {
                AssertTrue(!string.IsNullOrWhiteSpace(alert.TitleEn) && !string.IsNullOrWhiteSpace(alert.TitleZh), "Alert must include both English and Mandarin titles");
                AssertTrue(!string.IsNullOrWhiteSpace(alert.MessageEn) && !string.IsNullOrWhiteSpace(alert.MessageZh), "Alert must include both English and Mandarin messages");
                AssertTrue(alert.TranslationParams.Count > 0, "Alert must include localized parameter dictionary");
            }
        }

        private static void AssertEqual<T>(T expected, T actual, string message)
        {
            if (!Equals(expected, actual))
            {
                throw new Exception($"ASSERTION FAILED: {message}. Expected: <{expected}>, Actual: <{actual}>");
            }
        }

        private static void AssertNotNull(object? obj, string message)
        {
            if (obj == null)
            {
                throw new Exception($"ASSERTION FAILED: {message}. Expected non-null value.");
            }
        }

        private static void AssertTrue(bool condition, string message)
        {
            if (!condition)
            {
                throw new Exception($"ASSERTION FAILED: {message}.");
            }
        }

        public static void Main()
        {
            RunAllAsync().GetAwaiter().GetResult();
        }

        public static async Task RunAllAsync()
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Console.WriteLine("================================================================================");
            Console.WriteLine(" PFM Phase 1, Phase 2 & Phase 3 Bilingual Invariant Verification Suite (EN / 中文)");
            Console.WriteLine("================================================================================");

            await RunTest("Test 1: Atomic Double-Entry Transfer & Fee Expense Isolation", Test1_DoubleEntry_Transfer_And_Fee_Never_Inflate_Principal_Expenses);
            await RunTest("Test 2: Virtual Envelopes & Unrestricted Spendable Balance Formula", Test2_VirtualEnvelopes_And_UnrestrictedSpendableBalance_Formula);
            await RunTest("Test 3: Split Bill Pending Reimbursements & LHDN Tax Relief Caps", Test3_SplitBill_PendingReimbursement_And_TaxRelief_Tracking);
            await RunTest("Test 4: SPayLater 3-Month Installment Schedule & DSR % Engine", Test4_SPayLater_InstallmentEngine_And_DSR_Calculation);
            await RunTest("Test 5: ASNB Minimum Monthly Balance Dividend, Timing Tip & Daily Compound", Test5_ASNB_MinimumMonthlyBalance_And_TimingTip_And_DailyCompound);
            await RunTest("Test 6: Component Guardrails (Rule A TNG Floor, Rule B Auto-Debit, Rule C ASNB Sweeper)", Test6_Guardrails_RuleA_Floor_RuleB_AutoDebit_And_RuleC_IdleCashSweeper);
            await RunTest("Test 7: Dynamic 4-Pillar Unlimited Custom Sub-Types & Roll-Up Summary", () =>
            {
                Test7_Dynamic_4Pillar_CustomSubTypes_And_RollUp_Aggregation();
                return Task.FromResult(0);
            });
            await RunTest("Test 8: Phase 2 AsnbMinimumMonthlyBalanceDividendCalculator, InstallmentScheduleGenerator & AccountGuardrailService", Test8_Phase2_SpecializedCalculators_And_GuardrailService);
            await RunTest("Test 9: Phase 3 Category Roll-Ups, 30-Day Cashflow Calendar, Envelopes, Reimbursements & Bilingual Alerts", Test9_Phase3_CategoryRollUps_30DayCashflowCalendar_Envelopes_Reimbursements_And_LocalizedAlerts);

            Console.WriteLine("================================================================================");
            Console.WriteLine(" ALL 9 FINANCIAL DOMAIN INVARIANT TEST SUITES PASSED (100% VERIFIED)");
            Console.WriteLine("================================================================================");
        }

        private static async Task RunTest(string name, Func<Task> testFunc)
        {
            await testFunc();
            Console.WriteLine($" [PASS] {name}");
        }
    }
}
