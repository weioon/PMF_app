-- =========================================================================================
-- Personal Financial Management (PFM) System - Bilingual (EN / zh-CN) SQLite & SQL Schema
-- Currency Default: MYR (RM), stored strictly as DECIMAL(18, 2)
-- =========================================================================================

CREATE TABLE IF NOT EXISTS AccountSubTypes (
    Id TEXT PRIMARY KEY,
    Pillar INTEGER NOT NULL, -- 1=ASSET_LIQUID, 2=ASSET_INVESTMENT, 3=LIABILITY, 4=INCOME_SOURCE
    Code TEXT NOT NULL UNIQUE,
    NameEn TEXT NOT NULL,
    NameZh TEXT NOT NULL,
    TranslationKey TEXT NULL,
    IsSystemSeeded INTEGER NOT NULL DEFAULT 0,
    SortOrder INTEGER NOT NULL DEFAULT 0,
    CreatedAtUtc TEXT NOT NULL,
    UpdatedAtUtc TEXT NULL
);

CREATE TABLE IF NOT EXISTS Accounts (
    Id TEXT PRIMARY KEY,
    AccountSubTypeId TEXT NOT NULL,
    Pillar INTEGER NOT NULL,
    NameEn TEXT NOT NULL,
    NameZh TEXT NOT NULL,
    TranslationKey TEXT NULL,
    Currency TEXT NOT NULL DEFAULT 'MYR',
    CurrentBalance DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    MinBalanceLimit DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    LookAheadAlertDays INTEGER NOT NULL DEFAULT 7,
    InterestMethod INTEGER NOT NULL DEFAULT 0, -- 0=NONE, 1=ASNB_MIN_MONTHLY, 2=DAILY_COMPOUND, 3=FIXED_MATURITY
    AnnualInterestRate DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
    LiabilityType INTEGER NOT NULL DEFAULT 0,  -- 0=NONE, 1=BNPL_SPAYLATER, 2=CREDIT_CARD_STATEMENT, 3=CREDIT_CARD_EPP, 4=TERM_LOAN
    CreditLimit DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    StatementClosingDay INTEGER NULL,
    PaymentDueDay INTEGER NULL,
    IsZeroInterestLiquidAccount INTEGER NOT NULL DEFAULT 0,
    IsActive INTEGER NOT NULL DEFAULT 1,
    CreatedAtUtc TEXT NOT NULL,
    UpdatedAtUtc TEXT NULL,
    FOREIGN KEY (AccountSubTypeId) REFERENCES AccountSubTypes(Id)
);

CREATE TABLE IF NOT EXISTS VirtualEnvelopes (
    Id TEXT PRIMARY KEY,
    AccountId TEXT NOT NULL,
    NameEn TEXT NOT NULL,
    NameZh TEXT NOT NULL,
    TranslationKey TEXT NULL,
    AllocatedBalance DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    TargetAmount DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    TargetDate TEXT NULL,
    IsActive INTEGER NOT NULL DEFAULT 1,
    CreatedAtUtc TEXT NOT NULL,
    UpdatedAtUtc TEXT NULL,
    FOREIGN KEY (AccountId) REFERENCES Accounts(Id)
);

CREATE TABLE IF NOT EXISTS TransactionCategories (
    Id TEXT PRIMARY KEY,
    Code TEXT NOT NULL UNIQUE,
    NameEn TEXT NOT NULL,
    NameZh TEXT NOT NULL,
    TranslationKey TEXT NULL,
    ApplicableType INTEGER NOT NULL, -- 1=EXPENSE, 2=INCOME, 3=TRANSFER
    MonthlyBudgetLimit DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    IsSystemFeeCategory INTEGER NOT NULL DEFAULT 0,
    CreatedAtUtc TEXT NOT NULL,
    UpdatedAtUtc TEXT NULL
);

CREATE TABLE IF NOT EXISTS TaxReliefBuckets (
    Id TEXT PRIMARY KEY,
    TaxYear INTEGER NOT NULL,
    Code TEXT NOT NULL,
    NameEn TEXT NOT NULL,
    NameZh TEXT NOT NULL,
    TranslationKey TEXT NULL,
    AnnualCap DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    DescriptionEn TEXT NOT NULL,
    DescriptionZh TEXT NOT NULL,
    CreatedAtUtc TEXT NOT NULL,
    UpdatedAtUtc TEXT NULL
);

