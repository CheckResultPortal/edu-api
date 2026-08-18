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

export const publicApiEnvironmentSchema = httpEnvironmentSchema.extend({
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
  ...paystackProviderEnvironmentShape,
  PAYSTACK_CALLBACK_URL: z.url(),
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
});

export const adminApiEnvironmentSchema = httpEnvironmentSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
  ...adminIdentityEnvironmentShape,
  ...voucherImportEnvironmentShape,
});

export const workerEnvironmentSchema = commonEnvironmentSchema.extend({
  ...adminIdentityEnvironmentShape,
  ...voucherImportEnvironmentShape,
  ...orderMaintenanceEnvironmentShape,
  ...paystackProviderEnvironmentShape,
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
