using System;
using System.Linq;
using Pfm.Application.Interfaces;
using Pfm.Domain.Entities;
using Pfm.Domain.Enums;

namespace Pfm.Infrastructure.Persistence.Seed
{
    /// <summary>
    /// Seeds default Malaysian Personal Financial Management data in both English (en) and Simplified Mandarin (zh-CN)
    /// across all 4 immutable pillars, Virtual Envelopes, Recurring Auto-Debits, Categories, and LHDN Tax Relief Buckets.
    /// </summary>
    public static class BilingualDatabaseSeeder
    {
        public static readonly Guid SubTypeCommercialBankId = Guid.Parse("10000000-0000-0000-0000-000000000001");
        public static readonly Guid SubTypeDigitalBankId = Guid.Parse("10000000-0000-0000-0000-000000000002");
        public static readonly Guid SubTypeEWalletId = Guid.Parse("10000000-0000-0000-0000-000000000003");
        public static readonly Guid SubTypeTngNfcCardId = Guid.Parse("10000000-0000-0000-0000-000000000004");
        public static readonly Guid SubTypeCashId = Guid.Parse("10000000-0000-0000-0000-000000000005");

        public static readonly Guid SubTypeAsnbFixedId = Guid.Parse("20000000-0000-0000-0000-000000000001");
        public static readonly Guid SubTypeAsnbVariableId = Guid.Parse("20000000-0000-0000-0000-000000000002");
        public static readonly Guid SubTypeFixedDepositId = Guid.Parse("20000000-0000-0000-0000-000000000003");
        public static readonly Guid SubTypeStocksEtfId = Guid.Parse("20000000-0000-0000-0000-000000000004");
        public static readonly Guid SubTypeEpfId = Guid.Parse("20000000-0000-0000-0000-000000000005");

        public static readonly Guid SubTypeSpayLaterBnplId = Guid.Parse("30000000-0000-0000-0000-000000000001");
        public static readonly Guid SubTypeCreditCardId = Guid.Parse("30000000-0000-0000-0000-000000000002");
        public static readonly Guid SubTypeCarLoanId = Guid.Parse("30000000-0000-0000-0000-000000000003");
        public static readonly Guid SubTypePersonalLoanId = Guid.Parse("30000000-0000-0000-0000-000000000004");
        public static readonly Guid SubTypeMortgageId = Guid.Parse("30000000-0000-0000-0000-000000000005");

        public static readonly Guid SubTypeSalaryId = Guid.Parse("40000000-0000-0000-0000-000000000001");
        public static readonly Guid SubTypeFreelanceId = Guid.Parse("40000000-0000-0000-0000-000000000002");
        public static readonly Guid SubTypeDividendPayoutId = Guid.Parse("40000000-0000-0000-0000-000000000003");
        public static readonly Guid SubTypeCashbackId = Guid.Parse("40000000-0000-0000-0000-000000000004");

        // Well-known Seeded Account IDs
        public static readonly Guid AccountBankAId = Guid.Parse("50000000-0000-0000-0000-000000000001");
        public static readonly Guid AccountBankBId = Guid.Parse("50000000-0000-0000-0000-000000000002");
        public static readonly Guid AccountGxBankId = Guid.Parse("50000000-0000-0000-0000-000000000003");
        public static readonly Guid AccountTngEWalletId = Guid.Parse("50000000-0000-0000-0000-000000000004");
        public static readonly Guid AccountTngNfcCardId = Guid.Parse("50000000-0000-0000-0000-000000000005");
        public static readonly Guid AccountAsnbFixedId = Guid.Parse("50000000-0000-0000-0000-000000000006");
        public static readonly Guid AccountSpayLaterId = Guid.Parse("50000000-0000-0000-0000-000000000007");
        public static readonly Guid AccountCreditCardId = Guid.Parse("50000000-0000-0000-0000-000000000008");
        public static readonly Guid AccountSalaryIncomeId = Guid.Parse("50000000-0000-0000-0000-000000000009");
        public static readonly Guid AccountFreelanceIncomeId = Guid.Parse("50000000-0000-0000-0000-000000000010");

        // Well-known Category IDs
        public static readonly Guid CategoryFoodDiningId = Guid.Parse("60000000-0000-0000-0000-000000000001");
        public static readonly Guid CategoryTransportTollId = Guid.Parse("60000000-0000-0000-0000-000000000002");
        public static readonly Guid CategoryShoppingElectronicsId = Guid.Parse("60000000-0000-0000-0000-000000000003");
        public static readonly Guid CategoryInsuranceId = Guid.Parse("60000000-0000-0000-0000-000000000004");
        public static readonly Guid CategoryBankTransferFeeId = Guid.Parse("60000000-0000-0000-0000-000000000005");
        public static readonly Guid CategorySalaryIncomeId = Guid.Parse("60000000-0000-0000-0000-000000000006");

