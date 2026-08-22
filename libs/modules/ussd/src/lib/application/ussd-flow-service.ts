import type {
  CanonicalUssdRequest,
  CanonicalUssdResponse,
} from './ussd-provider';
import type { UssdSessionData, UssdSessionStore } from './ussd-session-store';

export const USSD_FLOW_SERVICE = Symbol('USSD_FLOW_SERVICE');
export const USSD_PRODUCT_QUERY = Symbol('USSD_PRODUCT_QUERY');
export const USSD_ORDER_CREATOR = Symbol('USSD_ORDER_CREATOR');
export const USSD_PAYMENT_INITIALIZER = Symbol('USSD_PAYMENT_INITIALIZER');

export interface UssdProductListItem {
  readonly name: string;
  readonly publicId: string;
  readonly sellingPriceMinor: string;
}

export interface UssdProductQuery {
  listActiveProducts(limit: number): Promise<readonly UssdProductListItem[]>;
}

export interface UssdOrderCreationCommand {
  readonly deliveryPreference: 'SMS_ONLY' | 'EMAIL_ONLY' | 'SMS_AND_EMAIL';
  readonly email?: string;
  readonly idempotencyKey: string;
  readonly phoneNumber: string;
  readonly productPublicId: string;
  readonly quantity: number;
}

export interface UssdCreatedOrder {
  readonly currency: string;
  readonly publicReference: string;
  readonly totalPriceMinor: string;
}

export interface UssdOrderCreator {
  create(
    command: UssdOrderCreationCommand,
    context: { readonly clientIp: string },
  ): Promise<UssdCreatedOrder>;
}

export interface UssdPaymentInitializationResult {
  readonly status: 'PENDING' | 'SUCCEEDED';
}

export interface UssdPaymentInitializer {
  initialize(command: {
    readonly channel: 'USSD';
    readonly clientIp: string;
    readonly idempotencyKey: string;
    readonly orderPublicReference: string;
    readonly payerPhoneNumber: string;
  }): Promise<UssdPaymentInitializationResult>;
}

export interface UssdFlowConfiguration {
  readonly maximumProducts: number;
  readonly quantityMaximum: number;
  readonly sessionTtlMilliseconds: number;
}

export interface UssdFlowContext {
  readonly clientIp: string;
}

/** Injectable flow contract; the class below is the only implementation. */
export type UssdFlowService = DefaultUssdFlowService;

const MAXIMUM_INPUT_LENGTH = 182;
const MAXIMUM_EMAIL_LENGTH = 320;

/**
 * The guest purchase conversation: product -> quantity -> delivery ->
 * (email) -> confirm -> order + Moolre prompt. The session never waits for
 * payment completion and holds no payment truth.
 */
export class DefaultUssdFlowService {
  constructor(
    private readonly sessions: UssdSessionStore,
    private readonly products: UssdProductQuery,
    private readonly orderCreator: UssdOrderCreator,
    private readonly paymentInitializer: UssdPaymentInitializer,
    private readonly configuration: UssdFlowConfiguration,
  ) {}

  async handle(
    request: CanonicalUssdRequest,
    context: UssdFlowContext,
  ): Promise<CanonicalUssdResponse> {
    if (!isRoutableMsisdn(request.msisdn)) {
      return { continueSession: false, message: 'Invalid session.' };
    }

    if (request.isNewSession) {
      await this.sessions.delete(request.msisdn);
    }
    let session = await this.sessions.get(request.msisdn);
    if (session === null || session.state === undefined) {
      session = { state: 'PRODUCT' };
    }

    switch (session.state) {
      case 'PRODUCT':
        return this.handleProductSelection(request, session, context);
      case 'QUANTITY':
        return this.handleQuantity(request, session);
      case 'DELIVERY':
        return this.handleDeliveryPreference(request, session);
      case 'EMAIL':
        return this.handleEmailEntry(request, session);
      case 'CONFIRM':
        return this.handleConfirmation(request, session, context);
    }
  }

