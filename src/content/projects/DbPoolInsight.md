---
title: "EFCore.Observability — Core Library Reference"
description: "Architecture, component breakdown, data flow algorithms, metrics catalog, thread safety, and memory management for the EFCore.Observability library."
date: 2026-02-27
tech: [".NET", "EF Core", "C#", "OpenTelemetry" ,"Prometheus", "Grafana" ]
tags: ["efcore",  "dbcontext", "pooling", "metrics" ,"observability","OpenTelemetry" ,"Prometheus", "Grafana"]
featured: true
draft: false
---
# EFCore.Observability — Core Library Reference

> **Version:** 1.0 · **Status:** Production Ready · **Target:** .NET 6+ / EF Core 6+

### EFCore.Observability — Integration & Setup Guide
  ([Github Project](https://github.com/khaledibrahim1015/DbPoolInsight))
## Reference
 - ([part-1-pooled-lifetime-di](/khaledibrahim.dev/articles/part-1-pooled-lifetime-di))
 - ([part-2-efcore-pool-tracking](/khaledibrahim.dev/articles/part-2-efcore-pool-tracking)) 
 - ([part-3-dotnet-diagnostics](/khaledibrahim.dev/articles/part-3-dotnet-diagnostics))

## Nuget Packages
  - ([ EFCore.Observability](https://www.nuget.org/packages/EFCore.Observability))
  - ([ EFCore.Observability.Core](https://www.nuget.org/packages/EFCore.Observability.Core))
  - ([ EFCore.Observability.OpenTelemetry ](https://www.nuget.org/packages/EFCore.Observability.OpenTelemetry))
---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Component Breakdown](#3-component-breakdown)
   - [EFCoreDiagnosticObserver](#31-efcorediagnosticobserver)
   - [RentTrackingInterceptor](#32-renttrackinginterceptor)
   - [PoolResettableTrackingService](#33-poolresettabletrackingservice)
   - [DbContextLifeCycleTracker](#34-dbcontextlifecycletracker)
   - [InstanceStateStore](#35-instancestatestore)
   - [PoolOverflowDetector](#36-pooloverflowdetector)
   - [RingBufferActivityStore](#37-ringbufferactivitystore)
   - [Metrics State Objects](#38-metrics-state-objects)
   - [OpenTelemetry Meters](#39-opentelemetry-meters)
4. [Data Flow & Algorithms](#4-data-flow--algorithms)
   - [Physical Creation Detection](#41-physical-creation-detection)
   - [Rent Tracking Flow](#42-rent-tracking-flow)
   - [Return Tracking Flow](#43-return-tracking-flow)
   - [Disposal Classification Algorithm](#44-disposal-classification-algorithm)
5. [Metrics Catalog](#5-metrics-catalog)
6. [Thread Safety Model](#6-thread-safety-model)
7. [Memory Management](#7-memory-management)
8. [Key Design Decisions](#8-key-design-decisions)

---

## 1. Overview

EFCore.Observability is a **zero-invasion monitoring layer** for EF Core's DbContext pooling feature. It answers questions that the framework itself leaves opaque:

- Is the pool actually being reused (or are we thrashing)?
- Are contexts leaking — rented but never returned?
- Is the pool sized correctly for the actual load?
- How long are contexts being held per request?

### Why tracking is non-trivial

EF Core pooling deliberately avoids re-running the DbContext constructor on each reuse. This means the obvious hook — `ContextInitialized` — only fires once per **physical instance**, not once per **logical rent**. The core problem this library solves is bridging that gap reliably.

```
Without pooling:       new DbContext()  →  use  →  Dispose()   ← constructor fires every time
With pooling:          new DbContext()  →  use  →  ResetState() →  pool  →  use  →  ResetState() ...
                            ↑                            ↑
                  constructor fires once          only hook available per return
```

---

## 2. Architecture

### High-Level Component Map

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Application Layer                              │
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
         │                      │                          │
         └──────────────────────┼──────────────────────────┘
                                ▼
                  ┌─────────────────────────────┐
                  │   DbContextLifeCycleTracker  │  ← Singleton, central hub
                  │                             │
                  │  ┌─────────────────────┐    │
                  │  │  InstanceStateStore  │    │
                  │  │  • _states          │    │
                  │  │  • _seenInstances   │    │
                  │  │  • _rentedInstances │    │
                  │  └─────────────────────┘    │
                  │  ┌─────────────────────┐    │
                  │  │  PooledMetricsState  │    │
                  │  │  (per context type) │    │
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

### Lifetimes at a Glance

| Component | DI Lifetime | Reason |
|---|---|---|
| `DbContextLifeCycleTracker` | Singleton | Owns all metrics state across the app |
| `EFCoreDiagnosticObserver` | Singleton | Subscribes once to `DiagnosticListener` |
| `RentTrackingInterceptor` | Singleton | Stateless per-command hook (bounded dict) |
| `PoolResettableTrackingService` | Scoped (EF internal DI) | One instance per physical DbContext |
| `DiagnosticsQueryService` | Singleton | Read-only façade |
| `EFCorePoolMeter` / `EFCoreStandardMeter` | Singleton | OTel instrument lifetime |

> ⚠️ **Scoped ≠ per-request here.** EF Core's internal DI scopes services to the **physical instance lifetime**, not the HTTP request lifetime. A `PoolResettableTrackingService` created for `ContextId = ABC-123` lives as long as that physical DbContext lives in the pool — which may span hundreds of requests.

---

## 3. Component Breakdown

### 3.1 EFCoreDiagnosticObserver

**File:** `Observers/EFCoreDiagnosticObserver.cs`  
**Implements:** `IObserver<DiagnosticListener>`

This is the entry point for **physical lifecycle events**. It subscribes to EF Core's `DiagnosticListener` at startup (after `app.Build()`) and handles two events:

| Event | When it fires | What we do |
|---|---|---|
| `ContextInitialized` | DbContext **constructor** ran | Detect physical creation; wire up `PoolResettableTrackingService` |
| `ContextDisposed` | Physical DbContext **destroyed** | Classify as leak, overflow, or normal disposal |

```csharp
// Inner class pattern: outer observer finds the right DiagnosticListener,
// inner observer handles individual key-value events.
public void OnNext(DiagnosticListener listener)
{
    if (listener.Name == "Microsoft.EntityFrameworkCore")
        listener.Subscribe(new EFCoreEventObserver(this));
}
```

**Important nuance — `ContextInitialized` fires on reuse too.**  
When a pooled context is returned and re-rented, `ContextInitialized` fires again (the event payload is replayed). The observer passes this through to `IContextMetricsCollector.OnContextInitialized`, which uses **instance ID deduplication** (see §4.1) to avoid double-counting physical creations.

**`PoolResettableTrackingService` wiring:**  
On every `ContextInitialized` for a pooled context, the observer retrieves the `PoolResettableTrackingService` from EF's internal service provider and calls `Configure(name, instanceId, lease)`. This keeps `_currentLease` in sync for accurate return tracking.

```csharp
var svc = context.GetService<PoolResettableTrackingService>();
svc?.Configure(name, instanceId, lease);
```

**IsPooled detection:**
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

---

### 3.2 RentTrackingInterceptor

**File:** `Interceptors/RentTrackingInterceptor.cs`  
**Extends:** `DbCommandInterceptor`

This is the **core innovation** of the library. Because `ContextInitialized` does not fire on each pool reuse, we hook into the **command pipeline** instead. Every SQL command (SELECT, INSERT, UPDATE, DELETE) passes through this interceptor.

**The rent key:**
```csharp
var rentKey = $"{instanceId}:{lease}";
// e.g. "a3f2b1c0-...:7"
// Unique per (physical instance, logical rent cycle)
```

**First-command-per-rent detection:**
```csharp
private void TrackIfNeeded(DbContext? context)
{
    if (context is null || !IsPooled(context)) return;

    var rentKey = $"{context.ContextId.InstanceId}:{context.ContextId.Lease}";

    if (_trackedRents.TryAdd(rentKey, true))      // atomic, lock-free
    {
        _collector.OnContextRented(...);           // only fires once per rent
        MaybeEvict();
    }
    // Subsequent commands in the same rent: TryAdd returns false → no-op
}
```

**All overrides covered:**
```
ReaderExecuting        / ReaderExecutingAsync         ← SELECT queries
ScalarExecuting        / ScalarExecutingAsync         ← scalar commands
NonQueryExecuting      / NonQueryExecutingAsync       ← INSERT/UPDATE/DELETE
```

**Memory bounding (eviction):**
```csharp
private const int MaxTrackedRents = 10_000;
private const int EvictTo         = 8_000;

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

---

### 3.3 PoolResettableTrackingService

**File:** `Services/PoolResettableTrackingService.cs`  
**Implements:** `IResettableService` (EF Core internal interface)

EF Core calls `ResetState()` automatically on every `IResettableService` registered in its internal DI **when a pooled context is returned to the pool**. This is the only reliable way to detect pool returns.

```csharp
public void ResetState()
{
    if (!_isInitialized || _contextName is null) return;

    _collector.OnContextReturnedToPool(_contextName, _instanceId, _currentLease);
    _currentLease++;    // keep in sync for next rent
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

---

### 3.4 DbContextLifeCycleTracker

**File:** `Services/DbContextLifeCycleTracker.cs`  
**Implements:** `IContextMetricsCollector`, `IContextMetricsProvider`

The **central coordinator**. All three tracking components funnel events here. It owns:

- `_pooledStates`: `ConcurrentDictionary<string, PooledMetricsState>` — one entry per pooled context type name
- `_standardStates`: `ConcurrentDictionary<string, StandardMetricsState>` — one entry per standard context type name
- `_instanceStore`: `InstanceStateStore` — per-instance mutable state
- `_activityStore`: `IInstanceActivityStore` — ring buffer of recent rent/lifetime records

**Key method responsibilities:**

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

### 3.5 InstanceStateStore

**File:** `Internal/InstanceStateStore.cs`

Thread-safe in-memory store for per-instance mutable state. Uses three separate `ConcurrentDictionary` structures:

| Dictionary | Key | Value | Purpose |
|---|---|---|---|
| `_states` | `Guid instanceId` | `InstanceState` | Full state for each live instance |
| `_seenInstances` | `contextName → Set<Guid>` | `bool` | Detect if instance was ever seen (physical creation guard) |
| `_rentedInstances` | `contextName → Set<Guid>` | `bool` | Instances currently rented (for future ActiveRents validation) |

**`InstanceState` fields:**
```csharp
string  ContextName
bool    IsPooled
int     CurrentLease
DateTime CreatedAt
DateTime LastRented
DateTime? LastReturned
bool    WasReturnedToPool    // ← key flag for leak detection
bool    IsOverflow           // ← set once at creation if pool was already full
```

---

### 3.6 PoolOverflowDetector

**File:** `Internal/PoolOverflowDetector.cs`

Pure static logic for classifying a disposal event. Called from `OnPooledContextDisposed`.

```csharp
public static DisposalClassification Classify(
    InstanceState state,
    long physicalCreations,
    long physicalDisposals,
    int maxPoolSize)
```

**Decision tree:**

```
Was WasReturnedToPool = true?
    YES → OverflowAfterReturn
          (Context returned cleanly; pool was full so EF disposed it)

Was IsOverflow = true?
    YES → OverflowCreation
          (Instance was created when pool was already at capacity)

Is (physicalCreations - physicalDisposals) > maxPoolSize?
    YES → OverflowCapacity
          (Race condition: pool went over capacity during this disposal window)

Otherwise → Leaked
            (Context rented, never returned, eventually GC'd)
```

| Classification | Meaning | Action |
|---|---|---|
| `OverflowAfterReturn` | Normal — pool full, EF disposed the extra | Increment `OverflowDisposals` |
| `OverflowCreation` | Normal — instance was always overflow | Increment `OverflowDisposals` |
| `OverflowCapacity` | Normal — race condition window | Increment `OverflowDisposals` |
| `Leaked` | **Problem** — context never returned | Increment `LeakedContexts` ⚠️ |

---

### 3.7 RingBufferActivityStore

**File:** `Internal/RingBufferActivityStore.cs`  
**Implements:** `IInstanceActivityStore`

Bounded activity log using a per-context-type circular queue. When capacity is reached, the **oldest entry is dropped automatically**.

```
Capacity: 500 (default, configurable via ObservabilityOptions)

Enqueue(activity):
    if _inner.Count >= _capacity → Dequeue()   ← drop oldest
    _inner.Enqueue(activity)                    ← add newest

TakeLast(n):
    arr = _inner.ToArray()
    return arr[Max(0, len-n)..]
```

Each `InstanceActivity` record contains:

```csharp
string   InstanceId    // first 8 chars of GUID for readability
int      Lease
DateTime StartedAt
DateTime EndedAt
long     DurationMs
```

---

### 3.8 Metrics State Objects

#### `PooledMetricsState`

Mutable counters for a single pooled context type. All mutations use `Interlocked` for lock-free thread safety.

```csharp
long _physicalCreations      // Interlocked.Increment
long _physicalDisposals      // Interlocked.Increment
long _totalRents             // Interlocked.Increment
long _totalReturns           // Interlocked.Increment
long _overflowDisposals      // Interlocked.Increment
long _overflowCreations      // Interlocked.Increment
long _leakedContexts         // Interlocked.Increment
long _totalRentDurationMs    // Interlocked.Add
long _minRentDurationMs      // CAS loop (compare-and-swap)
long _maxRentDurationMs      // CAS loop
```

**Min/Max with CAS (no lock needed):**
```csharp
// Atomic min update — same pattern for max
long currentMin;
do {
    currentMin = Interlocked.Read(ref _minRentDurationMs);
    if (durationMs >= currentMin) break;          // not a new min, done
} while (Interlocked.CompareExchange(
    ref _minRentDurationMs, durationMs, currentMin) != currentMin);
// If another thread changed _min between our read and our swap, CAS fails and we retry
```

**`Snapshot()` produces an immutable `PooledContextMetrics` record** with all computed properties:

```csharp
// Computed properties on PooledContextMetrics (not stored, calculated on read):
PhysicalInPool   = PhysicalCreations - PhysicalDisposals
AvailableInPool  = PhysicalInPool - ActiveRents
RoomToGrow       = MaxPoolSize - PhysicalInPool
ActiveRents      = TotalRents - TotalReturns
PoolUtilization  = (PhysicalInPool / MaxPoolSize) * 100
ReuseRatio       = TotalRents / PhysicalCreations
ReturnRate       = (TotalReturns / TotalRents) * 100
AvgRentDurationMs = TotalRentDurationMs / TotalReturns
```

#### `StandardMetricsState`

Simpler version for non-pooled contexts. Tracks `TotalCreations`, `TotalDisposals`, and lifetime min/max/total with the same `Interlocked` + CAS pattern.

---

### 3.9 OpenTelemetry Meters

Two meters expose metrics to any OTel-compatible backend (Prometheus, Grafana, Datadog, etc.).

#### `EFCorePoolMeter` — meter name: `EFCore.Pool`

All instruments are **observable** (polled by the OTel SDK, not pushed). Each instrument iterates `IContextMetricsProvider.GetAllPooledMetrics()` and yields one `Measurement<T>` per context type, tagged with `db.context = "ContextTypeName"`.

```csharp
// Pattern for all instruments:
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
```

**Instruments exposed:**

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

#### `EFCoreStandardMeter` — meter name: `EFCore.Standard`

Same pattern for non-pooled contexts. Tag: `db.context`.

| Instrument | Type |
|---|---|
| `efcore.standard.active` | Gauge |
| `efcore.standard.leaks` | Gauge |
| `efcore.standard.duration.avg_ms` | Gauge |
| `efcore.standard.duration.min_ms` | Gauge |
| `efcore.standard.duration.max_ms` | Gauge |
| `efcore.standard.creations.total` | Counter |
| `efcore.standard.disposals.total` | Counter |

---

## 4. Data Flow & Algorithms

### 4.1 Physical Creation Detection

**Problem:** `ContextInitialized` fires again on every pool reuse. Naively incrementing `PhysicalCreations` there would double/triple count.

**Solution:** Instance ID deduplication via `_seenInstances`.

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

### 4.2 Rent Tracking Flow

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

---

### 4.3 Return Tracking Flow

```
`using` block ends (or Dispose() called)
        │
        ▼
  EF Core: IsPooled? MaxPoolSize not reached?
        │
   ┌────┴────────────────┐
  YES (pool return)     NO (physical dispose)
   │                         │
   ▼                         ▼
EF Core calls               ContextDisposed event fires
ResetState() on all         → EFCoreDiagnosticObserver
IResettableService          → HandleContextDisposed()
instances                   → OnPooledContextDisposed()
   │                         → PoolOverflowDetector.Classify()
   ▼
PoolResettableTrackingService.ResetState()
   │
   ▼
OnContextReturnedToPool(name, instanceId, currentLease)
   │
   ▼
  IncrementTotalReturns()
  InstanceState.WasReturnedToPool = true
  InstanceState.LastReturned = now
  RecordRentDuration(now - LastRented)
  _currentLease++
```

---

### 4.4 Disposal Classification Algorithm

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

## 5. Metrics Catalog

### Pooled Context Metrics

| Metric | Formula / Source | Healthy Value |
|---|---|---|
| `PhysicalCreations` | Counter — incremented on first seen `instanceId` | Grows slowly, then stable |
| `PhysicalDisposals` | Counter — incremented on `ContextDisposed` | 0 in steady state |
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
| `MaxRentDurationMs` | CAS-tracked max | Alert if outliers |

### Standard Context Metrics

| Metric | Formula / Source | Healthy Value |
|---|---|---|
| `TotalCreations` | Counter — `ContextInitialized` | Grows with requests |
| `TotalDisposals` | Counter — `ContextDisposed` | Should equal `TotalCreations` eventually |
| `ActiveContexts` | `TotalCreations - TotalDisposals` | 0 when idle |
| `PotentialLeaks` | `ActiveContexts` after long idle | **0** |
| `AvgLifetimeMs` | `TotalLifetimeMs / TotalDisposals` | Short (< request duration) |

---

## 6. Thread Safety Model

All shared state is modified without explicit locks by using .NET's concurrent primitives.

### `ConcurrentDictionary` — for collections
```csharp
// GetOrAdd is atomic — only one thread creates the entry even under contention
var state = _pooledStates.GetOrAdd(contextName, _ => new PooledMetricsState(contextName));

// TryAdd returns true to exactly one thread — used as a "first seen" gate
if (_seenInstances[name].TryAdd(instanceId, true)) { /* physical creation */ }
```

### `Interlocked` — for counters
```csharp
// Atomic increment — no lost updates even with N concurrent threads
Interlocked.Increment(ref _totalRents);
Interlocked.Add(ref _totalRentDurationMs, durationMs);
```

### CAS loops — for min/max
```csharp
// Compare-And-Swap loop: read → compare → swap, retry if another thread changed the value
long current;
do {
    current = Interlocked.Read(ref _minRentDurationMs);
    if (durationMs >= current) break;
} while (Interlocked.CompareExchange(ref _minRentDurationMs, durationMs, current) != current);
```

### Computed properties — no synchronization needed
```csharp
// Reading two atomic longs and computing a result is safe because:
// • Worst case: slightly stale snapshot (off by one in a nanosecond window)
// • Metrics are observational — 100% precision is not required
public long ActiveRents => TotalRents - TotalReturns;
```

### Concurrency characteristics under load

| Threads | Ops/sec (estimated) | Contention |
|---|---|---|
| 1 | 100,000 | 0% |
| 4 | ~380,000 | ~5% |
| 8 | ~720,000 | ~8% |
| 16 | ~1,200,000 | ~12% |

---

## 7. Memory Management

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

## 8. Key Design Decisions

### Decision 1: Interceptor over `ContextInitialized` for rent tracking

`ContextInitialized` does not fire on pool reuse — only on physical construction. The command interceptor fires on **every database operation**, making it the only reliable rent detection point.

**Trade-off accepted:** Slight overhead per command (~10ns for the `ConcurrentDictionary` lookup). For the first command of a new rent, there's also a `TryAdd` write (~50ns). All subsequent commands in the same rent are pure lookup no-ops.

### Decision 2: Instance ID deduplication over lease=0 detection

Relying on catching `lease=0` during `ContextInitialized` is fragile due to startup timing races (the pool may warm up before the observer subscribes). Using `instanceId` deduplication works regardless of subscription order.

### Decision 3: `IResettableService` for return tracking

EF Core's internal pool implementation calls `ResetState()` on every registered `IResettableService` exactly when a context is being returned. This is the **only documented, stable contract** for detecting pool returns.

### Decision 4: Pull-based metrics API + OTel push

The `DiagnosticsQueryService` HTTP API requires no external dependencies and costs zero when not queried. The OTel meters layer on top for production observability pipelines without removing the simpler API.

### Decision 5: Scoped service in EF's internal DI for `PoolResettableTrackingService`

Registered via `TrackingOptionsExtension.ApplyServices()` — the only way to inject a service into EF Core's internal DI container. Scoped here means one instance per physical DbContext object (not per HTTP request).

```csharp
// In TrackingOptionsExtension.ApplyServices():
services.AddScoped<PoolResettableTrackingService>(...);
services.AddScoped<IResettableService>(sp =>
    sp.GetRequiredService<PoolResettableTrackingService>());
```

---

*EFCore.Observability Core Reference — v1.0*