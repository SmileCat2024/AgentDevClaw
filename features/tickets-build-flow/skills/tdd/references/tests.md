# Good and Bad Tests — 好测试与坏测试

## Good Tests

**Integration 风格**：通过真实接口测试，而不是 mock 内部零件。

```typescript
// GOOD: 测试可观察行为
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

特征：

- 测试用户/调用方关心的行为
- 只使用公开 API
- 在内部重构后存活
- 描述 WHAT，不描述 HOW
- 每个测试一个逻辑断言

## Bad Tests

**实现细节测试**：耦合内部结构。

```typescript
// BAD: 测试实现细节
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

红旗信号：

- Mock 内部协作者
- 测试私有方法
- 断言调用次数/顺序
- 行为没变的重构让测试挂掉
- 测试名描述 HOW 而不是 WHAT
- 绕过接口用外部手段验证

```typescript
// BAD: 绕过接口验证
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

// GOOD: 通过接口验证
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

**同义反复测试（Tautological）**：期望值复述了实现，测试构造上必然通过。

```typescript
// BAD: 期望值用代码自己的方式重算
test("calculateTotal sums line items", () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});

// GOOD: 期望值是独立的已知字面量
test("calculateTotal sums line items", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```