        // Well-known Tax Relief Bucket IDs
        public static readonly Guid TaxReliefLifestyleId = Guid.Parse("70000000-0000-0000-0000-000000000001");
        public static readonly Guid TaxReliefSportsId = Guid.Parse("70000000-0000-0000-0000-000000000002");
        public static readonly Guid TaxReliefMedicalId = Guid.Parse("70000000-0000-0000-0000-000000000003");

        public static void SeedDefaultData(IPfmDataStore store, int taxYear = 2026)
        {
            if (store.AccountSubTypes.Any()) return;

            // 1. Seed 4-Pillar Account Sub-Types (EN & zh-CN)
            var subTypes = new[]
            {
                // Pillar 1: ASSET_LIQUID
                new AccountSubType { Id = SubTypeCommercialBankId, Pillar = PillarType.ASSET_LIQUID, Code = "COMMERCIAL_BANK", NameEn = "Commercial Banks", NameZh = "商业银行", TranslationKey = "SUBTYPE.COMMERCIAL_BANK", IsSystemSeeded = true, SortOrder = 1 },
                new AccountSubType { Id = SubTypeDigitalBankId, Pillar = PillarType.ASSET_LIQUID, Code = "DIGITAL_BANK", NameEn = "Digital Banks", NameZh = "数字银行", TranslationKey = "SUBTYPE.DIGITAL_BANK", IsSystemSeeded = true, SortOrder = 2 },
                new AccountSubType { Id = SubTypeEWalletId, Pillar = PillarType.ASSET_LIQUID, Code = "EWALLET", NameEn = "e-Wallets", NameZh = "电子钱包", TranslationKey = "SUBTYPE.EWALLET", IsSystemSeeded = true, SortOrder = 3 },
                new AccountSubType { Id = SubTypeTngNfcCardId, Pillar = PillarType.ASSET_LIQUID, Code = "TNG_NFC_CARD", NameEn = "Touch 'n Go NFC Card", NameZh = "Touch 'n Go 一触即通 NFC 卡", TranslationKey = "SUBTYPE.TNG_NFC_CARD", IsSystemSeeded = true, SortOrder = 4 },
                new AccountSubType { Id = SubTypeCashId, Pillar = PillarType.ASSET_LIQUID, Code = "PHYSICAL_CASH", NameEn = "Physical Cash", NameZh = "现金", TranslationKey = "SUBTYPE.PHYSICAL_CASH", IsSystemSeeded = true, SortOrder = 5 },

                // Pillar 2: ASSET_INVESTMENT
                new AccountSubType { Id = SubTypeAsnbFixedId, Pillar = PillarType.ASSET_INVESTMENT, Code = "ASNB_FIXED", NameEn = "ASNB Fixed-Price Funds", NameZh = "ASNB 固定价格基金 (ASM/ASB)", TranslationKey = "SUBTYPE.ASNB_FIXED", IsSystemSeeded = true, SortOrder = 1 },
                new AccountSubType { Id = SubTypeAsnbVariableId, Pillar = PillarType.ASSET_INVESTMENT, Code = "ASNB_VARIABLE", NameEn = "ASNB Variable Funds", NameZh = "ASNB 浮动价格基金", TranslationKey = "SUBTYPE.ASNB_VARIABLE", IsSystemSeeded = true, SortOrder = 2 },
                new AccountSubType { Id = SubTypeFixedDepositId, Pillar = PillarType.ASSET_INVESTMENT, Code = "FIXED_DEPOSIT", NameEn = "Fixed Deposits (FD)", NameZh = "定期存款 (FD)", TranslationKey = "SUBTYPE.FIXED_DEPOSIT", IsSystemSeeded = true, SortOrder = 3 },
                new AccountSubType { Id = SubTypeStocksEtfId, Pillar = PillarType.ASSET_INVESTMENT, Code = "STOCKS_ETF", NameEn = "Stocks / ETF / Robo-Advisor", NameZh = "股票 / ETF / 智能投顾 (StashAway)", TranslationKey = "SUBTYPE.STOCKS_ETF", IsSystemSeeded = true, SortOrder = 4 },
                new AccountSubType { Id = SubTypeEpfId, Pillar = PillarType.ASSET_INVESTMENT, Code = "EPF_KWSP", NameEn = "EPF (KWSP)", NameZh = "雇员公积金 (EPF / KWSP)", TranslationKey = "SUBTYPE.EPF_KWSP", IsSystemSeeded = true, SortOrder = 5 },

                // Pillar 3: LIABILITY
                new AccountSubType { Id = SubTypeSpayLaterBnplId, Pillar = PillarType.LIABILITY, Code = "BNPL_SPAYLATER", NameEn = "SPayLater / BNPL", NameZh = "SPayLater / 先买后付 (BNPL)", TranslationKey = "SUBTYPE.BNPL_SPAYLATER", IsSystemSeeded = true, SortOrder = 1 },
                new AccountSubType { Id = SubTypeCreditCardId, Pillar = PillarType.LIABILITY, Code = "CREDIT_CARD", NameEn = "Credit Cards", NameZh = "信用卡", TranslationKey = "SUBTYPE.CREDIT_CARD", IsSystemSeeded = true, SortOrder = 2 },
                new AccountSubType { Id = SubTypeCarLoanId, Pillar = PillarType.LIABILITY, Code = "CAR_LOAN", NameEn = "Car Loan (Hire Purchase)", NameZh = "汽车贷款", TranslationKey = "SUBTYPE.CAR_LOAN", IsSystemSeeded = true, SortOrder = 3 },
                new AccountSubType { Id = SubTypePersonalLoanId, Pillar = PillarType.LIABILITY, Code = "PERSONAL_LOAN", NameEn = "Personal Loan", NameZh = "个人贷款", TranslationKey = "SUBTYPE.PERSONAL_LOAN", IsSystemSeeded = true, SortOrder = 4 },
                new AccountSubType { Id = SubTypeMortgageId, Pillar = PillarType.LIABILITY, Code = "MORTGAGE", NameEn = "Home Mortgage", NameZh = "房屋贷款", TranslationKey = "SUBTYPE.MORTGAGE", IsSystemSeeded = true, SortOrder = 5 },

                // Pillar 4: INCOME_SOURCE
                new AccountSubType { Id = SubTypeSalaryId, Pillar = PillarType.INCOME_SOURCE, Code = "SALARY", NameEn = "Monthly Salary", NameZh = "固定薪资", TranslationKey = "SUBTYPE.SALARY", IsSystemSeeded = true, SortOrder = 1 },
                new AccountSubType { Id = SubTypeFreelanceId, Pillar = PillarType.INCOME_SOURCE, Code = "FREELANCE", NameEn = "Freelance & Side Hustle", NameZh = "自由职业与副业收入", TranslationKey = "SUBTYPE.FREELANCE", IsSystemSeeded = true, SortOrder = 2 },
                new AccountSubType { Id = SubTypeDividendPayoutId, Pillar = PillarType.INCOME_SOURCE, Code = "DIVIDEND_PAYOUT", NameEn = "Dividend & Interest Payout", NameZh = "投资分红与利息收入", TranslationKey = "SUBTYPE.DIVIDEND_PAYOUT", IsSystemSeeded = true, SortOrder = 3 },
                new AccountSubType { Id = SubTypeCashbackId, Pillar = PillarType.INCOME_SOURCE, Code = "CASHBACK", NameEn = "Cashback & Rewards", NameZh = "现金返还与奖励", TranslationKey = "SUBTYPE.CASHBACK", IsSystemSeeded = true, SortOrder = 4 }
            };

            foreach (var st in subTypes)
            {
                store.AccountSubTypes.Add(st);
            }

            // 2. Seed Default Accounts across the 4 Pillars
            var accounts = new[]
            {
                new Account
                {
                    Id = AccountBankAId,
                    AccountSubTypeId = SubTypeCommercialBankId,
                    Pillar = PillarType.ASSET_LIQUID,
                    NameEn = "Bank A (Maybank Main CASA)",
                    NameZh = "银行 A (Maybank 主力储蓄账户)",
                    Currency = "MYR",
                    CurrentBalance = 2000.00m,
                    MinBalanceLimit = 20.00m,
                    LookAheadAlertDays = 7,
                    InterestMethod = InterestCalculationMethod.NONE,
                    AnnualInterestRate = 0.00m,
                    IsZeroInterestLiquidAccount = true
                },
                new Account
                {
                    Id = AccountBankBId,
                    AccountSubTypeId = SubTypeCommercialBankId,
                    Pillar = PillarType.ASSET_LIQUID,
                    NameEn = "Bank B (CIMB Reserve CASA)",
                    NameZh = "银行 B (CIMB 备用储蓄账户)",
                    Currency = "MYR",
                    CurrentBalance = 1500.00m,
                    MinBalanceLimit = 20.00m,
                    LookAheadAlertDays = 7,
                    InterestMethod = InterestCalculationMethod.NONE,
                    AnnualInterestRate = 0.00m,
                    IsZeroInterestLiquidAccount = true
                },
                new Account
                {
                    Id = AccountGxBankId,
                    AccountSubTypeId = SubTypeDigitalBankId,
                    Pillar = PillarType.ASSET_LIQUID,
                    NameEn = "GXBank Daily Interest Pocket",
                    NameZh = "GXBank 每日计息数字银行账户",
                    Currency = "MYR",
                    CurrentBalance = 3650.00m,
                    MinBalanceLimit = 10.00m,
                    LookAheadAlertDays = 7,
                    InterestMethod = InterestCalculationMethod.DAILY_COMPOUND,
                    AnnualInterestRate = 3.00m,
                    IsZeroInterestLiquidAccount = false
                },
                new Account
                {
                    Id = AccountTngEWalletId,
                    AccountSubTypeId = SubTypeEWalletId,
                    Pillar = PillarType.ASSET_LIQUID,
                    NameEn = "Touch 'n Go eWallet",
                    NameZh = "Touch 'n Go 电子钱包",
                    Currency = "MYR",
                    CurrentBalance = 150.00m,
                    MinBalanceLimit = 20.00m,
                    LookAheadAlertDays = 7,
                    InterestMethod = InterestCalculationMethod.NONE,
                    AnnualInterestRate = 0.00m,
                    IsZeroInterestLiquidAccount = false
                },
                new Account
                {
                    Id = AccountTngNfcCardId,
                    AccountSubTypeId = SubTypeTngNfcCardId,
                    Pillar = PillarType.ASSET_LIQUID,
                    NameEn = "Touch 'n Go NFC Card",
                    NameZh = "Touch 'n Go NFC 实体卡",
                    Currency = "MYR",
                    CurrentBalance = 25.00m,
                    MinBalanceLimit = 10.00m, // Rule A Operational Floor for toll/parking gates
                    LookAheadAlertDays = 7,
                    InterestMethod = InterestCalculationMethod.NONE,
                    AnnualInterestRate = 0.00m,
                    IsZeroInterestLiquidAccount = false
                },
                new Account
                {
                    Id = AccountAsnbFixedId,
                    AccountSubTypeId = SubTypeAsnbFixedId,
                    Pillar = PillarType.ASSET_INVESTMENT,
                    NameEn = "ASNB ASM Fixed-Price Fund",
                    NameZh = "ASNB 大马信托固定价格基金 (ASM)",
                    Currency = "MYR",
                    CurrentBalance = 12000.00m,
                    MinBalanceLimit = 10.00m,
                    InterestMethod = InterestCalculationMethod.ASNB_MIN_MONTHLY,
                    AnnualInterestRate = 4.50m // 4.50% p.a. dividend rate
                },
                new Account
                {
                    Id = AccountSpayLaterId,
                    AccountSubTypeId = SubTypeSpayLaterBnplId,
                    Pillar = PillarType.LIABILITY,
                    NameEn = "SPayLater (Shopee BNPL)",
                    NameZh = "SPayLater 分期付款",
                    Currency = "MYR",
                    CurrentBalance = 0.00m,
                    LiabilityType = LiabilityType.BNPL_SPAYLATER,
                    CreditLimit = 3000.00m,
                    PaymentDueDay = 10
                },
                new Account
                {
                    Id = AccountCreditCardId,
                    AccountSubTypeId = SubTypeCreditCardId,
                    Pillar = PillarType.LIABILITY,
                    NameEn = "Maybank Visa Cashback Credit Card",
                    NameZh = "Maybank Visa 现金返还信用卡",
                    Currency = "MYR",
                    CurrentBalance = 0.00m,
                    LiabilityType = LiabilityType.CREDIT_CARD_STATEMENT,
                    CreditLimit = 10000.00m,
                    StatementClosingDay = 18,
                    PaymentDueDay = 8
                },
                new Account
                {
                    Id = AccountSalaryIncomeId,
                    AccountSubTypeId = SubTypeSalaryId,
                    Pillar = PillarType.INCOME_SOURCE,
                    NameEn = "Primary Employer Salary",
                    NameZh = "主业月薪收入",
                    Currency = "MYR",
                    CurrentBalance = 0.00m
                },
                new Account
                {
                    Id = AccountFreelanceIncomeId,
                    AccountSubTypeId = SubTypeFreelanceId,
                    Pillar = PillarType.INCOME_SOURCE,
                    NameEn = "Freelance Consulting Income",
                    NameZh = "自由顾问兼职收入",
                    Currency = "MYR",
                    CurrentBalance = 0.00m
                }
            };

            foreach (var acc in accounts)
            {
                var st = store.AccountSubTypes.First(s => s.Id == acc.AccountSubTypeId);
                acc.AccountSubType = st;
                st.Accounts.Add(acc);
                store.Accounts.Add(acc);
            }

            // 3. Seed Transaction Categories (EN & zh-CN)
            var categories = new[]
            {
                new TransactionCategory { Id = CategoryFoodDiningId, Code = "FOOD_DINING", NameEn = "Food & Dining", NameZh = "餐饮美食", ApplicableType = TransactionType.EXPENSE, MonthlyBudgetLimit = 800.00m },
                new TransactionCategory { Id = CategoryTransportTollId, Code = "TRANSPORT_TOLL", NameEn = "Transport, Toll & Parking", NameZh = "交通、过路费与停车", ApplicableType = TransactionType.EXPENSE, MonthlyBudgetLimit = 400.00m },
                new TransactionCategory { Id = CategoryShoppingElectronicsId, Code = "SHOPPING_TECH", NameEn = "Shopping, Tech & Lifestyle", NameZh = "购物、数码与生活", ApplicableType = TransactionType.EXPENSE, MonthlyBudgetLimit = 600.00m },
                new TransactionCategory { Id = CategoryInsuranceId, Code = "INSURANCE", NameEn = "Insurance & Protection", NameZh = "保险与保障", ApplicableType = TransactionType.EXPENSE, MonthlyBudgetLimit = 350.00m },
                new TransactionCategory { Id = CategoryBankTransferFeeId, Code = "BANK_FEES", NameEn = "Bank & Transfer Fees", NameZh = "银行与转账手续费", ApplicableType = TransactionType.EXPENSE, MonthlyBudgetLimit = 50.00m, IsSystemFeeCategory = true },
                new TransactionCategory { Id = CategorySalaryIncomeId, Code = "INCOME_SALARY", NameEn = "Salary & Bonus", NameZh = "薪资与奖金", ApplicableType = TransactionType.INCOME, MonthlyBudgetLimit = 0.00m }
            };

            foreach (var cat in categories)
            {
                store.TransactionCategories.Add(cat);
            }

            // 4. Seed Malaysian LHDN Tax Relief Buckets (EN & zh-CN)
            var taxBuckets = new[]
            {
                new TaxReliefBucket
                {
                    Id = TaxReliefLifestyleId,
                    TaxYear = taxYear,
                    Code = "LHDN_LIFESTYLE",
                    NameEn = "Lifestyle (Books, PC, Smartphone, Internet)",
                    NameZh = "生活方式税务减免（书籍、电脑、手机、网络）",
                    AnnualCap = 2500.00m,
                    DescriptionEn = "Up to RM 2,500 annual tax relief for reading materials, personal computer/smartphone/tablet, and monthly internet bill.",
                    DescriptionZh = "每年最高 RM 2,500 税务减免，涵盖书籍刊物、个人电脑/智能手机/平板及家庭宽带账单。"
                },
                new TaxReliefBucket
                {
                    Id = TaxReliefSportsId,
                    TaxYear = taxYear,
                    Code = "LHDN_SPORTS",
                    NameEn = "Sports Equipment, Gym & Competition",
                    NameZh = "体育用品、健身房与赛事税务减免",
                    AnnualCap = 1000.00m,
                    DescriptionEn = "Up to RM 1,000 annual tax relief for sports equipment, facility rental, gym membership, and competition registration.",
                    DescriptionZh = "每年最高 RM 1,000 税务减免，涵盖运动器材、场地租借、健身房会籍及比赛报名费。"
                },
                new TaxReliefBucket
                {
                    Id = TaxReliefMedicalId,
                    TaxYear = taxYear,
                    Code = "LHDN_MEDICAL",
                    NameEn = "Medical, Vaccination & Full Check-Up",
                    NameZh = "医疗、疫苗与全面体检税务减免",
                    AnnualCap = 10000.00m,
                    DescriptionEn = "Up to RM 10,000 annual tax relief for serious diseases, fertility treatment, vaccination, and health examination.",
                    DescriptionZh = "每年最高 RM 10,000 税务减免，涵盖重大疾病医疗、疫苗接种及全面健康体检费用。"
                }
            };

            foreach (var bucket in taxBuckets)
            {
                store.TaxReliefBuckets.Add(bucket);
            }
        }
    }
}

