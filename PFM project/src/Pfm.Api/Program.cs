using System;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Pfm.Application.Interfaces;
using Pfm.Application.Services;
using Pfm.Infrastructure.Persistence;
using Pfm.Infrastructure.Persistence.Seed;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// Register Bilingual PFM Clean Architecture Services
var store = new InMemoryPfmDataStore();
BilingualDatabaseSeeder.SeedDefaultData(store, DateTime.UtcNow.Year);

builder.Services.AddSingleton<IPfmDataStore>(store);
builder.Services.AddScoped<AsnbMinimumMonthlyBalanceDividendCalculator>();
builder.Services.AddScoped<IInvestmentYieldService, AsnbMinimumMonthlyBalanceDividendCalculator>();
builder.Services.AddScoped<IDoubleEntryLedgerService, DoubleEntryLedgerService>();
builder.Services.AddScoped<InstallmentScheduleGenerator>();
builder.Services.AddScoped<IInstallmentEngineService, InstallmentScheduleGenerator>();
builder.Services.AddScoped<AccountGuardrailService>();
builder.Services.AddScoped<IGuardrailRuleEngine, AccountGuardrailService>();
builder.Services.AddScoped<IPillarRollUpService, PillarRollUpService>();

builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowMobileAndWebClient", policy =>
        policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod());
});

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseCors("AllowMobileAndWebClient");
app.UseStaticFiles();
app.MapControllers();

app.Run();

