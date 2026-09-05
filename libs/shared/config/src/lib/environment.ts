import { z } from 'zod';

const nodeEnvironmentSchema = z.enum([
  'development',
  'test',
  'staging',
  'production',
]);

const logLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
]);

const commonEnvironmentSchema = z.object({
  NODE_ENV: nodeEnvironmentSchema.default('development'),

  SERVICE_NAME: z.string().trim().min(1),

  LOG_LEVEL: logLevelSchema.default('log'),

  DATABASE_URL: z.url(),

  REDIS_URL: z.url(),
});

const httpEnvironmentSchema = commonEnvironmentSchema.extend({
  HOST: z.string().trim().min(1).default('0.0.0.0'),

  PORT: z.coerce.number().int().min(1).max(65_535),

  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  CORS_ALLOWED_ORIGINS: z.string().trim().min(1).max(2_048).optional(),
});

const base64KeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'must be a 32-byte base64url key');

const adminIdentityEnvironmentShape = {
  ADMIN_APPLICATION_ORIGIN: z.url(),
  ADMIN_SESSION_HMAC_KEY: base64KeySchema,
  ADMIN_SECRET_ENCRYPTION_KEY_ID: z.string().trim().min(1).max(64),
  ADMIN_SECRET_ENCRYPTION_KEY: base64KeySchema,
} as const;

const voucherImportEnvironmentShape = {
  VOUCHER_SECRET_ENCRYPTION_KEY_ID: z.string().trim().min(1).max(64),
  VOUCHER_SECRET_ENCRYPTION_KEY: base64KeySchema,
  VOUCHER_PIN_FINGERPRINT_KEY: base64KeySchema,
  VOUCHER_IMPORT_CHUNK_SIZE: z.coerce
    .number()
    .int()
    .min(100)
    .max(5_000)
    .default(1_000),
  VOUCHER_IMPORT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_024 * 1_024)
    .max(64 * 1_024 * 1_024)
    .default(64 * 1_024 * 1_024),
  VOUCHER_IMPORT_STALE_AFTER_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60 * 1_000)
    .default(15 * 60 * 1_000),
  VOUCHER_IMPORT_RECOVERY_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60 * 60 * 1_000)
    .default(60_000),
} as const;

const orderMaintenanceEnvironmentShape = {
  ORDER_IDEMPOTENCY_CLEANUP_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(5_000)
    .default(1_000),
  ORDER_IDEMPOTENCY_CLEANUP_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60 * 60 * 1_000)
    .default(60_000),
} as const;

const paystackProviderEnvironmentShape = {
  PAYSTACK_SECRET_KEY: z.string().trim().min(20).max(512),
  PAYSTACK_BASE_URL: z.url().default('https://api.paystack.co/'),
  PAYSTACK_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(30_000)
    .default(10_000),
} as const;

const moolreProviderEnvironmentShape = {
  MOOLRE_API_USER: z.string().trim().min(1).max(128),
  MOOLRE_PUBLIC_KEY: z.string().trim().min(20).max(512),
  MOOLRE_ACCOUNT_NUMBER: z.string().regex(/^[0-9]{6,20}$/),
  MOOLRE_BASE_URL: z.url().default('https://api.moolre.com/'),
  MOOLRE_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(30_000)
    .default(10_000),
} as const;

const optionalEnvironmentString = (minimum: number, maximum: number) =>
  z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim().length === 0
        ? undefined
        : value,
    z.string().trim().min(minimum).max(maximum).optional(),
  );

const optionalMoolreProviderEnvironmentShape = {
  MOOLRE_API_USER: optionalEnvironmentString(1, 128),
  MOOLRE_PUBLIC_KEY: optionalEnvironmentString(20, 512),
  MOOLRE_ACCOUNT_NUMBER: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim().length === 0
        ? undefined
        : value,
    z
      .string()
      .regex(/^[0-9]{6,20}$/)
      .optional(),
  ),
  MOOLRE_BASE_URL: z.url().default('https://api.moolre.com/'),
  MOOLRE_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(30_000)
    .default(10_000),
} as const;

const environmentBoolean = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

const ussdFeatureEnvironmentShape = {
  USSD_ENABLED: environmentBoolean.default(false),
} as const;