  private async handleProductSelection(
    request: CanonicalUssdRequest,
    session: UssdSessionData,
    context: UssdFlowContext,
  ): Promise<CanonicalUssdResponse> {
    const page = await this.products.listActiveProducts(
      this.configuration.maximumProducts,
    );
    if (page.length === 0) {
      return {
        continueSession: false,
        message: 'No products are available right now. Try again later.',
      };
    }

    if (!session.productMenuShown) {
      await this.sessions.set(
        request.msisdn,
        { state: 'PRODUCT', productMenuShown: true },
        this.configuration.sessionTtlMilliseconds,
      );
      return {
        continueSession: true,
        message: renderProductMenu(page),
      };
    }

    const choice = parseChoice(request.input, page.length);
    if (choice === null) {
      return {
        continueSession: true,
        message: `Invalid option.\n${renderProductMenu(page)}`,
      };
    }
    const selected = page[choice - 1];
    if (selected === undefined) {
      return {
        continueSession: true,
        message: `Invalid option.\n${renderProductMenu(page)}`,
      };
    }

    await this.sessions.set(
      request.msisdn,
      {
        productPublicId: selected.publicId,
        productName: truncate(selected.name, 40),
        state: 'QUANTITY',
        unitPriceMinor: selected.sellingPriceMinor,
      },
      this.configuration.sessionTtlMilliseconds,
    );
    return {
      continueSession: true,
      message:
        `${truncate(selected.name, 40)}\n` +
        `Price: ${formatCedis(selected.sellingPriceMinor)}\n` +
        `Enter quantity (1-${this.configuration.quantityMaximum}):`,
    };
  }

  private async handleQuantity(
    request: CanonicalUssdRequest,
    session: UssdSessionData,
  ): Promise<CanonicalUssdResponse> {
    const quantity = Number.parseInt(request.input, 10);
    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > this.configuration.quantityMaximum ||
      request.input.trim() !== String(quantity)
    ) {
      return {
        continueSession: true,
        message: `Invalid quantity.\nEnter quantity (1-${this.configuration.quantityMaximum}):`,
      };
    }

    await this.sessions.set(
      request.msisdn,
      { ...session, quantity, state: 'DELIVERY' },
      this.configuration.sessionTtlMilliseconds,
    );
    return {
      continueSession: true,
      message: 'How should we reach you?\n1. SMS only\n2. Email only\n3. SMS and Email',
    };
  }

  private async handleDeliveryPreference(
    request: CanonicalUssdRequest,
    session: UssdSessionData,
  ): Promise<CanonicalUssdResponse> {
    const preferences: Record<string, 'SMS_ONLY' | 'EMAIL_ONLY' | 'SMS_AND_EMAIL'> = {
      '1': 'SMS_ONLY',
      '2': 'EMAIL_ONLY',
      '3': 'SMS_AND_EMAIL',
    };
    const preference = preferences[request.input.trim()];
    if (preference === undefined) {
      return {
        continueSession: true,
        message:
          'Invalid option.\nHow should we reach you?\n1. SMS only\n2. Email only\n3. SMS and Email',
      };
    }

    if (preference === 'SMS_ONLY') {
      return this.enterConfirmation(request.msisdn, {
        ...session,
        deliveryPreference: preference,
        email: undefined,
        state: 'CONFIRM',
      });
    }

    await this.sessions.set(
      request.msisdn,
      { ...session, deliveryPreference: preference, state: 'EMAIL' },
      this.configuration.sessionTtlMilliseconds,
    );
    return {
      continueSession: true,
      message: 'Enter your email address:',
    };
  }

  private async handleEmailEntry(
    request: CanonicalUssdRequest,
    session: UssdSessionData,
  ): Promise<CanonicalUssdResponse> {
    const email = request.input.trim().toLowerCase();
    if (
      email.length < 3 ||
      email.length > MAXIMUM_EMAIL_LENGTH ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return {
        continueSession: true,
        message: 'Invalid email.\nEnter your email address:',
      };
    }

    return this.enterConfirmation(request.msisdn, {
      ...session,
      email,
      state: 'CONFIRM',
    });
  }

  private async enterConfirmation(
    msisdn: string,
    session: UssdSessionData,
  ): Promise<CanonicalUssdResponse> {
    const confirmId = randomConfirmId();
    await this.sessions.set(
      msisdn,
      { ...session, confirmId },
      this.configuration.sessionTtlMilliseconds,
    );
    return {
      continueSession: true,
      message: renderSummary(session),
    };
  }

  private async handleConfirmation(
    request: CanonicalUssdRequest,
    session: UssdSessionData,
    context: UssdFlowContext,
  ): Promise<CanonicalUssdResponse> {
    const choice = request.input.trim();
    if (choice === '0' || choice.toUpperCase() === 'CANCEL') {
      await this.sessions.delete(request.msisdn);
      return { continueSession: false, message: 'Order cancelled.' };
    }
    if (choice !== '1') {
      return {
        continueSession: true,
        message: `${renderSummary(session)}\nReply 1 to pay or 0 to cancel.`,
      };
    }

    // A confirmId means a previous attempt already ran for this screen;
    // duplicates must never create a second order or second payment prompt.
    if (session.confirmId === undefined) {
      await this.sessions.delete(request.msisdn);
      return {
        continueSession: false,
        message: 'This session expired. Please dial again.',
      };
    }

    const phoneNumber = canonicalizeMsisdn(request.msisdn);
    if (phoneNumber === null) {
      await this.sessions.delete(request.msisdn);
      return { continueSession: false, message: 'Invalid session.' };
    }

    try {
      const order = await this.orderCreator.create(
        {
          deliveryPreference: session.deliveryPreference ?? 'SMS_ONLY',
          ...(session.email === undefined ? {} : { email: session.email }),
          idempotencyKey: `ussd-order-${session.confirmId}`,
          phoneNumber,
          productPublicId: session.productPublicId ?? '',
          quantity: session.quantity ?? 1,
        },
        context,
      );

      await this.paymentInitializer.initialize({
        channel: 'USSD',
        clientIp: context.clientIp,
        idempotencyKey: `ussd-pay-${session.confirmId}`,
        orderPublicReference: order.publicReference,
        payerPhoneNumber: phoneNumber,
      });

      await this.sessions.delete(request.msisdn);
      return {
        continueSession: false,
        message:
          `Approve the Mobile Money prompt on ${phoneNumber} ` +
          `for ${formatCedis(order.totalPriceMinor)}.\n` +
          'Your voucher will be delivered after payment.',
      };
    } catch {
      // The order/payment services own their durable state and retries; the
      // handset only needs a safe terminal message without internal detail.
      await this.sessions.delete(request.msisdn);
      return {
        continueSession: false,
        message:
          'We could not start your payment right now. Please dial again later.',
      };
    }
  }
}

