using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using Pfm.Application.Interfaces;
using Pfm.Domain.Entities;

namespace Pfm.Infrastructure.Persistence
{
    /// <summary>
    /// Entity Framework Core DbContext for SQLite (offline-first/local) and PostgreSQL/SQL Server.
    /// Configures every monetary property strictly as DECIMAL(18, 2).
    /// </summary>
    public class PfmDbContext : DbContext
    {
        public PfmDbContext(DbContextOptions<PfmDbContext> options) : base(options)
        {
        }

        public DbSet<AccountSubType> AccountSubTypes => Set<AccountSubType>();
        public DbSet<Account> Accounts => Set<Account>();
        public DbSet<VirtualEnvelope> VirtualEnvelopes => Set<VirtualEnvelope>();
        public DbSet<TransactionCategory> TransactionCategories => Set<TransactionCategory>();
        public DbSet<TaxReliefBucket> TaxReliefBuckets => Set<TaxReliefBucket>();
        public DbSet<LedgerTransaction> LedgerTransactions => Set<LedgerTransaction>();
        public DbSet<PendingReimbursement> PendingReimbursements => Set<PendingReimbursement>();
        public DbSet<InstallmentPlan> InstallmentPlans => Set<InstallmentPlan>();
        public DbSet<InstallmentSchedule> InstallmentSchedules => Set<InstallmentSchedule>();
        public DbSet<RecurringAutoDebit> RecurringAutoDebits => Set<RecurringAutoDebit>();
        public DbSet<MonthlyAccountSnapshot> MonthlyAccountSnapshots => Set<MonthlyAccountSnapshot>();
        public DbSet<FinancialAlert> FinancialAlerts => Set<FinancialAlert>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            base.OnModelCreating(modelBuilder);

            modelBuilder.Entity<Account>(b =>
            {
                b.Property(x => x.Currency).HasMaxLength(8).HasDefaultValue("MYR");
                b.Property(x => x.CurrentBalance).HasColumnType("DECIMAL(18, 2)");
                b.Property(x => x.MinBalanceLimit).HasColumnType("DECIMAL(18, 2)");
                b.Property(x => x.AnnualInterestRate).HasColumnType("DECIMAL(18, 4)");
                b.Property(x => x.CreditLimit).HasColumnType("DECIMAL(18, 2)");
            });

            modelBuilder.Entity<VirtualEnvelope>(b =>
            {
                b.Property(x => x.AllocatedBalance).HasColumnType("DECIMAL(18, 2)");
                b.Property(x => x.TargetAmount).HasColumnType("DECIMAL(18, 2)");
            });

            modelBuilder.Entity<TransactionCategory>(b =>
            {
                b.Property(x => x.MonthlyBudgetLimit).HasColumnType("DECIMAL(18, 2)");
            });

            modelBuilder.Entity<TaxReliefBucket>(b =>
            {
                b.Property(x => x.AnnualCap).HasColumnType("DECIMAL(18, 2)");
            });

            modelBuilder.Entity<LedgerTransaction>(b =>
            {
                b.Property(x => x.TotalAmount).HasColumnType("DECIMAL(18, 2)");
                b.Property(x => x.PersonalAmount).HasColumnType("DECIMAL(18, 2)");
                b.Property(x => x.ReceivableAmount).HasColumnType("DECIMAL(18, 2)");
                b.Property(x => x.TransferFee).HasColumnType("DECIMAL(18, 2)");
                b.HasOne(x => x.PendingReimbursement)
                    .WithOne(r => r.OriginalTransaction)
                    .HasForeignKey<PendingReimbursement>(r => r.OriginalTransactionId);
            });

            modelBuilder.Entity<PendingReimbursement>(b =>
            {
                b.Property(x => x.OwedAmount).HasColumnType("DECIMAL(18, 2)");
                b.Property(x => x.SettledAmount).HasColumnType("DECIMAL(18, 2)");
            });

            modelBuilder.Entity<InstallmentPlan>(b =>
            {
                b.Property(x => x.TotalPrincipal).HasColumnType("DECIMAL(18, 2)");
                b.Property(x => x.TotalInterestOrFee).HasColumnType("DECIMAL(18, 2)");
                b.Property(x => x.MonthlyInstallmentAmount).HasColumnType("DECIMAL(18, 2)");
                b.Ignore(x => x.TotalPayable);
            });

            modelBuilder.Entity<InstallmentSchedule>(b =>
            {
                b.Property(x => x.PrincipalPortion).HasColumnType("DECIMAL(18, 2)");
                b.Property(x => x.InterestOrFeePortion).HasColumnType("DECIMAL(18, 2)");
                b.Property(x => x.TotalDue).HasColumnType("DECIMAL(18, 2)");
            });

            modelBuilder.Entity<RecurringAutoDebit>(b =>
            {
                b.Property(x => x.Amount).HasColumnType("DECIMAL(18, 2)");
            });

            modelBuilder.Entity<MonthlyAccountSnapshot>(b =>
            {
                b.Property(x => x.OpeningBalance).HasColumnType("DECIMAL(18, 2)");
                b.Property(x => x.LowestMonthlyBalance).HasColumnType("DECIMAL(18, 2)");
                b.Property(x => x.ClosingBalance).HasColumnType("DECIMAL(18, 2)");
                b.Property(x => x.AppliedAnnualRate).HasColumnType("DECIMAL(18, 4)");
                b.Property(x => x.AccruedDividendOrInterest).HasColumnType("DECIMAL(18, 2)");
                b.HasIndex(x => new { x.AccountId, x.Year, x.Month }).IsUnique();
            });

            modelBuilder.Entity<FinancialAlert>(b =>
            {
                b.Property(x => x.SuggestedTransferAmount).HasColumnType("DECIMAL(18, 2)");
            });
        }
    }
}

