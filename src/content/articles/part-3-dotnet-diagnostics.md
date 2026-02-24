---
title: "Going Beyond Singleton, Scoped, and Transient — Part 3: Observing Your Pool with .NET Diagnostics"
description: "A practical guide to the .NET diagnostics ecosystem — DiagnosticListener, System.Diagnostics.Metrics, and EF Core Interceptors — and how to use them to monitor your pooled services in production."
date: 2026-01-17
tags: [dotnet, diagnostics, observability, efcore, opentelemetry, prometheus, aspnetcore]
draft: false
---

### Going Beyond Singleton, Scoped, and Transient — Part 3: Observing Your Pool with .NET Diagnostics

In [Part 1](/khaledibrahim.dev/articles/part-1-pooled-lifetime-di) we built a general-purpose pooled lifetime for .NET DI. In [Part 2](/khaledibrahim.dev/articles/part-2-efcore-pool-tracking) we explored EF Core's internal service provider and how to hook into the `DbContext` pool return lifecycle using `IResettableService` and `IDbContextOptionsExtension`.

Now that we have a pool — we need to **observe** it. How many instances are in the pool right now? How long does a typical lease last? Are we hitting the pool ceiling and discarding instances instead of returning them?

This post is a practical guide to the .NET diagnostics ecosystem, covering the tools available, when to use each, and how to combine them into a production-ready observability setup.

---

## The .NET Diagnostics Landscape

.NET provides several complementary approaches to monitoring and diagnostics:

```
┌─────────────────────────────────────────────────────────────────┐
│                    .NET Diagnostics Stack                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────┐  ┌─────────────────────────────────┐ │
│  │  DiagnosticListener  │  │  System.Diagnostics.Metrics     │ │
│  │  (Event Tracing)     │  │  (OpenTelemetry-compatible)     │ │
│  │  • Low overhead      │  │  • Modern standard              │ │
│  │  • Event-based       │  │  • Built-in aggregation         │ │
│  │  • Detailed events   │  │  • Prometheus/OTLP export       │ │
│  └──────────────────────┘  └─────────────────────────────────┘ │
│                                                                  │
│  ┌──────────────────────┐  ┌─────────────────────────────────┐ │
│  │  EF Core             │  │  Performance Counters           │ │
│  │  Interceptors        │  │  (Windows Only, Legacy)         │ │
│  │  • Full control      │  │  • OS-level                     │ │
│  │  • Modify behavior   │  │  • Historical data              │ │
│  │  • Sync and async    │  │  • Heavy overhead               │ │
│  └──────────────────────┘  └─────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                            ↓
            ┌───────────────────────────────┐
            │   Observability Backends      │
            │  • Prometheus + Grafana       │
            │  • OpenTelemetry Collector    │
            │  • Azure Monitor              │
            │  • DataDog                    │
            └───────────────────────────────┘
```

Each approach has a distinct purpose, different overhead characteristics, and different integration points. Let's work through them one by one.

---

## DiagnosticSource & DiagnosticListener

### What it is

`DiagnosticSource` is the event publisher; `DiagnosticListener` is the subscriber. Together they form .NET's built-in event tracing system, and they're designed for near-zero overhead when nothing is subscribed.

The pattern is used heavily inside the .NET runtime itself — EF Core, `HttpClient`, ASP.NET Core, and others all publish events through it. Consuming those events is purely opt-in.

```
EF Core Library
  ↓
_diagnosticSource.Write("ContextInitialized", new { Context = this })
  ↓
DiagnosticListener.AllListeners
  ↓
Your Observer
  public void OnNext(KeyValuePair<string, object?> evt) { ... }
```

### Key EF Core events