function renderProductMenu(
  products: readonly UssdProductListItem[],
): string {
  const lines = products.map(
    (product, index) =>
      `${index + 1}. ${truncate(product.name, 40)} ${formatCedis(product.sellingPriceMinor)}`,
  );
  return ['Buy a voucher:', ...lines].join('\n').slice(0, MAXIMUM_INPUT_LENGTH);
}

function renderSummary(session: UssdSessionData): string {
  const unit = session.unitPriceMinor ?? '0';
  const quantity = session.quantity ?? 0;
  const total = BigInt(unit) * BigInt(quantity);
  return [
    'Confirm order:',
    `${truncate(session.productName ?? '', 40)} x${quantity}`,
    `Total: ${formatCedis(total.toString())}`,
    `Deliver via: ${deliveryLabel(session.deliveryPreference)}`,
    'Reply 1 to pay or 0 to cancel.',
  ].join('\n');
}

function deliveryLabel(
  preference: UssdSessionData['deliveryPreference'],
): string {
  switch (preference) {
    case 'EMAIL_ONLY':
      return 'Email';
    case 'SMS_AND_EMAIL':
      return 'SMS + Email';
    default:
      return 'SMS';
  }
}

function parseChoice(
  input: string,
  maximum: number,
): number | null {
  const trimmed = input.trim();
  if (!/^[0-9]{1,3}$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  if (value < 1 || value > maximum) return null;
  return value;
}

/** 233XXXXXXXXX (gateway format) -> +233XXXXXXXXX (order/E.164 format). */
export function canonicalizeMsisdn(msisdn: string): string | null {
  if (/^233[0-9]{9}$/.test(msisdn)) return `+${msisdn}`;
  if (/^\+233[0-9]{9}$/.test(msisdn)) return msisdn;
  if (/^0[0-9]{9}$/.test(msisdn)) return `+233${msisdn.slice(1)}`;
  return null;
}

function isRoutableMsisdn(msisdn: string): boolean {
  return /^[0-9]{9,15}$/.test(msisdn);
}

function randomConfirmId(): string {
  const bytes = Buffer.alloc(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytes.toString('hex');
}

function formatCedis(minorAmount: string): string {
  const minor = BigInt(minorAmount);
  const cedis = minor / BigInt(100);
  const pesewas = minor % BigInt(100);
  return `GHS ${cedis}.${pesewas.toString().padStart(2, '0')}`;
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength - 1)}…`;
}