export const publicApiEnvironmentSchema = httpEnvironmentSchema
  .extend({
    MOOLRE_WEBHOOK_SECRET: optionalEnvironmentString(1, 512),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    ORDER_PRIVACY_HMAC_KEY: base64KeySchema,
    ORDER_IDEMPOTENCY_TTL_MS: z.coerce
      .number()
      .int()
      .min(60 * 60 * 1_000)
      .max(7 * 24 * 60 * 60 * 1_000)
      .default(24 * 60 * 60 * 1_000),
    ORDER_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(60 * 60 * 1_000)
      .default(10 * 60 * 1_000),
    ORDER_RATE_LIMIT_IP_MAXIMUM: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(30),
    ORDER_RATE_LIMIT_PHONE_MAXIMUM: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(10),
    ORDER_STATUS_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(60 * 60 * 1_000)
      .default(10 * 60 * 1_000),
    ORDER_STATUS_RATE_LIMIT_IP_MAXIMUM: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(30),
    ORDER_STATUS_RATE_LIMIT_CONTACT_MAXIMUM: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(10),
    ...paystackProviderEnvironmentShape,
    ...optionalMoolreProviderEnvironmentShape,
    ...ussdFeatureEnvironmentShape,
    PAYSTACK_CALLBACK_URL: z.url(),
    NALO_USER_ID: optionalEnvironmentString(1, 64),
    NALO_TRUSTED_SOURCE_IPS: z.preprocess(
      (value) =>
        typeof value === 'string' && value.trim().length === 0
          ? undefined
          : value,
      z.string().trim().max(1_000).optional(),
    ),
    CUSTOMER_SUPPORT_PHONE: z.preprocess(
      (value) =>
        typeof value === 'string' &&
        (value.trim() === '' || /^(?:233)?0+$/.test(value.replace(/\D/g, '')))
          ? undefined
          : value,
      z
        .string()
        .trim()
        .min(6)
        .max(32)
        .regex(/^\+?[0-9][0-9 ()-]{5,31}$/)
        .optional(),
    ),
    USSD_MAX_PRODUCTS: z.coerce.number().int().min(1).max(8).default(4),
    USSD_SESSION_TTL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(15 * 60_000)
      .default(5 * 60_000),
    USSD_PENDING_PAYMENT_TTL_MS: z.coerce
      .number()
      .int()
      .min(5 * 60_000)
      .max(24 * 60 * 60_000)
      .default(15 * 60_000),
    PAYMENT_IDEMPOTENCY_TTL_MS: z.coerce
      .number()
      .int()
      .min(60 * 60 * 1_000)
      .max(7 * 24 * 60 * 60 * 1_000)
      .default(24 * 60 * 60 * 1_000),
    PAYMENT_INITIAL_VERIFICATION_DELAY_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(60 * 60 * 1_000)
      .default(2 * 60 * 1_000),
    PAYMENT_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(60 * 60 * 1_000)
      .default(10 * 60 * 1_000),
    PAYMENT_RATE_LIMIT_IP_MAXIMUM: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(30),
    PAYMENT_RATE_LIMIT_ORDER_MAXIMUM: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10),
  })
  .superRefine((configuration, context) => {
    if (!configuration.USSD_ENABLED) {
      return;
    }

    const requiredFields = [
      ['MOOLRE_API_USER', configuration.MOOLRE_API_USER],
      ['MOOLRE_PUBLIC_KEY', configuration.MOOLRE_PUBLIC_KEY],
      ['MOOLRE_ACCOUNT_NUMBER', configuration.MOOLRE_ACCOUNT_NUMBER],
      ['NALO_USER_ID', configuration.NALO_USER_ID],
      ['MOOLRE_WEBHOOK_SECRET', configuration.MOOLRE_WEBHOOK_SECRET],
    ] as const;

    for (const [field, value] of requiredFields) {
      if (value !== undefined) {
        continue;
      }

      context.addIssue({
        code: 'custom',
        message: 'is required when USSD_ENABLED=true',
        path: [field],
      });
    }
  });

export const adminApiEnvironmentSchema = httpEnvironmentSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
  ...adminIdentityEnvironmentShape,
  ...voucherImportEnvironmentShape,
});

