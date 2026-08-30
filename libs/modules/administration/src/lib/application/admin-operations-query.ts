export const ADMIN_OPERATIONS_QUERY = Symbol('ADMIN_OPERATIONS_QUERY');

export type AdminJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AdminJsonValue[]
  | { readonly [key: string]: AdminJsonValue };

export interface AdminQueryPage {
  readonly items: readonly {
    readonly id: string;
    readonly attributes: { readonly [key: string]: AdminJsonValue };
  }[];
  readonly nextCursor: string | null;
}

export interface AdminOperationsQuery {
  getDashboard(input: {
    readonly from: Date;
    readonly to: Date;
  }): Promise<{ readonly [key: string]: AdminJsonValue }>;

  getOrder(orderPublicReference: string): Promise<{
    readonly id: string;
    readonly attributes: { readonly [key: string]: AdminJsonValue };
  } | null>;

  listAuditEvents(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<AdminQueryPage>;

  listBacklog(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly productPublicId?: string;
  }): Promise<AdminQueryPage>;

  listDeliveries(input: {
    readonly channel?: 'EMAIL' | 'SMS';
    readonly cursor?: string;
    readonly limit: number;
    readonly state?:
      | 'NEEDS_ATTENTION'
      | 'PENDING'
      | 'PROCESSING'
      | 'RETRYING'
      | 'SENT'
      | 'UNKNOWN';
  }): Promise<AdminQueryPage>;

  listInventory(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly query?: string;
  }): Promise<AdminQueryPage>;

  listReconciliationFindings(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly status?: 'OPEN' | 'RESOLVED';
    readonly type?: string;
  }): Promise<AdminQueryPage>;

  listOrders(input: {
    readonly channel?: 'USSD' | 'WEB';
    readonly cursor?: string;
    readonly from?: Date;
    readonly limit: number;
    readonly query?: string;
    readonly status?:
      | 'ALLOCATED'
      | 'COMPLETE'
      | 'DELIVERY_ISSUE'
      | 'PAID'
      | 'UNPAID'
      | 'WAITING';
    readonly to?: Date;
  }): Promise<AdminQueryPage>;

  listVouchers(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly productPublicId?: string;
    readonly serialNumber?: string;
    readonly status?: 'AVAILABLE' | 'SOLD';
  }): Promise<AdminQueryPage>;
}
