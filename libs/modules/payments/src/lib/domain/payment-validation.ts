import { PaymentInputValidationError } from '../application/payment-errors';

export function assertPaymentOrderReference(value: string): string {
  const reference = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      reference,
    )
  ) {
    throw new PaymentInputValidationError('The order reference is invalid.');
  }
  return reference;
}

export function assertPaymentIdempotencyKey(value: string): string {
  if (
    value.length < 16 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new PaymentInputValidationError(
      'Idempotency-Key must contain 16 to 128 safe ASCII characters.',
    );
  }
  return value;
}

export function assertEmptyPaymentInitializationBody(value: unknown): void {
  if (
    value === undefined ||
    value === null ||
    (typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  ) {
    return;
  }
  throw new PaymentInputValidationError(
    'Payment initialization does not accept request properties.',
  );
}
