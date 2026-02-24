---
title: "Part 2: Hooking into EF Core's DbContext Pool with IResettableService"
description: "A deep dive into EF Core's internal service provider, how DbContext pooling works under the hood, and how to hook into the pool return lifecycle using IResettableService and IDbContextOptionsExtension."
date: 2026-01-10
tags: [dotnet, efcore, dependency-injection, performance, aspnetcore ,"internal hooking"]
draft: false
---

###  Hooking into EF Core's DbContext Pool with `IResettableService`

In [Part 1](/khaledibrahim.dev/articles/part-1-pooled-lifetime-di), we built a general-purpose pooled lifetime for .NET's DI container, inspired by EF Core's `DbContext` pooling. We implemented `IResettableService`, `DependencyPool<T>`, and the supporting infrastructure to rent, return, reset, and dispose pooled instances.

In this post, we go deeper — into EF Core's internals. Specifically, we'll look at:

- What actually happens inside `DbContextPool.Return()` and `DbContext.ResetState()`
- Why EF Core has *two* service providers and what the difference is
- How to register services into EF Core's **internal** service provider using `IDbContextOptionsExtension`
- How to hook into the exact moment a `DbContext` is returned to the pool — without patching EF Core or using reflection

---

## Part 1 — What Actually Happens When a DbContext Is Returned

### `DbContextPool.Return()` — the moment a context goes back to the pool

From EF Core's source (`src/EFCore/Internal/DbContextPool.cs`):

```csharp
public virtual void Return(IDbContextPoolable context)
{
    if (Interlocked.Increment(ref _count) <= _maxSize)
    {
        context.ResetState();   // resets the context
        _pool.Enqueue(context); // puts it back in the pool
    }
    else
    {
        PooledReturn(context);  // overflow: actually dispose it
    }
}
```

`ResetState()` is called **before** the context is enqueued. This is the precise moment we want to capture — after the request is done, before the context is available for the next one.

### `DbContext.ResetState()` — iterates all internal `IResettableService` instances

From `src/EFCore/DbContext.cs`:

```csharp
void IResettableService.ResetState()
{
    foreach (var service in GetResettableServices())
    {
        service.ResetState();
    }
    _disposed = true;
}
```

`GetResettableServices()` resolves `IEnumerable<IResettableService>` from the `DbContext`'s **internal** service provider — not the application's root service provider. This is the key insight: `ResetState()` only calls services registered in the *internal* SP.

### The full call chain

```
Request ends / scope is disposed
  │
  ▼
DI disposes the scoped pooled-context wrapper
  │
  ▼
DbContextPool.Return(context)
  │
  ├── context.ResetState()
  │     ├── StateManager.ResetState()       — clears the change tracker
  │     ├── DatabaseFacade.ResetState()     — resets transaction state
  │     ├── ... other internal EF services ...
  │     └── PoolTrackingService.ResetState() — ✅ YOUR HOOK fires here
  │
  └── _pool.Enqueue(context)               — context available for reuse
```

---

## Part 2 — The Two Service Providers

Understanding this distinction is essential before you can register anything correctly.

### The Application Service Provider

This is the standard .NET DI container you interact with in `Program.cs`:

```csharp
public void ConfigureServices(IServiceCollection services)
{
    services.AddScoped<IUserService, UserService>();
    services.AddScoped<IEmailService, EmailService>();
    services.AddHttpContextAccessor();
    services.AddDbContext<MyDbContext>(...);
}
```

It holds your application services — things like `ILogger<T>`, `IHttpContextAccessor`, `IUserService`. Services are registered as singleton, scoped, or transient as normal.

### EF Core's Internal Service Provider

EF Core builds a **separate, private DI container** when it sets up a `DbContext` type. You never interact with it directly through `IServiceCollection`. It contains EF's infrastructure:

- `IModel` — the compiled entity model
- `IStateManager` — change tracker internals
- `IDatabase` / `IDatabaseFacade`
- Query translators, type mappers, database provider services
- Any `IResettableService` implementations — including your custom ones

This internal SP is **shared across all instances** of the same `DbContext` type, as long as the configuration hash matches. If you change the options (e.g. add `EnableSensitiveDataLogging()`), EF builds a new internal SP.

### Why two containers?

