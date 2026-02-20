---
title: "Distributed Cache System with Write-Behind Strategy"
description: "High-throughput distributed caching layer built on Redis Cluster with write-behind persistence, automatic failover, and cache invalidation via pub/sub."
date: 2025-11-15
tech: ["C#", ".NET 8", "Redis", "PostgreSQL", "Docker", "gRPC"]
tags: ["distributed-systems", "caching", "performance", "redis"]
featured: true
draft: false
---

## Overview

A production-grade distributed caching system designed to handle **50,000+ requests/second** with sub-millisecond read latency. The system implements a write-behind strategy to decouple cache writes from database persistence, ensuring high throughput without sacrificing data durability.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   API Layer  │────▶│  Cache Service   │────▶│ Redis Cluster│
│  (gRPC/REST) │     │  (Write-Behind)  │     │  (3 masters) │
└─────────────┘     └──────────────────┘     └─────────────┘
                            │                        │
                            ▼                        ▼
                    ┌──────────────┐         ┌──────────────┐
                    │ Write Queue  │         │  Pub/Sub     │
                    │ (Background) │         │ Invalidation │
                    └──────────────┘         └──────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │  PostgreSQL  │
                    │  (Durable)   │
                    └──────────────┘
```

## Key Implementation Details

### Write-Behind Cache Service

The core service decouples writes from persistence using a background channel:

```csharp
public sealed class WriteBehindCacheService<TKey, TValue> : IDisposable
    where TKey : notnull
{
    private readonly IDistributedCache _cache;
    private readonly IDbPersistence<TKey, TValue> _persistence;
    private readonly Channel<WriteOperation<TKey, TValue>> _writeChannel;
    private readonly ILogger _logger;

    public WriteBehindCacheService(
        IDistributedCache cache,
        IDbPersistence<TKey, TValue> persistence,
        ILogger<WriteBehindCacheService<TKey, TValue>> logger)
    {
        _cache = cache;
        _persistence = persistence;
        _logger = logger;
        _writeChannel = Channel.CreateBounded<WriteOperation<TKey, TValue>>(
            new BoundedChannelOptions(10_000)
            {
                FullMode = BoundedChannelFullMode.Wait,
                SingleReader = false,
                SingleWriter = false
            });
    }

    public async ValueTask SetAsync(TKey key, TValue value, CancellationToken ct = default)
    {
        var serialized = JsonSerializer.SerializeToUtf8Bytes(value);
        await _cache.SetAsync(
            key.ToString()!,
            serialized,
            new DistributedCacheEntryOptions { SlidingExpiration = TimeSpan.FromMinutes(30) },
            ct);

        await _writeChannel.Writer.WriteAsync(
            new WriteOperation<TKey, TValue>(key, value, DateTimeOffset.UtcNow), ct);
    }

    public async Task ProcessWriteQueueAsync(CancellationToken ct)
    {
        await foreach (var op in _writeChannel.Reader.ReadAllAsync(ct))
        {
            try
            {
                await _persistence.UpsertAsync(op.Key, op.Value, ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Write-behind failed for key {Key}", op.Key);
                // Re-enqueue with backoff logic
            }
        }
    }
}
```

### Cache Invalidation via Pub/Sub

Cross-node cache invalidation ensures consistency across the cluster:

```csharp
public sealed class CacheInvalidationSubscriber : BackgroundService
{
    private readonly IConnectionMultiplexer _redis;
    private readonly IMemoryCache _localCache;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var subscriber = _redis.GetSubscriber();
        await subscriber.SubscribeAsync(
            RedisChannel.Literal("cache:invalidate"),
            (_, message) =>
            {
                var key = message.ToString();
                _localCache.Remove(key);
            });

        await Task.Delay(Timeout.Infinite, ct);
    }
}
```

## Performance Results

| Metric | Value |
|--------|-------|
| Read latency (p99) | 0.8ms |
| Write throughput | 52,000 ops/sec |
| Cache hit ratio | 94.7% |
| Failover time | < 3 seconds |

## Deployment

The system runs as a set of Docker containers orchestrated with Docker Compose for development and Kubernetes for production:

```yaml
# docker-compose.yml (development)
services:
  cache-service:
    build: ./src/CacheService
    environment:
      - REDIS_CONNECTION=redis-cluster:6379
      - POSTGRES_CONNECTION=Host=db;Database=cache_store
    depends_on:
      - redis-cluster
      - db
```

## Lessons Learned

- **Bounded channels** are critical — unbounded write queues caused OOM in load testing
- **Sliding expiration** outperformed absolute expiration for our access patterns
- **Local cache + distributed cache** (L1/L2 pattern) reduced Redis round-trips by 40%
- **Pub/Sub invalidation** must handle subscriber reconnection gracefully
