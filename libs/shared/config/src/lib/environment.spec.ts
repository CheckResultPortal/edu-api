import {
  validateAdminApiEnvironment,
  validatePublicApiEnvironment,
  validateWorkerEnvironment,
  trustProxyFromEnvironment,
  corsAllowedOrigins,
} from './environment';

describe('environment validation', () => {
  it.each(['', '+233000000000'])(
    'omits missing/placeholder USSD support contact (%s)',
    (value) => {
      const config = validatePublicApiEnvironment({
        SERVICE_NAME: 'public-api',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
        ORDER_PRIVACY_HMAC_KEY: privacyHmacKey,
        ...paystackPublicEnvironment,
        CUSTOMER_SUPPORT_PHONE: value,
      });
      expect(config.CUSTOMER_SUPPORT_PHONE).toBeUndefined();
    },
  );

  describe('corsAllowedOrigins', () => {
    it('normalizes a bounded exact-origin allowlist', () => {
      expect(
        corsAllowedOrigins(
          'https://shop.example.com, https://admin.example.com',
          'https://fallback.example.com',
        ),
      ).toEqual(['https://shop.example.com', 'https://admin.example.com']);
    });

    it('rejects wildcard and path-based entries', () => {
      expect(() =>
        corsAllowedOrigins('*', 'https://fallback.example.com'),
      ).toThrow('must not contain a wildcard');
      expect(() =>
        corsAllowedOrigins(
          'https://shop.example.com/path',
          'https://fallback.example.com',
        ),
      ).toThrow('must be an exact HTTP(S) origin');
    });
  });
  describe('public API', () => {
    it.each([undefined, ''])(
      'requires a callback secret with USSD enabled (%s)',
      (secret) => {
        expect(() =>
          validatePublicApiEnvironment({
            SERVICE_NAME: 'public-api',
            DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
            REDIS_URL: 'redis://localhost:6379',
            ORDER_PRIVACY_HMAC_KEY: privacyHmacKey,
            ...paystackPublicEnvironment,
            ...naloUssdEnvironment,
            ...moolrePaymentEnvironment,
            MOOLRE_WEBHOOK_SECRET: secret,
          }),
        ).toThrow('MOOLRE_WEBHOOK_SECRET');
      },
    );
    it('applies valid defaults', () => {
      const configuration = validatePublicApiEnvironment({
        SERVICE_NAME: 'public-api',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
        ORDER_PRIVACY_HMAC_KEY: privacyHmacKey,
        ...paystackPublicEnvironment,
        ...naloUssdEnvironment,
        ...moolrePaymentEnvironment,
      });

      expect(configuration).toEqual({
        NODE_ENV: 'development',
        SERVICE_NAME: 'public-api',
        LOG_LEVEL: 'log',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
        HOST: '0.0.0.0',
        PORT: 3001,
        TRUST_PROXY_HOPS: 0,
        ORDER_PRIVACY_HMAC_KEY: privacyHmacKey,
        ORDER_IDEMPOTENCY_TTL_MS: 86400000,
        ORDER_RATE_LIMIT_WINDOW_MS: 600000,
        ORDER_RATE_LIMIT_IP_MAXIMUM: 30,
        ORDER_RATE_LIMIT_PHONE_MAXIMUM: 10,
        ORDER_STATUS_RATE_LIMIT_WINDOW_MS: 600000,
        ORDER_STATUS_RATE_LIMIT_IP_MAXIMUM: 30,
        ORDER_STATUS_RATE_LIMIT_CONTACT_MAXIMUM: 10,
        PAYSTACK_SECRET_KEY: paystackPublicEnvironment.PAYSTACK_SECRET_KEY,
        PAYSTACK_BASE_URL: 'https://api.paystack.co/',
        PAYSTACK_REQUEST_TIMEOUT_MS: 10000,
        PAYSTACK_CALLBACK_URL: paystackPublicEnvironment.PAYSTACK_CALLBACK_URL,
        MOOLRE_API_USER: moolrePaymentEnvironment.MOOLRE_API_USER,
        MOOLRE_PUBLIC_KEY: moolrePaymentEnvironment.MOOLRE_PUBLIC_KEY,
        MOOLRE_ACCOUNT_NUMBER: moolrePaymentEnvironment.MOOLRE_ACCOUNT_NUMBER,
        MOOLRE_BASE_URL: 'https://api.moolre.com/',
        MOOLRE_REQUEST_TIMEOUT_MS: 10000,
        USSD_ENABLED: true,
        MOOLRE_WEBHOOK_SECRET: 'test-callback-secret',
        NALO_USER_ID: naloUssdEnvironment.NALO_USER_ID,
        NALO_TRUSTED_SOURCE_IPS: naloUssdEnvironment.NALO_TRUSTED_SOURCE_IPS,
        USSD_MAX_PRODUCTS: 4,
        USSD_SESSION_TTL_MS: 300000,
        USSD_PENDING_PAYMENT_TTL_MS: 900000,
        PAYMENT_IDEMPOTENCY_TTL_MS: 86400000,
        PAYMENT_INITIAL_VERIFICATION_DELAY_MS: 120000,
        PAYMENT_RATE_LIMIT_WINDOW_MS: 600000,
        PAYMENT_RATE_LIMIT_IP_MAXIMUM: 30,
        PAYMENT_RATE_LIMIT_ORDER_MAXIMUM: 10,
      });
    });

    it('keeps web checkout bootable while USSD is disabled', () => {
      const configuration = validatePublicApiEnvironment({
        SERVICE_NAME: 'public-api',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
        ORDER_PRIVACY_HMAC_KEY: privacyHmacKey,
        ...paystackPublicEnvironment,
      });

      expect(configuration.USSD_ENABLED).toBe(false);
      expect(configuration.MOOLRE_API_USER).toBeUndefined();
      expect(configuration.NALO_USER_ID).toBeUndefined();
    });

    it('treats blank USSD provider variables as unset while USSD is disabled', () => {
      const configuration = validatePublicApiEnvironment({
        SERVICE_NAME: 'public-api',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
        ORDER_PRIVACY_HMAC_KEY: privacyHmacKey,
        ...paystackPublicEnvironment,
        MOOLRE_API_USER: '',
        MOOLRE_PUBLIC_KEY: '',
        MOOLRE_ACCOUNT_NUMBER: '',
        NALO_USER_ID: '',
        NALO_TRUSTED_SOURCE_IPS: '',
      });

      expect(configuration.MOOLRE_API_USER).toBeUndefined();
      expect(configuration.NALO_USER_ID).toBeUndefined();
    });

    it('requires collection credentials and the Nalo USERID when enabled', () => {
      expect(() =>
        validatePublicApiEnvironment({
          SERVICE_NAME: 'public-api',
          DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
          REDIS_URL: 'redis://localhost:6379',
          ORDER_PRIVACY_HMAC_KEY: privacyHmacKey,
          ...paystackPublicEnvironment,
          USSD_ENABLED: 'true',
        }),
      ).toThrow('NALO_USER_ID');
    });

    it('bounds trusted reverse-proxy hops', () => {
      expect(
        validatePublicApiEnvironment({
          SERVICE_NAME: 'public-api',
          DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
          REDIS_URL: 'redis://localhost:6379',
          ORDER_PRIVACY_HMAC_KEY: privacyHmacKey,
          ...paystackPublicEnvironment,
          ...naloUssdEnvironment,
          ...moolrePaymentEnvironment,
          TRUST_PROXY_HOPS: '1',
        }).TRUST_PROXY_HOPS,
      ).toBe(1);
      expect(() =>
        validatePublicApiEnvironment({
          SERVICE_NAME: 'public-api',
          DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
          REDIS_URL: 'redis://localhost:6379',
          ORDER_PRIVACY_HMAC_KEY: privacyHmacKey,
          ...paystackPublicEnvironment,
          ...naloUssdEnvironment,
          ...moolrePaymentEnvironment,
          TRUST_PROXY_HOPS: 'all',
        }),
      ).toThrow('TRUST_PROXY_HOPS');
      expect(trustProxyFromEnvironment()).toBe(false);
      expect(trustProxyFromEnvironment({ TRUST_PROXY_HOPS: '1' })).toBe(1);
    });

    it('converts PORT from a string to a number', () => {
      const configuration = validatePublicApiEnvironment({
        SERVICE_NAME: 'public-api',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
        ORDER_PRIVACY_HMAC_KEY: privacyHmacKey,
        ...paystackPublicEnvironment,
        ...naloUssdEnvironment,
        ...moolrePaymentEnvironment,
        PORT: '4001',
      });

      expect(configuration.PORT).toBe(4001);
    });

    it('rejects an invalid port', () => {
      expect(() =>
        validatePublicApiEnvironment({
          SERVICE_NAME: 'public-api',
          DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
          REDIS_URL: 'redis://localhost:6379',
          ORDER_PRIVACY_HMAC_KEY: privacyHmacKey,
          ...paystackPublicEnvironment,
          ...naloUssdEnvironment,
          ...moolrePaymentEnvironment,
          PORT: '70000',
        }),
      ).toThrow('Invalid environment configuration');
    });

    it('requires a 32-byte order privacy HMAC key', () => {
      expect(() =>
        validatePublicApiEnvironment({
          SERVICE_NAME: 'public-api',
          DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
          REDIS_URL: 'redis://localhost:6379',
          ORDER_PRIVACY_HMAC_KEY: 'short',
        }),
      ).toThrow('ORDER_PRIVACY_HMAC_KEY');
    });

    it('rejects a missing service name', () => {
      expect(() => validatePublicApiEnvironment({})).toThrow('SERVICE_NAME');
    });
  });

  describe('admin API', () => {
    it('uses port 3002 by default', () => {
      const configuration = validateAdminApiEnvironment({
        SERVICE_NAME: 'admin-api',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
        ADMIN_APPLICATION_ORIGIN: 'https://admin.example.com',
        ADMIN_SESSION_HMAC_KEY: '0123456789012345678901234567890123456789012',
        ADMIN_SECRET_ENCRYPTION_KEY_ID: 'local-v1',
        ADMIN_SECRET_ENCRYPTION_KEY:
          '0123456789012345678901234567890123456789012',
        VOUCHER_SECRET_ENCRYPTION_KEY_ID: 'local-v1',
        VOUCHER_SECRET_ENCRYPTION_KEY:
          '0123456789012345678901234567890123456789012',
        VOUCHER_PIN_FINGERPRINT_KEY:
          'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      });

      expect(configuration.PORT).toBe(3002);
    });

    it('rejects a short admin cryptographic key', () => {
      expect(() =>
        validateAdminApiEnvironment({
          SERVICE_NAME: 'admin-api',
          DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
          REDIS_URL: 'redis://localhost:6379',
          ADMIN_APPLICATION_ORIGIN: 'https://admin.example.com',
          ADMIN_SESSION_HMAC_KEY: 'short',
          ADMIN_SECRET_ENCRYPTION_KEY_ID: 'local-v1',
          ADMIN_SECRET_ENCRYPTION_KEY:
            '0123456789012345678901234567890123456789012',
          VOUCHER_SECRET_ENCRYPTION_KEY_ID: 'local-v1',
          VOUCHER_SECRET_ENCRYPTION_KEY:
            '0123456789012345678901234567890123456789012',
          VOUCHER_PIN_FINGERPRINT_KEY:
            'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
        }),
      ).toThrow('ADMIN_SESSION_HMAC_KEY');
    });
  });

  describe('worker', () => {
    it('validates worker configuration without HTTP settings', () => {
      const configuration = validateWorkerEnvironment({
        SERVICE_NAME: 'worker',
        NODE_ENV: 'test',
        LOG_LEVEL: 'debug',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
        PAYSTACK_SECRET_KEY: paystackPublicEnvironment.PAYSTACK_SECRET_KEY,
        MOOLRE_API_USER: moolrePaymentEnvironment.MOOLRE_API_USER,
        MOOLRE_PUBLIC_KEY: moolrePaymentEnvironment.MOOLRE_PUBLIC_KEY,
        MOOLRE_ACCOUNT_NUMBER: moolrePaymentEnvironment.MOOLRE_ACCOUNT_NUMBER,
        ADMIN_APPLICATION_ORIGIN: 'https://admin.example.com',
        ADMIN_SESSION_HMAC_KEY: '0123456789012345678901234567890123456789012',
        ADMIN_SECRET_ENCRYPTION_KEY_ID: 'test-v1',
        ADMIN_SECRET_ENCRYPTION_KEY:
          '0123456789012345678901234567890123456789012',
        VOUCHER_SECRET_ENCRYPTION_KEY_ID: 'test-v1',
        VOUCHER_SECRET_ENCRYPTION_KEY:
          '0123456789012345678901234567890123456789012',
        VOUCHER_PIN_FINGERPRINT_KEY:
          'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
        RESEND_API_KEY: 're_test',
        RESEND_FROM_EMAIL: 'EduVoucher <admin@example.com>',
        MOOLRE_SMS_VAS_KEY: 'moolre-test-key',
        MOOLRE_SMS_SENDER_ID: 'EduVoucher',
        CUSTOMER_SUPPORT_PHONE: '+233300000000',
      });

      expect(configuration).toEqual({
        NODE_ENV: 'test',
        SERVICE_NAME: 'worker',
        LOG_LEVEL: 'debug',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
        ADMIN_APPLICATION_ORIGIN: 'https://admin.example.com',
        ADMIN_SESSION_HMAC_KEY: '0123456789012345678901234567890123456789012',
        ADMIN_SECRET_ENCRYPTION_KEY_ID: 'test-v1',
        ADMIN_SECRET_ENCRYPTION_KEY:
          '0123456789012345678901234567890123456789012',
        VOUCHER_SECRET_ENCRYPTION_KEY_ID: 'test-v1',
        VOUCHER_SECRET_ENCRYPTION_KEY:
          '0123456789012345678901234567890123456789012',
        VOUCHER_PIN_FINGERPRINT_KEY:
          'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
        VOUCHER_IMPORT_CHUNK_SIZE: 1000,
        VOUCHER_IMPORT_MAX_BYTES: 67108864,
        VOUCHER_IMPORT_STALE_AFTER_MS: 900000,
        VOUCHER_IMPORT_RECOVERY_POLL_INTERVAL_MS: 60000,
        ORDER_IDEMPOTENCY_CLEANUP_BATCH_SIZE: 1000,
        ORDER_IDEMPOTENCY_CLEANUP_POLL_INTERVAL_MS: 60000,
        PAYSTACK_SECRET_KEY: paystackPublicEnvironment.PAYSTACK_SECRET_KEY,
        PAYSTACK_BASE_URL: 'https://api.paystack.co/',
        PAYSTACK_REQUEST_TIMEOUT_MS: 10000,
        MOOLRE_API_USER: moolrePaymentEnvironment.MOOLRE_API_USER,
        MOOLRE_PUBLIC_KEY: moolrePaymentEnvironment.MOOLRE_PUBLIC_KEY,
        MOOLRE_ACCOUNT_NUMBER: moolrePaymentEnvironment.MOOLRE_ACCOUNT_NUMBER,
        MOOLRE_BASE_URL: 'https://api.moolre.com/',
        MOOLRE_REQUEST_TIMEOUT_MS: 10000,
        USSD_ENABLED: false,
        PAYMENT_VERIFICATION_BATCH_SIZE: 25,
        PAYMENT_IDEMPOTENCY_CLEANUP_BATCH_SIZE: 1000,
        PAYMENT_VERIFICATION_LEASE_MS: 60000,
        PAYMENT_VERIFICATION_MAX_ATTEMPTS: 12,
        PAYMENT_VERIFICATION_BASE_DELAY_MS: 60000,
        PAYMENT_RECOVERY_POLL_INTERVAL_MS: 30000,
        RESEND_API_KEY: 're_test',
        RESEND_FROM_EMAIL: 'EduVoucher <admin@example.com>',
        MOOLRE_SMS_VAS_KEY: 'moolre-test-key',
        MOOLRE_SMS_SENDER_ID: 'EduVoucher',
        CUSTOMER_SUPPORT_PHONE: '+233300000000',
        MOOLRE_SMS_BASE_URL: 'https://api.moolre.com',
        MOOLRE_SMS_REQUEST_TIMEOUT_MS: 10000,
        USSD_PAYMENT_PROMPT_BATCH_SIZE: 25,
        VOUCHER_DELIVERY_BATCH_SIZE: 25,
        VOUCHER_DELIVERY_POLL_INTERVAL_MS: 5000,
        VOUCHER_DELIVERY_PROCESSING_LEASE_MS: 120000,
        VOUCHER_DELIVERY_MAX_ATTEMPTS: 5,
        VOUCHER_DELIVERY_RETRY_BASE_DELAY_MS: 5000,
        VOUCHER_DELIVERY_RETRY_MAX_DELAY_MS: 300000,
        ADMIN_INVITATION_EMAIL_MAX_ATTEMPTS: 5,
        ADMIN_INVITATION_EMAIL_BATCH_SIZE: 25,
        ADMIN_INVITATION_EMAIL_POLL_INTERVAL_MS: 5000,
        VOUCHER_ALLOCATION_OUTBOX_BATCH_SIZE: 10,
        VOUCHER_ALLOCATION_POLL_INTERVAL_MS: 5000,
        VOUCHER_ALLOCATION_LEASE_MS: 120000,
        VOUCHER_ALLOCATION_MAX_ATTEMPTS: 5,
        VOUCHER_ALLOCATION_RETRY_BASE_DELAY_MS: 5000,
        VOUCHER_ALLOCATION_RETRY_MAX_DELAY_MS: 300000,
        RESTOCK_DRAIN_OUTBOX_BATCH_SIZE: 10,
        RESTOCK_DRAIN_CHUNK_SIZE: 250,
        RESTOCK_DRAIN_RECOVERY_PRODUCT_BATCH_SIZE: 10,
        RESTOCK_DRAIN_POLL_INTERVAL_MS: 5000,
        RESTOCK_DRAIN_LEASE_MS: 120000,
        RESTOCK_DRAIN_MAX_ATTEMPTS: 5,
        RESTOCK_DRAIN_RETRY_BASE_DELAY_MS: 5000,
        RESTOCK_DRAIN_RETRY_MAX_DELAY_MS: 300000,
        STOCK_MONITORING_PRODUCT_BATCH_SIZE: 100,
        STOCK_MONITORING_POLL_INTERVAL_MS: 5000,
        STOCK_ALERT_OUTBOX_BATCH_SIZE: 25,
        STOCK_ALERT_OUTBOX_LEASE_MS: 120000,
        RECONCILIATION_BATCH_SIZE: 50,
        RECONCILIATION_POLL_INTERVAL_MS: 60000,
        VOUCHER_RETRIEVAL_EMAIL_BATCH_SIZE: 25,
        VOUCHER_RETRIEVAL_EMAIL_POLL_INTERVAL_MS: 5000,
        VOUCHER_RETRIEVAL_EMAIL_PROCESSING_LEASE_MS: 120000,
        VOUCHER_RETRIEVAL_EMAIL_MAX_ATTEMPTS: 5,
        VOUCHER_RETRIEVAL_EMAIL_RETRY_BASE_DELAY_MS: 5000,
        VOUCHER_RETRIEVAL_EMAIL_RETRY_MAX_DELAY_MS: 300000,
      });
    });

    it('rejects an unsupported environment', () => {
      expect(() =>
        validateWorkerEnvironment({
          SERVICE_NAME: 'worker',
          NODE_ENV: 'local',
          DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
          REDIS_URL: 'redis://localhost:6379',
        }),
      ).toThrow('NODE_ENV');
    });

    it('rejects an allocation retry maximum below its base delay', () => {
      expect(() =>
        validateWorkerEnvironment({
          ...validWorkerEnvironment,
          VOUCHER_ALLOCATION_RETRY_BASE_DELAY_MS: '10000',
          VOUCHER_ALLOCATION_RETRY_MAX_DELAY_MS: '5000',
        }),
      ).toThrow('VOUCHER_ALLOCATION_RETRY_MAX_DELAY_MS');
    });

    it('rejects a restock retry maximum below its base delay', () => {
      expect(() =>
        validateWorkerEnvironment({
          ...validWorkerEnvironment,
          RESTOCK_DRAIN_RETRY_BASE_DELAY_MS: '10000',
          RESTOCK_DRAIN_RETRY_MAX_DELAY_MS: '5000',
        }),
      ).toThrow('RESTOCK_DRAIN_RETRY_MAX_DELAY_MS');
    });

    it('rejects a voucher delivery retry maximum below its base delay', () => {
      expect(() =>
        validateWorkerEnvironment({
          ...validWorkerEnvironment,
          VOUCHER_DELIVERY_RETRY_BASE_DELAY_MS: '10000',
          VOUCHER_DELIVERY_RETRY_MAX_DELAY_MS: '5000',
        }),
      ).toThrow('VOUCHER_DELIVERY_RETRY_MAX_DELAY_MS');
    });
  });
});

const privacyHmacKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const paystackPublicEnvironment = {
  PAYSTACK_SECRET_KEY: 'sk_test_012345678901234567890123456789',
  PAYSTACK_CALLBACK_URL: 'https://app.example.com/payment/callback',
} as const;

const moolrePaymentEnvironment = {
  MOOLRE_WEBHOOK_SECRET: 'test-callback-secret',
  MOOLRE_API_USER: 'edu-integration',
  MOOLRE_PUBLIC_KEY: 'pk_test_0123456789012345678901234567890',
  MOOLRE_ACCOUNT_NUMBER: '100000157291',
} as const;

const naloUssdEnvironment = {
  NALO_TRUSTED_SOURCE_IPS: '203.0.113.10,203.0.113.11',
  NALO_USER_ID: 'NALOTest',
  USSD_ENABLED: true,
} as const;

const validWorkerEnvironment = {
  SERVICE_NAME: 'worker',
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
  REDIS_URL: 'redis://localhost:6379',
  PAYSTACK_SECRET_KEY: paystackPublicEnvironment.PAYSTACK_SECRET_KEY,
  MOOLRE_API_USER: moolrePaymentEnvironment.MOOLRE_API_USER,
  MOOLRE_PUBLIC_KEY: moolrePaymentEnvironment.MOOLRE_PUBLIC_KEY,
  MOOLRE_ACCOUNT_NUMBER: moolrePaymentEnvironment.MOOLRE_ACCOUNT_NUMBER,
  ADMIN_APPLICATION_ORIGIN: 'https://admin.example.com',
  ADMIN_SESSION_HMAC_KEY: '0123456789012345678901234567890123456789012',
  ADMIN_SECRET_ENCRYPTION_KEY_ID: 'test-v1',
  ADMIN_SECRET_ENCRYPTION_KEY: '0123456789012345678901234567890123456789012',
  VOUCHER_SECRET_ENCRYPTION_KEY_ID: 'test-v1',
  VOUCHER_SECRET_ENCRYPTION_KEY: '0123456789012345678901234567890123456789012',
  VOUCHER_PIN_FINGERPRINT_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  RESEND_API_KEY: 're_test',
  RESEND_FROM_EMAIL: 'EduVoucher <admin@example.com>',
  MOOLRE_SMS_VAS_KEY: 'moolre-test-key',
  MOOLRE_SMS_SENDER_ID: 'EduVoucher',
  CUSTOMER_SUPPORT_PHONE: '+233300000000',
} as const;