export const workerEnvironmentSchema = commonEnvironmentSchema
  .extend({
    ...adminIdentityEnvironmentShape,
    ...voucherImportEnvironmentShape,
    ...orderMaintenanceEnvironmentShape,
    ...paystackProviderEnvironmentShape,
    ...moolreProviderEnvironmentShape,
    ...ussdFeatureEnvironmentShape,
    USSD_PAYMENT_PROMPT_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    PAYMENT_VERIFICATION_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    PAYMENT_IDEMPOTENCY_CLEANUP_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(5_000)
      .default(1_000),
    PAYMENT_VERIFICATION_LEASE_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(10 * 60 * 1_000)
      .default(60_000),
    PAYMENT_VERIFICATION_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .default(12),
    PAYMENT_VERIFICATION_BASE_DELAY_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(60 * 60 * 1_000)
      .default(60_000),
    PAYMENT_RECOVERY_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60 * 60 * 1_000)
      .default(30_000),
    RESEND_API_KEY: z.string().trim().min(1),
    RESEND_FROM_EMAIL: z.string().trim().min(3).max(320),
    MOOLRE_SMS_VAS_KEY: z.string().trim().min(1).max(512),
    MOOLRE_SMS_SENDER_ID: z.string().trim().min(1).max(11),
    CUSTOMER_SUPPORT_PHONE: z
      .string()
      .trim()
      .min(6)
      .max(32)
      .regex(/^\+?[0-9][0-9 ()-]{5,31}$/),
    MOOLRE_SMS_BASE_URL: z.url().default('https://api.moolre.com'),
    MOOLRE_SMS_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(30_000)
      .default(10_000),
    VOUCHER_DELIVERY_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    VOUCHER_DELIVERY_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(5_000),
    VOUCHER_DELIVERY_PROCESSING_LEASE_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(10 * 60_000)
      .default(120_000),
    VOUCHER_DELIVERY_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5),
    VOUCHER_DELIVERY_RETRY_BASE_DELAY_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(5_000),
    VOUCHER_DELIVERY_RETRY_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(60 * 60_000)
      .default(300_000),
    ADMIN_INVITATION_EMAIL_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5),
    ADMIN_INVITATION_EMAIL_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    ADMIN_INVITATION_EMAIL_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(5_000),
    VOUCHER_ALLOCATION_OUTBOX_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10),
    VOUCHER_ALLOCATION_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(5_000),
    VOUCHER_ALLOCATION_LEASE_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(10 * 60_000)
      .default(120_000),
    VOUCHER_ALLOCATION_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5),
    VOUCHER_ALLOCATION_RETRY_BASE_DELAY_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(5_000),
    VOUCHER_ALLOCATION_RETRY_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(60 * 60_000)
      .default(300_000),
    RESTOCK_DRAIN_OUTBOX_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10),
    RESTOCK_DRAIN_CHUNK_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .default(250),
    RESTOCK_DRAIN_RECOVERY_PRODUCT_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10),
    RESTOCK_DRAIN_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60 * 60 * 1_000)
      .default(5_000),
    RESTOCK_DRAIN_LEASE_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(10 * 60_000)
      .default(120_000),
    RESTOCK_DRAIN_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5),
    RESTOCK_DRAIN_RETRY_BASE_DELAY_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(5_000),
    RESTOCK_DRAIN_RETRY_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(60 * 60_000)
      .default(300_000),
    STOCK_MONITORING_PRODUCT_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(100),
    STOCK_MONITORING_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60 * 60 * 1_000)
      .default(5_000),
    STOCK_ALERT_OUTBOX_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    STOCK_ALERT_OUTBOX_LEASE_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(10 * 60_000)
      .default(120_000),
    RECONCILIATION_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50),
    RECONCILIATION_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(24 * 60 * 60 * 1_000)
      .default(60_000),
    VOUCHER_RETRIEVAL_EMAIL_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    VOUCHER_RETRIEVAL_EMAIL_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(5_000),
    VOUCHER_RETRIEVAL_EMAIL_PROCESSING_LEASE_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(10 * 60_000)
      .default(120_000),
    VOUCHER_RETRIEVAL_EMAIL_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5),
    VOUCHER_RETRIEVAL_EMAIL_RETRY_BASE_DELAY_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(5_000),
    VOUCHER_RETRIEVAL_EMAIL_RETRY_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(60 * 60_000)
      .default(300_000),
  })
  .superRefine((configuration, context) => {
    if (
      configuration.VOUCHER_ALLOCATION_RETRY_MAX_DELAY_MS <
      configuration.VOUCHER_ALLOCATION_RETRY_BASE_DELAY_MS
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'must be greater than or equal to VOUCHER_ALLOCATION_RETRY_BASE_DELAY_MS',
        path: ['VOUCHER_ALLOCATION_RETRY_MAX_DELAY_MS'],
      });
    }
    if (
      configuration.RESTOCK_DRAIN_RETRY_MAX_DELAY_MS <
      configuration.RESTOCK_DRAIN_RETRY_BASE_DELAY_MS
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'must be greater than or equal to RESTOCK_DRAIN_RETRY_BASE_DELAY_MS',
        path: ['RESTOCK_DRAIN_RETRY_MAX_DELAY_MS'],
      });
    }
    if (
      configuration.VOUCHER_DELIVERY_RETRY_MAX_DELAY_MS <
      configuration.VOUCHER_DELIVERY_RETRY_BASE_DELAY_MS
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'must be greater than or equal to VOUCHER_DELIVERY_RETRY_BASE_DELAY_MS',
        path: ['VOUCHER_DELIVERY_RETRY_MAX_DELAY_MS'],
      });
    }
    if (
      configuration.VOUCHER_RETRIEVAL_EMAIL_RETRY_MAX_DELAY_MS <
      configuration.VOUCHER_RETRIEVAL_EMAIL_RETRY_BASE_DELAY_MS
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'must be greater than or equal to VOUCHER_RETRIEVAL_EMAIL_RETRY_BASE_DELAY_MS',
        path: ['VOUCHER_RETRIEVAL_EMAIL_RETRY_MAX_DELAY_MS'],
      });
    }
  });

