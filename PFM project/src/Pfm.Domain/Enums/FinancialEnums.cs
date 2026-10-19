namespace Pfm.Domain.Enums
{
    /// <summary>
    /// The 4 immutable financial pillars under which users can create unlimited AccountSubTypes and Accounts.
    /// </summary>
    public enum PillarType
    {
        ASSET_LIQUID = 1,
        ASSET_INVESTMENT = 2,
        LIABILITY = 3,
        INCOME_SOURCE = 4
    }

    /// <summary>
    /// Double-entry transaction types.
    /// </summary>
    public enum TransactionType
    {
        EXPENSE = 1,
        INCOME = 2,
        TRANSFER = 3
    }

    /// <summary>
    /// Interest / dividend calculation methods for liquid and investment accounts.
    /// </summary>
    public enum InterestCalculationMethod
    {
        NONE = 0,
        ASNB_MIN_MONTHLY = 1,
        DAILY_COMPOUND = 2,
        FIXED_MATURITY = 3
    }

    /// <summary>
    /// Distinguishes statement float liabilities from amortized installment / BNPL / loan liabilities.
    /// </summary>
    public enum LiabilityType
    {
        NONE = 0,
        BNPL_SPAYLATER = 1,
        CREDIT_CARD_STATEMENT = 2,
        CREDIT_CARD_EPP = 3,
        TERM_LOAN = 4
    }

    /// <summary>
    /// Lifecycle status of a monthly installment schedule slice.
    /// </summary>
    public enum InstallmentStatus
    {
        UPCOMING = 1,
        DUE = 2,
        PAID = 3,
        OVERDUE = 4
    }

    /// <summary>
    /// Lifecycle status of a split-bill pending reimbursement owed by friends.
    /// </summary>
    public enum ReimbursementStatus
    {
        NONE = 0,
        PENDING = 1,
        PARTIALLY_SETTLED = 2,
        SETTLED = 3
    }

    /// <summary>
    /// Component-level guardrail and proactive suggestion rule codes.
    /// </summary>
    public enum AlertRuleCode
    {
        RULE_A_STATIC_FLOOR = 1,
        RULE_B_AUTODEBIT_LOOKAHEAD = 2,
        RULE_C_IDLE_CASH_SWEEPER = 3,
        RULE_D_VELOCITY_OVERSPEND_CAP = 4,
        ASNB_DEPOSIT_TIMING_TIP = 5
    }

    /// <summary>
    /// Alert severity level for UI presentation.
    /// </summary>
    public enum AlertSeverity
    {
        INFO = 1,
        WARNING = 2,
        CRITICAL = 3
    }
}

