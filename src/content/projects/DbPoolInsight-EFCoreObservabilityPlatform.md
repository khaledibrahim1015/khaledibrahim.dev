---
title: "DbPoolInsight — Observability Platform"
description: "A production-grade monitoring platform for Entity Framework Core DbContext pooling — built from scratch, shipped as three NuGet packages, and fully deployed on Kubernetes with Prometheus, Grafana, and automated alerting."
date: 2026-03-11
tech: [".NET", "EF Core", "C#", "OpenTelemetry" ,"Prometheus", "Grafana" , "Kubernetes" , "Kustomize" , "Helm","Docker" ,"SQL Server" ,"K6"]
tags: [ ".NET", "EF Core", "C#", "OpenTelemetry" ,"Prometheus", "Grafana" , "Kubernetes" , "Kustomize" , "Helm","Docker", "Bash Script","K6 Load Testing", "DbContext Pooling", "metrics" ,"observability","HorizontalPodAutoscaler" ,"System.Diagnostics.Metrics" ]
featured: true
draft: false
---
# DbPoolInsight — EF Core Observability Platform

> A production-grade monitoring platform for Entity Framework Core DbContext pooling — built from scratch, shipped as three NuGet packages, and fully deployed on Kubernetes with Prometheus, Grafana, and automated alerting.

