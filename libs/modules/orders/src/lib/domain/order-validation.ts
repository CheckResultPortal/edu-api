import { OrderInputValidationError } from '../application/order-creation-errors';

export interface CreateWebGuestOrderDraft {
  readonly email: string;
  readonly firstName: string;
  readonly phoneNumber: string;
  readonly productPublicId: string;
  readonly quantity: number;
}

export const PURCHASE_CHANNELS = ['WEB', 'USSD'] as const;
export type PurchaseChannel = (typeof PURCHASE_CHANNELS)[number];

export const ORDER_DELIVERY_PREFERENCES = [
  'SMS_ONLY',
  'EMAIL_ONLY',
  'SMS_AND_EMAIL',
] as const;

export type OrderDeliveryPreference =
  (typeof ORDER_DELIVERY_PREFERENCES)[number];

export interface ValidatedWebGuestOrderInput {
  readonly deliveryPreference: OrderDeliveryPreference;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly phoneNumber: string;
  readonly productPublicId: string;
  readonly purchaseChannel: PurchaseChannel;
  readonly quantity: number;
}

/**
 * Web orders always carry a first name and email; USSD orders derive the
 * phone from the session and may omit both.
 */
export type ValidatedWebChannelOrderInput = ValidatedWebGuestOrderInput & {
  readonly email: string;
  readonly firstName: string;
};

const orderRequestKeys = new Set([
  'email',
  'firstName',
  'phoneNumber',
  'productPublicId',
  'quantity',
]);

export function parseGuestOrderRequest(
  value: unknown,
): ValidatedWebChannelOrderInput {
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

  return validateWebGuestOrderInput({
    email: requiredString(value, 'email'),
    firstName: requiredString(value, 'firstName'),
    phoneNumber: requiredString(value, 'phoneNumber'),
    productPublicId: requiredString(value, 'productPublicId'),
    quantity: requiredNumber(value, 'quantity'),
  });
}

export function validateWebGuestOrderInput(
  input: CreateWebGuestOrderDraft,
): ValidatedWebChannelOrderInput {
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

  const email = normalizeRequiredEmail(input.email);

  return {
    deliveryPreference: 'SMS_AND_EMAIL',
    email,
    firstName: normalizeFirstName(input.firstName),
    phoneNumber: normalizeGhanaPhoneNumber(input.phoneNumber),
    productPublicId,
    purchaseChannel: 'WEB',
    quantity: input.quantity,
  };
}

export interface CreateUssdGuestOrderDraft {
  readonly deliveryPreference: OrderDeliveryPreference;
  readonly email?: string;
  readonly phoneNumber: string;
  readonly productPublicId: string;
  readonly quantity: number;
}

export function validateUssdGuestOrderInput(
  input: CreateUssdGuestOrderDraft,
): ValidatedWebGuestOrderInput {
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

  const preference = input.deliveryPreference;
  const requiresEmail =
    preference === 'EMAIL_ONLY' || preference === 'SMS_AND_EMAIL';
  if (requiresEmail && input.email === undefined) {
    throw new OrderInputValidationError(
      'The selected delivery preference requires an email address.',
    );
  }
  if (!requiresEmail && input.email !== undefined) {
    throw new OrderInputValidationError(
      'The selected delivery preference must not include an email address.',
    );
  }

  return {
    deliveryPreference: preference,
    email: requiresEmail ? normalizeRequiredEmail(input.email ?? '') : null,
    firstName: null,
    phoneNumber: normalizeGhanaPhoneNumber(input.phoneNumber),
    productPublicId,
    purchaseChannel: 'USSD',
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

function normalizeFirstName(value: string): string {
  const firstName = value.trim().replace(/\s+/g, ' ');
  if (
    firstName.length === 0 ||
    Array.from(firstName).length > 100 ||
    containsAsciiControl(firstName)
  ) {
    throw new OrderInputValidationError(
      'First name must contain 1 to 100 valid characters.',
    );
  }
  return firstName;
}

function containsAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function normalizeRequiredEmail(value: string): string {
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