The separation serves several purposes. EF's internal machinery doesn't pollute your application's DI graph. The internal SP is expensive to build (it compiles the model, sets up the query pipeline, etc.), so sharing it across instances avoids rebuilding it on every request. And EF's internal services have their own lifecycle concerns that don't map cleanly to ASP.NET request scopes.

### Side-by-side: general .NET DI vs EF Core

In standard .NET DI, the separation is root vs. scoped:

```csharp
// ROOT PROVIDER — holds singletons, lives for the app lifetime
var rootProvider = app.Services;

// SCOPED PROVIDER — holds scoped services, lives for one request
using (var scope = rootProvider.CreateScope())
{
    var myService = scope.ServiceProvider.GetRequiredService<IMyScopedService>();
}
```

In EF Core, the separation is application vs. internal:

```csharp
// APPLICATION SP — your services, registered in Program.cs
services.AddScoped<IUserService, UserService>();

// INTERNAL SP — EF's private container
// You register into it via IDbContextOptionsExtension.ApplyServices()
// You resolve from it via context.GetService<T>()
```

---

## Part 3 — Registering into the Internal SP with `IDbContextOptionsExtension`

The only supported, non-reflective way to add services to EF's internal SP is through `IDbContextOptionsExtension`. You implement the interface, register your services in `ApplyServices()`, and attach the extension to `DbContextOptions`.

### Why you can't use `services.AddSingleton<IResettableService, ...>()`

If you register `IResettableService` in the *application* SP, it will never be called. `DbContext.ResetState()` resolves `IResettableService` from its **internal** SP. Your app-SP registration is invisible to it.

### Step 1 — Implement the extension

```csharp
/// <summary>
/// Registers PoolTrackingService into EF Core's INTERNAL service provider.
///
/// When EF Core builds its internal SP, it calls ApplyServices() on every
/// IDbContextOptionsExtension attached to DbContextOptions. The IServiceCollection
/// passed here IS the internal one — services added here are resolvable via
/// context.GetService<T>() and will be picked up by DbContext.ResetState().
/// </summary>
public class PoolTrackingExtension : IDbContextOptionsExtension
{
    private DbContextOptionsExtensionInfo? _info;

    public DbContextOptionsExtensionInfo Info
        => _info ??= new ExtensionInfo(this);

    public void ApplyServices(IServiceCollection services)
    {
        services.AddSingleton<IResettableService, PoolTrackingService>();
    }

    public void Validate(IDbContextOptions options) { }
}
```

### Step 2 — Implement the extension info

`DbContextOptionsExtensionInfo` provides EF Core with metadata and hashing logic used for internal SP caching. Every extension must have one:

```csharp
private sealed class ExtensionInfo : DbContextOptionsExtensionInfo
{
    public ExtensionInfo(IDbContextOptionsExtension extension)
        : base(extension) { }

    // Only true if this extension IS the database provider itself (e.g. UseSqlServer)
    public override bool IsDatabaseProvider => false;

    // Appears in EF Core log output and diagnostic strings
    public override string LogFragment => "PoolTracking ";

    // Used to determine if two DbContextOptions can share the same internal SP.
    // If your extension has no configuration, return 0.
    public override int GetServiceProviderHashCode() => 0;

    public override bool ShouldUseSameServiceProvider(DbContextOptionsExtensionInfo other)
        => other is ExtensionInfo;

    public override void PopulateDebugInfo(IDictionary<string, string> debugInfo)
        => debugInfo["PoolTracking:Enabled"] = "1";
}
```

### Step 3 — Add a fluent extension method

```csharp
public static class PoolTrackingDbContextOptionsExtensions
{
    public static DbContextOptionsBuilder UsePoolTracking(
        this DbContextOptionsBuilder optionsBuilder)
    {
        var extension = optionsBuilder.Options.FindExtension<PoolTrackingExtension>()
                        ?? new PoolTrackingExtension();

        ((IDbContextOptionsBuilderInfrastructure)optionsBuilder)
            .AddOrUpdateExtension(extension);

        return optionsBuilder;
    }
}
```

### Step 4 — Register in `Program.cs`

```csharp
services.AddDbContextPool<AppDbContext>(options =>
    options.UseSqlServer(connectionString)
           .UsePoolTracking());
```

---

## Part 4 — Implementing `PoolTrackingService`

This is the service that fires at the exact moment a context is returned to the pool:

