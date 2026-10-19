using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Pfm.Application.DTOs;
using Pfm.Application.Interfaces;
using Pfm.Application.Services;
using Pfm.Domain.Entities;
using Pfm.Domain.Enums;

namespace Pfm.Api.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class DashboardController : ControllerBase
    {
        private readonly IPillarRollUpService _rollUpService;

        public DashboardController(IPillarRollUpService rollUpService)
        {
            _rollUpService = rollUpService;
        }

        [HttpGet("rollup")]
        public ActionResult<DashboardRollUpResponseDto> GetRollUp([FromQuery] DateTime? asOfDate)
        {
            var evalDate = asOfDate ?? DateTime.UtcNow;
            return Ok(_rollUpService.GetDashboardRollUp(evalDate));
        }

        [HttpGet("category-rollups")]
        public ActionResult<IReadOnlyList<CategoryRollUpSummaryDto>> GetCategoryRollUpSummaries(
            [FromQuery] int? year,
            [FromQuery] int? month,
            [FromQuery] DateTime? asOfDate)
        {
            var evalDate = asOfDate ?? DateTime.UtcNow;
            return Ok(_rollUpService.GetCategoryRollUpSummaries(
                year ?? evalDate.Year,
                month ?? evalDate.Month,
                evalDate));
        }

        [HttpGet("cashflow-calendar")]
        public ActionResult<CashflowProjectionCalendarResponseDto> Get30DayCashflowCalendar(
            [FromQuery] DateTime? startDate,
            [FromQuery] decimal expectedMonthlySalaryInflow = 5000.00m,
            [FromQuery] int salaryCreditDayOfMonth = 25)
        {
            return Ok(_rollUpService.Get30DayCashflowProjectionCalendar(
                startDate ?? DateTime.UtcNow,
                expectedMonthlySalaryInflow,
                salaryCreditDayOfMonth));
        }
    }

    [ApiController]
    [Route("api/[controller]")]
    public class CategoryRollUpsController : ControllerBase
    {
        private readonly IPillarRollUpService _rollUpService;

        public CategoryRollUpsController(IPillarRollUpService rollUpService)
        {
            _rollUpService = rollUpService;
        }

        [HttpGet]
        public ActionResult<IReadOnlyList<CategoryRollUpSummaryDto>> GetCategories(
            [FromQuery] int? year,
            [FromQuery] int? month,
            [FromQuery] DateTime? asOfDate)
        {
            var evalDate = asOfDate ?? DateTime.UtcNow;
            return Ok(_rollUpService.GetCategoryRollUpSummaries(
                year ?? evalDate.Year,
                month ?? evalDate.Month,
                evalDate));
        }
    }

    [ApiController]
    [Route("api/[controller]")]
    public class CashflowCalendarController : ControllerBase
    {
        private readonly IPillarRollUpService _rollUpService;

        public CashflowCalendarController(IPillarRollUpService rollUpService)
        {
            _rollUpService = rollUpService;
        }

        [HttpGet("30-day-projection")]
        public ActionResult<CashflowProjectionCalendarResponseDto> Get30DayProjection(
            [FromQuery] DateTime? startDate,
            [FromQuery] decimal expectedMonthlySalaryInflow = 5000.00m,
            [FromQuery] int salaryCreditDayOfMonth = 25)
        {
            return Ok(_rollUpService.Get30DayCashflowProjectionCalendar(
                startDate ?? DateTime.UtcNow,
                expectedMonthlySalaryInflow,
                salaryCreditDayOfMonth));
        }
    }

    [ApiController]
    [Route("api/[controller]")]
    public class VirtualEnvelopesController : ControllerBase
    {
        private readonly IPillarRollUpService _rollUpService;
        private readonly IDoubleEntryLedgerService _ledgerService;

        public VirtualEnvelopesController(IPillarRollUpService rollUpService, IDoubleEntryLedgerService ledgerService)
        {
            _rollUpService = rollUpService;
            _ledgerService = ledgerService;
        }

        [HttpGet]
        public ActionResult<IReadOnlyList<VirtualEnvelopeSummaryDto>> GetVirtualEnvelopes([FromQuery] Guid? accountId)
        {
            return Ok(_rollUpService.GetVirtualEnvelopes(accountId));
        }

        [HttpPost]
        public async Task<ActionResult<VirtualEnvelope>> CreateOrAllocateEnvelope(
            [FromBody] AllocateVirtualEnvelopeRequestDto request,
            CancellationToken cancellationToken)
        {
            var envelope = await _ledgerService.AllocateToVirtualEnvelopeAsync(
                request.AccountId,
                request.NameEn,
                request.NameZh,
                request.AmountToLock,
                request.TargetAmount,
                request.TargetDate,
                cancellationToken);
            return Ok(envelope);
        }
    }

    [ApiController]
    [Route("api/[controller]")]
    public class ReimbursementsController : ControllerBase
    {
        private readonly IPillarRollUpService _rollUpService;
        private readonly IDoubleEntryLedgerService _ledgerService;

        public ReimbursementsController(IPillarRollUpService rollUpService, IDoubleEntryLedgerService ledgerService)
        {
            _rollUpService = rollUpService;
            _ledgerService = ledgerService;
        }

        [HttpGet]
        public ActionResult<IReadOnlyList<PendingReimbursementSummaryDto>> GetPendingReimbursements(
            [FromQuery] bool includeSettled = true)
        {
            return Ok(_rollUpService.GetPendingReimbursements(includeSettled));
        }

        [HttpPost("settle")]
        public async Task<ActionResult<PendingReimbursement>> SettleReimbursement(
            [FromBody] SettleReimbursementRequest request,
            CancellationToken cancellationToken)
        {
            var settled = await _ledgerService.SettleReimbursementAsync(request, cancellationToken);
            return Ok(settled);
        }
    }

    [ApiController]
    [Route("api/[controller]")]
    public class FinancialAlertsController : ControllerBase
    {
        private readonly AccountGuardrailService _guardrailService;

        public FinancialAlertsController(AccountGuardrailService guardrailService)
        {
            _guardrailService = guardrailService;
        }

        /// <summary>
        /// Evaluates all component-level guardrails (Rule A, Rule B, Rule C, Rule D)
        /// and returns localized parameters for both English (en) and Simplified Mandarin (zh-CN).
        /// </summary>
        [HttpGet]
        public ActionResult<IReadOnlyList<FinancialAlertDto>> GetActiveAlerts([FromQuery] DateTime? evaluationDate)
        {
            return Ok(_guardrailService.EvaluateAllRules(evaluationDate ?? DateTime.UtcNow));
        }
    }

    public class CreateCustomSubTypeRequestDto
    {
        public PillarType Pillar { get; set; }
        public string Code { get; set; } = string.Empty;
        public string NameEn { get; set; } = string.Empty;
        public string NameZh { get; set; } = string.Empty;
        public int SortOrder { get; set; } = 100;
    }

    public class CreateCustomAccountRequestDto
    {
        public Guid SubTypeId { get; set; }
        public string NameEn { get; set; } = string.Empty;
        public string NameZh { get; set; } = string.Empty;
        public decimal OpeningBalance { get; set; }
        public decimal MinBalanceLimit { get; set; }
        public InterestCalculationMethod InterestMethod { get; set; }
        public decimal AnnualInterestRate { get; set; }
        public LiabilityType LiabilityType { get; set; }
        public bool IsZeroInterestLiquidAccount { get; set; }
    }

    public class AllocateVirtualEnvelopeRequestDto
    {
        public Guid AccountId { get; set; }
        public string NameEn { get; set; } = string.Empty;
        public string NameZh { get; set; } = string.Empty;
        public decimal AmountToLock { get; set; }
        public decimal TargetAmount { get; set; }
        public DateTime? TargetDate { get; set; }
    }

    [ApiController]
    [Route("api/[controller]")]
    public class AccountsController : ControllerBase
    {
        private readonly IPillarRollUpService _rollUpService;
        private readonly IDoubleEntryLedgerService _ledgerService;

        public AccountsController(IPillarRollUpService rollUpService, IDoubleEntryLedgerService ledgerService)
        {
            _rollUpService = rollUpService;
            _ledgerService = ledgerService;
        }

        [HttpPost("subtypes")]
        public ActionResult<AccountSubType> CreateSubType([FromBody] CreateCustomSubTypeRequestDto request)
        {
            var created = _rollUpService.CreateCustomSubType(
                request.Pillar, request.Code, request.NameEn, request.NameZh, request.SortOrder);
            return Ok(created);
        }

        [HttpPost]
        public ActionResult<Account> CreateAccount([FromBody] CreateCustomAccountRequestDto request)
        {
            var created = _rollUpService.CreateCustomAccount(
                request.SubTypeId,
                request.NameEn,
                request.NameZh,
                request.OpeningBalance,
                request.MinBalanceLimit,
                request.InterestMethod,
                request.AnnualInterestRate,
                request.LiabilityType,
                request.IsZeroInterestLiquidAccount);
            return Ok(created);
        }

        [HttpPost("virtual-envelopes")]
        public async Task<ActionResult<VirtualEnvelope>> AllocateVirtualEnvelope(
            [FromBody] AllocateVirtualEnvelopeRequestDto request,
            CancellationToken cancellationToken)
        {
            var envelope = await _ledgerService.AllocateToVirtualEnvelopeAsync(
                request.AccountId,
                request.NameEn,
                request.NameZh,
                request.AmountToLock,
                request.TargetAmount,
                request.TargetDate,
                cancellationToken);
            return Ok(envelope);
        }

        [HttpGet("{accountId:guid}/safe-to-spend")]
        public ActionResult<decimal> GetSafeToSpend(Guid accountId, [FromQuery] DateTime? asOfDate)
        {
            return Ok(_ledgerService.CalculateUnrestrictedSpendableBalance(accountId, asOfDate ?? DateTime.UtcNow));
        }
    }

    [ApiController]
    [Route("api/[controller]")]
    public class TransactionsController : ControllerBase
    {
        private readonly IDoubleEntryLedgerService _ledgerService;

        public TransactionsController(IDoubleEntryLedgerService ledgerService)
        {
            _ledgerService = ledgerService;
        }

        [HttpPost("expense")]
        public async Task<ActionResult<LedgerTransaction>> RecordExpense(
            [FromBody] CreateExpenseRequest request,
            CancellationToken cancellationToken)
        {
            var tx = await _ledgerService.RecordExpenseAsync(request, cancellationToken);
            return Ok(tx);
        }

        [HttpPost("income")]
        public async Task<ActionResult<LedgerTransaction>> RecordIncome(
            [FromBody] CreateIncomeRequest request,
            CancellationToken cancellationToken)
        {
            var tx = await _ledgerService.RecordIncomeAsync(request, cancellationToken);
            return Ok(tx);
        }

        [HttpPost("transfer")]
        public async Task<ActionResult<TransferResultDto>> RecordTransfer(
            [FromBody] CreateTransferRequest request,
            CancellationToken cancellationToken)
        {
            var result = await _ledgerService.RecordTransferAsync(request, cancellationToken);
            return Ok(result);
        }

        [HttpPost("reimbursements/settle")]
        public async Task<ActionResult<PendingReimbursement>> SettleReimbursement(
            [FromBody] SettleReimbursementRequest request,
            CancellationToken cancellationToken)
        {
            var settled = await _ledgerService.SettleReimbursementAsync(request, cancellationToken);
            return Ok(settled);
        }

        [HttpGet("tax-reliefs/{taxYear:int}")]
        public ActionResult<IReadOnlyList<TaxReliefSummaryDto>> GetTaxReliefSummary(int taxYear)
        {
            return Ok(_ledgerService.GetTaxReliefSummary(taxYear));
        }
    }

    public class PayInstallmentRequestDto
    {
        public Guid SourceLiquidAccountId { get; set; }
        public DateTime PaymentDate { get; set; } = DateTime.UtcNow;
    }

    [ApiController]
    [Route("api/[controller]")]
    public class InstallmentsController : ControllerBase
    {
        private readonly InstallmentScheduleGenerator _installmentGenerator;

        public InstallmentsController(InstallmentScheduleGenerator installmentGenerator)
        {
            _installmentGenerator = installmentGenerator;
        }

        [HttpPost]
        public async Task<ActionResult<InstallmentPlan>> CreateInstallmentPurchase(
            [FromBody] CreateInstallmentPurchaseRequest request,
            CancellationToken cancellationToken)
        {
            var plan = await _installmentGenerator.CreateInstallmentPurchaseAsync(request, cancellationToken);
            return Ok(plan);
        }

        [HttpPost("schedules/{scheduleId:guid}/pay")]
        public async Task<ActionResult<InstallmentSchedule>> PayInstallment(
            Guid scheduleId,
            [FromBody] PayInstallmentRequestDto request,
            CancellationToken cancellationToken)
        {
            var schedule = await _installmentGenerator.PayInstallmentScheduleAsync(
                scheduleId, request.SourceLiquidAccountId, request.PaymentDate, cancellationToken);
            return Ok(schedule);
        }

        [HttpGet("{planId:guid}/progress")]
        public ActionResult<InstallmentPlanProgressDto> GetProgress(Guid planId)
        {
            return Ok(_installmentGenerator.GetInstallmentPlanProgress(planId));
        }

        [HttpGet("dsr")]
        public ActionResult<DsrSummaryDto> GetDsr([FromQuery] int year, [FromQuery] int month, [FromQuery] decimal? overrideNetIncome)
        {
            return Ok(_installmentGenerator.CalculateDebtServiceRatio(year, month, overrideNetIncome));
        }
    }

    [ApiController]
    [Route("api/[controller]")]
    public class InvestmentsController : ControllerBase
    {
        private readonly AsnbMinimumMonthlyBalanceDividendCalculator _asnbCalculator;

        public InvestmentsController(AsnbMinimumMonthlyBalanceDividendCalculator asnbCalculator)
        {
            _asnbCalculator = asnbCalculator;
        }

        [HttpGet("asnb/{accountId:guid}/projection")]
        public ActionResult<AsnbDividendSummaryDto> GetAsnbProjection(Guid accountId, [FromQuery] DateTime? asOfDate)
        {
            return Ok(_asnbCalculator.GetAsnbDividendProjection(accountId, asOfDate ?? DateTime.UtcNow));
        }

        [HttpGet("asnb/calculate-monthly")]
        public ActionResult<decimal> CalculateMonthlyDividend([FromQuery] decimal lowestMonthlyBalance, [FromQuery] decimal annualRatePercent)
        {
            return Ok(_asnbCalculator.CalculateAsnbMonthlyDividend(lowestMonthlyBalance, annualRatePercent));
        }

        [HttpGet("daily-compound")]
        public ActionResult<decimal> CalculateDailyCompound([FromQuery] decimal endOfDayBalance, [FromQuery] decimal annualRatePercent, [FromQuery] int days = 1)
        {
            return Ok(_asnbCalculator.CalculateDailyCompoundInterest(endOfDayBalance, annualRatePercent, days));
        }
    }

    [ApiController]
    [Route("api/[controller]")]
    public class GuardrailsController : ControllerBase
    {
        private readonly AccountGuardrailService _guardrailService;

        public GuardrailsController(AccountGuardrailService guardrailService)
        {
            _guardrailService = guardrailService;
        }

        [HttpGet("evaluate")]
        public ActionResult<IReadOnlyList<FinancialAlertDto>> EvaluateAll([FromQuery] DateTime? evaluationDate)
        {
            return Ok(_guardrailService.EvaluateAllRules(evaluationDate ?? DateTime.UtcNow));
        }

        [HttpGet("floor/{accountId:guid}")]
        public ActionResult<FinancialAlertDto?> EvaluateStaticFloor(Guid accountId)
        {
            return Ok(_guardrailService.EvaluateStaticFloorAlert(accountId));
        }

        [HttpGet("autodebit/{accountId:guid}")]
        public ActionResult<FinancialAlertDto?> EvaluateAutoDebitLookAhead(Guid accountId, [FromQuery] DateTime? evaluationDate)
        {
            return Ok(_guardrailService.EvaluateAutoDebitLookAheadAlert(accountId, evaluationDate ?? DateTime.UtcNow));
        }

        [HttpGet("idle-cash-sweeper")]
        public ActionResult<IReadOnlyList<FinancialAlertDto>> EvaluateIdleCashSweeper([FromQuery] DateTime? evaluationDate)
        {
            return Ok(_guardrailService.EvaluateIdleCashSweeperAlerts(evaluationDate ?? DateTime.UtcNow));
        }
    }
}