export type PublicApiEnvironment = z.infer<typeof publicApiEnvironmentSchema>;

export type AdminApiEnvironment = z.infer<typeof adminApiEnvironmentSchema>;

export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;

function parseEnvironment<TSchema extends z.ZodType>(
  schema: TSchema,
  values: Record<string, unknown>,
): z.infer<TSchema> {
  const result = schema.safeParse(values);

  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => {
        const field = issue.path.join('.') || 'environment';

        return `${field}: ${issue.message}`;
      })
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${messages}`);
  }

  return result.data;
}

export function validatePublicApiEnvironment(
  values: Record<string, unknown>,
): PublicApiEnvironment {
  return parseEnvironment(publicApiEnvironmentSchema, values);
}

export function validateAdminApiEnvironment(
  values: Record<string, unknown>,
): AdminApiEnvironment {
  return parseEnvironment(adminApiEnvironmentSchema, values);
}

export function validateWorkerEnvironment(
  values: Record<string, unknown>,
): WorkerEnvironment {
  return parseEnvironment(workerEnvironmentSchema, values);
}

export function trustProxyFromEnvironment(
  values: Readonly<Record<string, string | undefined>> = process.env,
): number | false {
  const hops = Number(values['TRUST_PROXY_HOPS'] ?? '0');
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) {
    throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5.');
  }
  return hops === 0 ? false : hops;
}

export function corsAllowedOrigins(
  configuredValue: string | undefined,
  fallbackOrigin: string,
): readonly string[] {
  const configured = configuredValue ?? fallbackOrigin;
  const origins = configured
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length !== 0);
  if (origins.length === 0 || origins.length > 20) {
    throw new Error(
      'CORS_ALLOWED_ORIGINS must contain between 1 and 20 origins.',
    );
  }
  return [...new Set(origins.map(assertExactHttpOrigin))];
}

function assertExactHttpOrigin(value: string): string {
  if (value === '*') {
    throw new Error('CORS_ALLOWED_ORIGINS must not contain a wildcard.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid CORS origin: ${value}`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(`CORS origin must be an exact HTTP(S) origin: ${value}`);
  }
  return url.origin;
}