| Event Name | When Fired | Key Data |
|---|---|---|
| `Microsoft.EntityFrameworkCore.Infrastructure.ContextInitialized` | DbContext created | Context, Options |
| `Microsoft.EntityFrameworkCore.Infrastructure.ContextDisposed` | DbContext disposed | Context |
| `Microsoft.EntityFrameworkCore.Database.Connection.ConnectionOpening` | Before connection opens | ConnectionId, Connection |
| `Microsoft.EntityFrameworkCore.Database.Connection.ConnectionOpened` | After connection opens | ConnectionId, Duration |
| `Microsoft.EntityFrameworkCore.Database.Connection.ConnectionError` | Connection fails | ConnectionId, Exception |
| `Microsoft.EntityFrameworkCore.Database.Command.CommandExecuting` | Before SQL executes | CommandId, Command, Parameters |
| `Microsoft.EntityFrameworkCore.Database.Command.CommandExecuted` | After SQL executes | CommandId, Duration, Result |

### Implementation pattern

Subscribing to EF Core events requires two levels of observer — one that watches for `DiagnosticListener` instances as they're created, and one that handles the specific events within EF Core's listener:

```csharp
public class EFCoreDiagnosticObserver : IObserver<DiagnosticListener>
{
    // Step 1: Subscribe to ALL DiagnosticListeners as they're created
    public void OnNext(DiagnosticListener listener)
    {
        if (listener.Name == "Microsoft.EntityFrameworkCore")
        {
            // Step 2: Subscribe to EF Core's specific events
            listener.Subscribe(new EFCoreEventObserver());
        }
    }

    public void OnCompleted() { }
    public void OnError(Exception error) { }

    private class EFCoreEventObserver : IObserver<KeyValuePair<string, object?>>
    {
        public void OnNext(KeyValuePair<string, object?> evt)
        {
            // Step 3: Handle specific events
            switch (evt.Key)
            {
                case "Microsoft.EntityFrameworkCore.Infrastructure.ContextInitialized":
                    HandleContextInitialized(evt.Value);
                    break;
                case "Microsoft.EntityFrameworkCore.Database.Command.CommandExecuted":
                    HandleCommandExecuted(evt.Value);
                    break;
            }
        }

        public void OnCompleted() { }
        public void OnError(Exception error) { }
    }
}
```

In an ASP.NET Core app, you'd typically activate the subscription through a hosted service so it starts and stops cleanly with the application lifetime:

```csharp
public class DiagnosticListenerHostedService : IHostedService
{
    private readonly EFCoreDiagnosticObserver _observer;
    private IDisposable? _subscription;

    public DiagnosticListenerHostedService(EFCoreDiagnosticObserver observer)
    {
        _observer = observer;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _subscription = DiagnosticListener.AllListeners.Subscribe(_observer);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _subscription?.Dispose();
        return Task.CompletedTask;
    }
}
```

### When to use DiagnosticListener

DiagnosticListener shines when you need detailed, real-time event data about individual operations — for example, correlating a specific context initialization with the connections and queries it produces, or building a custom monitoring dashboard. It works on all platforms and versions of .NET, and has essentially zero overhead when not subscribed.

Its main limitation is that it's event-based, not metric-based. You get raw events, not aggregated histograms or percentiles. If you want those, you'll need to aggregate manually — or reach for the next tool.

---

## System.Diagnostics.Metrics

### What it is

Introduced in .NET 6, `System.Diagnostics.Metrics` is the modern .NET observability standard. It's designed to be fully compatible with OpenTelemetry and to integrate directly with Prometheus, Grafana, Azure Monitor, and other metric backends.

Where `DiagnosticListener` gives you individual events, `System.Diagnostics.Metrics` gives you aggregated time-series data — counters, histograms, gauges — with built-in support for tags and automatic export.

### Core concepts

```
Meter (the factory)
  ↓
Instruments (the metrics)
  ├── Counter         — monotonically increasing (total requests, total errors)
  ├── Histogram       — distribution of values (request duration, lease lifetime)
  ├── ObservableGauge — point-in-time value (current pool size, memory used)
  └── ObservableCounter — current rate (requests/sec)
  ↓
MeterListener or OpenTelemetry SDK
  ↓
Exporters (Prometheus, OTLP, Azure Monitor...)
```

### Instrument types in practice

A **Counter** is monotonically increasing — it only ever goes up. Use it for totals like "contexts created" or "queries executed":

