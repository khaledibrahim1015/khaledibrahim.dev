---
title: "Event-Driven Order Pipeline with Kafka and Outbox Pattern"
description: "Reliable order processing pipeline using Apache Kafka, the transactional outbox pattern, and saga orchestration for distributed transactions."
date: 2025-08-22
tech: ["C#", ".NET 8", "Kafka", "PostgreSQL", "Docker", "Kubernetes"]
tags: ["event-driven", "kafka", "microservices", "distributed-systems"]
featured: true
draft: false
---

## Overview

A production order processing pipeline handling **10,000+ orders/minute** with exactly-once processing semantics. The system uses the **transactional outbox pattern** to guarantee that domain events are published reliably, and the **saga pattern** to coordinate distributed transactions across services.

## Architecture

```
┌──────────┐    ┌─────────────┐    ┌──────────────┐    ┌───────────┐
│ Order API │───▶│ Order Svc   │───▶│   Kafka      │───▶│ Payment   │
│           │    │ + Outbox    │    │  (Events)    │    │ Service   │
└──────────┘    └─────────────┘    └──────────────┘    └───────────┘
                       │                  │                   │
                       ▼                  │                   ▼
                ┌─────────────┐           │            ┌───────────┐
                │ PostgreSQL  │           └───────────▶│ Inventory │
                │ (Outbox tbl)│                        │ Service   │
                └─────────────┘                        └───────────┘
```

## Transactional Outbox Implementation

The outbox pattern ensures atomicity between the domain write and event publish:

```csharp
public sealed class OrderService
{
    private readonly AppDbContext _db;
    private readonly ILogger<OrderService> _logger;

    public async Task<Order> CreateOrderAsync(CreateOrderCommand cmd, CancellationToken ct)
    {
        await using var transaction = await _db.Database.BeginTransactionAsync(ct);

        try
        {
            var order = Order.Create(cmd.CustomerId, cmd.Items);
            _db.Orders.Add(order);

            // Write event to outbox in the same transaction
            var outboxMessage = new OutboxMessage
            {
                Id = Guid.NewGuid(),
                Type = nameof(OrderCreatedEvent),
                Payload = JsonSerializer.Serialize(new OrderCreatedEvent
                {
                    OrderId = order.Id,
                    CustomerId = order.CustomerId,
                    TotalAmount = order.TotalAmount,
                    Items = order.Items.Select(i => new OrderItemDto(i.ProductId, i.Quantity)).ToList()
                }),
                CreatedAt = DateTimeOffset.UtcNow,
                ProcessedAt = null
            };

            _db.OutboxMessages.Add(outboxMessage);
            await _db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);

            return order;
        }
        catch
        {
            await transaction.RollbackAsync(ct);
            throw;
        }
    }
}
```

### Outbox Publisher (Background Service)

A polling publisher reads unprocessed outbox messages and publishes them to Kafka:

```csharp
public sealed class OutboxPublisher : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IProducer<string, string> _producer;
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(1);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

            var messages = await db.OutboxMessages
                .Where(m => m.ProcessedAt == null)
                .OrderBy(m => m.CreatedAt)
                .Take(100)
                .ToListAsync(ct);

            foreach (var msg in messages)
            {
                await _producer.ProduceAsync(
                    $"orders.{msg.Type}",
                    new Message<string, string> { Key = msg.Id.ToString(), Value = msg.Payload },
                    ct);

                msg.ProcessedAt = DateTimeOffset.UtcNow;
            }

            await db.SaveChangesAsync(ct);
            await Task.Delay(PollInterval, ct);
        }
    }
}
```

## Monitoring

The pipeline exposes Prometheus metrics for:

- Order creation rate
- Outbox lag (unprocessed messages)
- Kafka consumer lag per partition
- Saga completion/failure rates

## Lessons Learned

- **Outbox polling interval** directly impacts end-to-end latency — 1s was our sweet spot
- **Idempotency keys** on consumers prevent duplicate processing during rebalances
- **Dead letter topics** with manual retry saved us from data loss on poison messages
- **Partitioning by customer ID** maintained ordering guarantees where needed
