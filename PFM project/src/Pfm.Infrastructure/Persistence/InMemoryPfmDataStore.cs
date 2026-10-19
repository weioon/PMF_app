using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Pfm.Application.Interfaces;
using Pfm.Domain.Entities;

namespace Pfm.Infrastructure.Persistence
{
    /// <summary>
    /// Transactional data store backing the PFM application (supports in-memory / local persistence
    /// and shares exact schema definitions with PfmDbContext for SQLite / PostgreSQL / SQL Server).
    /// </summary>
    public class InMemoryPfmDataStore : IPfmDataStore
    {
        public IList<AccountSubType> AccountSubTypes { get; } = new List<AccountSubType>();
        public IList<Account> Accounts { get; } = new List<Account>();
        public IList<VirtualEnvelope> VirtualEnvelopes { get; } = new List<VirtualEnvelope>();
        public IList<TransactionCategory> TransactionCategories { get; } = new List<TransactionCategory>();
        public IList<TaxReliefBucket> TaxReliefBuckets { get; } = new List<TaxReliefBucket>();
        public IList<LedgerTransaction> LedgerTransactions { get; } = new List<LedgerTransaction>();
        public IList<PendingReimbursement> PendingReimbursements { get; } = new List<PendingReimbursement>();
        public IList<InstallmentPlan> InstallmentPlans { get; } = new List<InstallmentPlan>();
        public IList<InstallmentSchedule> InstallmentSchedules { get; } = new List<InstallmentSchedule>();
        public IList<RecurringAutoDebit> RecurringAutoDebits { get; } = new List<RecurringAutoDebit>();
        public IList<MonthlyAccountSnapshot> MonthlyAccountSnapshots { get; } = new List<MonthlyAccountSnapshot>();
        public IList<FinancialAlert> FinancialAlerts { get; } = new List<FinancialAlert>();

        public async Task ExecuteInTransactionAsync(Func<Task> action, CancellationToken cancellationToken = default)
        {
            if (action == null) throw new ArgumentNullException(nameof(action));
            await action();
        }

        public Task<int> SaveChangesAsync(CancellationToken cancellationToken = default)
        {
            return Task.FromResult(1);
        }
    }
}