```csharp
var meter = new Meter("MyApp.Database", "1.0.0");

var contextsCreated = meter.CreateCounter<long>(
    name: "db.context.created",
    unit: "{context}",
    description: "Total DbContext instances created");

// Record with tags for slicing in dashboards
contextsCreated.Add(1,
    new KeyValuePair<string, object?>("context.type", "PrimaryDbContext"));
```

A **Histogram** records the distribution of values. Use it for durations and sizes:

```csharp
var contextLifetime = meter.CreateHistogram<double>(
    name: "db.context.lifetime",
    unit: "ms",
    description: "DbContext lease duration distribution");

contextLifetime.Record(45.2,
    new KeyValuePair<string, object?>("context.type", "PrimaryDbContext"));

// Prometheus output (automatically bucketed):
// db_context_lifetime_bucket{le="10"} 245
// db_context_lifetime_bucket{le="50"} 892
// db_context_lifetime_bucket{le="100"} 1401
// db_context_lifetime_sum 45632
// db_context_lifetime_count 1523
```

An **ObservableGauge** reports the current value of something at query time. Use it for pool sizes, queue depths, and other point-in-time state:

```csharp
var currentPoolSize = meter.CreateObservableGauge<int>(
    name: "db.connection.pool.size",
    observeValue: () => GetCurrentPoolSize(),
    unit: "{connection}",
    description: "Current connection pool size");

// No manual recording needed — the MeterListener calls observeValue() automatically
```

### Semantic conventions

Following [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/database/) ensures your metrics are consistent with what other tooling expects:

```csharp
// Recommended database metric names
"db.client.connections.usage"          // current active connections
"db.client.connections.idle.max"       // max idle connections configured
"db.client.connections.create_time"    // connection creation time
"db.client.operation.duration"         // per-query duration

// Recommended tags
new TagList
{
    { "db.system", "mssql" },
    { "db.name", "MyDatabase" },
    { "db.operation", "SELECT" },
    { "server.address", "sql.example.com" }
}
```

### Prometheus integration

With the OpenTelemetry Prometheus exporter, exposing your metrics to Prometheus is a few lines of setup:

```csharp
// dotnet add package OpenTelemetry.Exporter.Prometheus.AspNetCore

builder.Services.AddOpenTelemetry()
    .WithMetrics(metrics =>
    {
        metrics
            .AddMeter("MyApp.Database")           // your custom metrics
            .AddRuntimeInstrumentation()           // .NET runtime metrics
            .AddAspNetCoreInstrumentation()        // ASP.NET Core metrics
            .AddPrometheusExporter();
    });

// Expose /metrics for Prometheus to scrape
app.MapPrometheusScrapingEndpoint();
```

### When to use System.Diagnostics.Metrics

This is the right tool for production-scale monitoring. If you're running in an environment with Prometheus, Grafana, OpenTelemetry Collector, or any modern observability backend, this is how you feed it. The built-in aggregation means you're not paying per-event overhead at scale — you define the instruments once, record values as they happen, and the exporter handles the rest.

The tradeoff is that it doesn't give you individual operation data. You'll know the 99th percentile query duration, but not which specific query was the outlier. For that, you still want `DiagnosticListener`.

---

## EF Core Interceptors

### What they are

Interceptors let you sit in the middle of EF Core's execution pipeline and either observe operations or modify them. Unlike `DiagnosticListener` (passive observation), interceptors can change behavior — suppress a command, add retry logic, inject query hints, or short-circuit an operation entirely.

```
Your Code
  ↓
DbContext.SaveChanges()
  ↓
┌─────────────────────────┐
│  Interceptor 1          │  ← runs before EF Core logic
│  Interceptor 2          │  ← can modify or suppress
│  Your Interceptor       │  ← can log, monitor, retry
└─────────────────────────┘
  ↓
EF Core Internal Logic
  ↓
Database
```

### Available interceptor types

| Type | Purpose |
|---|---|
| `IDbCommandInterceptor` | Intercept SQL commands |
| `IDbConnectionInterceptor` | Intercept connection open/close |
| `IDbTransactionInterceptor` | Intercept transactions |
| `ISaveChangesInterceptor` | Intercept `SaveChanges` |
| `IMaterializationInterceptor` | Intercept entity materialization |

