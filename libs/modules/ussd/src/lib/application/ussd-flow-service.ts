import type {
  CanonicalUssdRequest,
  CanonicalUssdResponse,
} from './ussd-provider';
import type { UssdSessionData, UssdSessionStore } from './ussd-session-store';

export const USSD_FLOW_SERVICE = Symbol('USSD_FLOW_SERVICE');
export const USSD_PRODUCT_QUERY = Symbol('USSD_PRODUCT_QUERY');
export const USSD_ORDER_CREATOR = Symbol('USSD_ORDER_CREATOR');
export const USSD_PAYMENT_INITIALIZER = Symbol('USSD_PAYMENT_INITIALIZER');

export interface UssdCategoryListItem {
  readonly name: string;
  readonly publicId: string;
}

export interface UssdProductListItem {
  readonly name: string;
  readonly publicId: string;
  readonly sellingPriceMinor: string;
}

export interface UssdProductQuery {
  listActiveCategories(limit: number): Promise<readonly UssdCategoryListItem[]>;
  listActiveProducts(
    catalogGroupPublicId: string,
    limit: number,
  ): Promise<readonly UssdProductListItem[]>;
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
  readonly status: 'FAILED' | 'PENDING' | 'SUCCEEDED' | 'UNKNOWN';
}

export interface UssdPaymentInitializer {
  initialize(command: {
    readonly channel: 'USSD';
    readonly clientIp: string;
    readonly idempotencyKey: string;
    readonly moolreChannel?: string;
    readonly orderPublicReference: string;
    readonly payerPhoneNumber: string;
  }): Promise<UssdPaymentInitializationResult>;
}

export interface UssdFlowConfiguration {
  readonly maximumProducts: number;
  readonly paymentPendingTtlMilliseconds: number;
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
 * The guest purchase conversation: category -> product -> quantity -> delivery
 * -> (email) -> confirm -> order + Moolre prompt. The session
 * never waits for payment completion and holds no payment truth.
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

    const sessionId = sessionIdentifier(request);
    let session = await this.sessions.get(sessionId);
    if (request.isNewSession && session?.state !== 'PAYMENT_PENDING') {
      await this.sessions.delete(sessionId);
      session = null;
    }
    if (session === null || session.state === undefined) {
      session = { state: 'CATEGORY' };
    }