**GitHub:** [github.com/khaledibrahim1015/DbPoolInsight](https://github.com/khaledibrahim1015/DbPoolInsight)

---
## 🔍 Project Snapshot

> Built a complete observability platform for EF Core DbContext pooling — from zero built-in instrumentation to production-grade metrics, alerts, and dashboards — shipped as 3 NuGet packages and fully deployed on Kubernetes.

---

### What It Does in 30 Seconds

EF Core's `DbContextPool` gives you serious throughput gains, but ships with **zero visibility** into pool behavior. DbPoolInsight fixes that.

Three non-invasive hooks (`DiagnosticListener` + `DbCommandInterceptor` + `IResettableService`) reconstruct the full pool lifecycle and export everything as standard OpenTelemetry metrics — no reflection, no EF Core internals modified.

---

### Live Under Load

k6 hitting the API at 20 VUs — **100% return rate, 0 leaks, 16.7x reuse ratio**:

![k6 Load Test + Grafana Dashboard](/public/docs/GrafanaDashBoard-k6-loadtest.png)

Pooled + standard DbContext metrics side by side — **555 creations, 555 disposals, 0 active, 0 leaks**:

![Grafana Standard DbContext Panel](/public/docs/GrafanaDashBoard-k6-loadtest-2.png)

---

### Fully Deployed on Kubernetes

One script. Dev and prod overlays via Kustomize. Prometheus + Grafana via Helm. HPA on CPU + memory.

![Kubernetes Deployment](/public/docs/apply-deployment-k8s-1.png)

![Kubernetes Cluster Running](/public/docs/apply-deployment-k8s-2.png)

---

### By the Numbers

| | |
|---|---|
| **NuGet packages shipped** | 3 |
| **Metrics tracked** | 24 (17 pool + 7 standard) |
| **Kubernetes manifests** | Base + dev/prod overlays + HPA |
| **Prometheus alert rules** | 5 (leak, utilization, return rate, overflow, slow rent) |
| **Load test result** | 576 checks · 100% pass · 0 failures |
| **Stack** | .NET 8 · EF Core · OTel · Prometheus · Grafana · K8s · Helm · Kustomize |

---

## NuGet Packages

| Package | Version | Purpose |
|---|---|---|
| [`EFCore.Observability`](https://www.nuget.org/packages/EFCore.Observability) | 1.0.0 | Core tracking engine — DiagnosticListener, interceptor, IResettableService hooks |
| [`EFCore.Observability.Core`](https://www.nuget.org/packages/EFCore.Observability.Core) | 1.0.0 | Zero-dependency abstractions, models, and enums |
| [`EFCore.Observability.OpenTelemetry`](https://www.nuget.org/packages/EFCore.Observability.OpenTelemetry) | 1.0.0 | OTel bridge — exports metrics to Prometheus, Grafana, Datadog |

---

## Table of Contents

1. [The Problem](#1-the-problem)
2. [Solution Overview](#2-solution-overview)
3. [Library Usage — Quick Integration](#3-library-usage--quick-integration)
4. [Library Usage — Full Configuration](#4-library-usage--full-configuration)
5. [Library Usage — Multiple DbContext Types](#5-library-usage--multiple-dbcontext-types)
6. [Library Usage — Reading Metrics](#6-library-usage--reading-metrics)
7. [Library Usage — Health Checks & Background Monitoring](#7-library-usage--health-checks--background-monitoring)
8. [Demo API — Endpoints & Load Tests](#8-demo-api--endpoints--load-tests)
9. [OpenTelemetry Integration](#9-opentelemetry-integration)
10. [Docker — Container Build](#10-docker--container-build)
11. [Kubernetes — Cluster Structure](#11-kubernetes--cluster-structure)
12. [Kubernetes — Namespace & Secrets](#12-kubernetes--namespace--secrets)
13. [Kubernetes — SQL Server Deployment](#13-kubernetes--sql-server-deployment)
14. [Kubernetes — Database Initialization Job](#14-kubernetes--database-initialization-job)
15. [Kubernetes — EFCore API Deployment](#15-kubernetes--efcore-api-deployment)
16. [Kubernetes — Services](#16-kubernetes--services)
17. [Kubernetes — Kustomize Base](#17-kubernetes--kustomize-base)
18. [Kubernetes — Dev Overlay](#18-kubernetes--dev-overlay)
19. [Kubernetes — Prod Overlay & HPA](#19-kubernetes--prod-overlay--hpa)
20. [Helm — Monitoring Stack](#20-helm--monitoring-stack)
21. [Helm — ServiceMonitor](#21-helm--servicemonitor)
22. [Helm — PrometheusRule Alerts](#22-helm--prometheusrule-alerts)
23. [Grafana — Dashboard & PromQL](#23-grafana--dashboard--promql)
24. [Deployment Script](#24-deployment-script)
25. [Build & Push Script](#25-build--push-script)
26. [Accessing the Cluster](#26-accessing-the-cluster)
27. [Metrics Reference](#27-metrics-reference)
28. [Technology Stack](#28-technology-stack)

---

## 1. The Problem

Entity Framework Core's `DbContextPool` reuses `DbContext` instances across HTTP requests instead of constructing a new one every time. In production, this delivers significant throughput gains — but the framework provides **zero built-in instrumentation** for pool behavior.

Without observability you cannot answer:

- Is the pool actually being reused, or is a new instance created on every request?
- Are contexts leaking — rented from the pool but never returned?
- Is the pool sized correctly, or is it thrashing under load?
- How long are contexts held per request (min, avg, max)?
- When the pool is full, are overflow disposals happening at a healthy rate?

The tracking is non-trivial because EF Core's `ContextInitialized` diagnostic event fires once at **physical construction** — not once per logical rent. When a context is reused from the pool there is no built-in event. Standard APM tools and health checks are completely blind to pool lifecycle.

---

## 2. Solution Overview

Three complementary hooks reconstruct the full pool lifecycle without modifying EF Core internals or using reflection:

| Hook | Implementation | Detects |
|---|---|---|
| `DiagnosticListener` | `IObserver<DiagnosticListener>` | Physical creation and physical disposal |
| Command pipeline | `DbCommandInterceptor` | First command per logical rent (every reuse) |
| Pool return | `IResettableService` | Every clean return to the pool |

These three hooks feed a single singleton `DbContextLifeCycleTracker` that maintains lock-free, thread-safe counters and an activity ring buffer per context type. An OpenTelemetry bridge then exports everything as standard .NET Metrics instruments to any compatible backend.

---

## 3. Library Usage — Quick Integration

Install the packages:

```bash
dotnet add package EFCore.Observability
dotnet add package EFCore.Observability.OpenTelemetry        # optional — for OTel/Prometheus
dotnet add package OpenTelemetry.Extensions.Hosting          # optional
dotnet add package OpenTelemetry.Exporter.Prometheus.AspNetCore  # optional
```

Minimum `Program.cs`:

```csharp
var builder = WebApplication.CreateBuilder(args);

// 1. Register observability services
builder.Services.AddEFCoreObservability();

// 2. Register your pooled DbContext — call UseObservability inside the lambda
builder.Services.AddDbContextPool<AppDbContext>((sp, options) =>
{
    options.UseSqlServer(builder.Configuration.GetConnectionString("Default"))
           .UseObservability<AppDbContext>(sp, poolSize: 128);
}, poolSize: 128);  // ← poolSize must match in both places

var app = builder.Build();

// 3. Activate the DiagnosticListener subscription — MUST be after Build()
app.Services.UseEFCoreObservability();

// 4. Expose a quick JSON endpoint
app.MapGet("/health/pool", (DiagnosticsQueryService q) => q.GetSummary());
app.Run();
```

Verify after a few requests:

```bash
curl http://localhost:5000/health/pool
```

```json
{
  "pooled": [{
    "contextName": "AppDbContext",
    "maxPoolSize": 128,
    "physicalCreations": 1,
    "totalRents": 3,
    "totalReturns": 3,
    "activeRents": 0,
    "reuseRatio": 3.0,
    "returnRate": 100.0,
    "leakedContexts": 0,
    "healthStatus": "Healthy",
    "reuseQuality": "Fair"
  }],
  "standard": []
}
```

---

## 4. Library Usage — Full Configuration

```csharp
var builder = WebApplication.CreateBuilder(args);

// ── Observability with all options ───────────────────────────────────────────
builder.Services.AddEFCoreObservability(opts =>
{
    // Record per-rent timing — feeds avg/min/max duration metrics
    opts.TrackRentDurations = true;

    // Track non-pooled DbContext creation/disposal as well
    opts.TrackStandardContexts = true;

    // Emit ILogger messages for every lifecycle event — development only
    opts.EnableDiagnosticLogging = false;

    // Ring-buffer capacity; oldest entry is dropped when full
    opts.MaxActivityHistoryPerContext = 500;

    // Reserved for future automated leak detection (not yet enforced)
    opts.LeakDetectionThresholdMs = 30_000;
});

// ── Pooled DbContext ─────────────────────────────────────────────────────────
builder.Services.AddDbContextPool<PrimaryDbContext>((sp, options) =>
{
    options.UseSqlServer(builder.Configuration.GetConnectionString("TMS_Conn"))
           .UseObservability<PrimaryDbContext>(sp, poolSize: 128);
}, poolSize: 128);

// ── Standard (non-pooled) DbContext — tracked automatically ─────────────────
// No UseObservability() call needed; DiagnosticListener handles it
builder.Services.AddDbContext<ReplicaDbContext>((sp, options) =>
{
    options.UseSqlServer(builder.Configuration.GetConnectionString("TMSReplica_Conn"));
});

// ── OpenTelemetry → Prometheus ───────────────────────────────────────────────
builder.Services.AddOpenTelemetry()
    .WithMetrics(m => m
        .AddEFCoreInstrumentation()  // registers both EFCore.Pool + EFCore.Standard meters
        .AddPrometheusExporter());

// ── Health checks ────────────────────────────────────────────────────────────
builder.Services.AddHealthChecks()
    .Add(new HealthCheckRegistration(
        "efcore-pool",
        sp => new EFCorePoolHealthCheck(sp.GetRequiredService<DiagnosticsQueryService>()),
        HealthStatus.Degraded,
        tags: ["database", "pool"]));

var app = builder.Build();

// ── Activate DiagnosticListener (after Build) ────────────────────────────────
app.Services.UseEFCoreObservability();

// ── Endpoints ────────────────────────────────────────────────────────────────
app.MapPrometheusScrapingEndpoint();                                     // /metrics
app.MapHealthChecks("/health");
app.MapGet("/diagnostics/efcore/metrics", (DiagnosticsQueryService q) => q.GetAllDetails());
app.MapGet("/diagnostics/summary",        (DiagnosticsQueryService q) => q.GetSummary());

app.Run();
```

> ⚠️ **Critical:** `UseEFCoreObservability()` must be called **after** `builder.Build()`. Calling it earlier subscribes a discarded instance from a transient service provider, so no events are received.

> ⚠️ **Critical:** The `poolSize` value passed to `UseObservability<TContext>(sp, poolSize: N)` must match the value passed to `AddDbContextPool<TContext>(..., poolSize: N)`. A mismatch causes incorrect `PoolUtilization` and `RoomToGrow` calculations.

---

## 5. Library Usage — Multiple DbContext Types

Each type gets its own isolated metrics bucket, keyed by `typeof(TContext).Name`:

```csharp
// Primary write DB — large pool
builder.Services.AddDbContextPool<WriteDbContext>((sp, options) =>
    options.UseSqlServer(writeConnString)
           .UseObservability<WriteDbContext>(sp, poolSize: 128), poolSize: 128);

// Read replica — smaller pool
builder.Services.AddDbContextPool<ReadDbContext>((sp, options) =>
    options.UseSqlServer(readConnString)
           .UseObservability<ReadDbContext>(sp, poolSize: 64), poolSize: 64);

// Analytics — standard (not pooled), tracked automatically
builder.Services.AddDbContext<AnalyticsDbContext>(options =>
    options.UseSqlServer(analyticsConnString));
```

Query each bucket independently:

```csharp
// Inject IContextMetricsProvider (read-only interface — prefer over DiagnosticsQueryService)
public class MyService(IContextMetricsProvider metrics)
{
    public void LogStatus()
    {
        var write     = metrics.GetPooledMetrics("WriteDbContext");
        var read      = metrics.GetPooledMetrics("ReadDbContext");
        var analytics = metrics.GetStandardMetrics("AnalyticsDbContext");

        Console.WriteLine($"Write pool utilization: {write?.PoolUtilization}%");
        Console.WriteLine($"Read  pool reuse ratio: {read?.ReuseRatio}x");
        Console.WriteLine($"Analytics active:       {analytics?.ActiveContexts}");
    }
}
```

---

## 6. Library Usage — Reading Metrics

### Via DiagnosticsQueryService (shaped responses)

```csharp
app.MapGet("/diagnostics/summary", (DiagnosticsQueryService q) =>
    q.GetSummary());

app.MapGet("/diagnostics/details", (DiagnosticsQueryService q) =>
    q.GetAllDetails());

app.MapGet("/diagnostics/pool/{name}", (string name, DiagnosticsQueryService q) =>
{
    var m = q.GetPooledMetrics(name);
    return m is null ? Results.NotFound() : Results.Ok(m);
});

app.MapGet("/diagnostics/activity/{name}", (string name, DiagnosticsQueryService q) =>
    q.GetRecentActivity(name, take: 50));
```

### Via IContextMetricsProvider (raw interface)

```csharp
public class PoolStatusService(IContextMetricsProvider provider)
{
    public bool IsHealthy(string contextName)
    {
        var m = provider.GetPooledMetrics(contextName);
        return m is { LeakedContexts: 0, ReturnRate: >= 99.0, PoolUtilization: < 90 };
    }

    public void PrintAll()
    {
        foreach (var (name, m) in provider.GetAllPooledMetrics())
        {
            Console.WriteLine($"[{name}] " +
                $"Rents={m.TotalRents} Returns={m.TotalReturns} " +
                $"Leaks={m.LeakedContexts} Utilization={m.PoolUtilization}% " +
                $"ReuseRatio={m.ReuseRatio}x Health={m.HealthStatus}");
        }
    }
}
```

### GetSummary() response shape

```json
{
  "pooled": [{
    "contextName": "PrimaryDbContext",
    "maxPoolSize": 128,
    "summary": "Pool Size: 128, Active: 6/8",
    "physicalCreations": 8,
    "physicalDisposals": 0,
    "physicalInPool": 8,
    "availableInPool": 2,
    "roomToGrow": 120,
    "activeRents": 6,
    "totalRents": 4821,
    "totalReturns": 4815,
    "overflowDisposals": 0,
    "leakedContexts": 0,
    "poolUtilization": 6.25,
    "reuseRatio": 602.6,
    "returnRate": 99.88,
    "avgRentDurationMs": 42.3,
    "minRentDurationMs": 8,
    "maxRentDurationMs": 1240,
    "healthStatus": "Healthy",
    "reuseQuality": "Excellent",
    "lastUpdated": "2026-03-11T10:43:21Z"
  }],
  "standard": [{
    "contextName": "ReplicaDbContext",
    "summary": "Created: 52, Active: 0",
    "totalCreations": 52,
    "totalDisposals": 52,
    "activeContexts": 0,
    "potentialLeaks": 0,
    "avgLifetimeMs": 18.4,
    "minLifetimeMs": 6,
    "maxLifetimeMs": 410,
    "healthStatus": "Healthy"
  }]
}
```

---

## 7. Library Usage — Health Checks & Background Monitoring

### ASP.NET Core Health Check

```csharp
// Register
builder.Services.AddHealthChecks()
    .Add(new HealthCheckRegistration(
        "efcore-pool",
        sp => new EFCorePoolHealthCheck(sp.GetRequiredService<DiagnosticsQueryService>()),
        HealthStatus.Degraded,
        tags: ["database", "pool"]));

app.MapHealthChecks("/health");

// Implementation
public class EFCorePoolHealthCheck(DiagnosticsQueryService query) : IHealthCheck
{
    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        var summary = query.GetSummary();

        foreach (var pool in summary.Pooled)
        {
            if (pool.LeakedContexts > 0)
                return Task.FromResult(HealthCheckResult.Unhealthy(
                    $"{pool.ContextName}: {pool.LeakedContexts} leaked contexts detected. " +
                    $"Check for missing `using` statements."));

            if (pool.ReturnRate < 95)
                return Task.FromResult(HealthCheckResult.Degraded(
                    $"{pool.ContextName}: return rate {pool.ReturnRate:F1}% (expected ~100%)"));

            if (pool.PoolUtilization > 90)
                return Task.FromResult(HealthCheckResult.Degraded(
                    $"{pool.ContextName}: pool utilization {pool.PoolUtilization:F1}% — consider increasing MaxPoolSize"));
        }

        return Task.FromResult(HealthCheckResult.Healthy("All pools healthy"));
    }
}
```

### Background monitoring service

```csharp
public class PoolMonitorService(
    IContextMetricsProvider provider,
    ILogger<PoolMonitorService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            foreach (var (name, m) in provider.GetAllPooledMetrics())
            {
                if (m.LeakedContexts > 0)
                    logger.LogCritical(
                        "[Pool] LEAK DETECTED — {Context}: {Leaks} context(s) never returned",
                        name, m.LeakedContexts);

                if (m.PoolUtilization > 90)
                    logger.LogWarning(
                        "[Pool] HIGH UTILIZATION — {Context}: {Util:F1}% (max {Max})",
                        name, m.PoolUtilization, m.MaxPoolSize);

                if (m.ReturnRate < 99)
                    logger.LogWarning(
                        "[Pool] LOW RETURN RATE — {Context}: {Rate:F1}% ({Rents} rents, {Returns} returns)",
                        name, m.ReturnRate, m.TotalRents, m.TotalReturns);
            }

            await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
        }
    }
}

// Register
builder.Services.AddHostedService<PoolMonitorService>();
```

---

## 8. Demo API — Endpoints & Load Tests

### Load Test Results

The following screenshot shows a k6 load test running against the API alongside the live Grafana dashboard, confirming 100% return rate, 0 leaks, and a reuse ratio of 16.7x under 20 VUs:

![k6 Load Test + Grafana Dashboard](/public/docs/GrafanaDashBoard-k6-loadtest.png)

The companion API (`EFCore.Observability.API`) demonstrates the library against a real SQL Server database with endpoints that exercise different pool patterns.

### appsettings.json

```json
{
  "ConnectionStrings": {
    "TMS_Conn": "Server=localhost;Database=observabilityDB;User Id=khaled;Password=StrongPassword123!!;Min Pool Size=5;Max Pool Size=200;Pooling=True;TrustServerCertificate=True;",
    "TMSReplica_Conn": "Server=localhost;Database=observabilityDB;User Id=khaled;Password=StrongPassword123!!;Min Pool Size=5;Max Pool Size=100;Pooling=True;TrustServerCertificate=True;"
  }
}
```

### Full Program.cs

```csharp
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddEFCoreObservability(opts =>
{
    opts.TrackRentDurations           = true;
    opts.EnableDiagnosticLogging      = true;    // verbose in dev
    opts.MaxActivityHistoryPerContext  = 500;
    opts.TrackStandardContexts        = true;
});

builder.Services.AddDbContextPool<PrimaryDbContext>(
    (sp, options) => options
        .UseSqlServer(builder.Configuration.GetConnectionString("TMS_Conn"))
        .UseObservability<PrimaryDbContext>(sp, poolSize: 128),
    poolSize: 128);

builder.Services.AddDbContext<ReplicaDbContext>((sp, options) =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("TMSReplica_Conn")));

builder.Services.AddOpenTelemetry()
    .WithMetrics(m => m
        .AddEFCorePoolInstrumentation()
        .AddEFCoreStandardInstrumentation()
        .AddPrometheusExporter());

builder.Services.AddHealthChecks()
    .Add(new HealthCheckRegistration(
        "efcore-pool",
        sp => new EFCorePoolHealthCheck(sp.GetRequiredService<DiagnosticsQueryService>()),
        HealthStatus.Degraded,
        tags: ["database", "pool"]));

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

app.Services.UseEFCoreObservability();

app.UseSwagger();
app.UseSwaggerUI();
app.UseHttpsRedirection();
app.UseAuthorization();
app.MapControllers();
app.MapPrometheusScrapingEndpoint();
app.MapHealthChecks("/health");

// ── Basic endpoints ───────────────────────────────────────────────────────────

app.MapGet("/ping", () => Results.Ok(new
{
    Message = "API is running",
    Environment = app.Environment.EnvironmentName,
    Time = DateTime.UtcNow,
    Version = "1.0"
}));

app.MapGet("/diagnostics/efcore/metrics",
    (DiagnosticsQueryService svc) => svc.GetAllDetails());

app.MapPost("/bills", async (PrimaryDbContext db, Bill bill) =>
{
    db.Bills.Add(bill);
    await db.SaveChangesAsync();
    return Results.Created($"/bills/{bill.Id}", bill);
});

// ── Sequential load test — maximizes reuse ratio ─────────────────────────────
// Each request runs in series; the same physical context is reused every time.
// Expected result: physicalCreations=1, reuseRatio grows, returnRate=100%
app.MapPost("/api/pool/test/sequential",
    async (IServiceScopeFactory scopeFactory, ILogger<Program> logger,
           [FromQuery] int requests = 10, [FromQuery] int delayMs = 50) =>
    {
        logger.LogInformation("Sequential test: {Requests} requests", requests);

        for (int i = 0; i < requests; i++)
        {
            using var scope   = scopeFactory.CreateScope();
            var context       = scope.ServiceProvider.GetRequiredService<PrimaryDbContext>();
            await context.Bills.CountAsync();   // trigger DB command -> interceptor fires
            await Task.Delay(delayMs);
        }

        await Task.Delay(500);
        GC.Collect();
        GC.WaitForPendingFinalizers();
        await Task.Delay(200);

        return Results.Ok();
    });

// ── Sequential test for standard (non-pooled) context ────────────────────────
app.MapPost("/api/standard/test/sequential",
    async (IServiceScopeFactory scopeFactory, ILogger<Program> logger,
           [FromQuery] int requests = 10, [FromQuery] int delayMs = 50) =>
    {
        for (int i = 0; i < requests; i++)
        {
            using var scope = scopeFactory.CreateScope();
            var context     = scope.ServiceProvider.GetRequiredService<ReplicaDbContext>();
            await context.Bills.CountAsync();
            await Task.Delay(delayMs);
        }

        await Task.Delay(500);
        GC.Collect();
        GC.WaitForPendingFinalizers();
        await Task.Delay(200);

        return Results.Ok();
    });

// ── Concurrent load test — forces pool expansion ──────────────────────────────
// N requests run in parallel, each holding the context for delayMs.
// Expected result: physicalCreations grows to N, pool utilization spikes.
app.MapPost("/api/pool/test/concurrent",
    async (IServiceScopeFactory scopeFactory, ILogger<Program> logger,
           [FromQuery] int parallelRequests = 10, [FromQuery] int delayMs = 100) =>
    {
        logger.LogInformation("Concurrent test: {Requests} parallel requests", parallelRequests);

        var tasks = Enumerable.Range(0, parallelRequests)
            .Select(async _ =>
            {
                using var scope = scopeFactory.CreateScope();
                var context     = scope.ServiceProvider.GetRequiredService<PrimaryDbContext>();
                await context.Bills.CountAsync();
                await Task.Delay(delayMs);  // hold context -> forces others to get new instances
            }).ToList();

        await Task.WhenAll(tasks);

        await Task.Delay(500);
        GC.Collect();
        GC.WaitForPendingFinalizers();
        await Task.Delay(200);

        return Results.Ok();
    });

// ── Concurrent test for standard context ─────────────────────────────────────
app.MapPost("/api/standard/test/concurrent",
    async (IServiceScopeFactory scopeFactory, ILogger<Program> logger,
           [FromQuery] int parallelRequests = 10, [FromQuery] int delayMs = 100) =>
    {
        var tasks = Enumerable.Range(0, parallelRequests)
            .Select(async _ =>
            {
                using var scope = scopeFactory.CreateScope();
                var context     = scope.ServiceProvider.GetRequiredService<ReplicaDbContext>();
                await context.Bills.CountAsync();
                await Task.Delay(delayMs);
            }).ToList();

        await Task.WhenAll(tasks);

        await Task.Delay(500);
        GC.Collect();
        GC.WaitForPendingFinalizers();
        await Task.Delay(200);

        return Results.Ok();
    });

// ── Sustained wave load ───────────────────────────────────────────────────────
// Multiple waves of concurrent requests, small delay between waves.
// Simulates real production bursty traffic patterns.
app.MapGet("/api/pooldiagnostics/sustained-load",
    async (IServiceScopeFactory scopeFactory, DiagnosticsQueryService svc,
           ILogger<Program> logger,
           [FromQuery] int waves = 5,
           [FromQuery] int requestsPerWave = 10,
           [FromQuery] int delayMs = 100) =>
    {
        for (int wave = 0; wave < waves; wave++)
        {
            logger.LogInformation("Wave {Wave}/{Total}", wave + 1, waves);

            var tasks = Enumerable.Range(0, requestsPerWave).Select(async i =>
            {
                using var scope = scopeFactory.CreateScope();
                var context     = scope.ServiceProvider.GetRequiredService<PrimaryDbContext>();
                await context.Bills.CountAsync();
                logger.LogTrace("Wave {Wave}, Request {Index} done", wave + 1, i);
            });

            await Task.WhenAll(tasks);
            if (wave < waves - 1) await Task.Delay(delayMs);
        }

        await Task.Delay(500);
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        await Task.Delay(100);

        return Results.Ok(new
        {
            Message         = "Sustained load completed",
            TotalRequests   = waves * requestsPerWave,
            Waves           = waves,
            RequestsPerWave = requestsPerWave,
            Metrics         = svc.GetPooledMetrics("PrimaryDbContext")
        });
    });

// ── Sustained HIGH load — forces pool to near-capacity ───────────────────────
// Each context is held for 2 seconds, forcing many concurrent instances
// and giving visible pool utilization spikes in Grafana.
app.MapGet("/api/pooldiagnostics/sustained-high-load",
    async (IServiceScopeFactory scopeFactory, DiagnosticsQueryService svc,
           ILogger<Program> logger,
           [FromQuery] int waves = 5,
           [FromQuery] int requestsPerWave = 10,
           [FromQuery] int delayMs = 100) =>
    {
        for (int wave = 0; wave < waves; wave++)
        {
            var tasks = Enumerable.Range(0, requestsPerWave).Select(async _ =>
            {
                using var scope = scopeFactory.CreateScope();
                var context     = scope.ServiceProvider.GetRequiredService<PrimaryDbContext>();
                await Task.Delay(2_000); // hold for 2s — forces pool expansion under load
                await context.Bills.CountAsync();
            });

            await Task.WhenAll(tasks);
            if (wave < waves - 1) await Task.Delay(delayMs);
        }

        return Results.Ok(new
        {
            Message         = "Sustained high load completed",
            TotalRequests   = waves * requestsPerWave,
            Metrics         = svc.GetPooledMetrics("PrimaryDbContext")
        });
    });

// ── Apply migrations on startup ───────────────────────────────────────────────
using (var scope = app.Services.CreateScope())
{
    var db     = scope.ServiceProvider.GetRequiredService<PrimaryDbContext>();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();
    logger.LogInformation("Applying migrations...");
    db.Database.Migrate();
}

app.Run();
```

---

## 9. OpenTelemetry Integration

The `EFCore.Observability.OpenTelemetry` package registers two meters:

| Meter | Instruments |
|---|---|
| `EFCore.Pool` | 17 gauges and counters for pooled contexts |
| `EFCore.Standard` | 7 gauges and counters for non-pooled contexts |

All instruments are tagged with `db.context = "<ContextTypeName>"` so multi-context dashboards work automatically.

Registration:

```csharp
// Register all (pool + standard)
.AddEFCoreInstrumentation()

// Or selectively
.AddEFCorePoolInstrumentation()
.AddEFCoreStandardInstrumentation()
```

Prometheus scrape output (OTel converts dots to underscores):

```
# Pool meters
efcore_pool_utilization_percent{db_context="PrimaryDbContext"} 6.25
efcore_pool_return_rate_percent{db_context="PrimaryDbContext"} 99.88
efcore_pool_reuse_ratio{db_context="PrimaryDbContext"} 602.63
efcore_pool_leaks{db_context="PrimaryDbContext"} 0
efcore_pool_rents_active{db_context="PrimaryDbContext"} 3
efcore_pool_rent_duration_avg_ms_milliseconds{db_context="PrimaryDbContext"} 42.3
efcore_pool_rents_total{db_context="PrimaryDbContext"} 4821
efcore_pool_returns_total{db_context="PrimaryDbContext"} 4818
efcore_pool_overflow_disposals_total{db_context="PrimaryDbContext"} 0
efcore_pool_physical_creations_total{db_context="PrimaryDbContext"} 8

# Standard meters
efcore_standard_active{db_context="ReplicaDbContext"} 0
efcore_standard_leaks{db_context="ReplicaDbContext"} 0
efcore_standard_duration_avg_ms_milliseconds{db_context="ReplicaDbContext"} 18.4
efcore_standard_creations_total{db_context="ReplicaDbContext"} 52
efcore_standard_disposals_total{db_context="ReplicaDbContext"} 52
```

---

## 10. Docker — Container Build

**`Deployments/Docker/Dockerfile.efcoreapi`**

```dockerfile
# Stage 1: Restore dependencies
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS restore
WORKDIR /src
COPY ["EFCore.Observability.API/EFCore.Observability.API.csproj",                       "EFCore.Observability.API/"]
COPY ["EFCore.Observability/EFCore.Observability.csproj",                               "EFCore.Observability/"]
COPY ["EFCore.Observability.Core/EFCore.Observability.Core.csproj",                     "EFCore.Observability.Core/"]
COPY ["EFCore.Observability.OpenTelemetry/EFCore.Observability.OpenTelemetry.csproj",   "EFCore.Observability.OpenTelemetry/"]
RUN dotnet restore "EFCore.Observability.API/EFCore.Observability.API.csproj"

# Stage 2: Build
FROM restore AS build
COPY . .
WORKDIR /src/EFCore.Observability.API
RUN dotnet build -c Release --no-restore -o /app/build

# Stage 3: Publish
FROM build AS publish
RUN dotnet publish -c Release --no-build -o /app/publish /p:UseAppHost=false

# Stage 4: Final minimal runtime image
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS final
WORKDIR /app
EXPOSE 8080
EXPOSE 8081
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "EFCore.Observability.API.dll"]
```

Build and tag:

```bash
docker build \
  --file Deployments/Docker/Dockerfile.efcoreapi \
  --target final \
  --tag khaledibrahimahmed/efcore-api:1.0.0 \
  .
```

---

## 11. Kubernetes — Cluster Structure

```
k8s/
├── base/                         # Environment-agnostic base resources
│   ├── namespace.yaml            # dbpoolinsight namespace
│   ├── secrets.yaml              # Secret template (never commit real values)
│   ├── kustomization.yaml        # Base kustomization manifest
│   ├── efcore-api/
│   │   ├── deployment.yaml       # Rolling update, probes, resource limits
│   │   └── service.yaml          # ClusterIP service on port 8080
│   └── sqlserver/
│       ├── deployment.yaml       # Recreate strategy, single Express instance
│       ├── pvc.yaml              # 1Gi PersistentVolumeClaim for SQL data
│       ├── service.yaml          # ClusterIP on port 1433
│       ├── configmap.yaml        # init.sql + entrypoint.sh scripts
│       └── job.yaml              # One-time DB init Job (idempotent)
├── overlays/
│   ├── dev/
│   │   ├── kustomization.yml     # 1 replica, reduced resources, NodePort, dev secrets
│   │   ├── dev.env               # KEY=VALUE secret values for dev
│   │   └── patches/
│   │       ├── replica-patches.yaml    # replicas: 1
│   │       └── resource-patches.yaml  # lower CPU/memory limits
│   └── prod/
│       ├── kustomization.yaml    # 2 replicas, full resources, prod secrets, HPA
│       ├── prod.env              # KEY=VALUE secret values (injected by CI/CD)
│       ├── hpa.yaml              # HorizontalPodAutoscaler
│       └── patches/
│           ├── replica-patches.yaml
│           └── resource-patches.yaml
└── helm/
    ├── monitoring-values.yaml      # kube-prometheus-stack Helm values
    ├── efcore-servicemonitor.yaml  # ServiceMonitor CRD
    └── efcore-rules.yaml           # PrometheusRule CRD (alert rules)
```

**Tools used:**

- **Kustomize** — built into `kubectl` since v1.14. Manages base + overlay resources without templating. Overlays patch only what changes; everything else from base is preserved automatically.
- **Helm** — used for the `kube-prometheus-stack` third-party chart. Templating adds real value for complex community charts with many configurable options.
- **kubectl** — all manifests are applied with `kubectl apply -k <overlay>`.

---

## 12. Kubernetes — Namespace & Secrets

**`base/namespace.yaml`**

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: dbpoolinsight
  labels:
    app.kubernetes.io/managed-by: kustomize
    environment: base
```

**`base/secrets.yaml`** — template only, never commit real values

```yaml
# ============================================================
# secrets.yaml — TEMPLATE ONLY
# ============================================================
# Option A (local/dev): fill values and apply manually
#   kubectl apply -f k8s/base/secrets.yaml -n dbpoolinsight
#
# Option B (prod): use Sealed Secrets or External Secrets Operator
#   https://github.com/bitnami-labs/sealed-secrets
#
# Option C (CI/CD): inject via secretGenerator in overlay kustomization.yaml
#   The overlay reads KEY=VALUE from dev.env or prod.env at pipeline runtime.
# ============================================================
apiVersion: v1
kind: Secret
metadata:
  name: dbpoolinsight-secrets
  namespace: dbpoolinsight
  labels:
    app.kubernetes.io/part-of: dbpoolinsight
type: Opaque
stringData:
  SA_PASSWORD:     "StrongPassword123!!"
  TMS_Conn:        "Server=sqlserverdb;Database=observabilityDB;User Id=khaled;Password=StrongPassword123!!;Min Pool Size=5;Max Pool Size=200;Pooling=True;TrustServerCertificate=True;"
  TMSReplica_Conn: "Server=sqlserverdb;Database=observabilityDB;User Id=khaled;Password=StrongPassword123!!;Min Pool Size=5;Max Pool Size=100;Pooling=True;TrustServerCertificate=True;"
```

The Kubernetes DNS name `sqlserverdb` matches the SQL Server `Service.metadata.name`, so connection strings work inside the cluster without any hardcoded IP addresses.

---

## 13. Kubernetes — SQL Server Deployment

**`base/sqlserver/deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sqlserverdb
  namespace: dbpoolinsight
  labels:
    app: sqlserverdb
    app.kubernetes.io/part-of: dbpoolinsight
    app.kubernetes.io/component: sqlserver
spec:
  # SQL Server Express supports a single instance only.
  # Recreate strategy prevents two pods fighting over the same PVC.
  replicas: 1
  selector:
    matchLabels:
      app: sqlserverdb
  strategy:
    type: Recreate
  template:
    metadata:
      labels:
        app: sqlserverdb
        app.kubernetes.io/part-of: dbpoolinsight
    spec:
      containers:
        - name: sqlserver
          image: mcr.microsoft.com/mssql/server:2022-latest
          imagePullPolicy: IfNotPresent
          ports:
            - name: mssql
              containerPort: 1433
              protocol: TCP
          env:
            - name: ACCEPT_EULA
              value: "Y"
            - name: MSSQL_PID
              value: "Express"
            - name: MSSQL_MEMORY_LIMIT_MB
              value: "1024"
            - name: MSSQL_SA_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: dbpoolinsight-secrets
                  key: SA_PASSWORD

          # readinessProbe gates traffic — pod will not receive connections
          # until SQL Server is fully started and can accept queries.
          readinessProbe:
            exec:
              command:
                - /bin/bash
                - -c
                - >
                  /opt/mssql-tools18/bin/sqlcmd
                  -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -C
                  -Q "SELECT 1" > /dev/null 2>&1
            initialDelaySeconds: 60
            periodSeconds: 15
            timeoutSeconds: 30
            failureThreshold: 10

          # livenessProbe restarts the pod if SQL Server crashes after startup.
          livenessProbe:
            exec:
              command:
                - /bin/bash
                - -c
                - >
                  /opt/mssql-tools18/bin/sqlcmd
                  -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -C
                  -Q "SELECT 1" > /dev/null 2>&1
            initialDelaySeconds: 120
            periodSeconds: 30
            timeoutSeconds: 30
            failureThreshold: 5

          resources:
            requests:
              memory: "1Gi"
              cpu: "500m"
            limits:
              memory: "2Gi"
              cpu: "1000m"

          volumeMounts:
            - name: sqlserver-data
              mountPath: /var/opt/mssql   # persist database files across pod restarts

      volumes:
        - name: init-scripts
          configMap:
            name: sqlserver-init
            defaultMode: 0755   # executable — needed for entrypoint.sh
        - name: sqlserver-data
          persistentVolumeClaim:
            claimName: sqlserver-data
```

**`base/sqlserver/pvc.yaml`**

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sqlserver-data
  namespace: dbpoolinsight
  labels:
    app.kubernetes.io/part-of: dbpoolinsight
    app.kubernetes.io/component: sqlserver
spec:
  accessModes:
    - ReadWriteOnce     # single node — sufficient for Express
  resources:
    requests:
      storage: 1Gi
  storageClassName: standard
  # For cloud clusters use the appropriate class:
  #   AKS: managed-premium  |  EKS: gp2/gp3  |  GKE: standard-rwo
```

**`base/sqlserver/configmap.yaml`** — idempotent SQL init script

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: sqlserver-init
  namespace: dbpoolinsight
data:
  init.sql: |
    IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = 'observabilityDB')
    BEGIN
        CREATE DATABASE observabilityDB;
        PRINT 'Database observabilityDB created.';
    END
    ELSE
        PRINT 'Database observabilityDB already exists — skipping.';
    GO

    USE observabilityDB;
    GO

    IF NOT EXISTS (SELECT * FROM sys.server_principals WHERE name = 'khaled')
    BEGIN
        CREATE LOGIN khaled WITH PASSWORD = 'StrongPassword123!!';
        PRINT 'Login khaled created.';
    END
    GO

    IF NOT EXISTS (SELECT * FROM sys.database_principals WHERE name = 'khaled')
    BEGIN
        CREATE USER khaled FOR LOGIN khaled;
        ALTER ROLE db_owner ADD MEMBER khaled;
        PRINT 'User khaled created and granted db_owner.';
    END
    GO

    PRINT 'Initialization complete.';
    GO
```

---

## 14. Kubernetes — Database Initialization Job

A one-shot `batch/v1 Job` runs `init.sql` once at deployment time. It handles a two-phase startup problem: SQL Server's TCP port opens before the internal security catalog is fully upgraded — naive readiness checks pass the TCP test but fail on `sys.server_principals` during this window.

**`base/sqlserver/job.yaml`**

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: dbpoolinsight-init-job
  namespace: dbpoolinsight
  labels:
    app.kubernetes.io/part-of: dbpoolinsight
    app.kubernetes.io/component: sqlserver
spec:
  backoffLimit: 5              # retry up to 5 times on failure
  ttlSecondsAfterFinished: 300 # auto-clean the completed Job after 5 minutes
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: sqlcmd
          image: mcr.microsoft.com/mssql/server:2022-latest
          env:
            - name: SA_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: dbpoolinsight-secrets
                  key: SA_PASSWORD
          command: ["/bin/bash", "-c"]
          args:
            - |
              # Phase 1 — wait for TCP port to accept connections
              echo "Phase 1: waiting for TCP port..."
              for i in $(seq 1 60); do
                if /opt/mssql-tools18/bin/sqlcmd \
                    -S sqlserverdb -U sa -P "$SA_PASSWORD" -C -l 2 \
                    -Q "SELECT 1" &>/dev/null; then
                  echo "TCP ready at attempt $i"
                  break
                fi
                echo "  TCP attempt $i/60 — sleeping 5s..."
                sleep 5
              done

              # Phase 2 — wait for security catalog to be fully upgraded.
              # sys.server_principals is unavailable until the upgrade is complete.
              echo "Phase 2: waiting for security catalog..."
              for i in $(seq 1 60); do
                if /opt/mssql-tools18/bin/sqlcmd \
                    -S sqlserverdb -U sa -P "$SA_PASSWORD" -C -l 5 \
                    -Q "SELECT name FROM sys.server_principals WHERE name='sa'" \
                    &>/dev/null; then
                  echo "Security catalog ready at attempt $i — running init.sql..."
                  /opt/mssql-tools18/bin/sqlcmd \
                    -S sqlserverdb -U sa -P "$SA_PASSWORD" -C \
                    -i /scripts/init.sql
                  exit 0
                fi
                echo "  Catalog attempt $i/60 — sleeping 10s..."
                sleep 10
              done

              echo "ERROR: SQL Server never became fully ready after 600s"
              exit 1
          volumeMounts:
            - name: init-scripts
              mountPath: /scripts
      volumes:
        - name: init-scripts
          configMap:
            name: sqlserver-init
```

---

## 15. Kubernetes — EFCore API Deployment

**`base/efcore-api/deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: efcore-api
  namespace: dbpoolinsight
  labels:
    app: efcore-api
    app.kubernetes.io/part-of: dbpoolinsight
    app.kubernetes.io/component: api
spec:
  replicas: 1   # patched per overlay

  selector:
    matchLabels:
      app: efcore-api

  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1        # allow one extra pod during rollout
      maxUnavailable: 0  # never take a pod down before the new one is ready

  template:
    metadata:
      labels:
        app: efcore-api
        app.kubernetes.io/part-of: dbpoolinsight
        app.kubernetes.io/component: api
      annotations:
        # Prometheus pod-annotation scraping (fallback if ServiceMonitor not used)
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      # ── Wait for SQL Server before starting ──────────────────────────────
      # Prevents EF Core migration from failing because SQL Server is still starting.
      initContainers:
        - name: wait-for-sqlserver
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              echo "Waiting for sqlserverdb:1433..."
              until nc -z -w 3 sqlserverdb 1433; do
                echo "  SQL Server not ready — retrying in 5s"
                sleep 5
              done
              echo "SQL Server is reachable!"

      containers:
        - name: efcore-api
          image: khaledibrahimahmed/efcore-api:1.0.0   # overridden by images: in each overlay
          imagePullPolicy: Always

          env:
            - name: ASPNETCORE_ENVIRONMENT
              value: "Production"   # overridden to Development in dev overlay

            # ASP.NET Core maps ConnectionStrings__X -> appsettings ConnectionStrings.X
            - name: ConnectionStrings__TMS_Conn
              valueFrom:
                secretKeyRef:
                  name: dbpoolinsight-secrets
                  key: TMS_Conn
            - name: ConnectionStrings__TMSReplica_Conn
              valueFrom:
                secretKeyRef:
                  name: dbpoolinsight-secrets
                  key: TMSReplica_Conn

          ports:
            - name: http
              containerPort: 8080
              protocol: TCP

          # readinessProbe: pod only receives traffic when EF migrations have run
          # and the /health endpoint returns 200.
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 20
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 5

          # livenessProbe: restart the pod if it stops responding to /ping.
          livenessProbe:
            httpGet:
              path: /ping
              port: 8080
            initialDelaySeconds: 40
            periodSeconds: 15
            timeoutSeconds: 5
            failureThreshold: 3

          # startupProbe: gives the app up to 100s (20 x 5s) to complete
          # first-run migrations before liveness kicks in.
          startupProbe:
            httpGet:
              path: /ping
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 5
            failureThreshold: 20

          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
```

---

## 16. Kubernetes — Services

**`base/efcore-api/service.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: efcore-api
  namespace: dbpoolinsight
  labels:
    app: efcore-api
    app.kubernetes.io/part-of: dbpoolinsight
    app.kubernetes.io/component: api
spec:
  type: ClusterIP   # patched to NodePort in dev overlay
  selector:
    app: efcore-api
  ports:
    - name: http
      port: 8080
      targetPort: 8080
      protocol: TCP
```

**`base/sqlserver/service.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata:
  # This DNS name is used in all connection strings: Server=sqlserverdb
  name: sqlserverdb
  namespace: dbpoolinsight
  labels:
    app: sqlserverdb
    app.kubernetes.io/part-of: dbpoolinsight
    app.kubernetes.io/component: sqlserver
spec:
  type: ClusterIP   # internal only — SQL Server is not exposed outside the cluster
  selector:
    app: sqlserverdb
  ports:
    - name: mssql
      port: 1433
      targetPort: 1433
      protocol: TCP
```

---

## 17. Kubernetes — Kustomize Base

**`base/kustomization.yaml`**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: dbpoolinsight

resources:
  - namespace.yaml
  - secrets.yaml

  # SQL Server
  - sqlserver/configmap.yaml
  - sqlserver/pvc.yaml
  - sqlserver/deployment.yaml
  - sqlserver/job.yaml
  - sqlserver/service.yaml

  # EFCore API
  - efcore-api/deployment.yaml
  - efcore-api/service.yaml

# Labels applied to every generated resource
commonLabels:
  app.kubernetes.io/managed-by: kustomize
  app.kubernetes.io/part-of: dbpoolinsight
```

---

## 18. Kubernetes — Dev Overlay

The dev overlay patches the base with: 1 replica, lower resource limits, NodePort for external access, Development environment variable, and dev secrets from `dev.env`.

**`overlays/dev/dev.env`** — injected at pipeline runtime, never committed with real values

```env
SA_PASSWORD=StrongPassword123!!
TMS_Conn=Server=sqlserverdb;Database=observabilityDB;User Id=khaled;Password=StrongPassword123!!;TrustServerCertificate=True
TMSReplica_Conn=Server=sqlserverdb;Database=observabilityDB;User Id=khaled;Password=StrongPassword123!!;TrustServerCertificate=True
```

**`overlays/dev/patches/replica-patches.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: efcore-api
  namespace: dbpoolinsight
spec:
  replicas: 1
```

**`overlays/dev/patches/resource-patches.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: efcore-api
  namespace: dbpoolinsight
spec:
  template:
    spec:
      containers:
        - name: efcore-api
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "250m"
```

**`overlays/dev/kustomization.yml`**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../base

commonLabels:
  environment: dev

# Pin the image tag for dev
images:
  - name: khaledibrahimahmed/efcore-api
    newTag: dev

# secretGenerator reads KEY=VALUE from dev.env and creates/updates the Secret.
# disableNameSuffixHash keeps the name stable so secretKeyRef lookups in the
# Deployment don't need to change between deploys.
# behavior: merge patches the existing base Secret rather than creating a new one.
secretGenerator:
  - name: dbpoolinsight-secrets
    namespace: dbpoolinsight
    behavior: merge
    envs:
      - dev.env
    options:
      disableNameSuffixHash: true
      labels:
        app.kubernetes.io/part-of: dbpoolinsight

patches:
  - path: patches/replica-patches.yaml
  - path: patches/resource-patches.yaml

  # Set Development environment for verbose logging
  - patch: |-
      apiVersion: apps/v1
      kind: Deployment
      metadata:
        name: efcore-api
        namespace: dbpoolinsight
      spec:
        template:
          spec:
            containers:
              - name: efcore-api
                env:
                  - name: ASPNETCORE_ENVIRONMENT
                    value: "Development"

  # Expose as NodePort so the API is reachable outside the cluster at :30080
  - patch: |-
      apiVersion: v1
      kind: Service
      metadata:
        name: efcore-api
        namespace: dbpoolinsight
      spec:
        type: NodePort
        ports:
          - name: http
            port: 8080
            targetPort: 8080
            nodePort: 30080
```

---

## 19. Kubernetes — Prod Overlay & HPA

**`overlays/prod/patches/replica-patches.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: efcore-api
  namespace: dbpoolinsight
spec:
  replicas: 2
```

**`overlays/prod/patches/resource-patches.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: efcore-api
  namespace: dbpoolinsight
spec:
  template:
    spec:
      containers:
        - name: efcore-api
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
```

**`overlays/prod/hpa.yaml`** — HPA scales on CPU and memory

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: efcore-api-hpa
  namespace: dbpoolinsight
  labels:
    app.kubernetes.io/part-of: dbpoolinsight
    app.kubernetes.io/component: api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: efcore-api
  minReplicas: 2
  maxReplicas: 6
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
  behavior:
    # Scale up quickly — pool exhaustion is visible immediately
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
        - type: Pods
          value: 2
          periodSeconds: 30
    # Scale down slowly — prevents pod thrashing under bursty load
    scaleDown:
      stabilizationWindowSeconds: 300   # wait 5 minutes before scaling down
      policies:
        - type: Pods
          value: 1
          periodSeconds: 60
```

> **Metrics Server prerequisite:** HPA requires `metrics-server` to read CPU/memory. On local clusters (Docker Desktop, Minikube), the kubelet uses self-signed certificates that cause metrics-server to fail. Fix by adding `--kubelet-insecure-tls`:
> ```bash
> kubectl edit deployment metrics-server -n kube-system
> # Add under spec.containers.args:
> #   - --kubelet-insecure-tls
> ```

**`overlays/prod/kustomization.yaml`**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../base
  - hpa.yaml        # prod-only HPA

commonLabels:
  environment: prod

# Always pin to an immutable tag in production — never use :latest
images:
  - name: khaledibrahimahmed/efcore-api
    newTag: "1.0.1"

secretGenerator:
  - name: dbpoolinsight-secrets
    namespace: dbpoolinsight
    behavior: merge
    envs:
      - prod.env    # injected by CI/CD pipeline at runtime
    options:
      disableNameSuffixHash: true
      labels:
        app.kubernetes.io/part-of: dbpoolinsight

patches:
  - path: patches/replica-patches.yaml
  - path: patches/resource-patches.yaml
  - patch: |-
      apiVersion: apps/v1
      kind: Deployment
      metadata:
        name: efcore-api
        namespace: dbpoolinsight
      spec:
        template:
          spec:
            containers:
              - name: efcore-api
                env:
                  - name: ASPNETCORE_ENVIRONMENT
                    value: "Production"
```

---

## 20. Helm — Monitoring Stack

The monitoring stack is installed via Helm using the `kube-prometheus-stack` chart, which bundles Prometheus, Grafana, Alertmanager, node-exporter, and kube-state-metrics in a single release.

**`helm/monitoring-values.yaml`**

```yaml
# Install:
#   helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
#   helm repo update
#   helm install monitoring prometheus-community/kube-prometheus-stack \
#     --namespace dbpoolinsight --create-namespace \
#     -f helm/monitoring-values.yaml
#
# Upgrade:
#   helm upgrade monitoring prometheus-community/kube-prometheus-stack \
#     --namespace dbpoolinsight \
#     -f helm/monitoring-values.yaml

grafana:
  enabled: true
  adminPassword: admin   # override with --set grafana.adminPassword=<secret> in CI

  service:
    type: ClusterIP   # exposed via port-forward or Ingress

  persistence:
    enabled: true
    size: 2Gi

  # Auto-provision Prometheus datasource so dashboards work immediately
  additionalDataSources:
    - name: Prometheus
      type: prometheus
      uid: prometheus
      url: http://monitoring-kube-prometheus-prometheus:9090
      access: proxy
      isDefault: true
      editable: true
      jsonData:
        timeInterval: "15s"
        queryTimeout: "60s"
        httpMethod: POST

  # Auto-load the EFCore dashboard from a ConfigMap
  dashboardProviders:
    dashboardproviders.yaml:
      apiVersion: 1
      providers:
        - name: dbpoolinsight
          orgId: 1
          type: file
          disableDeletion: false
          updateIntervalSeconds: 30
          allowUiUpdates: true
          options:
            path: /var/lib/grafana/dashboards/dbpoolinsight

  dashboardsConfigMaps:
    dbpoolinsight: "efcore-dashboard-configmap"
  # Create the ConfigMap:
  #   kubectl create configmap efcore-dashboard-configmap \
  #     --from-file=efcore-dashboard.json=.../grafana/dashboards/efcore-dashboard.json \
  #     -n dbpoolinsight

  livenessProbe:
    httpGet:
      path: /api/health
      port: 3000
    initialDelaySeconds: 120
    timeoutSeconds: 30
    periodSeconds: 30
    failureThreshold: 10

  readinessProbe:
    httpGet:
      path: /api/health
      port: 3000
    initialDelaySeconds: 60
    timeoutSeconds: 30
    periodSeconds: 10
    failureThreshold: 10

prometheus:
  enabled: true
  prometheusSpec:
    retention: 15d
    retentionSize: "4GB"
    scrapeInterval: "5s"          # match EFCore metric resolution
    evaluationInterval: "15s"
    storageSpec:
      volumeClaimTemplate:
        spec:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 5Gi

alertmanager:
  enabled: true
  alertmanagerSpec:
    storage:
      volumeClaimTemplate:
        spec:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 1Gi

kubeStateMetrics:
  enabled: true   # useful cluster-level metrics

nodeExporter:
  enabled: true   # per-node CPU/memory/disk metrics

# Disable components not needed for app-level observability
kubeApiServer:
  enabled: false
kubeEtcd:
  enabled: false
kubeScheduler:
  enabled: false
kubeControllerManager:
  enabled: false
```

---

## 21. Helm — ServiceMonitor

The `ServiceMonitor` CRD tells the Prometheus Operator (installed by `kube-prometheus-stack`) to scrape the `/metrics` endpoint of the `efcore-api` Service. This is preferred over pod annotation-based scraping because it is namespace-scoped, survives Service restarts, and supports per-endpoint configuration.

**`helm/efcore-servicemonitor.yaml`**

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: efcore-api
  namespace: dbpoolinsight
  labels:
    # Must match the Helm release name used for kube-prometheus-stack
    # so the Prometheus Operator discovers and loads this monitor.
    release: monitoring
    app.kubernetes.io/part-of: dbpoolinsight
spec:
  selector:
    matchLabels:
      app: efcore-api
  endpoints:
    - port: http
      path: /metrics
      interval: 5s    # scrape every 5 seconds — matches EFCore metric granularity
```

Apply:

```bash
kubectl apply -f helm/efcore-servicemonitor.yaml -n dbpoolinsight
```

---

## 22. Helm — PrometheusRule Alerts

`PrometheusRule` is a CRD provided by the Prometheus Operator. Rules defined here are automatically loaded into Prometheus without any manual reload — Kubernetes reconciles them continuously.

**`helm/efcore-rules.yaml`**

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: efcore-alerts
  namespace: dbpoolinsight
  labels:
    # Must match the kube-prometheus-stack release name and app label
    release: monitoring
    app: kube-prometheus-stack
    app.kubernetes.io/part-of: dbpoolinsight
spec:
  groups:
    - name: efcore_pool
      interval: 15s
      rules:

        # ── Critical: context rented but never returned ─────────────────────
        - alert: EFCoreContextLeak
          expr: efcore_pool_leaks > 0 or efcore_standard_leaks > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "DbContext leak detected in {{ $labels.db_context }}"
            description: >
              {{ $value }} context(s) rented but never returned.
              Check for missing `using` statements or exception paths that skip Dispose().

        # ── Warning: pool is nearly exhausted ──────────────────────────────
        - alert: EFCorePoolHighUtilization
          expr: efcore_pool_utilization_percent > 90
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "EFCore pool utilization critical on {{ $labels.db_context }}"
            description: >
              Pool utilization is {{ $value }}% for {{ $labels.db_context }}.
              Consider increasing pool size or investigating slow queries.

        # ── Warning: return rate dropped ────────────────────────────────────
        - alert: EFCoreReturnRateLow
          expr: efcore_pool_return_rate_percent < 95
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Low pool return rate for {{ $labels.db_context }}"
            description: >
              Return rate is {{ $value }}%. Expected ~100%.
              Investigate disposal patterns.

        # ── Warning: pool overflowing — contexts thrown away ────────────────
        - alert: EFCorePoolOverflowing
          expr: rate(efcore_pool_overflow_disposals_total[5m]) > 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Pool overflow for {{ $labels.db_context }}"
            description: >
              Contexts being disposed due to pool overflow.
              Increase pool size or reduce concurrency.

        # ── Warning: slow queries / long-held transactions ──────────────────
        - alert: EFCoreSlowContextRent
          expr: efcore_pool_rent_duration_avg_ms_milliseconds > 2000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Slow DbContext rent: {{ $value }}ms for {{ $labels.db_context }}"
            description: >
              Average rent duration exceeded 2000ms.
              Investigate slow queries or long-running transactions.
```

Apply:

```bash
kubectl apply -f helm/efcore-rules.yaml -n dbpoolinsight
```

---

## 23. Grafana — Dashboard & PromQL

Load the dashboard ConfigMap (Grafana provisions it automatically via the `dashboardsConfigMaps` entry in the Helm values):

```bash
kubectl create configmap efcore-dashboard-configmap \
  --from-file=efcore-dashboard.json=Deployments/Docker/monitoring/grafana/dashboards/efcore-dashboard.json \
  -n dbpoolinsight \
  --dry-run=client -o yaml | kubectl apply -f -

# Label for label-based dashboard discovery
kubectl label configmap efcore-dashboard-configmap grafana_dashboard=1 \
  -n dbpoolinsight --overwrite
```

### Recommended dashboard panels and PromQL

**Pool utilization gauge:**
```promql
efcore_pool_utilization_percent{db_context="PrimaryDbContext"}
```
Thresholds: 0–80 green · 80–90 yellow · 90–100 red

**Return rate gauge (should always be ~100):**
```promql
efcore_pool_return_rate_percent{db_context="PrimaryDbContext"}
```
Thresholds: 99–100 green · 95–99 yellow · < 95 red

**Active rents (concurrent pool consumers right now):**
```promql
efcore_pool_rents_active{db_context="PrimaryDbContext"}
```

**Reuse ratio time series (higher = better):**
```promql
efcore_pool_reuse_ratio{db_context="PrimaryDbContext"}
```

**Average rent duration:**
```promql
efcore_pool_rent_duration_avg_ms_milliseconds{db_context="PrimaryDbContext"}
```

**Leak detection (should always be 0 — alert if > 0):**
```promql
efcore_pool_leaks > 0
```

**Physical vs. logical rents (pool reuse efficiency over time):**
```promql
rate(efcore_pool_rents_total[1m])
rate(efcore_pool_physical_creations_total[1m])
```

**Standard context lifetime:**
```promql
efcore_standard_duration_avg_ms_milliseconds{db_context="ReplicaDbContext"}
```
### Live Dashboard Screenshots

**Pooled DbContext panel** — captured during a k6 load test. Pool utilization at 43%, return rate 100%, reuse ratio 16.7x, zero leaks:

![Grafana EFCore DbPoolInsight Dashboard](/public/docs/GrafanaDashBoard-k6-loadtest.png)

**Standard (non-pooled) DbContext panel** — ReplicaDbContext showing 555 creations, 555 disposals, 0 active, 0 leaks:

![Grafana Standard DbContext Panel](/public/docs/GrafanaDashBoard-k6-loadtest-2.png)
---

## 24. Deployment Script

A single Bash script handles the complete workflow: prerequisites check → optional build and push → Kustomize apply → Grafana dashboard load → monitoring stack install → access info print.

**`scripts/deploy.sh`**

```bash
#!/usr/bin/env bash

# =============================================================================
# Usage:
#   ./scripts/deploy.sh dev  dbpoolinsight --build khaledibrahimahmed latest
#   ./scripts/deploy.sh prod dbpoolinsight --build khaledibrahimahmed 1.0.1
#   ./scripts/deploy.sh loadtest
# =============================================================================

# set -e: exit immediately if any command fails
# set -u: treat unset variables as errors
# set -o pipefail: fail if any command in a pipeline fails
set -euo pipefail

ENVIRONMENT="${1:-dev}"
NAMESPACE="${2:-dbpoolinsight}"
SHOULD_BUILD=false
REGISTRY=""
TAG="latest"

shift 2 || true

while [[ $# -gt 0 ]]; do
  case $1 in
    -b|--build)
      SHOULD_BUILD=true
      REGISTRY="${2:?"Error: --build requires a registry (e.g. docker.io/user)"}"
      shift 2
      if [[ $# -gt 0 && ! $1 =~ ^- ]]; then TAG="$1"; shift; fi
      ;;
    *) shift ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$(dirname "$(dirname "$SCRIPT_DIR")")")"

RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' BLUE='\033[0;34m' NC='\033[0m'
log()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()  { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }

check_prerequisites() {
  log "Checking prerequisites..."
  # command -v is safer and more POSIX-compliant than `which`
  for cmd in kubectl helm; do
    command -v "$cmd" &>/dev/null || die "$cmd is not installed"
  done
  kubectl kustomize --help &>/dev/null || die "kubectl does not support kustomize"
  kubectl cluster-info &>/dev/null     || die "kubectl cannot reach the cluster"
  ok "Prerequisites OK"
}

install_monitoring() {
  log "Installing kube-prometheus-stack via Helm..."
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
  helm repo update

  helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
    --namespace "$NAMESPACE" \
    --create-namespace \
    -f "$ROOT_DIR/Deployments/k8s/helm/monitoring-values.yaml"

  ok "Monitoring stack installed"

  log "Applying EFCore alert rules..."
  kubectl apply -f "$ROOT_DIR/Deployments/k8s/helm/efcore-rules.yaml" -n "$NAMESPACE"
  ok "Alert rules applied"

  log "Applying EFCore ServiceMonitor..."
  kubectl apply -f "$ROOT_DIR/Deployments/k8s/helm/efcore-servicemonitor.yaml" -n "$NAMESPACE"
  ok "ServiceMonitor applied"
}

load_dashboard() {
  local DASHBOARD_PATH="$ROOT_DIR/Deployments/k8s/helm/monitoring/grafana/dashboards/efcore-dashboard.json"
  if [ -f "$DASHBOARD_PATH" ]; then
    log "Loading Grafana dashboard ConfigMap..."
    kubectl create configmap efcore-dashboard-configmap \
      --from-file=efcore-dashboard.json="$DASHBOARD_PATH" \
      -n "$NAMESPACE" \
      --dry-run=client -o yaml | kubectl apply -f -
    ok "Dashboard ConfigMap applied"
  else
    warn "Dashboard file not found at $DASHBOARD_PATH — skipping"
  fi
}

deploy_app() {
  local OVERLAY_PATH="$ROOT_DIR/Deployments/k8s/overlays/$ENVIRONMENT"
  [ -d "$OVERLAY_PATH" ] || die "Overlay path not found: $OVERLAY_PATH"

  if [ "$SHOULD_BUILD" = true ]; then
    log "Updating Kustomize image tag to $TAG..."
    if command -v kustomize &>/dev/null; then
      (cd "$OVERLAY_PATH" && kustomize edit set image "$REGISTRY/efcore-api:$TAG")
    else
      warn "Standalone kustomize not found — using sed fallback"
      sed -i "s|newTag:.*|newTag: \"$TAG\"|" "$OVERLAY_PATH/kustomization.yaml"
      "$SCRIPT_DIR/build-push.sh" "$REGISTRY" "$TAG"
    fi
  fi

  log "Deploying $ENVIRONMENT overlay..."
  kubectl apply -k "$OVERLAY_PATH"
  ok "Kustomize overlay applied"

  log "Waiting for SQL Server to be ready..."
  kubectl rollout status deployment/sqlserverdb -n "$NAMESPACE"

  log "Waiting for EFCore API to be ready..."
  kubectl rollout status deployment/efcore-api -n "$NAMESPACE"

  ok "Deployment complete!"
}

print_access_info() {
  echo ""
  echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  DbPoolInsight deployed: $ENVIRONMENT${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
  echo ""
  echo "  Port-forward commands (run in separate terminals):"
  echo "    kubectl port-forward svc/efcore-api 8080:8080 -n $NAMESPACE"
  echo "    kubectl port-forward svc/monitoring-grafana 3000:80 -n $NAMESPACE"
  echo "    kubectl port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090 -n $NAMESPACE"
  echo ""
  echo "  Then open:"
  echo "    API Swagger: http://localhost:8080/swagger/index.html"
  echo "    OTel Scrape: http://localhost:8080/metrics"
  echo "    Health:      http://localhost:8080/health"
  echo "    Grafana:     http://localhost:3000  (admin / admin)"
  echo "    Prometheus:  http://localhost:9090"
  echo ""
}

main() {
  check_prerequisites
  case "$ENVIRONMENT" in
    dev|prod)
      log "Deploying $ENVIRONMENT..."
      load_dashboard
      install_monitoring
      deploy_app
      print_access_info
      ;;
    loadtest)
      log "Load test environment — add k6 job here"
      ;;
    *)
      die "Unknown environment: $ENVIRONMENT. Use: dev | prod | loadtest"
      ;;
  esac
}

main "$@"
```

### Deployment in Action

The screenshots below show the full `./deploy.sh prod dbpoolinsight` run: Helm installs the monitoring stack, Kustomize applies the prod overlay, and pods come up across the `dbpoolinsight` namespace:

![Kubernetes Deployment — Part 1](/public/docs/apply-deployment-k8s-1.png)

![Kubernetes Deployment — Part 2](/public/docs/apply-deployment-k8s-2.png)



---

## 25. Build & Push Script

**`scripts/build-push.sh`**

```bash
#!/usr/bin/env bash

# =============================================================================
# Usage:
#   ./scripts/build-push.sh docker.io/myuser          # tags as :latest
#   ./scripts/build-push.sh docker.io/myuser 1.2.0    # tags as :1.2.0
# =============================================================================

set -euo pipefail

REGISTRY=${1:?"Usage: $0 <registry> [tag]"}
TAG=${2:-latest}
IMAGE="$REGISTRY/efcore-api:$TAG"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Walk up the directory tree to find the project root
# (identified by the presence of Deployments/Docker)
find_project_root() {
  local dir="$SCRIPT_DIR"
  while [[ "$dir" != "/" ]]; do
    [ -d "$dir/Deployments/Docker" ] && { echo "$dir"; return 0; }
    dir="$(dirname "$dir")"
  done
  echo "ERROR: Could not find project root" >&2
  exit 1
}

PROJECT_ROOT="$(find_project_root)"

echo "Building: $IMAGE"
echo "  Context:    $PROJECT_ROOT"
echo "  Dockerfile: Deployments/Docker/Dockerfile.efcoreapi"

docker build \
  --file "$PROJECT_ROOT/Deployments/Docker/Dockerfile.efcoreapi" \
  --target final \
  --tag "$IMAGE" \
  --label "build.date=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --label "build.tag=$TAG" \
  "$PROJECT_ROOT"

echo ""
echo "Pushing $IMAGE..."
docker push "$IMAGE"

echo ""
echo "Done! Update your Kustomize overlay:"
echo "  images:"
echo "    - name: $REGISTRY/efcore-api"
echo "      newTag: \"$TAG\""
```

---

## 26. Accessing the Cluster

After deployment, use port-forward to reach services locally:

```bash
# API
kubectl port-forward svc/efcore-api 8080:8080 -n dbpoolinsight

# Grafana
kubectl port-forward svc/monitoring-grafana 3000:80 -n dbpoolinsight

# Prometheus
kubectl port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090 -n dbpoolinsight
```

| Endpoint | URL | Purpose |
|---|---|---|
| Swagger UI | `http://localhost:8080/swagger` | Full API docs and manual testing |
| Pool metrics (JSON) | `http://localhost:8080/diagnostics/efcore/metrics` | Raw JSON from DiagnosticsQueryService |
| Health check | `http://localhost:8080/health` | EFCore pool health check result |
| Prometheus scrape | `http://localhost:8080/metrics` | OTel Prometheus-format metrics |
| Grafana | `http://localhost:3000` | Dashboards — credentials: admin / admin |
| Prometheus UI | `http://localhost:9090` | Ad-hoc PromQL queries |

In dev the API is also reachable directly via NodePort at `http://<node-ip>:30080`.

**Useful diagnostic commands:**

```bash
# Watch pod status
kubectl get pods -n dbpoolinsight -w

# SQL Server logs
kubectl logs -n dbpoolinsight -l app=sqlserverdb --follow

# API logs
kubectl logs -n dbpoolinsight -l app=efcore-api --follow

# Verify SQL Server connectivity
kubectl exec -it -n dbpoolinsight deployment/sqlserverdb -- \
  /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "StrongPassword123!!" -C \
  -Q "SELECT name FROM sys.databases"

# Describe a pod — shows events and probe results
kubectl describe pod -l app=efcore-api -n dbpoolinsight

# Check HPA status (prod only)
kubectl get hpa efcore-api-hpa -n dbpoolinsight

# Verify Prometheus is scraping the API
kubectl get servicemonitor efcore-api -n dbpoolinsight
```

---

## 27. Metrics Reference

### Pool metrics — meter: `EFCore.Pool` · tag: `db.context`

| Metric | Type | Unit | Description | Healthy value |
|---|---|---|---|---|
| `efcore.pool.max_size` | Gauge | `{instances}` | Configured pool capacity | — |
| `efcore.pool.room_to_grow` | Gauge | `{instances}` | Instances that can still be created | > 0 |
| `efcore.pool.instances.physical` | Gauge | `{instances}` | Physical instances currently in pool | <= MaxPoolSize |
| `efcore.pool.instances.available` | Gauge | `{instances}` | Idle instances ready to be rented | > 0 |
| `efcore.pool.rents.active` | Gauge | `{rents}` | Instances currently rented | 0 when idle |
| `efcore.pool.utilization` | Gauge | `%` | PhysicalInPool / MaxPoolSize x 100 | < 80% |
| `efcore.pool.reuse_ratio` | Gauge | `x` | TotalRents / PhysicalCreations | > 5 (Excellent) |
| `efcore.pool.return_rate` | Gauge | `%` | TotalReturns / TotalRents x 100 | ~100% |
| `efcore.pool.leaks` | Gauge | `{contexts}` | Rented but never returned | **0** |
| `efcore.pool.rent.duration.avg_ms` | Gauge | `ms` | Rolling average hold time | Workload-dependent |
| `efcore.pool.rent.duration.min_ms` | Gauge | `ms` | Minimum recorded rent duration | — |
| `efcore.pool.rent.duration.max_ms` | Gauge | `ms` | Maximum recorded rent duration | Alert on outliers |
| `efcore.pool.rents.total` | Counter | `{rents}` | Cumulative logical rents since startup | Grows with traffic |
| `efcore.pool.returns.total` | Counter | `{returns}` | Cumulative clean returns since startup | Should track rents |
| `efcore.pool.overflow_disposals.total` | Counter | `{disposals}` | Disposed due to pool full | Low; spikes under burst |
| `efcore.pool.physical_creations.total` | Counter | `{instances}` | Total physical instances ever created | Grows slowly |
| `efcore.pool.physical_disposals.total` | Counter | `{instances}` | Total physical instances ever disposed | 0 in steady state |

### Standard metrics — meter: `EFCore.Standard` · tag: `db.context`

| Metric | Type | Unit | Description | Healthy value |
|---|---|---|---|---|
| `efcore.standard.active` | Gauge | `{instances}` | Alive instances (created, not disposed) | 0 when idle |
| `efcore.standard.leaks` | Gauge | `{contexts}` | Created but never disposed | **0** |
| `efcore.standard.duration.avg_ms` | Gauge | `ms` | Average context lifetime | Short |
| `efcore.standard.duration.min_ms` | Gauge | `ms` | Minimum recorded lifetime | — |
| `efcore.standard.duration.max_ms` | Gauge | `ms` | Maximum recorded lifetime | — |
| `efcore.standard.creations.total` | Counter | `{instances}` | Cumulative creations since startup | Grows with requests |
| `efcore.standard.disposals.total` | Counter | `{instances}` | Cumulative disposals since startup | Should track creations |

### Health status thresholds

| Metric | Healthy | Warning | Critical |
|---|---|---|---|
| `LeakedContexts` / `PotentialLeaks` | 0 | 1–5 | > 5 |
| `ReturnRate` | >= 99% | 95–99% | < 95% |
| `PoolUtilization` | < 80% | 80–90% | > 90% |
| `ReuseRatio` | > 5x (Excellent) | 2–5x (Good/VeryGood) | < 1x (Poor) |

---

## 28. Technology Stack

| Category | Technology | Role |
|---|---|---|
| Language / Runtime | C# · .NET 8 | Library and API implementation |
| ORM | Entity Framework Core 8 | Tracked DbContext type |
| API framework | ASP.NET Core 8 Minimal API | Demo HTTP API and load test endpoints |
| Database | SQL Server 2022 (Express) | Persistence layer |
| Metrics instrumentation | System.Diagnostics.Metrics | .NET native Metrics API (no extra deps) |
| Observability bridge | OpenTelemetry .NET 1.15 | SDK + Prometheus exporter |
| Metrics backend | Prometheus | Time-series storage and rule evaluation |
| Visualization | Grafana | Dashboards and alert notifications |
| Alerting rules | PrometheusRule CRD | Kubernetes-native alert definitions |
| Service discovery | ServiceMonitor CRD | Auto-configures Prometheus scraping targets |
| Monitoring chart | kube-prometheus-stack (Helm) | Bundles Prometheus + Grafana + Alertmanager |
| Containerization | Docker (multi-stage) | Minimal runtime image |
| Orchestration | Kubernetes | Pod scheduling, health probes, autoscaling |
| Configuration | Kustomize | Base + overlay pattern (dev / prod) |
| Package manager | Helm | Third-party chart installation and upgrades |
| Autoscaling | HorizontalPodAutoscaler v2 | CPU + memory-based pod scaling |
| Secret management | Kubernetes Secrets + secretGenerator | Env-specific credentials injection |
| Distribution | NuGet (3 packages) | Public library distribution |

---

*DbPoolInsight — v1.0 · Khaled Ibrahim*
*GitHub: [github.com/khaledibrahim1015/DbPoolInsight](https://github.com/khaledibrahim1015/DbPoolInsight)*