### Implementation pattern

The base classes (`DbCommandInterceptor`, `DbConnectionInterceptor`, etc.) provide do-nothing default implementations so you only override what you need. Both sync and async variants are available:

```csharp
public class ConnectionMonitoringInterceptor : DbConnectionInterceptor
{
    private readonly ILogger _logger;
    private readonly ConcurrentDictionary<Guid, DateTime> _openTimes = new();

    public override InterceptionResult ConnectionOpening(
        DbConnection connection,
        ConnectionEventData eventData,
        InterceptionResult result)
    {
        _openTimes[eventData.ConnectionId] = DateTime.UtcNow;
        return result; // return unmodified to continue normally
    }

    public override void ConnectionOpened(
        DbConnection connection,
        ConnectionEndEventData eventData)
    {
        if (_openTimes.TryRemove(eventData.ConnectionId, out var startTime))
        {
            var duration = DateTime.UtcNow - startTime;

            if (duration.TotalMilliseconds > 100)
            {
                _logger.LogWarning("Slow connection: {Id} took {Duration}ms",
                    eventData.ConnectionId, duration.TotalMilliseconds);
            }
        }

        base.ConnectionOpened(connection, eventData);
    }

    public override void ConnectionFailed(
        DbConnection connection,
        ConnectionErrorEventData eventData)
    {
        _logger.LogError(eventData.Exception,
            "Connection {Id} failed", eventData.ConnectionId);

        base.ConnectionFailed(connection, eventData);
    }
}
```

### Advanced: modifying behavior

Because interceptors sit in the execution pipeline, you can do more than observe — you can modify. Here's a basic retry interceptor that handles transient connection failures:

```csharp
public class RetryInterceptor : DbConnectionInterceptor
{
    private const int MaxRetries = 3;
    private readonly ILogger _logger;

    public override async ValueTask<InterceptionResult> ConnectionOpeningAsync(
        DbConnection connection,
        ConnectionEventData eventData,
        InterceptionResult result,
        CancellationToken cancellationToken)
    {
        for (int attempt = 1; attempt <= MaxRetries; attempt++)
        {
            try
            {
                return await base.ConnectionOpeningAsync(
                    connection, eventData, result, cancellationToken);
            }
            catch (Exception ex) when (attempt < MaxRetries && IsTransient(ex))
            {
                _logger.LogWarning(
                    "Connection attempt {Attempt} failed, retrying...", attempt);

                await Task.Delay(
                    TimeSpan.FromSeconds(Math.Pow(2, attempt)),
                    cancellationToken);
            }
        }

        return result;
    }

    private static bool IsTransient(Exception ex) =>
        ex is TimeoutException || ex.Message.Contains("timeout");
}
```

### Registration

Interceptors can be registered globally at configuration time, or resolved from the DI container if they need application services:

```csharp
// Option 1: simple global registration
services.AddDbContext<MyDbContext>(options =>
{
    options
        .UseSqlServer(connectionString)
        .AddInterceptors(new ConnectionMonitoringInterceptor(logger));
});

// Option 2: resolve from DI (when interceptor needs scoped/singleton services)
services.AddSingleton<ConnectionMonitoringInterceptor>();

services.AddDbContext<MyDbContext>((sp, options) =>
{
    options
        .UseSqlServer(connectionString)
        .AddInterceptors(sp.GetRequiredService<ConnectionMonitoringInterceptor>());
});
```

### When to use interceptors

Interceptors are the right tool when you need to **change** EF Core's behavior — retry logic, circuit breakers, caching layers, query hints. For pure observation, they carry more overhead than `DiagnosticListener` because they run for every operation regardless of whether anyone is listening. If monitoring is all you need, prefer `DiagnosticListener`.

---

## A Note on Performance Counters

