export class OrderInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderInputValidationError';
  }
}

export class OrderProductUnavailableError extends Error {
  constructor() {
    super('The requested product is not available for purchase.');
    this.name = 'OrderProductUnavailableError';
  }
}

export class OrderCurrencyUnsupportedError extends Error {
  constructor() {
    super('The requested product is not available in the launch currency.');
    this.name = 'OrderCurrencyUnsupportedError';
  }
}

export class OrderIdempotencyConflictError extends Error {
  constructor() {
    super('The idempotency key was already used with different order details.');
    this.name = 'OrderIdempotencyConflictError';
  }
}

export class OrderCreationUnavailableError extends Error {
  constructor() {
    super(
      'Order creation could not be completed safely. Retry with the same idempotency key.',
    );
    this.name = 'OrderCreationUnavailableError';
  }
}

export class OrderRateLimitExceededError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Too many order requests were received.');
    this.name = 'OrderRateLimitExceededError';
  }
}
