---
title: "Going Beyond Singleton, Scoped, and Transient — Part 1: Implementing a Pooled Lifetime in .NET DI (DbContextPool From Scratch)"
description: "Explore the standard DI lifetimes in ASP.NET Core and implement a pooled lifetime inspired by EF Core's DbContext pooling — reducing allocations and improving performance."
date: 2026-01-03
tags: [dotnet, dependency-injection, performance, aspnetcore]
draft: false
---

### Going Beyond Singleton, Scoped, and Transient: Implementing a Pooled Lifetime in .NET DI

When you register a service in .NET's dependency injection container, you choose a **lifetime**. The lifetime controls how and when the container creates a new instance of a service — and when it returns an already-existing one:

- **Singleton** — only a single instance is ever created, shared across the entire application lifetime.
- **Scoped** — a new instance is created once per "scope" (typically once per HTTP request).
- **Transient** — a new instance is created every time the service is requested.

These three cover the vast majority of use cases. But there are scenarios where none of them quite fits. In this series, we explore three "additional" lifetime types:

- **Tenant-scoped services** — effectively per-tenant singletons ([covered here](https://michael-mckenna.com/multi-tenant-asp-dot-net-8-tenant-resolution/))
- **Time-based (drifter) services** — singleton services that are replaced periodically ([covered here](https://andrewlock.net/going-beyond-singleton-scoped-and-transient-lifetimes/#implementing-a-simple-time-based-lifetime-service))
- **Pooled services** — reuses a "pool" of service instances *(this post)*

This post focuses on implementing a **pooled lifetime**.

---

## Why Pooling?

Pooling is a technique for reducing memory allocations and, by extension, improving performance. The idea is simple: instead of creating and destroying objects on every request, you maintain a pool of reusable instances. When a request needs one, it *rents* an instance from the pool; when it's done, it *returns* the instance (after resetting its state) rather than discarding it.

The inspiration for a pooled DI lifetime comes from **EF Core's DbContext pooling**, which was introduced in EF Core 2.0. A `DbContext` is a relatively heavyweight object — it allocates significant memory, performs expensive initialization (model compilation, query compilation, change tracking setup), and creates metadata caches that are discarded on disposal. Without pooling, under load this means constant allocation and garbage collection pressure.

With pooling, the numbers speak for themselves:

| Method | Mean | Gen 0 | Allocated |
|---|---|---|---|
| WithoutContextPooling | 701.6 µs | 11.7188 | 50.38 KB |
| WithContextPooling | 350.1 µs | 0.9766 | 4.63 KB |

Roughly **2× faster** and **10× less memory allocated** per request. The pooled lifetime generalizes this capability to any service in your DI container.

> **Note:** This implementation deliberately avoids `ObjectPool<T>` to explore a slightly different API. You can find a similar implementation that uses `ObjectPool<T>` in the [Microsoft docs](https://learn.microsoft.com/en-us/aspnet/core/performance/objectpool?view=aspnetcore-9.0).

---

## Requirements for the Pooled Lifetime

Before writing any code, it's worth being clear about what the pooled lifetime should do:

1. Pooled services should have **scoped semantics** — one instance per request scope, not shared across parallel requests.
2. When a pooled service is requested, the container should **use a pooled instance first** if one is available. If not, it creates a new instance.
3. When the scope is disposed, pooled services should be **returned to the pool**.
4. The pool should enforce a **maximum size of N instances**. If the pool is full when a service is returned, the instance is discarded (and disposed if necessary).
5. Pooled services must implement **`IResettableService`**, which contains a single `Reset()` method.
6. When returned to the pool, `Reset()` is called on the instance to prepare it for reuse.
7. Beyond `IResettableService`, there are **no other requirements** on the pooled service.
8. If a service implements `IDisposable`, it must be **disposed if not returned to the pool**.

---

## The Five Moving Parts

The implementation consists of five components:

- `IResettableService` — the interface pooled services must implement
- `IPooledService<T>` — the interface used to access a pooled instance (analogous to `IOptions<T>`)
- `PooledService<T>` — the internal implementation of `IPooledService<T>`
- `DependencyPool<T>` — the pooling engine, responsible for renting and returning instances
- `PoolingExtensions` — helper methods for registering everything in the DI container

---

### `IResettableService`

This is the only contract the pooled service itself must fulfill:

```csharp
public interface IResettableService
{
    void Reset();
}
```

When called, `Reset()` must restore the service to its original state so it can be safely reused. If you were pooling a `DbContext`, this is where you would reset the change tracker.

---

### `IPooledService<T>`

This is the interface your application code depends on. Rather than injecting `T` directly, you inject `IPooledService<T>` and access the underlying instance via `.Value` — similar to how `IOptions<T>` works for configuration:

```csharp
public interface IPooledService<out T>
    where T : IResettableService
{
    T Value { get; }
}
```

In a dependent service, usage looks like this:

```csharp
public class DependentService
{
    private readonly IMyService _myService;

    public DependentService(IPooledService<IMyService> pooled)
    {
        _myService = pooled.Value;
    }
}
```

---

### `PooledService<T>`

`PooledService<T>` is the internal implementation of `IPooledService<T>`. It rents an instance from `DependencyPool<T>` in its constructor, and returns it when disposed. Since the DI container disposes scoped services at the end of each scope, this means the pooled service is automatically returned when the request ends:

```csharp
internal class PooledService<T> : IPooledService<T>, IDisposable
    where T : IResettableService
{
    private readonly DependencyPool<T> _pool;

    public PooledService(DependencyPool<T> pool)
    {
        _pool = pool;
        Value = _pool.Rent();
    }

    public T Value { get; }

    void IDisposable.Dispose()
    {
        _pool.Return(Value);
    }
}
```

---

### `DependencyPool<T>`

This is where the real work happens. `DependencyPool<T>` is responsible for creating, pooling, renting, returning, and disposing service instances:

```csharp
internal class DependencyPool<T>(IServiceProvider provider) : IDisposable
    where T : IResettableService
{
    private int _count = 0;
    private int _maxPoolSize = 3; // TODO: make configurable via options
    private readonly ConcurrentQueue<T> _pool = new();
    private readonly Func<T> _factory = () => ActivatorUtilities.CreateInstance<T>(provider);

    public T Rent()
    {
        if (_pool.TryDequeue(out var service))
        {
            Interlocked.Decrement(ref _count);
            return service;
        }

        return _factory();
    }

    public void Return(T service)
    {
        if (Interlocked.Increment(ref _count) <= _maxPoolSize)
        {
            service.Reset();
            _pool.Enqueue(service);
        }
        else
        {
            Interlocked.Decrement(ref _count);
            (service as IDisposable)?.Dispose();
        }
    }

    public void Dispose()
    {
        _maxPoolSize = 0;

        while (_pool.TryDequeue(out var service))
        {
            (service as IDisposable)?.Dispose();
        }
    }
}
```

A few details worth noting:

- `ActivatorUtilities.CreateInstance<T>(provider)` is used to create instances, meaning the pooled service can still have its own constructor-injected dependencies from the DI container.
- `_count` is tracked separately from the queue using `Interlocked` operations to ensure the maximum pool size is respected even under concurrent access.
- When `DependencyPool<T>` itself is disposed (at app shutdown), it drains and disposes all pooled instances.

---

### `PoolingExtensions`

The final piece is registering everything in the container. `DependencyPool<T>` is registered as a **singleton** (one pool per service type, shared across all requests), and `IPooledService<T>` is registered as **scoped** (one rental per request):

```csharp
public static class PoolingExtensions
{
    public static IServiceCollection AddScopedPooling<T>(this IServiceCollection services)
        where T : class, IResettableService
    {
        services.TryAddSingleton<DependencyPool<T>>();
        services.TryAddScoped<IPooledService<T>, PooledService<T>>();

        return services;
    }
}
```

Note that `T` itself is not registered directly in the container — you always go through `IPooledService<T>`.

---

## Testing the Implementation

To verify the behavior, consider a simple `TestService` that logs when it's reset or disposed:

```csharp
public class TestService : IResettableService, IDisposable
{
    private static int _id = 0;

    public int Id { get; } = Interlocked.Increment(ref _id);

    public void Dispose() => Console.WriteLine($"Disposing service: {Id}");
    public void Reset() => Console.WriteLine($"Resetting service: {Id}");
}
```

A simple console app creates 5 parallel scopes twice in sequence:

```csharp
var collection = new ServiceCollection();
collection.AddScopedPooling<TestService>();
var services = collection.BuildServiceProvider();

Console.WriteLine("Generating scopes A");
GenerateScopes(services);

Console.WriteLine();
Console.WriteLine("Generating scopes B");
GenerateScopes(services);

static void GenerateScopes(IServiceProvider services)
{
    var count = 5;
    List<IServiceScope> scopes = new(count);

    for (int i = 0; i < count; i++)
    {
        var scope = services.CreateScope();
        scopes.Add(scope);
        var service = scope.ServiceProvider
            .GetRequiredService<IPooledService<TestService>>().Value;
        Console.WriteLine($"Received service: {service.Id}");
    }

    foreach (var scope in scopes)
    {
        scope.Dispose();
    }
}
```

Running this produces the following output:

```
Generating scopes A
Received value: 1
Received value: 2
Received value: 3
Received value: 4
Received value: 5
Resetting service: 1
Resetting service: 2
Resetting service: 3
Disposing service: 4
Disposing service: 5

Generating scopes B
Received value: 1
Received value: 2
Received value: 3
Received value: 6
Received value: 7
Resetting service: 1
Resetting service: 2
Resetting service: 3
Disposing service: 6
Disposing service: 7
```

The behavior is exactly as expected:

- 5 new instances are created to satisfy 5 parallel scopes.
- When the scopes are disposed, 3 instances are reset and pooled. The remaining 2 are disposed (pool is full).
- On the second run, the first 3 requests get pooled instances (Ids 1, 2, 3). The remaining 2 require new instances (Ids 6 and 7).
- Again, 3 are pooled and 2 are disposed on cleanup.

---

## Limitations

This implementation differs from EF Core's DbContext pooling in a few important ways.

`DbContext` was designed with pooling in mind — its internals have explicit knowledge of the pool lease lifecycle. That means you use a pooled `DbContext` exactly the same way as a non-pooled one. In contrast, this implementation requires consumers to use `IPooledService<T>` as an intermediate wrapper, which is a more visible abstraction.

Pooled services also **cannot depend on scoped services**. Because a pooled instance lives across multiple request scopes, the only safe dependency lifetimes are singleton or transient. Injecting a scoped service would cause it to be held beyond the scope it was intended for.

The pool itself is also intentionally simple: first-in, first-out, with no expiration or eviction. Pooled instances stay in the pool until rented again. You could make this more sophisticated, but complexity can quickly erode the performance benefits pooling was meant to provide.

---

## Is Pooling Worth It?

Whether pooling is right for your service depends on a few factors. The benefits are most pronounced when:

- Instance creation is expensive (e.g. involves model compilation, connection setup, heavy initialization)
- The service is requested frequently under load
- The service is easily resettable to a clean state

For lightweight services, the overhead of pool management may outweigh the savings.

The clearest real-world case is `DbContext` pooling — the benchmarks show roughly 2× throughput improvement and 10× reduction in allocations. If your service has similar characteristics, a pooled lifetime is worth exploring.

---

In **Part 2**, we'll look at how EF Core's own pooling infrastructure works internally — specifically how `IResettableService` is used within EF Core's private service provider, and how you can hook into that lifecycle using `IDbContextOptionsExtension`.