Performance Counters are the Windows-specific, legacy approach to application monitoring. They require admin rights to create, are not cross-platform, carry significant overhead, and are not compatible with modern observability tooling. There is essentially no reason to use them in new applications — `System.Diagnostics.Metrics` replaces them entirely and works on every platform. If you're maintaining a legacy Windows application that already uses them, consider a migration path to `System.Diagnostics.Metrics`.

---

## Comparison at a Glance

| | DiagnosticListener | System.Diagnostics.Metrics | EF Core Interceptors | Performance Counters |
|---|---|---|---|---|
| **Overhead** | Very low | Low | Medium | High |
| **Detail level** | High | Medium | Very high | Low |
| **Platform** | Cross-platform | Cross-platform | Cross-platform | Windows only |
| **Real-time events** | ✅ | ❌ | ✅ | ❌ |
| **Aggregated metrics** | Manual | ✅ Built-in | Manual | ✅ Built-in |
| **OpenTelemetry** | ❌ | ✅ | ❌ | ❌ |
| **Prometheus export** | Manual | ✅ Easy | Manual | ❌ Difficult |
| **Modify behavior** | ❌ | ❌ | ✅ | ❌ |
| **Production ready** | ✅ | ✅ | ⚠️ Use carefully | ❌ Legacy |

The decision usually comes down to what question you're trying to answer:

- "What happened to this specific request?" → **DiagnosticListener**
- "What is the p99 query duration across all requests over the last hour?" → **System.Diagnostics.Metrics**
- "I need to add retry logic to connection failures" → **EF Core Interceptors**
- "I need both event detail and standard metrics" → **DiagnosticListener + System.Diagnostics.Metrics**

---

## Putting It Together: A Production-Ready Setup

The best approach for most applications is to combine `DiagnosticListener` for detailed event tracking with `System.Diagnostics.Metrics` for standard observability. Both are low overhead and they complement each other directly:

```csharp
// Program.cs
var builder = WebApplication.CreateBuilder(args);

// Detailed event tracking via DiagnosticListener
builder.Services.AddSingleton<EFCoreDiagnosticObserver>();
builder.Services.AddHostedService<DiagnosticListenerHostedService>();

// Standard observability metrics
builder.Services.AddSingleton<PoolingMetrics>();

// OpenTelemetry with Prometheus export
builder.Services.AddOpenTelemetry()
    .WithMetrics(metrics =>
    {
        metrics
            .AddMeter("MyApp.Database.Pooling")
            .AddRuntimeInstrumentation()
            .AddPrometheusExporter();
    });

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(connectionString));

var app = builder.Build();

// Expose /metrics for Prometheus
app.MapPrometheusScrapingEndpoint();

app.Run();
```

The hosted service keeps the subscription lifetime tied to the application:

```csharp
public class DiagnosticListenerHostedService : IHostedService
{
    private readonly EFCoreDiagnosticObserver _observer;
    private IDisposable? _subscription;

    public DiagnosticListenerHostedService(EFCoreDiagnosticObserver observer)
    {
        _observer = observer;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _subscription = DiagnosticListener.AllListeners.Subscribe(_observer);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _subscription?.Dispose();
        return Task.CompletedTask;
    }
}
```

This combination gives you detailed per-operation event tracking for debugging and correlation, standard aggregated metrics for your Prometheus/Grafana dashboards, low overhead on both paths, and a clean integration with the broader OpenTelemetry ecosystem.

---

## Summary

The .NET diagnostics ecosystem offers complementary tools for different observability needs. `DiagnosticListener` is for detailed, real-time event tracking with near-zero overhead when idle. `System.Diagnostics.Metrics` is for production-scale aggregated metrics with first-class OpenTelemetry and Prometheus integration. EF Core interceptors are for modifying behavior — retry logic, caching, circuit breakers — rather than pure monitoring. Performance Counters are a legacy Windows-only approach that should not be used in new applications.

For most applications, the right answer is to combine `DiagnosticListener` and `System.Diagnostics.Metrics`: you get the best of both worlds, and neither approach compromises the other.

With the pool built (Part 1), the EF Core lifecycle hooked (Part 2), and observability in place (this post), you have everything you need to run pooled services confidently in production.