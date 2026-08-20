# When to Mock — 何时 Mock

只在**系统边界**上 mock：

- 外部 API（支付、邮件等）
- 数据库（有时——优先用测试库）
- 时间/随机性
- 文件系统（有时）

不要 mock：

- 你自己的类/模块
- 内部协作者
- 任何你控制的东西

## 为可 Mock 性而设计

在系统边界上，设计易于 mock 的接口：

**1. 使用依赖注入**

把外部依赖传进来，而不是在内部创建：

```typescript
// 易于 mock
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// 难以 mock
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
```

**2. 偏好 SDK 风格接口而非通用 fetcher**

为每个外部操作创建具体函数，而不是一个带条件逻辑的通用函数：

```typescript
// GOOD: 每个函数可独立 mock
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  getOrders: (userId) => fetch(`/users/${userId}/orders`),
  createOrder: (data) => fetch('/orders', { method: 'POST', body: data }),
};

// BAD: mock 需要在内部写条件逻辑
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
};
```

SDK 方式意味着：

- 每个 mock 返回一种具体形状
- 测试 setup 无条件逻辑
- 更容易看清测试走了哪些端点
- 每个端点有类型安全
