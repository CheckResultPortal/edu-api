import { OrderInputValidationError } from '../application/order-creation-errors';

export interface CreateGuestOrderDraft {
  readonly email?: string;
  readonly phoneNumber: string;
  readonly productPublicId: string;
  readonly quantity: number;
}

export interface ValidatedGuestOrderInput {
  readonly email: string | null;
  readonly phoneNumber: string;
  readonly productPublicId: string;
  readonly quantity: number;
}

const orderRequestKeys = new Set([
  'email',
  'phoneNumber',
  'productPublicId',
  'quantity',
]);

export function parseGuestOrderRequest(
  value: unknown,
): ValidatedGuestOrderInput {
  if (!isPlainObject(value)) {
    throw new OrderInputValidationError('The order body must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (!orderRequestKeys.has(key)) {
      throw new OrderInputValidationError(
        'The order body contains an unsupported property.',
      );
    }
  }

  return validateGuestOrderInput({
    email: optionalString(value, 'email'),
    phoneNumber: requiredString(value, 'phoneNumber'),
    productPublicId: requiredString(value, 'productPublicId'),
    quantity: requiredNumber(value, 'quantity'),
  });
}

export function validateGuestOrderInput(
  input: CreateGuestOrderDraft,
): ValidatedGuestOrderInput {
  if (
    !Number.isSafeInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > 20
  ) {
    throw new OrderInputValidationError(
      'Order quantity must be an integer between 1 and 20.',
    );
  }

  const productPublicId = input.productPublicId.trim().toLowerCase();
  if (!isUuid(productPublicId)) {
    throw new OrderInputValidationError('The product reference is invalid.');
  }

  return {
    email: normalizeEmail(input.email),
    phoneNumber: normalizeGhanaPhoneNumber(input.phoneNumber),
    productPublicId,
    quantity: input.quantity,
  };
}

export function assertOrderIdempotencyKey(value: string): string {
  if (
    value.length < 16 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new OrderInputValidationError(
      'Idempotency-Key must contain 16 to 128 safe ASCII characters.',
    );
  }
  return value;
}

export function normalizeGhanaPhoneNumber(value: string): string {
  const compact = value.trim().replace(/[\s()-]/g, '');
  const canonical = /^0[0-9]{9}$/.test(compact)
    ? `+233${compact.slice(1)}`
    : compact;
  if (!/^\+233[0-9]{9}$/.test(canonical)) {
    throw new OrderInputValidationError(
      'Phone number must be a valid Ghana number.',
    );
  }
  return canonical;
}

function normalizeEmail(value: string | undefined): string | null {
  if (value === undefined) return null;
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new OrderInputValidationError('Email address is invalid.');
  }
  return email;
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const entry = value[key];
  if (typeof entry !== 'string') {
    throw new OrderInputValidationError(`Order ${key} is required.`);
  }
  return entry;
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const entry = value[key];
  if (entry === undefined) return undefined;
  if (typeof entry !== 'string') {
    throw new OrderInputValidationError(`Order ${key} must be a string.`);
  }
  return entry;
}

function requiredNumber(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const entry = value[key];
  if (typeof entry !== 'number') {
    throw new OrderInputValidationError(`Order ${key} is required.`);
  }
  return entry;
}

function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
}