```csharp
/// <summary>
/// Registered into DbContext's INTERNAL service provider via PoolTrackingExtension.
///
/// DbContextPool.Return() calls context.ResetState() immediately before
/// enqueuing the context back into the pool. DbContext.ResetState() iterates
/// every IResettableService in the internal SP — including this one.
///
/// ResetState() fires at the EXACT moment of return: after the request is done,
/// before the context is available for reuse.
/// </summary>
public class PoolTrackingService : IResettableService
{
    private DateTime _leaseStartedAt;

    /// <summary>
    /// Call this when the context is first leased from the pool.
    /// Typically called from your DbContext constructor or an initialization interceptor.
    /// </summary>
    public void OnContextLeased()
    {
        _leaseStartedAt = DateTime.UtcNow;
    }

    /// <summary>
    /// Called by DbContext.ResetState() immediately before the context is
    /// enqueued back into the pool.
    /// </summary>
    public void ResetState()
    {
        var duration = DateTime.UtcNow - _leaseStartedAt;
        Console.WriteLine($"[PoolTracking] Context returned after {duration.TotalMilliseconds:F1}ms");

        // Always reset your own state so the next lease starts clean
        _leaseStartedAt = default;
    }

    public Task ResetStateAsync(CancellationToken cancellationToken = default)
    {
        ResetState();
        return Task.CompletedTask;
    }
}
```

---

## Part 5 — Bridging to the Application SP

Because the internal SP is isolated, you can't inject application services like `ILogger<T>` or a custom `IMetricsCollector` directly into `PoolTrackingService` via constructor injection — they live in a different container. There are two approaches to bridge the gap.

### Option A: Pass the app-SP service through the extension constructor (recommended)

Store a reference to your app-level service in the extension at configuration time, then register it in `ApplyServices()`:

```csharp
public class PoolTrackingExtension : IDbContextOptionsExtension
{
    private readonly IPoolLifecycleTracker _tracker;
    private DbContextOptionsExtensionInfo? _info;

    public PoolTrackingExtension(IPoolLifecycleTracker tracker)
    {
        _tracker = tracker;
    }

    public DbContextOptionsExtensionInfo Info
        => _info ??= new ExtensionInfo(this);

    public void ApplyServices(IServiceCollection services)
    {
        // Register the app-level tracker as a singleton in the INTERNAL SP
        services.AddSingleton(_tracker);
        services.AddSingleton<IResettableService, PoolTrackingService>();
    }

    public void Validate(IDbContextOptions options) { }

    private sealed class ExtensionInfo : DbContextOptionsExtensionInfo
    {
        public ExtensionInfo(IDbContextOptionsExtension extension) : base(extension) { }
        public override bool IsDatabaseProvider => false;
        public override string LogFragment => "PoolTracking ";
        public override int GetServiceProviderHashCode() => 0;
        public override bool ShouldUseSameServiceProvider(DbContextOptionsExtensionInfo other)
            => other is ExtensionInfo;
        public override void PopulateDebugInfo(IDictionary<string, string> debugInfo)
            => debugInfo["PoolTracking:Enabled"] = "1";
    }
}
```

Update the fluent method to accept the tracker:

```csharp
public static DbContextOptionsBuilder UsePoolTracking(
    this DbContextOptionsBuilder optionsBuilder,
    IPoolLifecycleTracker tracker)
{
    var extension = new PoolTrackingExtension(tracker);
    ((IDbContextOptionsBuilderInfrastructure)optionsBuilder).AddOrUpdateExtension(extension);
    return optionsBuilder;
}
```

Register in `Program.cs`:

```csharp
services.AddSingleton<IPoolLifecycleTracker, PoolLifecycleTracker>();

services.AddDbContextPool<AppDbContext>((sp, options) =>
{
    var tracker = sp.GetRequiredService<IPoolLifecycleTracker>();
    options.UseSqlServer(connectionString)
           .UsePoolTracking(tracker);
});
```

`PoolTrackingService` then receives it via normal constructor injection:

```csharp
public class PoolTrackingService : IResettableService
{
    private readonly IPoolLifecycleTracker _tracker;
    private DateTime _leaseStartedAt;

    public PoolTrackingService(IPoolLifecycleTracker tracker)
    {
        _tracker = tracker;
    }

    public void ResetState()
    {
        var duration = DateTime.UtcNow - _leaseStartedAt;
        _tracker.OnContextReturnedToPool(duration);
        _leaseStartedAt = default;
    }

    public Task ResetStateAsync(CancellationToken cancellationToken = default)
    {
        ResetState();
        return Task.CompletedTask;
    }
}
```

### Option B: Resolve from the internal SP via `context.GetService<T>()`

If you already have a `DbContext` reference (e.g. inside an interceptor), you can call `context.GetService<T>()` to resolve from the internal SP:

```csharp
var trackingService = context.GetService<PoolTrackingService>();
trackingService?.OnContextLeased();
```

This doesn't cross the SP boundary — it stays within the internal SP. Use Option A when you need app-SP services.

---

## Part 6 — Other Services You Can Register via `IDbContextOptionsExtension`

The same extension mechanism supports more than just `IResettableService`.

### Registering a custom interceptor

EF Core automatically resolves all `IInterceptor` registrations from the internal SP:

```csharp
public void ApplyServices(IServiceCollection services)
{
    services.AddSingleton<IInterceptor, MyCustomSaveInterceptor>();
    services.AddSingleton<IResettableService, PoolTrackingService>();
}
```

### Registering a global model customizer

```csharp
public void ApplyServices(IServiceCollection services)
{
    services.AddSingleton<IModelCustomizer, MyCustomModelCustomizer>();
}

public class MyCustomModelCustomizer : ModelCustomizer
{
    public MyCustomModelCustomizer(ModelCustomizerDependencies dependencies)
        : base(dependencies) { }

    public override void Customize(ModelBuilder modelBuilder, DbContext context)
    {
        base.Customize(modelBuilder, context);

        // Apply a global value converter to all DateTime properties
        foreach (var entityType in modelBuilder.Model.GetEntityTypes())
        {
            foreach (var property in entityType.GetProperties()
                         .Where(p => p.ClrType == typeof(DateTime)))
            {
                property.SetValueConverter(new MyDateTimeConverter());
            }
        }
    }
}
```

---

## Part 7 — When to Use Each Approach

If you only need interceptor-style hooks and want those interceptors to receive services from the application SP (e.g. a scoped `ICurrentUserService`), you don't need `IDbContextOptionsExtension` at all. Use `AddInterceptors()` directly:

```csharp
services.AddSingleton<IAuditLogger, AuditLogger>();
services.AddScoped<AuditInterceptor>();

services.AddDbContext<MyDbContext>((sp, options) =>
{
    var interceptor = sp.GetRequiredService<AuditInterceptor>();
    options.UseSqlServer("...")
           .AddInterceptors(interceptor);
});
```

EF stores the interceptor instance internally, but you resolved it from the app SP — so it has access to all your normal app services.

Here's a summary of when to use each approach:

| Scenario | Approach |
|---|---|
| Interceptors that need app services | `AddInterceptors()` via app SP |
| Pool return / reset lifecycle hooks | `IResettableService` via `IDbContextOptionsExtension` |
| Global value converters or model-level changes | `IModelCustomizer` via `IDbContextOptionsExtension` |
| Reusable EF library / plugin | `IDbContextOptionsExtension` |
| Passing an app-SP singleton into an internal service | Extension constructor + `ApplyServices()` |
| Multiple related EF services working together | `IDbContextOptionsExtension` (register all in one `ApplyServices()`) |

---

## Summary

- `DbContextPool.Return()` calls `context.ResetState()` before re-enqueuing the context — this is the hook point.
- `DbContext.ResetState()` iterates `IResettableService` from the **internal SP only** — app SP registrations are not seen.
- The only way to register into the internal SP is via `IDbContextOptionsExtension.ApplyServices()`.
- App SP services can be bridged in by resolving them at configuration time and passing them through the extension constructor.
- `IResettableService` + `IDbContextOptionsExtension` is the clean, supported, non-reflective API for any custom lifecycle behavior tied to pooled `DbContext` instances.

In this two-part series, we've gone from implementing a general-purpose pooled DI lifetime from scratch, to understanding and extending EF Core's own pooling infrastructure using the same underlying concept. Whether you're optimizing a custom service or instrumenting `DbContext` pool behavior, `IResettableService` gives you a precise, clean hook into the lifecycle.