    switch (session.state) {
      case 'CATEGORY':
        return this.handleCategorySelection(request, session);
      case 'PRODUCT':
        return this.handleProductSelection(request, session);
      case 'QUANTITY':
        return this.handleQuantity(request, session);
      case 'DELIVERY':
        return this.handleDeliveryPreference(request, session);
      case 'EMAIL':
        return this.handleEmailEntry(request, session);
      case 'CONFIRM':
        return this.handleConfirmation(request, session, context);
      case 'PAYMENT_PENDING':
        return this.handlePendingPayment(request, session, context);
    }
  }

  private async handleCategorySelection(
    request: CanonicalUssdRequest,
    session: UssdSessionData,
  ): Promise<CanonicalUssdResponse> {
    const categories = await this.products.listActiveCategories(
      this.configuration.maximumProducts,
    );
    if (categories.length === 0) {
      return {
        continueSession: false,
        message: 'No vouchers are available right now. Try again later.',
      };
    }

    if (!session.categoryMenuShown) {
      await this.sessions.set(
        sessionIdentifier(request),
        { state: 'CATEGORY', categoryMenuShown: true },
        this.configuration.sessionTtlMilliseconds,
      );
      return {
        continueSession: true,
        message: renderCategoryMenu(categories),
      };
    }

    const choice = parseChoice(request.input, categories.length);
    const selected = choice === null ? undefined : categories[choice - 1];
    if (selected === undefined) {
      return {
        continueSession: true,
        message: `Invalid option.\n${renderCategoryMenu(categories)}`,
      };
    }

    const products = await this.products.listActiveProducts(
      selected.publicId,
      this.configuration.maximumProducts,
    );
    if (products.length === 0) {
      return {
        continueSession: true,
        message: `No vouchers are available in ${truncate(selected.name, 36)}.\n${renderCategoryMenu(categories)}`,
      };
    }

    await this.sessions.set(
      sessionIdentifier(request),
      {
        catalogGroupName: truncate(selected.name, 36),
        catalogGroupPublicId: selected.publicId,
        productMenuShown: true,
        state: 'PRODUCT',
      },
      this.configuration.sessionTtlMilliseconds,
    );
    return {
      continueSession: true,
      message: renderProductMenu(products, selected.name),
    };
  }

  private async handleProductSelection(
    request: CanonicalUssdRequest,
    session: UssdSessionData,
  ): Promise<CanonicalUssdResponse> {
    if (session.catalogGroupPublicId === undefined) {
      await this.sessions.set(
        sessionIdentifier(request),
        { state: 'CATEGORY' },
        this.configuration.sessionTtlMilliseconds,
      );
      return {
        continueSession: true,
        message: 'Choose a voucher category first.',
      };
    }
    const page = await this.products.listActiveProducts(
      session.catalogGroupPublicId,
      this.configuration.maximumProducts,
    );
    if (page.length === 0) {
      await this.sessions.set(
        sessionIdentifier(request),
        { state: 'CATEGORY' },
        this.configuration.sessionTtlMilliseconds,
      );
      return {
        continueSession: true,
        message:
          'Those vouchers are no longer available. Choose another category.',
      };
    }

    if (!session.productMenuShown) {
      await this.sessions.set(
        sessionIdentifier(request),
        { state: 'PRODUCT', productMenuShown: true },
        this.configuration.sessionTtlMilliseconds,
      );
      return {
        continueSession: true,
        message: renderProductMenu(
          page,
          session.catalogGroupName ?? 'Vouchers',
        ),
      };
    }

    const choice = parseChoice(request.input, page.length);
    if (choice === null) {
      return {
        continueSession: true,
        message: `Invalid option.\n${renderProductMenu(page, session.catalogGroupName ?? 'Vouchers')}`,
      };
    }
    const selected = page[choice - 1];
    if (selected === undefined) {
      return {
        continueSession: true,
        message: `Invalid option.\n${renderProductMenu(page, session.catalogGroupName ?? 'Vouchers')}`,
      };
    }

    await this.sessions.set(
      sessionIdentifier(request),
      {
        catalogGroupName: session.catalogGroupName,
        catalogGroupPublicId: session.catalogGroupPublicId,
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
      sessionIdentifier(request),
      { ...session, quantity, state: 'DELIVERY' },
      this.configuration.sessionTtlMilliseconds,
    );
    return {
      continueSession: true,
      message: renderDeliveryMenu(),
    };
  }

  private async handleDeliveryPreference(
    request: CanonicalUssdRequest,
    session: UssdSessionData,
  ): Promise<CanonicalUssdResponse> {
    const preferences: Record<
      string,
      'SMS_ONLY' | 'EMAIL_ONLY' | 'SMS_AND_EMAIL'
    > = {
      '1': 'SMS_ONLY',
      '2': 'EMAIL_ONLY',
      '3': 'SMS_AND_EMAIL',
    };
    const preference = preferences[request.input.trim()];
    if (preference === undefined) {
      return {
        continueSession: true,
        message: `Invalid option.\n${renderDeliveryMenu()}`,
      };
    }

    if (preference === 'SMS_ONLY') {
      return this.enterConfirmation(sessionIdentifier(request), {
        ...session,
        deliveryPreference: preference,
        email: undefined,
      });
    }

    await this.sessions.set(
      sessionIdentifier(request),
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

    return this.enterConfirmation(sessionIdentifier(request), {
      ...session,
      email,
    });
  }

  private async enterConfirmation(
    msisdn: string,
    session: UssdSessionData,
  ): Promise<CanonicalUssdResponse> {
    const confirmId = randomConfirmId();
    await this.sessions.set(
      msisdn,
      { ...session, confirmId, state: 'CONFIRM' },
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
      await this.sessions.delete(sessionIdentifier(request));
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
      await this.sessions.delete(sessionIdentifier(request));
      return {
        continueSession: false,
        message: 'This session expired. Please dial again.',
      };
    }

    const phoneNumber = canonicalizeMsisdn(request.msisdn);
    if (phoneNumber === null) {
      await this.sessions.delete(sessionIdentifier(request));
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

      const payment = await this.paymentInitializer.initialize({
        channel: 'USSD',
        clientIp: context.clientIp,
        idempotencyKey: `ussd-pay-${session.confirmId}`,
        ...(request.moolreChannel === undefined
          ? {}
          : { moolreChannel: request.moolreChannel }),
        orderPublicReference: order.publicReference,
        payerPhoneNumber: phoneNumber,
      });

      if (payment.status === 'FAILED') {
        await this.sessions.delete(sessionIdentifier(request));
        return {
          continueSession: false,
          message: 'We could not start your payment. Please dial again later.',
        };
      }

      await this.persistPendingPayment(
        sessionIdentifier(request),
        session,
        order.publicReference,
      );
      if (payment.status === 'UNKNOWN') {
        return {
          continueSession: false,
          message:
            'Your payment request may be processing. Do not start another payment. ' +
            'Your voucher will be delivered after verification.',
        };
      }
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
      await this.sessions.delete(sessionIdentifier(request));
      return {
        continueSession: false,
        message:
          'We could not start your payment right now. Please dial again later.',
      };
    }
  }

  private async handlePendingPayment(
    request: CanonicalUssdRequest,
    session: UssdSessionData,
    context: UssdFlowContext,
  ): Promise<CanonicalUssdResponse> {
    const phoneNumber = canonicalizeMsisdn(request.msisdn);
    if (
      phoneNumber === null ||
      session.confirmId === undefined ||
      session.paymentOrderPublicReference === undefined
    ) {
      await this.sessions.delete(sessionIdentifier(request));
      return {
        continueSession: false,
        message: 'This payment session expired. Please dial again.',
      };
    }

    try {
      const payment = await this.paymentInitializer.initialize({
        channel: 'USSD',
        clientIp: context.clientIp,
        idempotencyKey: `ussd-pay-${session.confirmId}`,
        ...(request.moolreChannel === undefined
          ? {}
          : { moolreChannel: request.moolreChannel }),
        orderPublicReference: session.paymentOrderPublicReference,
        payerPhoneNumber: phoneNumber,
      });
      if (payment.status === 'SUCCEEDED') {
        await this.sessions.delete(sessionIdentifier(request));
        return {
          continueSession: false,
          message: 'Payment confirmed. Your voucher will be delivered shortly.',
        };
      }
      if (payment.status === 'FAILED') {
        await this.sessions.delete(sessionIdentifier(request));
        return {
          continueSession: false,
          message: 'Your payment did not complete. Please dial again to retry.',
        };
      }
    } catch {
      // A database/provider outage cannot turn a pending payment into a new one.
    }

    return {
      continueSession: false,
      message:
        'Your payment is still being verified. Do not start another payment. ' +
        'Your voucher will be delivered after verification.',
    };
  }

  private async persistPendingPayment(
    msisdn: string,
    session: UssdSessionData,
    orderPublicReference: string,
  ): Promise<void> {
    await this.sessions.set(
      msisdn,
      {
        confirmId: session.confirmId,
        paymentOrderPublicReference: orderPublicReference,
        state: 'PAYMENT_PENDING',
      },
      this.configuration.paymentPendingTtlMilliseconds,
    );
  }
}

function renderCategoryMenu(
  categories: readonly UssdCategoryListItem[],
): string {
  const lines = categories.map(
    (category, index) => `${index + 1}. ${truncate(category.name, 40)}`,
  );
  return ['Choose voucher category:', ...lines]
    .join('\n')
    .slice(0, MAXIMUM_INPUT_LENGTH);
}

function renderProductMenu(
  products: readonly UssdProductListItem[],
  categoryName: string,
): string {
  const lines = products.map(
    (product, index) =>
      `${index + 1}. ${truncate(product.name, 40)} ${formatCedis(product.sellingPriceMinor)}`,
  );
  return [`${truncate(categoryName, 36)}:`, ...lines]
    .join('\n')
    .slice(0, MAXIMUM_INPUT_LENGTH);
}

function renderDeliveryMenu(): string {
  return [
    'Choose delivery method:',
    '1. SMS only',
    '2. Email only',
    '3. SMS and Email',
  ].join('\n');
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

function parseChoice(input: string, maximum: number): number | null {
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

function sessionIdentifier(request: CanonicalUssdRequest): string {
  return request.sessionId ?? request.msisdn;
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
