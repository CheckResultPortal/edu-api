import { OrderInputValidationError } from '../application/order-creation-errors';

export interface CreateWebGuestOrderDraft {
  readonly email: string;
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
  readonly phoneNumber: string;
  readonly productPublicId: string;
  readonly purchaseChannel: PurchaseChannel;
  readonly quantity: number;
}

export type ValidatedWebChannelOrderInput = ValidatedWebGuestOrderInput & {
  readonly email: string;
};

const orderRequestKeys = new Set([
  'email',
  'phoneNumber',
  'productPublicId',
  'quantity',
]);

const orderStatusRequestKeys = new Set([
  'email',
  'orderReference',
  'phoneNumber',
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

export interface GuestOrderStatusRequest {
  readonly email?: string;
  readonly orderReference?: string;
  readonly phoneNumber: string;
}

/**
 * Status lookup intentionally needs a Ghana phone number and one additional
 * identifier. This limits contact-based order enumeration without requiring
 * customers to create an account.
 */
export function parseGuestOrderStatusRequest(
  value: unknown,
): GuestOrderStatusRequest {
  if (!isPlainObject(value)) {
    throw new OrderInputValidationError('The status body must be an object.');
  }
  assertOnlySupportedProperties(value, orderStatusRequestKeys, 'status');

  const email = optionalEmail(value.email);
  const orderReference = optionalOrderReference(value.orderReference);
  if ((email === undefined) === (orderReference === undefined)) {
    throw new OrderInputValidationError(
      'Provide exactly one of email or orderReference alongside phoneNumber.',
    );
  }

  return {
    ...(email === undefined ? {} : { email }),
    ...(orderReference === undefined ? {} : { orderReference }),
    phoneNumber: normalizeGhanaPhoneNumber(
      requiredString(value, 'phoneNumber'),
    ),
  };
}

export interface GuestVoucherRetrievalRequest {
  readonly email?: string;
  readonly phoneNumber?: string;
}

/**
 * A voucher-copy request is authorised by the opaque order reference in the
 * URL plus at least one matching stored contact. If both are supplied, both
 * must match, which is useful when the browser already has both values.
 */
export function parseGuestVoucherRetrievalRequest(
  value: unknown,
): GuestVoucherRetrievalRequest {
  if (!isPlainObject(value)) {
    throw new OrderInputValidationError(
      'The voucher retrieval body must be an object.',
    );
  }
  assertOnlySupportedProperties(
    value,
    new Set(['email', 'phoneNumber']),
    'voucher retrieval',
  );

  const email = optionalEmail(value.email);
  const phoneNumber = optionalPhoneNumber(value.phoneNumber);
  if (email === undefined && phoneNumber === undefined) {
    throw new OrderInputValidationError(
      'Provide the order email address or phone number.',
    );
  }

  return {
    ...(email === undefined ? {} : { email }),
    ...(phoneNumber === undefined ? {} : { phoneNumber }),
  };
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

function optionalEmail(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new OrderInputValidationError('Email address must be a string.');
  }
  return normalizeRequiredEmail(value);
}

function optionalPhoneNumber(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new OrderInputValidationError('Phone number must be a string.');
  }
  return normalizeGhanaPhoneNumber(value);
}

function optionalOrderReference(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new OrderInputValidationError('Order reference must be a string.');
  }
  return normalizeOrderPublicReference(value);
}

export function normalizeOrderPublicReference(value: string): string {
  const reference = value
    .trim()
    .toLowerCase()
    .replace(/^edupay-(?=[1-9][0-9]{5}$)/, '');
  if (
    !isUuid(reference) &&
    !/^[1-9][0-9]{5}$/.test(reference) &&
    !/^edu-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      reference,
    )
  ) {
    throw new OrderInputValidationError('Order reference is invalid.');
  }
  return reference.startsWith('edu-') ? `EDU-${reference.slice(4)}` : reference;
}

function assertOnlySupportedProperties(
  value: Readonly<Record<string, unknown>>,
  supported: ReadonlySet<string>,
  subject: string,
): void {
  for (const key of Object.keys(value)) {
    if (!supported.has(key)) {
      throw new OrderInputValidationError(
        `The ${subject} body contains an unsupported property.`,
      );
    }
  }
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
