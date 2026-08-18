export class PaymentInputValidationError extends Error {}

export class PaymentIdempotencyConflictError extends Error {
  constructor() {
    super('The idempotency key was already used for a different request.');
  }
}

export class PaymentOrderUnavailableError extends Error {
  constructor() {
    super('The web order is unavailable for payment initialization.');
  }
}

export class PaymentOrderAlreadyPaidError extends Error {
  constructor() {
    super('The order already has an applied successful payment.');
  }
}

export class PaymentInitializationInProgressError extends Error {
  constructor() {
    super('The original payment initialization is still being resolved.');
  }
}

export class PaymentProviderRejectedError extends Error {
  constructor() {
    super('The payment provider rejected initialization.');
  }
}

export class PaymentProviderUnknownOutcomeError extends Error {
  constructor() {
    super('The payment provider outcome is not yet known.');
  }
}

export class PaymentWebhookAuthenticationError extends Error {
  constructor() {
    super('The payment webhook could not be authenticated.');
  }
}

export class PaymentWebhookPayloadError extends Error {
  constructor() {
    super('The payment webhook payload is invalid.');
  }
}

export class PaymentProcessingUnavailableError extends Error {
  constructor() {
    super('Payment processing is temporarily unavailable.');
  }
}

export class PaymentRateLimitExceededError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Too many payment initialization requests.');
  }
}