CREATE TABLE IF NOT EXISTS LedgerTransactions (
    Id TEXT PRIMARY KEY,
    TransactionDate TEXT NOT NULL,
    Type INTEGER NOT NULL, -- 1=EXPENSE, 2=INCOME, 3=TRANSFER
    SourceAccountId TEXT NULL,
    DestinationAccountId TEXT NULL,
    CategoryId TEXT NULL,
    TotalAmount DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    PersonalAmount DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    ReceivableAmount DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    TransferFee DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    LinkedFeeTransactionId TEXT NULL,
    TaxReliefBucketId TEXT NULL,
    ReceiptAttachmentUrl TEXT NULL,
    InstallmentPlanId TEXT NULL,
    InstallmentScheduleId TEXT NULL,
    IsCreditCardStatementFloat INTEGER NOT NULL DEFAULT 0,
    IsReimbursementSettlement INTEGER NOT NULL DEFAULT 0,
    DescriptionEn TEXT NOT NULL,
    DescriptionZh TEXT NOT NULL,
    CreatedAtUtc TEXT NOT NULL,
    UpdatedAtUtc TEXT NULL,
    FOREIGN KEY (SourceAccountId) REFERENCES Accounts(Id),
    FOREIGN KEY (DestinationAccountId) REFERENCES Accounts(Id),
    FOREIGN KEY (CategoryId) REFERENCES TransactionCategories(Id),
    FOREIGN KEY (TaxReliefBucketId) REFERENCES TaxReliefBuckets(Id)
);

CREATE TABLE IF NOT EXISTS PendingReimbursements (
    Id TEXT PRIMARY KEY,
    OriginalTransactionId TEXT NOT NULL,
    DebtorName TEXT NOT NULL,
    OwedAmount DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    SettledAmount DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    Status INTEGER NOT NULL DEFAULT 1, -- 1=PENDING, 2=PARTIALLY_SETTLED, 3=SETTLED
    SettlementTransactionId TEXT NULL,
    SettledAtUtc TEXT NULL,
    CreatedAtUtc TEXT NOT NULL,
    UpdatedAtUtc TEXT NULL,
    FOREIGN KEY (OriginalTransactionId) REFERENCES LedgerTransactions(Id)
);

CREATE TABLE IF NOT EXISTS InstallmentPlans (
    Id TEXT PRIMARY KEY,
    LiabilityAccountId TEXT NOT NULL,
    LinkedRepaymentAccountId TEXT NULL,
    CategoryId TEXT NOT NULL,
    MerchantOrTitleEn TEXT NOT NULL,
    MerchantOrTitleZh TEXT NOT NULL,
    TotalPrincipal DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    TotalInterestOrFee DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    TenureMonths INTEGER NOT NULL,
    MonthlyInstallmentAmount DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    StartDate TEXT NOT NULL,
    IsActive INTEGER NOT NULL DEFAULT 1,
    CreatedAtUtc TEXT NOT NULL,
    UpdatedAtUtc TEXT NULL,
    FOREIGN KEY (LiabilityAccountId) REFERENCES Accounts(Id),
    FOREIGN KEY (LinkedRepaymentAccountId) REFERENCES Accounts(Id),
    FOREIGN KEY (CategoryId) REFERENCES TransactionCategories(Id)
);

CREATE TABLE IF NOT EXISTS InstallmentSchedules (
    Id TEXT PRIMARY KEY,
    InstallmentPlanId TEXT NOT NULL,
    InstallmentNumber INTEGER NOT NULL,
    DueDate TEXT NOT NULL,
    PrincipalPortion DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    InterestOrFeePortion DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    TotalDue DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    Status INTEGER NOT NULL DEFAULT 1, -- 1=UPCOMING, 2=DUE, 3=PAID, 4=OVERDUE
    PaidAtUtc TEXT NULL,
    PaymentTransactionId TEXT NULL,
    CreatedAtUtc TEXT NOT NULL,
    UpdatedAtUtc TEXT NULL,
    FOREIGN KEY (InstallmentPlanId) REFERENCES InstallmentPlans(Id)
);

CREATE TABLE IF NOT EXISTS RecurringAutoDebits (
    Id TEXT PRIMARY KEY,
    AccountId TEXT NOT NULL,
    CategoryId TEXT NULL,
    NameEn TEXT NOT NULL,
    NameZh TEXT NOT NULL,
    TranslationKey TEXT NULL,
    Amount DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    BillingDayOfMonth INTEGER NOT NULL,
    NextDueDate TEXT NOT NULL,
    IsActive INTEGER NOT NULL DEFAULT 1,
    CreatedAtUtc TEXT NOT NULL,
    UpdatedAtUtc TEXT NULL,
    FOREIGN KEY (AccountId) REFERENCES Accounts(Id)
);

CREATE TABLE IF NOT EXISTS MonthlyAccountSnapshots (
    Id TEXT PRIMARY KEY,
    AccountId TEXT NOT NULL,
    Year INTEGER NOT NULL,
    Month INTEGER NOT NULL,
    OpeningBalance DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    LowestMonthlyBalance DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    ClosingBalance DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    AppliedAnnualRate DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
    AccruedDividendOrInterest DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    CreatedAtUtc TEXT NOT NULL,
    UpdatedAtUtc TEXT NULL,
    UNIQUE(AccountId, Year, Month),
    FOREIGN KEY (AccountId) REFERENCES Accounts(Id)
);

