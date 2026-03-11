---
title: "EFCore.Observability — Core Library Reference"
description: "Zero-invasion observability for EF Core's DbContext pool. Tracks rents, returns, leaks, and utilization — with OpenTelemetry, Prometheus, and Grafana support built in."
date: 2026-02-27
tech: [".NET", "EF Core ", "C#", "ASP.NET Core", "OpenTelemetry", "Prometheus", "Grafana", "System.Diagnostics.Metrics", "SQL Server"]
tags: [".NET", "EF Core ", "System.Diagnostics.Metrics", "dbcontext", "dbcontext-pool","observability", "opentelemetry", "prometheus", "grafana",  "diagnostics", "leak-detection", "pool-monitoring", "nuget", "library"]
featured: true
draft: false
---
### EFCore.Observability — Core Library Reference & Integration Guide

> **Version:** 1.0 · **Status:** Production Ready · **Target:** .NET 8+ / EF Core 8+  
> **GitHub:** [DbPoolInsight](https://github.com/khaledibrahim1015/DbPoolInsight)

## NuGet Packages

| Package | Purpose |
|---|---|
| [`EFCore.Observability`](https://www.nuget.org/packages/EFCore.Observability) | Core tracking, lifecycle hooks, interceptor |
| [`EFCore.Observability.Core`](https://www.nuget.org/packages/EFCore.Observability.Core) | Zero-dependency abstractions and models |
| [`EFCore.Observability.OpenTelemetry`](https://www.nuget.org/packages/EFCore.Observability.OpenTelemetry) | OTel bridge — Prometheus / Grafana / Datadog |

---

## Related Articles

- [Part 1 — Pooled Lifetime & DI](/khaledibrahim.dev/articles/part-1-pooled-lifetime-di)
- [Part 2 — EF Core Pool Tracking](/khaledibrahim.dev/articles/part-2-efcore-pool-tracking)
- [Part 3 — .NET Diagnostics](/khaledibrahim.dev/articles/part-3-dotnet-diagnostics)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Prerequisites & Installation](#2-prerequisites--installation)
3. [Quick Start (5 minutes)](#3-quick-start-5-minutes)
4. [Full Registration Reference](#4-full-registration-reference)
5. [Configuring DbContext Types](#5-configuring-dbcontext-types)
6. [ObservabilityOptions Reference](#6-observabilityoptions-reference)
7. [Architecture](#7-architecture)
8. [Component Breakdown](#8-component-breakdown)
9. [Data Flow & Algorithms](#9-data-flow--algorithms)
10. [Metrics Catalog](#10-metrics-catalog)
11. [OpenTelemetry Integration](#11-opentelemetry-integration)
12. [HTTP Diagnostics API](#12-http-diagnostics-api)
13. [Reading Metrics Programmatically](#13-reading-metrics-programmatically)
14. [Prometheus & Grafana Setup](#14-prometheus--grafana-setup)
15. [Alerting Rules](#15-alerting-rules)
16. [Thread Safety Model](#16-thread-safety-model)
17. [Memory Management](#17-memory-management)
18. [Key Design Decisions](#18-key-design-decisions)
19. [Engineering Journey — How We Got Here](#19-engineering-journey--how-we-got-here)
20. [Validating Your Installation](#20-validating-your-installation)
21. [Troubleshooting](#21-troubleshooting)

---

## 1. Overview

EFCore.Observability is a **zero-invasion monitoring layer** for EF Core's DbContext pooling feature. It answers questions that the framework itself leaves opaque:

- Is the pool actually being reused — or are we thrashing with a new instance per request?
- Are contexts leaking — rented but never returned to the pool?
- Is the pool sized correctly for the actual load?
- How long are contexts being held per request, and what is the min/max/avg?

### Why tracking is non-trivial

EF Core pooling deliberately avoids re-running the `DbContext` constructor on each reuse. This means the obvious hook — `ContextInitialized` — only fires once per **physical instance**, not once per **logical rent**. The core problem this library solves is bridging that gap reliably.

```
Without pooling:   new DbContext() → use → Dispose()       ← constructor fires every time

With pooling:      new DbContext() → use → ResetState() → pool → use → ResetState() ...
                         ↑                      ↑
               constructor fires once      only hook available per return
```

The library uses three complementary hooks to reconstruct the full picture:

| Hook | What it detects |
|---|---|
| `EFCoreDiagnosticObserver` (DiagnosticListener) | Physical creation and physical disposal |
| `RentTrackingInterceptor` (DbCommandInterceptor) | Every logical rent (first command per lease) |
| `PoolResettableTrackingService` (IResettableService) | Every clean pool return |

---

## 2. Prerequisites & Installation

### Requirements

| Requirement | Minimum Version |
|---|---|
| .NET | 6.0 |
| Entity Framework Core | 6.0 |
| ASP.NET Core | 6.0 |
| OpenTelemetry .NET *(optional)* | 1.5.0 |

### Install packages

```bash
# Core library (required)
dotnet add package EFCore.Observability

# Optional: OpenTelemetry exporter support
dotnet add package EFCore.Observability.OpenTelemetry

# OpenTelemetry infrastructure (if using OTel)
dotnet add package OpenTelemetry.Extensions.Hosting
dotnet add package OpenTelemetry.Exporter.Prometheus.AspNetCore
```

---

## 3. Quick Start (5 minutes)

The absolute minimum setup to get metrics flowing:

```csharp
// Program.cs
var builder = WebApplication.CreateBuilder(args);

// Step 1: Register observability services
builder.Services.AddEFCoreObservability();

// Step 2: Register your pooled DbContext with tracking enabled
builder.Services.AddDbContextPool<AppDbContext>((sp, options) =>
{
    options.UseSqlServer(builder.Configuration.GetConnectionString("Default"))
           .UseObservability<AppDbContext>(sp, poolSize: 128);
}, poolSize: 128);  // ← poolSize must match in both places

var app = builder.Build();

// Step 3: Activate the DiagnosticListener subscription (MUST be after Build())
app.Services.UseEFCoreObservability();

// Optional: expose a simple JSON endpoint
app.MapGet("/health/pool", (DiagnosticsQueryService q) => q.GetSummary());

app.Run();
```

Verify it works after making a few requests to any endpoint that uses `AppDbContext`:

```bash
curl http://localhost:5000/health/pool
```

Expected response:

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
    "healthStatus": "Healthy"
  }],
  "standard": []
}
```

---

## 4. Full Registration Reference

```csharp
var builder = WebApplication.CreateBuilder(args);

// ── Step 1: Observability with options ───────────────────────────────────────
builder.Services.AddEFCoreObservability(opts =>
{
    opts.TrackRentDurations           = true;   // record per-rent timing
    opts.TrackStandardContexts        = true;   // also track non-pooled contexts
    opts.EnableDiagnosticLogging      = false;  // verbose ILogger output (dev only)
    opts.MaxActivityHistoryPerContext  = 500;   // ring buffer capacity per context
    opts.LeakDetectionThresholdMs     = 30_000; // reserved for future anomaly detection
});

// ── Step 2: Pooled DbContext with tracking ───────────────────────────────────
builder.Services.AddDbContextPool<PrimaryDbContext>((sp, options) =>
{
    options.UseSqlServer(connectionString)
           .UseObservability<PrimaryDbContext>(sp, poolSize: 128);
}, poolSize: 128);

// ── Step 3: Standard (non-pooled) DbContext — tracked automatically ──────────
builder.Services.AddDbContext<ReplicaDbContext>(options =>
{
    options.UseSqlServer(replicaConnString);
    // No UseObservability() needed for standard tracking
});

// ── Step 4: OpenTelemetry (optional) ─────────────────────────────────────────
builder.Services.AddOpenTelemetry()
    .WithMetrics(metrics => metrics
        .AddEFCoreInstrumentation()    // both pool + standard meters
        .AddPrometheusExporter());

var app = builder.Build();

// ── Step 5: Activate (MUST be after Build()) ─────────────────────────────────
app.UseEFCoreObservability();
// OR: app.Services.UseEFCoreObservability();

// ── Step 6: Diagnostic endpoints ─────────────────────────────────────────────
app.MapPrometheusScrapingEndpoint();   // /metrics
app.MapGet("/diagnostics/pool",         (DiagnosticsQueryService q) => q.GetSummary());
app.MapGet("/diagnostics/pool/details", (DiagnosticsQueryService q) => q.GetAllDetails());

app.Run();
```

> ⚠️ **`UseEFCoreObservability()` must be called after `builder.Build()`.**  
> The `DiagnosticListener` subscription needs the real singleton instance from the built service provider. Calling it before `Build()` subscribes a discarded, transient instance.

---

## 5. Configuring DbContext Types

### 5.1 Pooled DbContext

`UseObservability<TContext>()` does three things internally:

1. Registers the configured pool size so `PoolUtilization` can be computed correctly.
2. Injects `PoolResettableTrackingService` into EF Core's internal DI via `TrackingOptionsExtension` so pool returns are detected.
3. Adds `RentTrackingInterceptor` to the command pipeline to track logical rents.

```csharp
services.AddDbContextPool<WriteDbContext>((sp, options) =>
{
    options.UseSqlServer(writeConn)
           .UseObservability<WriteDbContext>(sp, poolSize: 128);
}, poolSize: 128);
```

> ⚠️ **Pool size must match in both places.** Passing different values will produce incorrect `PoolUtilization` and `RoomToGrow` calculations.

### 5.2 Standard (Non-Pooled) DbContext

Standard contexts are tracked automatically via `ContextInitialized` / `ContextDisposed` events. No call to `UseObservability()` is required — just ensure `TrackStandardContexts = true` (the default).

```csharp
services.AddDbContext<AnalyticsDbContext>(options =>
{
    options.UseSqlServer(analyticsConn);
    // No UseObservability() needed
});
```

### 5.3 Multiple DbContext Types

Each context type gets its own isolated metrics bucket, keyed automatically by `typeof(TContext).Name`.

```csharp
// Primary write DB — pooled, large pool
services.AddDbContextPool<WriteDbContext>((sp, options) =>
    options.UseSqlServer(writeConn)
           .UseObservability<WriteDbContext>(sp, poolSize: 128), poolSize: 128);

// Read replica — pooled, smaller pool
services.AddDbContextPool<ReadDbContext>((sp, options) =>
    options.UseSqlServer(readConn)
           .UseObservability<ReadDbContext>(sp, poolSize: 64), poolSize: 64);

// Analytics — standard (not pooled)
services.AddDbContext<AnalyticsDbContext>(options =>
    options.UseSqlServer(analyticsConn));
```

Query each bucket independently:

```csharp
diagnosticsQueryService.GetPooledMetrics("WriteDbContext");
diagnosticsQueryService.GetPooledMetrics("ReadDbContext");
diagnosticsQueryService.GetStandardMetrics("AnalyticsDbContext");
```

---

## 6. ObservabilityOptions Reference

```csharp
builder.Services.AddEFCoreObservability(opts => { /* configure here */ });
```

| Property | Type | Default | Description |
|---|---|---|---|
| `TrackRentDurations` | `bool` | `true` | Record per-rent min/avg/max timing. Minor overhead per return. |
| `TrackStandardContexts` | `bool` | `true` | Track non-pooled DbContext creation and disposal. |
| `EnableDiagnosticLogging` | `bool` | `false` | Emit verbose `ILogger` output for every lifecycle event. Dev only. |
| `MaxActivityHistoryPerContext` | `int` | `500` | Ring buffer capacity — oldest entry dropped when full. |
| `LeakDetectionThresholdMs` | `long` | `30000` | Reserved for future automated leak detection. Not currently enforced. |

---

## 7. Architecture

### High-Level Component Map

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Application Layer                             │
│   Controllers / Services / Repositories  ──►  DbContext (pooled)     │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │  EF Core DbContextPool
          ┌──────────────────────┼──────────────────────┐
          │                      │                       │
          ▼                      ▼                       ▼
  ┌───────────────┐    ┌──────────────────┐    ┌─────────────────────┐
  │ Diagnostic    │    │ RentTracking     │    │ PoolResettable      │
  │ Observer      │    │ Interceptor      │    │ TrackingService     │
  │               │    │                  │    │                     │
  │ Fires on:     │    │ Fires on:        │    │ Fires on:           │
  │ • Constructor │    │ • Every DB cmd   │    │ • Context returned  │
  │ • Disposal    │    │   (first per     │    │   to pool           │
  │               │    │    rent only)    │    │   (ResetState)      │
  └──────┬────────┘    └────────┬─────────┘    └──────────┬──────────┘
         └──────────────────────┼──────────────────────────┘
                                ▼
                  ┌─────────────────────────────┐
                  │   DbContextLifeCycleTracker  │  ← Singleton, central hub
                  │                             │
                  │  ┌─────────────────────┐    │
                  │  │  InstanceStateStore  │    │
                  │  └─────────────────────┘    │
                  │  ┌─────────────────────┐    │
                  │  │  PooledMetricsState  │    │
                  │  └─────────────────────┘    │
                  │  ┌──────────────────────┐   │
                  │  │ StandardMetricsState │   │
                  │  └──────────────────────┘   │
                  └──────────────┬──────────────┘
                                 │
                  ┌──────────────┼──────────────┐
                  ▼              ▼               ▼
         ┌────────────┐  ┌────────────┐  ┌──────────────────┐
         │ Diagnostics│  │ OTel Pool  │  │  OTel Standard   │
         │  Query     │  │   Meter    │  │     Meter        │
         │  Service   │  │            │  │                  │
         └────────────┘  └────────────┘  └──────────────────┘
           HTTP API        Prometheus /     Prometheus /
           endpoint        Grafana          Grafana
```

### Service Lifetimes

| Component | DI Lifetime | Reason |
|---|---|---|
| `DbContextLifeCycleTracker` | Singleton | Owns all metrics state across the app lifetime |
| `EFCoreDiagnosticObserver` | Singleton | Subscribes once to `DiagnosticListener` |
| `RentTrackingInterceptor` | Singleton | Stateless per-command hook with bounded dictionary |
| `PoolResettableTrackingService` | Scoped (EF internal DI) | One instance per physical DbContext object |
| `DiagnosticsQueryService` | Singleton | Read-only façade over the tracker |
| `EFCorePoolMeter` / `EFCoreStandardMeter` | Singleton | OTel instrument lifetime |

> ⚠️ **Scoped ≠ per-request here.** EF Core's internal DI scopes services to the **physical instance lifetime**, not the HTTP request lifetime. A `PoolResettableTrackingService` lives as long as its physical `DbContext` lives in the pool — which may span hundreds of requests.

---

## 8. Component Breakdown

### 8.1 EFCoreDiagnosticObserver

**File:** `Observers/EFCoreDiagnosticObserver.cs`  
**Implements:** `IObserver<DiagnosticListener>`

Entry point for physical lifecycle events. Subscribes to EF Core's `DiagnosticListener` after startup and handles two events:

| Event | When it fires | What we do |
|---|---|---|
| `ContextInitialized` | DbContext **constructor** ran | Detect physical creation; wire up `PoolResettableTrackingService` |
| `ContextDisposed` | Physical DbContext **destroyed** | Classify as leak, overflow, or normal disposal |

The observer uses a nested class pattern to separate `DiagnosticListener` discovery (outer) from event handling (inner):

```csharp
// Outer: finds the right DiagnosticListener
public void OnNext(DiagnosticListener listener)
{
    if (listener.Name == "Microsoft.EntityFrameworkCore")
        listener.Subscribe(new EFCoreEventObserver(this));
}

// Inner: handles individual key-value events
public void OnNext(KeyValuePair<string, object> evt)
{
    switch (evt.Key)
    {
        case EfCoreDiagnosticConstants.ContextInitialized:
            _parent.HandleContextInitialized(evt.Value);
            break;
        case EfCoreDiagnosticConstants.ContextDisposed:
            _parent.HandleContextDisposed(evt.Value);
            break;
    }
}
```

**Important nuance — `ContextInitialized` fires on reuse too.**  
When a pooled context is returned and re-rented, `ContextInitialized` fires again (the event payload is replayed). The observer passes this through to `IContextMetricsCollector.OnContextInitialized`, which uses **instance ID deduplication** (see §4.1) to avoid double-counting physical creations.

**`PoolResettableTrackingService` wiring:**  
On every `ContextInitialized` for a pooled context, the observer retrieves the `PoolResettableTrackingService` from EF's internal service provider and calls `Configure(name, instanceId, lease)`. This keeps `_currentLease` in sync for accurate return tracking.


```csharp
private void HandleContextInitialized(object payload)
{
    if (payload is not ContextInitializedEventData eventData) return;

    var context = eventData.Context;
    var isPooled = ResolveIsPooled(context);

    _collector.OnContextInitialized(name, instanceId, lease, isPooled);

    if (isPooled)
    {
        // Wire up the resettable service so pool returns are captured
        var svc = context.GetService<PoolResettableTrackingService>();
        svc?.Configure(name, instanceId, lease);
    }
}
```

**IsPooled detection** (checks EF Core's internal options rather than guessing):

```csharp
private static bool ResolveIsPooled(DbContext context)
{
    var maxPoolSize = context
        .GetService<IDbContextOptions>()
        .Extensions
        .OfType<CoreOptionsExtension>()
        .FirstOrDefault()?.MaxPoolSize ?? 0;
    return maxPoolSize > 0;
}
```

### 8.2 RentTrackingInterceptor

**File:** `Interceptors/RentTrackingInterceptor.cs`  
**Extends:** `DbCommandInterceptor`

This is the core innovation of the library. Because `ContextInitialized` does not fire on each pool reuse, we hook into the **command pipeline** instead. Every SQL command passes through this interceptor.

The rent key uniquely identifies a logical rent cycle:

```csharp
var rentKey = $"{instanceId}:{lease}";
// e.g. "a3f2b1c0-...:7"  — unique per (physical instance, logical rent cycle)
```

First-command-per-rent detection uses a lock-free `ConcurrentDictionary`:

```csharp
private void TrackIfNeeded(DbContext? context)
{
    if (context is null || !IsPooled(context)) return;

    var rentKey = $"{context.ContextId.InstanceId}:{context.ContextId.Lease}";

    if (_trackedRents.TryAdd(rentKey, true))   // atomic — only one thread wins
    {
        _collector.OnContextRented(
            context.GetType().Name,
            context.ContextId.InstanceId,
            context.ContextId.Lease);
        MaybeEvict();
    }
    // Subsequent commands in the same rent: TryAdd returns false → no-op
}
```

All six command pipeline methods are covered:

```csharp
// Sync
public override InterceptionResult<DbDataReader> ReaderExecuting(...)
public override InterceptionResult<object>       ScalarExecuting(...)
public override InterceptionResult<int>          NonQueryExecuting(...)

// Async
public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(...)
public override ValueTask<InterceptionResult<object>>       ScalarExecutingAsync(...)
public override ValueTask<InterceptionResult<int>>          NonQueryExecutingAsync(...)
```

**Why the command interceptor — alternatives considered:**

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| Override `OnModelCreating()` | Fires on every use | Requires DbContext modification | ❌ Too invasive |
| Override `SaveChanges()` | Simple | Only fires if saving data — misses read-only requests | ❌ Unreliable |
| Custom `DbContext` base class | Centralized | Requires inheritance changes in user code | ❌ Breaking change |
| `ContextInitialized` event | Already present | Only fires on physical construction, not on pool reuse | ❌ Fundamentally wrong event |
| **DbCommandInterceptor** | Non-invasive, fires on every operation | ~10 ns overhead per command for the dictionary lookup | ✅ Selected |

**Performance characteristics:**

```
Per-command overhead:
  Dictionary lookup (key already present): O(1) ≈ 10 ns  ← most common path
  First command of a new rent (TryAdd):    O(1) ≈ 50 ns  ← once per rent cycle
  All subsequent commands in the same rent: pure lookup no-op

Worst case: < 0.01 ms per command
Typical case: < 0.001 ms per command (already tracked)
```

Memory bounding via eviction (old `instanceId:lease` keys never repeat, so eviction is safe):

```csharp
private const int MaxTrackedRents = 10_000;  // ~1 MB worst case
private const int EvictTo         = 8_000;   // trim 20% when threshold hit

private void MaybeEvict()
{
    if (_trackedRents.Count <= MaxTrackedRents) return;

    int toRemove = _trackedRents.Count - EvictTo;
    foreach (var key in _trackedRents.Keys)
    {
        if (toRemove-- <= 0) break;
        _trackedRents.TryRemove(key, out _);
    }
}
```
> Old rent keys are safe to evict because `instanceId:lease` combinations never repeat — lease is monotonically increasing per physical instance.
### 8.3 PoolResettableTrackingService

**File:** `Services/PoolResettableTrackingService.cs`  
**Implements:** `IResettableService` (EF Core internal interface)

EF Core calls `ResetState()` on every registered `IResettableService` when a pooled context is returned to the pool. This is the only reliable, documented way to detect pool returns.

```csharp
public void ResetState()
{
    if (!_isInitialized || _contextName is null) return;

    _collector.OnContextReturnedToPool(_contextName, _instanceId, _currentLease);
    _currentLease++;    // keep in sync; Configure() will reset on next ContextInitialized
}
```

**Why `_currentLease` is incremented here:**  
When the context is returned and later re-rented, `ContextInitialized` fires again and `Configure()` is called with the new lease value. The `_currentLease++` here is a safety measure to keep the service consistent even if the wiring fires slightly out of order.

**Lifetime diagram for a single physical instance:**

```
Physical instance created (lease=0)
    └─► PoolResettableTrackingService constructed
    └─► Configure("MyCtx", guid-ABC, lease=0)  ← _currentLease = 0

Request 1: context rented (lease=1)
    └─► ContextInitialized fires → Configure(..., lease=1)  ← _currentLease = 1
    └─► SQL runs → RentTrackingInterceptor records rent for "ABC:1"
    └─► using block ends → ResetState() called
            ├─► OnContextReturnedToPool(..., lease=1)
            └─► _currentLease = 2

Request 2: context rented (lease=2)
    └─► Configure(..., lease=2)  ← resets _currentLease = 2
    └─► ... same pattern ...
```

### 8.4 DbContextLifeCycleTracker

**File:** `Services/DbContextLifeCycleTracker.cs`  
**Implements:** `IContextMetricsCollector`, `IContextMetricsProvider`

The central coordinator. All three tracking components funnel events here. Owns:

- `_pooledStates`: `ConcurrentDictionary<string, PooledMetricsState>` — one entry per pooled context type
- `_standardStates`: `ConcurrentDictionary<string, StandardMetricsState>` — one entry per standard context type
- `_instanceStore`: `InstanceStateStore` — per-instance mutable lifecycle state
- `_activityStore`: `IInstanceActivityStore` — ring buffer of recent rent/lifetime records

Key method responsibilities at a glance:

```
OnContextInitialized(name, instanceId, lease, isPooled)
    ├─ Standard context → HandleStandardCreated()
    └─ Pooled context
        ├─ _instanceStore.TryAddSeen()  ← deduplication
        │       true  → new physical instance → IncrementPhysicalCreations
        │       false → reuse, skip
        └─ AddOrUpdateState(instanceId, InstanceState{...})

OnContextRented(name, instanceId, lease)
    ├─ IncrementTotalRents()
    ├─ _instanceStore.TryAddRented()
    └─ UpdateState: WasReturnedToPool = false, LastRented = now

OnContextReturnedToPool(name, instanceId, lease)
    ├─ IncrementTotalReturns()
    ├─ _instanceStore.TryRemoveRented()
    ├─ UpdateState: WasReturnedToPool = true, LastReturned = now
    └─ TrackRentDurations if enabled

OnPooledContextDisposed(name, instanceId, lease)
    ├─ IncrementPhysicalDisposals()
    ├─ PoolOverflowDetector.Classify() → leak / overflow variant
    ├─ IncrementLeakedContexts OR IncrementOverflowDisposals
    └─ TrackRentDurations if enabled

OnStandardContextDisposed(name, instanceId)
    ├─ IncrementTotalDisposals()
    ├─ RecordLifetime(duration)
    └─ RecordActivity(...)
```

---

### 8.5 InstanceStateStore

**File:** `Internal/InstanceStateStore.cs`

Thread-safe in-memory store for per-instance mutable state using three `ConcurrentDictionary` structures:

| Dictionary | Key | Purpose |
|---|---|---|
| `_states` | `Guid instanceId` | Full lifecycle state for each live instance |
| `_seenInstances` | `contextName → Set<Guid>` | Detect first-ever encounter (physical creation guard) |
| `_rentedInstances` | `contextName → Set<Guid>` | Instances currently rented (for future validation) |

`InstanceState` fields:

```csharp
string   ContextName
bool     IsPooled
int      CurrentLease
DateTime CreatedAt
DateTime LastRented
DateTime? LastReturned
bool     WasReturnedToPool    // ← key flag for the overflow vs. leak decision
bool     IsOverflow           // ← set once at creation if pool was already at capacity
```

### 8.6 PoolOverflowDetector

**File:** `Internal/PoolOverflowDetector.cs`

Pure static classification logic for disposal events. Called from `OnPooledContextDisposed`.

```csharp
public static DisposalClassification Classify(
    InstanceState state,
    long physicalCreations,
    long physicalDisposals,
    int maxPoolSize)
```

Decision tree:

```
Was WasReturnedToPool = true?
    YES → OverflowAfterReturn   (clean return; pool was full → EF disposed the extra)

Was IsOverflow = true?
    YES → OverflowCreation      (instance was always overflow from birth)

Is (creations - disposals) > maxPoolSize?
    YES → OverflowCapacity      (race condition during disposal window)

Otherwise → Leaked ⚠️          (context rented, never returned)
```

| Classification | Meaning | Counter incremented |
|---|---|---|
| `OverflowAfterReturn` | Normal — pool was full | `OverflowDisposals` |
| `OverflowCreation` | Normal — born overflow | `OverflowDisposals` |
| `OverflowCapacity` | Normal — race condition | `OverflowDisposals` |
| `Leaked` | **Problem** — never returned | `LeakedContexts` ⚠️ |

### 8.7 RingBufferActivityStore

**File:** `Internal/RingBufferActivityStore.cs`
**Implements:** `IInstanceActivityStore`
Bounded activity log using a per-context-type circular queue. When capacity is reached, the **oldest entry is dropped automatically**.

```csharp
// Enqueue: O(1) amortized
if (_inner.Count >= _capacity) _inner.Dequeue();   // drop oldest
_inner.Enqueue(activity);                           // add newest

// TakeLast(n): O(n) — copies array under lock
var all  = _inner.ToArray();
var skip = Math.Max(0, all.Length - count);
return all.Skip(skip).ToList();
```

Each `InstanceActivity` record:

```csharp
string   InstanceId    // first 8 chars of GUID for readability
int      Lease
DateTime StartedAt
DateTime EndedAt
long     DurationMs
```

### 8.8 Metrics State Objects

#### PooledMetricsState

Mutable counters for a single pooled context type. All mutations use `Interlocked` for lock-free thread safety:

```csharp
// All counter mutations
Interlocked.Increment(ref _physicalCreations);
Interlocked.Increment(ref _totalRents);
Interlocked.Add(ref _totalRentDurationMs, durationMs);

// Min/max via CAS loop — no lock needed
long currentMin;
do {
    currentMin = Interlocked.Read(ref _minRentDurationMs);
    if (durationMs >= currentMin) break;
} while (Interlocked.CompareExchange(
    ref _minRentDurationMs, durationMs, currentMin) != currentMin);
```

`Snapshot()` produces an immutable `PooledContextMetrics` record. All computed properties are derived from the atomic values:

```csharp
PhysicalInPool   = PhysicalCreations - PhysicalDisposals
ActiveRents      = TotalRents - TotalReturns - OverflowDisposals
AvailableInPool  = PhysicalInPool - ActiveRents
RoomToGrow       = MaxPoolSize - PhysicalInPool
PoolUtilization  = (PhysicalInPool / MaxPoolSize) × 100
ReuseRatio       = TotalRents / PhysicalCreations
ReturnRate       = (TotalReturns / TotalRents) × 100
AvgRentDurationMs = TotalRentDurationMs / TotalReturns
```

#### StandardMetricsState

Simpler version for non-pooled contexts. Same `Interlocked` + CAS pattern for `TotalCreations`, `TotalDisposals`, and lifetime min/max/total.

### 8.9 OpenTelemetry Meters

Two meters expose metrics to any OTel-compatible backend. All instruments are **observable** (polled by the SDK, not pushed). Each instrument iterates all contexts and emits one `Measurement<T>` per context type tagged with `db.context`.

```csharp
// Pattern used for every instrument
_meter.CreateObservableGauge(
    "efcore.pool.utilization",
    observeValues: () => Observe(m => Measure(m.PoolUtilization, m)),
    unit: "%",
    description: "Pool utilization as a percentage of MaxPoolSize.");

private IEnumerable<Measurement<T>> Observe<T>(Func<PooledContextMetrics, Measurement<T>> selector)
{
    foreach (var metrics in _provider.GetAllPooledMetrics().Values)
        yield return selector(metrics);
}

private static Measurement<T> Measure<T>(T value, PooledContextMetrics m) where T : struct =>
    new(value, new KeyValuePair<string, object?>("db.context", m.ContextName));
```



---

## 9. Data Flow & Algorithms

### 9.1 Physical Creation Detection

**Problem:** `ContextInitialized` fires again on every pool reuse. Naively incrementing `PhysicalCreations` there would double-count.

**Solution:** Instance ID deduplication via `_seenInstances`:

```
OnContextInitialized(name, instanceId, lease, isPooled=true)
                │
                ▼
    _seenInstances[name].TryAdd(instanceId)
                │
        ┌───────┴───────┐
      true             false
   (new ID)         (already seen)
        │                 │
        ▼                 ▼
  PhysicalCreations++   no-op
  AddOrUpdateState()    (reuse, rent tracked by interceptor)
```

This approach is **resilient to subscription timing** — even if we miss the very first `ContextInitialized` during pool warmup (before the observer is subscribed), the next time we see any event for a new `instanceId` it will be counted exactly once.

---

### 9.2 Rent Tracking Flow

```
HTTP request arrives
        │
        ▼
  EF Core rents DbContext from pool
  (no constructor, ContextId.Lease incremented)
        │
        ▼
  Application code executes query:
  context.Users.Where(...).ToListAsync()
        │
        ▼
  EF Core builds SQL → fires command pipeline
        │
        ▼
  RentTrackingInterceptor.ReaderExecutingAsync()
        │
        ▼
  rentKey = $"{instanceId}:{lease}"
        │
        ▼
  _trackedRents.TryAdd(rentKey, true)
        │
   ┌────┴────┐
  true      false
(new rent) (2nd+ cmd same rent)
   │             │
   ▼             ▼
OnContextRented() no-op
   │
   ▼
  PooledMetricsState.IncrementTotalRents()
  InstanceState.WasReturnedToPool = false
  InstanceState.LastRented = DateTime.UtcNow
        │
        ▼
  Database executes query
  Application receives results
        │
        ▼
  (may execute more queries — all no-ops in interceptor)
        │
        ▼
  `using` block ends → EF Core returns context to pool
  (see §4.3 Return Tracking Flow)
```

### 9.3 Return Tracking Flow

```
`using` block ends (Dispose() called)
        │
        ▼
  EF Core: IsPooled? Pool not full?
        │
   ┌────┴──────────────────────┐
  YES (pool return)           NO (physical dispose)
   │                               │
   ▼                               ▼
EF Core calls ResetState()    ContextDisposed event fires
on IResettableService         → EFCoreDiagnosticObserver
   │                          → OnPooledContextDisposed()
   ▼                          → PoolOverflowDetector.Classify()
PoolResettableTrackingService
   │
   ▼
OnContextReturnedToPool(name, instanceId, currentLease)
   │
   ▼
IncrementTotalReturns()
InstanceState.WasReturnedToPool = true
RecordRentDuration(now - LastRented)
_currentLease++
```

### 9.4 Disposal Classification Algorithm

```
OnPooledContextDisposed(name, instanceId, lease)
        │
        ▼
  Retrieve InstanceState from store
        │
        ▼
  PoolOverflowDetector.Classify(state, creations, disposals, maxPoolSize)
        │
        ▼
  state.WasReturnedToPool == true?
  ┌─────────────────────────┐
  │ YES → OverflowAfterReturn│ ← Normal. Pool had no room on return.
  └──────────┬──────────────┘
             │ NO
             ▼
  state.IsOverflow == true?
  ┌──────────────────────────┐
  │ YES → OverflowCreation   │ ← Normal. Instance born overflow.
  └──────────┬───────────────┘
             │ NO
             ▼
  (creations - disposals) > maxPoolSize?
  ┌───────────────────────────┐
  │ YES → OverflowCapacity    │ ← Normal. Race condition window.
  └──────────┬────────────────┘
             │ NO
             ▼
  ┌───────────────────────────┐
  │ Leaked ⚠️                │ ← Problem. Never returned.
  └───────────────────────────┘
        │
        ▼
  IncrementLeakedContexts()
  Log WARNING
```

---

## 10. Metrics Catalog

### Pooled Context Metrics

| Metric | Formula / Source | Healthy value |
|---|---|---|
| `PhysicalCreations` | Counter — first seen `instanceId` | Grows slowly, then stable |
| `PhysicalDisposals` | Counter — `ContextDisposed` | 0 in steady state |
| `PhysicalInPool` | `PhysicalCreations - PhysicalDisposals` | ≤ MaxPoolSize |
| `AvailableInPool` | `PhysicalInPool - ActiveRents` | > 0 (headroom) |
| `RoomToGrow` | `MaxPoolSize - PhysicalInPool` | > 0 (not saturated) |
| `TotalRents` | Counter — interceptor first-cmd per rent | Grows with traffic |
| `TotalReturns` | Counter — `ResetState()` calls | Should equal `TotalRents` when idle |
| `ActiveRents` | `TotalRents - TotalReturns` | 0 when idle |
| `OverflowDisposals` | Counter — overflow classifications | Low; spikes under burst load |
| `LeakedContexts` | Counter — `Leaked` classification | **Must be 0** |
| `PoolUtilization` | `(PhysicalInPool / MaxPoolSize) × 100` | < 80% |
| `ReuseRatio` | `TotalRents / PhysicalCreations` | > 10 for healthy traffic |
| `ReturnRate` | `(TotalReturns / TotalRents) × 100` | **100%** |
| `AvgRentDurationMs` | `TotalRentDurationMs / TotalReturns` | Depends on workload |
| `MinRentDurationMs` | CAS-tracked min | — |
| `MaxRentDurationMs` | CAS-tracked max | Alert if outliers are extreme |

### Standard Context Metrics

| Metric | Formula | Healthy value |
|---|---|---|
| `TotalCreations` | Counter — `ContextInitialized` | Grows with requests |
| `TotalDisposals` | Counter — `ContextDisposed` | Should equal `TotalCreations` eventually |
| `ActiveContexts` | `TotalCreations - TotalDisposals` | 0 when idle |
| `PotentialLeaks` | `ActiveContexts` after long idle | **0** |
| `AvgLifetimeMs` | `TotalLifetimeMs / TotalDisposals` | Short (< request duration) |

### Health Status Enums

```csharp
// ContextHealthStatus — derived from LeakedContexts or PotentialLeaks
Healthy  // 0 leaks
Warning  // 1–5 leaks
Leaking  // > 5 leaks

// ReuseQuality — derived from ReuseRatio (pooled only)
Excellent  // >= 5.0
VeryGood   // >= 3.0
Good       // >= 2.0
Fair       // >= 1.0
Poor       // < 1.0
```

---

## 11. OpenTelemetry Integration

### Registration options

```csharp
builder.Services.AddOpenTelemetry()
    .WithMetrics(m => m
        // Option A: both pool and standard in one call
        .AddEFCoreInstrumentation()

        // Option B: only pool metrics
        .AddEFCorePoolInstrumentation()

        // Option C: only standard metrics
        .AddEFCoreStandardInstrumentation()
    );
```

### Prometheus exporter

```csharp
builder.Services.AddOpenTelemetry()
    .WithMetrics(m => m
        .AddEFCoreInstrumentation()
        .AddPrometheusExporter());

app.MapPrometheusScrapingEndpoint();  // exposes /metrics
```

### OTLP exporter (Grafana Cloud, Datadog)

```csharp
builder.Services.AddOpenTelemetry()
    .WithMetrics(m => m
        .AddEFCoreInstrumentation()
        .AddOtlpExporter(o =>
        {
            o.Endpoint = new Uri("https://otlp.example.com:4317");
            o.Headers  = "Authorization=Bearer your-token";
        }));
```

### EFCorePoolMeter — meter name: `EFCore.Pool`

| Instrument | Type | Unit |
|---|---|---|
| `efcore.pool.max_size` | Gauge | `{instances}` |
| `efcore.pool.room_to_grow` | Gauge | `{instances}` |
| `efcore.pool.instances.physical` | Gauge | `{instances}` |
| `efcore.pool.instances.available` | Gauge | `{instances}` |
| `efcore.pool.rents.active` | Gauge | `{rents}` |
| `efcore.pool.utilization` | Gauge | `%` |
| `efcore.pool.reuse_ratio` | Gauge | `{instances}` |
| `efcore.pool.return_rate` | Gauge | `%` |
| `efcore.pool.leaks` | Gauge | `{contexts}` |
| `efcore.pool.rent.duration.avg_ms` | Gauge | `ms` |
| `efcore.pool.rent.duration.min_ms` | Gauge | `ms` |
| `efcore.pool.rent.duration.max_ms` | Gauge | `ms` |
| `efcore.pool.rents.total` | Counter | `{rents}` |
| `efcore.pool.returns.total` | Counter | `{returns}` |
| `efcore.pool.overflow_disposals.total` | Counter | `{disposals}` |
| `efcore.pool.physical_creations.total` | Counter | `{instances}` |
| `efcore.pool.physical_disposals.total` | Counter | `{instances}` |

### EFCoreStandardMeter — meter name: `EFCore.Standard`

| Instrument | Type | Unit |
|---|---|---|
| `efcore.standard.active` | Gauge | `{instances}` |
| `efcore.standard.leaks` | Gauge | `{contexts}` |
| `efcore.standard.duration.avg_ms` | Gauge | `ms` |
| `efcore.standard.duration.min_ms` | Gauge | `ms` |
| `efcore.standard.duration.max_ms` | Gauge | `ms` |
| `efcore.standard.creations.total` | Counter | `{instances}` |
| `efcore.standard.disposals.total` | Counter | `{instances}` |

### Metric names in Prometheus format

OTel converts dot-notation names to underscore for Prometheus:

| OTel name | Prometheus name |
|---|---|
| `efcore.pool.utilization` | `efcore_pool_utilization_percent` |
| `efcore.pool.rents.total` | `efcore_pool_rents_total` |
| `efcore.pool.leaks` | `efcore_pool_leaks` |
| `efcore.standard.active` | `efcore_standard_active` |

Sample Prometheus output:

```
# TYPE efcore_pool_utilization_percent gauge
efcore_pool_utilization_percent{db_context="WriteDbContext"} 7.81

# TYPE efcore_pool_rents_total counter
efcore_pool_rents_total{db_context="WriteDbContext"} 1024

# TYPE efcore_pool_leaks gauge
efcore_pool_leaks{db_context="WriteDbContext"} 0
```

---

## 12. HTTP Diagnostics API

Inject `DiagnosticsQueryService` directly into endpoints or controllers when you don't need OTel.

### Minimal API

```csharp
var diag = app.MapGroup("/diagnostics");

diag.MapGet("/summary",
    (DiagnosticsQueryService q) => q.GetSummary());

diag.MapGet("/details",
    (DiagnosticsQueryService q) => q.GetAllDetails());

diag.MapGet("/pool/{name}", (string name, DiagnosticsQueryService q) =>
{
    var m = q.GetPooledMetrics(name);
    return m is null ? Results.NotFound() : Results.Ok(m);
});

diag.MapGet("/standard/{name}", (string name, DiagnosticsQueryService q) =>
{
    var m = q.GetStandardMetrics(name);
    return m is null ? Results.NotFound() : Results.Ok(m);
});

diag.MapGet("/activity/{name}", (string name, DiagnosticsQueryService q) =>
    q.GetRecentActivity(name, take: 50));
```

### Controller-based

```csharp
[ApiController]
[Route("api/[controller]")]
public class PoolDiagnosticsController : ControllerBase
{
    private readonly DiagnosticsQueryService _diagnostics;

    public PoolDiagnosticsController(DiagnosticsQueryService diagnostics)
        => _diagnostics = diagnostics;

    [HttpGet("summary")]
    public IActionResult GetSummary() => Ok(_diagnostics.GetSummary());

    [HttpGet("pool/{contextName}")]
    public IActionResult GetPooled(string contextName)
    {
        var metrics = _diagnostics.GetPooledMetrics(contextName);
        return metrics is null ? NotFound() : Ok(metrics);
    }

    [HttpGet("activity/{contextName}")]
    public IActionResult GetActivity(string contextName, [FromQuery] int take = 20)
        => Ok(_diagnostics.GetRecentActivity(contextName, take));
}
```

### Response shape — `GetSummary()`

```json
{
  "pooled": [{
    "contextName": "WriteDbContext",
    "maxPoolSize": 128,
    "physicalCreations": 8,
    "physicalInPool": 8,
    "availableInPool": 2,
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
    "lastUpdated": "2026-02-27T10:43:21Z"
  }],
  "standard": []
}
```

---

## 13. Reading Metrics Programmatically

### Health check integration

```csharp
builder.Services.AddHealthChecks()
    .Add(new HealthCheckRegistration(
        "efcore-pool",
        sp => new EFCorePoolHealthCheck(sp.GetRequiredService<DiagnosticsQueryService>()),
        HealthStatus.Degraded,
        tags: ["database", "pool"]));

public class EFCorePoolHealthCheck : IHealthCheck
{
    private readonly DiagnosticsQueryService _query;
    public EFCorePoolHealthCheck(DiagnosticsQueryService query) => _query = query;

    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        var summary = _query.GetSummary();

        foreach (var pool in summary.Pooled)
        {
            if (pool.LeakedContexts > 0)
                return Task.FromResult(HealthCheckResult.Unhealthy(
                    $"{pool.ContextName}: {pool.LeakedContexts} leaked contexts"));

            if (pool.ReturnRate < 95)
                return Task.FromResult(HealthCheckResult.Degraded(
                    $"{pool.ContextName}: return rate {pool.ReturnRate:F1}%"));
        }

        return Task.FromResult(HealthCheckResult.Healthy("All pools healthy"));
    }
}
```

### Background monitoring service

```csharp
public class PoolMonitorService : BackgroundService
{
    private readonly IContextMetricsProvider _provider;
    private readonly ILogger<PoolMonitorService> _logger;

    public PoolMonitorService(
        IContextMetricsProvider provider,
        ILogger<PoolMonitorService> logger)
    {
        _provider = provider;
        _logger   = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            foreach (var (name, metrics) in _provider.GetAllPooledMetrics())
            {
                if (metrics.LeakedContexts > 0)
                    _logger.LogCritical(
                        "[Pool] LEAK DETECTED: {Context} has {Leaks} leaked contexts",
                        name, metrics.LeakedContexts);

                if (metrics.PoolUtilization > 90)
                    _logger.LogWarning(
                        "[Pool] HIGH UTILIZATION: {Context} at {Util:F1}%",
                        name, metrics.PoolUtilization);
            }

            await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
        }
    }
}
```

### Inject as IContextMetricsProvider

`IContextMetricsProvider` is the read-only interface — prefer it over injecting `DiagnosticsQueryService` or the tracker directly:

```csharp
public class MyService
{
    private readonly IContextMetricsProvider _metricsProvider;

    public MyService(IContextMetricsProvider metricsProvider)
        => _metricsProvider = metricsProvider;

    public bool IsPoolHealthy(string contextName)
    {
        var metrics = _metricsProvider.GetPooledMetrics(contextName);
        return metrics is { LeakedContexts: 0, ReturnRate: >= 99 };
    }

    public IEnumerable<string> GetAllTrackedContexts()
        => _metricsProvider.GetAllPooledMetrics().Keys
            .Concat(_metricsProvider.GetAllStandardMetrics().Keys);
}
```

---

## 14. Prometheus & Grafana Setup

### Prometheus scrape config

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'myapp-efcore'
    static_configs:
      - targets: ['myapp:8080']
    metrics_path: '/metrics'
    scrape_interval: 15s
```

### Grafana PromQL examples

**Pool health status:**
```promql
efcore_pool_return_rate_percent{db_context="WriteDbContext"}
```
Thresholds: ≥ 99 → green · ≥ 95 → yellow · < 95 → red

**Reuse ratio over time:**
```promql
efcore_pool_reuse_ratio{db_context="WriteDbContext"}
```

**Active rents (concurrent pool consumers):**
```promql
efcore_pool_rents_active{db_context="WriteDbContext"}
```

**Leak detection alert panel:**
```promql
efcore_pool_leaks{db_context="WriteDbContext"} > 0
```

**Average rent duration:**
```promql
efcore_pool_rent_duration_avg_ms_milliseconds{db_context="WriteDbContext"}
```

---

## 15. Alerting Rules

### Prometheus alert rules (YAML)

```yaml
groups:
  - name: efcore_pool
    rules:

      - alert: EFCoreContextLeak
        expr: efcore_pool_leaks > 0 or efcore_standard_leaks > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "DbContext leak in {{ $labels.db_context }}"
          description: >
            {{ $value }} context(s) rented but never returned.
            Check for missing `using` statements or exception paths that skip Dispose().

      - alert: EFCoreReturnRateLow
        expr: efcore_pool_return_rate_percent < 95
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Low pool return rate for {{ $labels.db_context }}"
          description: "Return rate is {{ $value }}%. Expected 100%. Investigate disposal patterns."

      - alert: EFCorePoolNearCapacity
        expr: efcore_pool_utilization_percent > 90
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Pool near capacity for {{ $labels.db_context }}"
          description: "Utilization is {{ $value }}%. Consider increasing MaxPoolSize."

      - alert: EFCorePoolOverflowing
        expr: rate(efcore_pool_overflow_disposals_total[5m]) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Pool overflow for {{ $labels.db_context }}"
          description: "Contexts disposed due to pool overflow. Increase pool size or reduce concurrency."

      - alert: EFCoreSlowContextRent
        expr: efcore_pool_rent_duration_avg_ms_milliseconds > 2000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Slow DbContext rent: {{ $value }}ms for {{ $labels.db_context }}"
          description: "Average rent duration exceeded 2000ms. Investigate slow queries or long-running transactions."
```

---

## 16. Thread Safety Model

All shared state is mutated without explicit locks by using .NET's concurrent primitives.

### ConcurrentDictionary — for collections

```csharp
// GetOrAdd is atomic — only one thread creates the entry under contention
var state = _pooledStates.GetOrAdd(contextName, _ => new PooledMetricsState(contextName));

// TryAdd returns true to exactly one thread — used as a "first seen" gate
if (_seenInstances[name].TryAdd(instanceId, true)) { /* physical creation */ }
```

### Interlocked — for counters

```csharp
// Atomic increment — no lost updates across N concurrent threads
Interlocked.Increment(ref _totalRents);
Interlocked.Add(ref _totalRentDurationMs, durationMs);
```

### CAS loops — for min/max

```csharp
// Compare-And-Swap loop: read → compare → swap, retry if another thread raced us
long current;
do {
    current = Interlocked.Read(ref _minRentDurationMs);
    if (durationMs >= current) break;
} while (Interlocked.CompareExchange(ref _minRentDurationMs, durationMs, current) != current);
```

### Computed properties — no synchronization needed

```csharp
// Reading two atomic longs and computing a result is safe:
// worst case is a slightly stale snapshot (off by one in a nanosecond window)
// Metrics are observational — 100% precision is not required
public long ActiveRents => TotalRents - TotalReturns;
```

---

## 17. Memory Management


### `RentTrackingInterceptor` dictionary

Without bounds, `_trackedRents` would grow indefinitely (one entry per logical rent ever). The eviction strategy:

```
Max size: 10,000 entries  (~1 MB worst case)
Evict to: 8,000 entries   (remove oldest 2,000 keys when threshold hit)

Cost per entry: ~100 bytes (string key + bool + dict overhead)
Cost at max:    ~1 MB
```

Eviction safety: old `instanceId:lease` keys will never appear again (lease is monotonically increasing), so evicting them cannot cause double-counting.

### `RingBufferActivityStore`

Fixed capacity per context type (default 500). The inner `BoundedQueue` uses a standard `Queue<T>` behind a `lock` (acceptable here — writes are infrequent and hold the lock for microseconds):

```
Enqueue:  O(1) amortized (queue resize is rare)
TakeLast: O(n) — copies array under lock
Capacity: 500 × ~120 bytes ≈ 60 KB per context type
```

### `InstanceStateStore`

Entries are removed on disposal (`TryRemoveState`). In a stable system with pool size N, `_states` holds at most N entries at any time. Memory: `N × ~200 bytes`.

---

## 18. Key Design Decisions

### Decision 1: Interceptor over `ContextInitialized` for rent tracking

`ContextInitialized` does not fire on pool reuse — only on physical construction. The command interceptor fires on every database operation, making it the only reliable rent detection point.

**Trade-off accepted:** ~10ns overhead per command for the `ConcurrentDictionary` lookup. For the first command of a new rent, ~50ns for the `TryAdd` write. All subsequent commands in the same rent are pure lookup no-ops.

### Decision 2: Instance ID deduplication over lease=0 detection

Relying on `lease=0` during `ContextInitialized` is fragile due to startup timing races. Using `instanceId` deduplication works regardless of subscription order or observer registration timing.

### Decision 3: IResettableService for return tracking

EF Core's internal pool calls `ResetState()` on every registered `IResettableService` exactly when a context is being returned. This is the only documented, stable, non-reflection-based contract for detecting pool returns.

### Decision 4: Pull-based HTTP API + OTel push

The `DiagnosticsQueryService` HTTP API requires no external dependencies and costs zero when not queried. The OTel meters layer on top for production observability pipelines without displacing the simpler API.

### Decision 5: Scoped service in EF's internal DI

`PoolResettableTrackingService` is registered via `TrackingOptionsExtension.ApplyServices()` — the only way to inject a service into EF Core's internal DI container. Scoped here means one instance per physical `DbContext` object (not per HTTP request).

```csharp
// In TrackingOptionsExtension.ApplyServices():
services.AddScoped<PoolResettableTrackingService>(...);
services.AddScoped<IResettableService>(sp =>
    sp.GetRequiredService<PoolResettableTrackingService>());
```

---

## 19. Engineering Journey — How We Got Here

> This section documents the discovery process that led to the final three-hook architecture. Each phase represents a real implementation attempt, the surprising behaviour EF Core exhibited, and the lesson that shaped the next approach. Understanding this history helps explain why each design decision in §18 exists.

The core challenge: **EF Core pooling is opaque by design.** The pool does not expose events, counters, or callbacks. Everything in this section describes the process of finding the right hooks by trial and error.

---

### Phase 1 — Initial Attempt: ContextInitialized Events

**The hypothesis:** EF Core fires diagnostic events when contexts are created and disposed. Count those events.

```csharp
public void OnContextInitialized(...)
{
    metrics.TotalRents++;   // Count every initialization as a rent
}

public void OnContextDisposed(...)
{
    metrics.TotalReturns++; // Count every disposal as a return
}
```

**What we expected:** `ContextInitialized` fires on every rent. `ContextDisposed` fires on every return. Simple subtraction gives active contexts.

**What actually happened:**

```
Warmup: ContextInitialized fires ✓
Test request 1:  [silence] ✗
Test request 2:  [silence] ✗
...
Test request 10: [silence] ✗

Result:
  TotalRents:   1  (only the initial construction!)
  TotalReturns: 0
  Active:       1  (wrong — the context has been returned to the pool)
```

**The discovery:** `ContextInitialized` only fires when the `DbContext` **constructor** runs. For pooled contexts the constructor runs once at physical creation (`Lease=0`). Every pool reuse (`Lease=1, 2, 3 …`) bypasses the constructor entirely — no event fires.

The logs that revealed this:

```
ContextInitialized: Instance=ABC123, Lease=0, Pooled=True  ← Constructor ran once
[10 test requests execute]
[NO MORE ContextInitialized EVENTS]
ResetState called: Lease=1
ResetState called: Lease=2
...
ResetState called: Lease=10
```

> **Lesson 1:** Event names are deceiving. `ContextInitialized` means "context constructor ran", not "context is being initialized for use". These are fundamentally different things under pooling.

---

### Phase 2 — Tracking by Lease Number

**The pivot:** If `ContextInitialized` only fires once, use the `Lease` property to detect reuse. `Lease=0` means first use (physical creation). `Lease=1, 2 …` means reuse.

```csharp
public void OnContextInitialized(string contextName, Guid instanceId, int lease, bool isPooled)
{
    metrics.TotalRents++;

    if (lease == 0)
        metrics.PhysicalCreations++;
}
```

**What actually happened:**

```
Startup warmup:
  ContextInitialized: Lease=1  ✗  (expected Lease=0)

Result:
  PhysicalCreations: 0  (missed the actual creation)
  TotalRents: 1
```

**The discovery:** The pool was warming up — creating the first physical instance — **before our diagnostic observer subscribed**. Timeline:

```
1. Program.cs: AddDbContextPool() called
2. EF Core:    Creates first instance for validation (Lease=0)
3.             ContextInitialized fires — nobody is listening yet
4. Our observer subscribes
5. First request: Gets existing instance (Lease=1)
6.             ContextInitialized fires — we see it, but it is already Lease=1
```

> **Lesson 2:** Initialization order is critical. Pool warmup can and does happen before the diagnostic pipeline is active.

---

### Phase 3 — Subscription Timing Fix

**The fix attempt:** Subscribe to diagnostics before the pool is created.

```csharp
// Build a temporary provider just to get the observer
var tempProvider = builder.Services.BuildServiceProvider();
var observer = tempProvider.GetRequiredService<EFCoreDiagnosticObserver>();
DiagnosticListener.AllListeners.Subscribe(observer);
tempProvider.Dispose();  // Clean up

// NOW register the pool
builder.Services.AddDbContextPool<PrimaryDbContext>(...);
```

**What actually happened:**

```
Startup:
  DiagnosticListener subscribed ✓
  AddDbContextPool() called ✓
  [No ContextInitialized event] ✗

First request:
  ContextInitialized: Lease=1 ✗ (still missing Lease=0)
```

**The discovery:** `tempProvider.Dispose()` destroyed the observer instance we had just subscribed. The subscription held a reference to a now-disposed object. The GC collected it and the subscription went silent.

> **Lesson 3:** Service provider lifetime matters. Disposing the provider disposes all services created from it, including any that have active subscriptions.

---

### Phase 4 — Persistent Subscription

**The fix:** Subscribe using the real application service provider, not a temporary one.

```csharp
var app = builder.Build();
var observer = app.Services.GetRequiredService<EFCoreDiagnosticObserver>();
DiagnosticListener.AllListeners.Subscribe(observer);
```

**Result:** `Lease=0` is now captured reliably. Physical creations track correctly.

But a new problem immediately appeared:

```
Test request 1:  [No ContextInitialized] ✗
Test request 2:  [No ContextInitialized] ✗

Result: TotalRents: 1  (still only counting the initial warmup construction)
```

**The realisation:** Even with perfect subscription timing, `ContextInitialized` **fundamentally does not fire on pool reuse**. We were solving the timing problem when the real problem was relying on the wrong event entirely.

> **Lesson 4:** Sometimes you need to step back and question your assumptions. We kept trying to fix the subscription when the real issue was the event itself.

---

### Phase 5 — The IResettableService Attempt

**The breakthrough idea:** If contexts return to the pool, there must be a "return" hook. EF Core's `IResettableService` interface is called when a pooled context is returned.

```csharp
public class PoolResettableTrackingService : IResettableService
{
    public void ResetState()
    {
        _tracker.OnContextReturnedToPool(_contextName, _instanceId, _currentLease);
        _currentLease++;
    }
}
```

**Result:**

```
ResetState called: Lease=1  ✓
ResetState called: Lease=2  ✓
...
ResetState called: Lease=10 ✓

Metrics:
  TotalReturns: 10  ✓
  TotalRents:   1   ✗  (still only the warmup construction)
  ActiveRents: -9   ✗  (negative — impossible)
```

Half the problem solved: returns tracked perfectly. Rents still not tracked.

> **Lesson 5:** Partial solutions reveal the true scope of the problem. Negative `ActiveRents` was a clear signal — we were tracking returns without tracking rents.

---

### Phase 6 — The InitializeOnce Attempt

**The idea:** `PoolResettableTrackingService` is constructed with the context. Use `InitializeOnce()` to track rents through it.

```csharp
public void InitializeOnce(string contextName, Guid instanceId, int lease)
{
    if (!_isInitialized)
    {
        _contextName = contextName;
        _instanceId  = instanceId;
        _isInitialized = true;
    }
    _tracker.OnContextRented(contextName, instanceId, lease);
}
```

**What actually happened:**

```
InitializeOnce called: Lease=1  ✓
[10 test requests execute]
[InitializeOnce NOT called again]  ✗

Result: Still only tracking the first rent
```

**The discovery:** `PoolResettableTrackingService` is scoped to the **physical DbContext instance**, not to each logical rent. It is constructed once and reused across every lease of that instance:

```
Physical instance created:
  ├─ DbContext constructor runs
  ├─ PoolResettableTrackingService constructed and injected
  └─ InitializeOnce() called  ✓

Returned to pool, then rented again:
  ├─ [No constructor — reusing instance]
  ├─ [No new PoolResettableTrackingService — reusing service]
  └─ [InitializeOnce already called — skipped]  ✗
```

> **Lesson 6:** Scoped services in pooled contexts are scoped to the physical instance lifetime, not the logical use lifetime. One instance of the service serves all leases of that physical context.

---

### Phase 7 — Instance ID Deduplication

**The creative solution:** If we cannot rely on events for physical creation detection, track unique instance IDs ourselves. Every `DbContext` has a `ContextId.InstanceId` (Guid) that is assigned at construction and **never changes** even on reuse.

```csharp
private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, bool>> _seenInstances = new();

public void OnContextInitialized(string contextName, Guid instanceId, int lease, bool isPooled)
{
    var seen = _seenInstances.GetOrAdd(contextName, _ => new ConcurrentDictionary<Guid, bool>());

    if (seen.TryAdd(instanceId, true))   // returns true only for the first appearance
    {
        metric.PhysicalCreations++;
    }
}
```

**Result:**

```
Request 1: InstanceId=ABC123 → TryAdd returns true  → PhysicalCreations++  ✓
Request 2: InstanceId=ABC123 → TryAdd returns false → detected as reuse    ✓
```

This approach is resilient to subscription timing: even if `Lease=0` is missed during warmup, the first time any event arrives for a new `instanceId` it is counted exactly once.

**But rents are still not tracked:**

```
PhysicalCreations: 1  ✓
TotalRents:        1  ✗  (still only the warmup construction)
```

> **Lesson 7:** Sometimes the right solution is to track state yourself rather than relying on framework events. The instance ID is always available — we just needed to use it.

---

### Phase 8 — The Interceptor Epiphany

**The final breakthrough:** Stop looking for a lifecycle event and look for something that **always happens during a rent**.

Every pooled context rent, without exception, executes at least one database command. The command interceptor pipeline fires on every operation — `SELECT`, `INSERT`, `UPDATE`, `DELETE`. It is available, documented, stable, and requires no DbContext modification.

```csharp
public class RentTrackingInterceptor : DbCommandInterceptor
{
    private readonly ConcurrentDictionary<string, bool> _trackedRents = new();

    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result)
    {
        TrackIfNeeded(eventData.Context);
        return base.ReaderExecuting(command, eventData, result);
    }

    private void TrackIfNeeded(DbContext? context)
    {
        if (context is null) return;

        // rentKey is unique per (physical instance, logical lease)
        var rentKey = $"{context.ContextId.InstanceId}:{context.ContextId.Lease}";

        if (_trackedRents.TryAdd(rentKey, true))  // first command of this rent?
        {
            _tracker.OnContextRented(context.GetType().Name,
                                     context.ContextId.InstanceId,
                                     context.ContextId.Lease);
        }
        // All subsequent commands in the same rent: TryAdd returns false → no-op
    }
}
```

The rent key table for a single physical instance across 11 requests:

| Lease | Rent Key | `TryAdd` result | Action |
|---|---|---|---|
| 1 | `ABC123:1` | `true` | Track rent ✓ |
| 2 | `ABC123:2` | `true` | Track rent ✓ |
| 3 | `ABC123:3` | `true` | Track rent ✓ |
| 3 (2nd command) | `ABC123:3` | `false` | No-op ✓ |
| … | … | … | … |
| 11 | `ABC123:11` | `true` | Track rent ✓ |

**Final result:**

```
PhysicalCreations: 1   ✓
TotalRents:        11  ✓
TotalReturns:      11  ✓
ActiveRents:       0   ✓
ReuseRatio:        11× ✓
ReturnRate:        100% ✓
```

> **Lesson 8:** The best hook point is not always the obvious one. Intercepting database commands is more reliable than listening to context lifecycle events because commands are the actual unit of work — they are guaranteed to happen during every rent.

---

### Summary — Eight Lessons

| # | Lesson |
|---|---|
| 1 | `ContextInitialized` means "constructor ran", not "context is being used". They are different things under pooling. |
| 2 | Pool warmup can happen before diagnostic observers subscribe. Startup order matters. |
| 3 | Disposing a service provider disposes all services created from it, breaking any active subscriptions. |
| 4 | Fixing the symptom (timing) when the root cause is a wrong assumption (wrong event) leads nowhere. |
| 5 | Partial solutions reveal the full problem scope. Negative `ActiveRents` showed the true gap. |
| 6 | Services scoped to a physical pooled DbContext instance serve all its logical leases, not just one. |
| 7 | Track state yourself when framework events are insufficient. `ContextId.InstanceId` is always available. |
| 8 | The best instrumentation hook is the one that is guaranteed to fire during the unit of work — database commands, not lifecycle events. |

---

## 20. Validating Your Installation

### Step 1: Check services are registered

```csharp
// Startup validation (development only)
var tracker    = app.Services.GetService<DbContextLifeCycleTracker>();
var interceptor = app.Services.GetService<RentTrackingInterceptor>();
var observer    = app.Services.GetService<EFCoreDiagnosticObserver>();

Debug.Assert(tracker    is not null, "DbContextLifeCycleTracker not registered");
Debug.Assert(interceptor is not null, "RentTrackingInterceptor not registered");
Debug.Assert(observer   is not null, "EFCoreDiagnosticObserver not registered");
```

### Step 2: Trigger pool activity

```bash
for i in {1..10}; do curl -s http://localhost:5000/api/users > /dev/null; done
```

### Step 3: Verify metrics

```bash
curl http://localhost:5000/diagnostics/summary | jq '.pooled[0]'
```

| Metric | Expected | Problem if not |
|---|---|---|
| `physicalCreations` | 1–10 (pool warming up) | 0 = observer not subscribed |
| `totalRents` | Equals number of requests | 0 = interceptor not registered |
| `totalReturns` | Should equal `totalRents` when idle | Mismatch = resettable service not wired |
| `activeRents` | 0 at rest | > 0 at rest = slow disposal |
| `leakedContexts` | 0 | > 0 = real leak |
| `reuseRatio` | > 1.0 after first reuse | 1.0 = pool not reusing |

### Step 4: Simulate a leak (dev only)

```csharp
// DO NOT use in production — intentionally leaks a context
[HttpGet("test/leak")]
public async Task<IActionResult> SimulateLeak([FromServices] AppDbContext ctx)
{
    // Deliberately NOT using `using` or disposing ctx
    var count = await ctx.Users.CountAsync();
    return Ok(new { count, warning = "Context leaked intentionally for testing" });
}
```

After calling this and waiting for GC, `leakedContexts` should increment.

---

## 21. Troubleshooting

### `totalRents` is 0 or always equals `physicalCreations`

**Cause:** `RentTrackingInterceptor` is not attached.  
**Fix:** Ensure `UseObservability<TContext>(sp, poolSize)` is called inside the `AddDbContextPool` lambda, with `sp` as the lambda parameter (not a captured reference from before `Build()`).

```csharp
// ✅ Correct
services.AddDbContextPool<AppDbContext>((sp, options) =>
    options.UseObservability<AppDbContext>(sp, poolSize: 128));

// ❌ Wrong — sp captured before the DI container is built
var earlyProvider = someReference;
services.AddDbContextPool<AppDbContext>((_, options) =>
    options.UseObservability<AppDbContext>(earlyProvider, poolSize: 128));
```

### `physicalCreations` is 0

**Cause:** `UseEFCoreObservability()` was not called after `builder.Build()`.  
**Fix:**

```csharp
var app = builder.Build();
app.UseEFCoreObservability();  // ← must be here, not before Build()
```

### `leakedContexts` is non-zero with no actual leaks

**Cause:** `PoolResettableTrackingService.Configure()` was not called before disposal, meaning the context was GC'd without a proper rental cycle. Enable `EnableDiagnosticLogging = true` temporarily and look for `[EFObservability] ResetState called on uninitialized tracking service` in the logs.

### `reuseRatio` is always 1.0

**Not a bug** for very low-traffic or single-request-at-a-time apps. Under real concurrent load the ratio should climb significantly (100+ for high-traffic endpoints).

### `poolUtilization` is always 0

**Cause:** Pool size was never registered with the tracker.  
**Fix:** Ensure the `poolSize` parameter in `UseObservability<TContext>(sp, poolSize: N)` matches the `poolSize` in `AddDbContextPool<TContext>(..., poolSize: N)`.

### OpenTelemetry metrics not appearing in Prometheus

Check that `AddEFCoreInstrumentation()` is called **before** the exporter, and that `app.MapPrometheusScrapingEndpoint()` is called and the `/metrics` endpoint is accessible. Observable gauges only appear in the scrape output after the first metric value is recorded — make sure at least one request has been handled.

---

*EFCore.Observability Reference & Integration Guide — v1.0 · 21 sections*