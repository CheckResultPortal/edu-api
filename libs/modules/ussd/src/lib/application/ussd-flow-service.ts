import { createHash } from 'node:crypto';
import type {
  CanonicalUssdRequest,
  CanonicalUssdResponse,
} from './ussd-provider';
import type { UssdSessionData, UssdSessionStore } from './ussd-session-store';

export interface UssdVoucherRetrieval {
  lookup(input: {
    phoneNumber: string;
    orderReference: string;
  }): Promise<{ status: string; canRequestVoucherEmail: boolean } | null>;
  request(input: {
    orderReference: string;
    contact: { phoneNumber: string };
    idempotencyKey: string;
  }): Promise<unknown>;
}

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
  readonly customerCode?: string | null;
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
  readonly supportPhone?: string;
}

export interface UssdFlowContext {
  readonly clientIp: string;
}

/** Injectable flow contract; the class below is the only implementation. */
export type UssdFlowService = DefaultUssdFlowService;

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
    private readonly retrieval: UssdVoucherRetrieval,
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
      return this.showHome(request);
    }

    switch (session.state) {
      case 'HOME':
        return this.handleHome(request);
      case 'RETRIEVAL_REFERENCE':
        return this.handleRetrievalReference(request);
      case 'RETRIEVAL_CONFIRM':
        return this.handleRetrievalConfirmation(request, session);
      case 'RETRIEVAL_COMPLETE':
        return {
          continueSession: false,
          message: 'Your voucher email copy request is queued.',
        };
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

  private async showHome(
    request: CanonicalUssdRequest,
    prefix = '',
  ): Promise<CanonicalUssdResponse> {
    await this.sessions.set(
      sessionIdentifier(request),
      { state: 'HOME' },
      this.configuration.sessionTtlMilliseconds,
    );
    return {
      continueSession: true,
      message: [
        prefix,
        'Welcome to EduVoucherStore',
        '1. Buy voucher',
        '2. Retrieve voucher',
        ...(this.supportPhone() ? ['0. Support'] : []),
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  private supportPhone(): string | undefined {
    const phone = this.configuration.supportPhone?.trim();
    return phone && !/^(?:233)?0+$/.test(phone.replace(/\D/g, ''))
      ? phone
      : undefined;
  }

  private async handleHome(
    request: CanonicalUssdRequest,
  ): Promise<CanonicalUssdResponse> {
    const input = request.input.trim().toUpperCase();
    if (input === '0' || input === 'SUPPORT') {
      await this.sessions.delete(sessionIdentifier(request));
      return {
        continueSession: false,
        message: this.supportPhone()
          ? `EduVoucher Support:\nCall: ${this.supportPhone()}`
          : 'Support contact is currently unavailable. Please try again later.',
      };
    }
    if (input === '1')
      return this.handleCategorySelection(
        { ...request, input: '' },
        { state: 'CATEGORY' },
      );
    if (input === '2') {
      await this.sessions.set(
        sessionIdentifier(request),
        { state: 'RETRIEVAL_REFERENCE' },
        this.configuration.sessionTtlMilliseconds,
      );
      return {
        continueSession: true,
        message: 'Enter your order reference:\n0. Home',
      };
    }
    return this.showHome(request, 'Invalid option.');
  }

  private async handleRetrievalReference(
    request: CanonicalUssdRequest,
  ): Promise<CanonicalUssdResponse> {
    if (request.input.trim() === '0') return this.showHome(request);
    const reference = request.input.trim().toLowerCase();
    if (
      !/^[1-9][0-9]{5}$/.test(reference) &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        reference,
      )
    )
      return {
        continueSession: true,
        message: 'Enter your six-digit code or full order reference:\n0. Home',
      };
    const phoneNumber = canonicalizeMsisdn(request.msisdn);
    if (phoneNumber === null)
      return { continueSession: false, message: 'Invalid session.' };
    try {
      const order = await this.retrieval.lookup({
        phoneNumber,
        orderReference: reference,
      });
      if (order === null)
        return {
          continueSession: true,
          message:
            'No matching order. Check the reference and use the phone used to purchase.\n0. Home',
        };
      if (!order.canRequestVoucherEmail) {
        await this.sessions.delete(sessionIdentifier(request));
        const status =
          order.status === 'WAITING_FOR_STOCK'
            ? 'Payment received. Waiting for stock.'
            : order.status === 'PAYMENT_PENDING'
              ? 'Payment is still being verified.'
              : order.status === 'PAYMENT_FAILED'
                ? 'Payment did not complete.'
                : 'Email copies are unavailable for this order.';
        return {
          continueSession: false,
          message: [
            status,
            ...(this.supportPhone() ? [`Support: ${this.supportPhone()}`] : []),
          ].join('\n'),
        };
      }
      const key =
        'ussd-retrieval-' +
        createHash('sha256')
          .update(
            JSON.stringify([
              sessionIdentifier(request),
              phoneNumber,
              reference,
            ]),
          )
          .digest('hex');
      await this.sessions.set(
        sessionIdentifier(request),
        {
          state: 'RETRIEVAL_CONFIRM',
          retrievalOrderReference: reference,
          retrievalKey: key,
        },
        this.configuration.sessionTtlMilliseconds,
      );
      return {
        continueSession: true,
        message:
          'Send the same vouchers to the email saved on your order?\n1. Send email copy\n0. Cancel',
      };
    } catch {
      return {
        continueSession: true,
        message: 'Unable to retrieve now. Please try later.\n0. Home',
      };
    }
  }

  private async handleRetrievalConfirmation(
    request: CanonicalUssdRequest,
    session: UssdSessionData,
  ): Promise<CanonicalUssdResponse> {
    if (request.input.trim() === '0') {
      await this.sessions.delete(sessionIdentifier(request));
      return { continueSession: false, message: 'Retrieval cancelled.' };
    }
    if (request.input.trim() !== '1')
      return {
        continueSession: true,
        message: '1. Send email copy\n0. Cancel',
      };
    const phoneNumber = canonicalizeMsisdn(request.msisdn);
    if (
      !phoneNumber ||
      !session.retrievalOrderReference ||
      !session.retrievalKey
    )
      return this.showHome(request, 'Session expired.');
    try {
      await this.retrieval.request({
        orderReference: session.retrievalOrderReference,
        contact: { phoneNumber },
        idempotencyKey: session.retrievalKey,
      });
      await this.sessions.set(
        sessionIdentifier(request),
        { state: 'RETRIEVAL_COMPLETE' },
        this.configuration.sessionTtlMilliseconds,
      );
      return {
        continueSession: false,
        message: 'Your voucher email copy request is queued.',
      };
    } catch {
      return {
        continueSession: true,
        message:
          'Unable to confirm the request yet.\n1. Retry same request\n0. Cancel',
      };
    }
  }

  private async handleCategorySelection(
    request: CanonicalUssdRequest,
    session: UssdSessionData,
  ): Promise<CanonicalUssdResponse> {
    if (request.input.trim() === '0' && session.categoryMenuShown)
      return this.showHome(request);
    const categories = await this.products.listActiveCategories(
      this.configuration.maximumProducts,
    );
    if (categories.length === 0)
      return this.showHome(request, 'No vouchers are available right now.');
    const page = menuPage(session.menuPage, categories.length);
    if (!session.categoryMenuShown) {
      await this.sessions.set(
        sessionIdentifier(request),
        { state: 'CATEGORY', categoryMenuShown: true, menuPage: 0 },
        this.configuration.sessionTtlMilliseconds,
      );
      return {
        continueSession: true,
        message: renderCategoryMenu(categories, 0),
      };
    }
    if (request.input.trim() === '9' && categories.length > MENU_PAGE_SIZE) {
      const next = (page + 1) % Math.ceil(categories.length / MENU_PAGE_SIZE);
      await this.sessions.set(
        sessionIdentifier(request),
        { ...session, menuPage: next },
        this.configuration.sessionTtlMilliseconds,
      );
      return {
        continueSession: true,
        message: renderCategoryMenu(categories, next),
      };
    }
    const choice = parseChoice(
      request.input,
      Math.min(MENU_PAGE_SIZE, categories.length - page * MENU_PAGE_SIZE),
    );
    const selected =
      choice === null
        ? undefined
        : categories[page * MENU_PAGE_SIZE + choice - 1];
    if (selected === undefined)
      return {
        continueSession: true,
        message: renderCategoryMenu(categories, page, 'Invalid option.'),
      };

    const products = await this.products.listActiveProducts(
      selected.publicId,
      this.configuration.maximumProducts,
    );
    if (products.length === 0)
      return {
        continueSession: true,
        message: renderCategoryMenu(categories, page, 'Category unavailable.'),
      };

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
    if (request.input.trim() === '0') return this.showHome(request);
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

    const pageIndex = menuPage(session.menuPage, page.length);
    if (request.input.trim() === '9' && page.length > MENU_PAGE_SIZE) {
      const next = (pageIndex + 1) % Math.ceil(page.length / MENU_PAGE_SIZE);
      await this.sessions.set(
        sessionIdentifier(request),
        { ...session, menuPage: next },
        this.configuration.sessionTtlMilliseconds,
      );
      return {
        continueSession: true,
        message: renderProductMenu(
          page,
          session.catalogGroupName ?? 'Vouchers',
          next,
        ),
      };
    }
    const choice = parseChoice(
      request.input,
      Math.min(MENU_PAGE_SIZE, page.length - pageIndex * MENU_PAGE_SIZE),
    );
    const selected =
      choice === null
        ? undefined
        : page[pageIndex * MENU_PAGE_SIZE + choice - 1];
    if (selected === undefined)
      return {
        continueSession: true,
        message: renderProductMenu(
          page,
          session.catalogGroupName ?? 'Vouchers',
          pageIndex,
          'Invalid option.',
        ),
      };

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
          `Approve the Mobile Money prompt for ${formatCedis(order.totalPriceMinor)} when it arrives.\n` +
          (order.customerCode ? `Order code: ${order.customerCode}\n` : '') +
          (request.paymentPromptInstructions ??
            'If delayed, check pending approvals in your MoMo menu.') +
          '\nDo not pay again.',
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

const MENU_PAGE_SIZE = 2;
function menuPage(value: number | undefined, length: number): number {
  return value !== undefined &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < Math.ceil(length / MENU_PAGE_SIZE)
    ? value
    : 0;
}
function renderCategoryMenu(
  categories: readonly UssdCategoryListItem[],
  page = 0,
  prefix = '',
): string {
  return [
    prefix,
    'Choose voucher category:',
    ...categories
      .slice(page * MENU_PAGE_SIZE, (page + 1) * MENU_PAGE_SIZE)
      .map((category, index) => `${index + 1}. ${truncate(category.name, 40)}`),
    ...(categories.length > MENU_PAGE_SIZE ? ['9. More'] : []),
    '0. Home',
  ]
    .filter(Boolean)
    .join('\n');
}
function renderProductMenu(
  products: readonly UssdProductListItem[],
  categoryName: string,
  page = 0,
  prefix = '',
): string {
  return [
    prefix,
    `${truncate(categoryName, 24)}:`,
    ...products
      .slice(page * MENU_PAGE_SIZE, (page + 1) * MENU_PAGE_SIZE)
      .map(
        (product, index) =>
          `${index + 1}. ${truncate(product.name, 24)} ${formatCedis(product.sellingPriceMinor)}`,
      ),
    ...(products.length > MENU_PAGE_SIZE ? ['9. More'] : []),
    '0. Home',
  ]
    .filter(Boolean)
    .join('\n');
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
