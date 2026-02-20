---
title: "Designing Resilient Microservices: Patterns That Actually Work"
description: "A practical guide to building fault-tolerant microservices using circuit breakers, bulkheads, retry policies, and health checks — with real C# implementation examples."
date: 2025-10-03
tags: ["microservices", "resilience", "distributed-systems", "dotnet"]
draft: false
---

## Introduction

Every distributed system will fail. The question is not **if** but **when** and **how gracefully**. After operating microservices in production for several years, these are the resilience patterns that consistently prevented cascading failures.

This article covers practical implementations, not theory. Every pattern includes working C# code.

## Circuit Breaker

The circuit breaker prevents a failing downstream service from consuming resources and causing cascading failures:

```csharp
// Using Polly v8 with the new resilience pipeline API
var pipeline = new ResiliencePipelineBuilder<HttpResponseMessage>()
    .AddCircuitBreaker(new CircuitBreakerStrategyOptions<HttpResponseMessage>
    {
        FailureRatio = 0.5,
        SamplingDuration = TimeSpan.FromSeconds(30),
        MinimumThroughput = 10,
        BreakDuration = TimeSpan.FromSeconds(15),
        ShouldHandle = new PredicateBuilder<HttpResponseMessage>()
            .HandleResult(r => !r.IsSuccessStatusCode)
            .Handle<HttpRequestException>()
            .Handle<TimeoutRejectedException>()
    })
    .Build();
```

### When to Use

- Wrapping HTTP calls to downstream services
- Database connection attempts during outages
- Any I/O operation where repeated failures waste resources

### When NOT to Use

- In-process method calls (use proper error handling instead)
- Operations where every attempt must be made (e.g., financial transactions)

## Bulkhead Isolation

Bulkheads limit the concurrency of a specific operation, preventing one slow dependency from exhausting all threads:

```csharp
services.AddHttpClient("PaymentService")
    .AddResilienceHandler("payment-bulkhead", builder =>
    {
        builder.AddConcurrencyLimiter(new ConcurrencyLimiterOptions
        {
            PermitLimit = 25,
            QueueLimit = 50
        });
    });
```

## Retry with Exponential Backoff

Not all failures are permanent. Transient failures (network blips, brief overloads) often resolve within seconds:

```csharp
builder.AddRetry(new RetryStrategyOptions<HttpResponseMessage>
{
    MaxRetryAttempts = 3,
    Delay = TimeSpan.FromMilliseconds(200),
    BackoffType = DelayBackoffType.Exponential,
    UseJitter = true, // Prevents thundering herd
    ShouldHandle = new PredicateBuilder<HttpResponseMessage>()
        .HandleResult(r => r.StatusCode == HttpStatusCode.ServiceUnavailable)
        .HandleResult(r => r.StatusCode == HttpStatusCode.TooManyRequests)
        .Handle<HttpRequestException>()
});
```

> **Critical**: Always add jitter to exponential backoff. Without it, retries from multiple clients synchronize and create thundering herd problems.

## Health Checks

Health checks allow orchestrators (Kubernetes, load balancers) to route traffic away from unhealthy instances:

```csharp
builder.Services.AddHealthChecks()
    .AddNpgSql(connectionString, name: "postgresql")
    .AddRedis(redisConnection, name: "redis")
    .AddKafka(kafkaConfig, name: "kafka")
    .AddCheck<CustomDependencyCheck>("payment-gateway");

// In Program.cs
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready")
});

app.MapHealthChecks("/health/live", new HealthCheckOptions
{
    Predicate = _ => false // Liveness = app is running
});
```

## Combining Patterns

In production, these patterns compose. The order matters:

```
Request → Bulkhead → Retry → Circuit Breaker → Timeout → HTTP Call
```

Each layer handles a different failure mode. The bulkhead limits concurrency, retries handle transient errors, the circuit breaker stops calling a dead service, and the timeout prevents hanging.

## Key Takeaways

1. **Design for failure** — every external call should have a resilience policy
2. **Monitor your circuit breakers** — a tripped breaker is an alert, not a solution
3. **Test failure scenarios** — use chaos engineering tools to verify your patterns work
4. **Keep timeouts tight** — a 30-second timeout on a 100ms call wastes 299x resources during failures
5. **Log transitional states** — knowing when a circuit opens/closes is more valuable than knowing individual failures
