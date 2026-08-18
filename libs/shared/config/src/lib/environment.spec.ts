import {
  validateAdminApiEnvironment,
  validatePublicApiEnvironment,
  validateWorkerEnvironment,
  trustProxyFromEnvironment,
} from './environment';

describe('environment validation', () => {
  describe('public API', () => {
    it('applies valid defaults', () => {
      const configuration = validatePublicApiEnvironment({
        SERVICE_NAME: 'public-api',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
        ORDER_PRIVACY_HMAC_KEY: privacyHmacKey,
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
      });
    });

    it('bounds trusted reverse-proxy hops', () => {
      expect(
        validatePublicApiEnvironment({
          SERVICE_NAME: 'public-api',
          DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
          REDIS_URL: 'redis://localhost:6379',
          ORDER_PRIVACY_HMAC_KEY: privacyHmacKey,
          TRUST_PROXY_HOPS: '1',
        }).TRUST_PROXY_HOPS,
      ).toBe(1);
      expect(() =>
        validatePublicApiEnvironment({
          SERVICE_NAME: 'public-api',
          DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
          REDIS_URL: 'redis://localhost:6379',
          ORDER_PRIVACY_HMAC_KEY: privacyHmacKey,
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
        RESEND_API_KEY: 're_test',
        RESEND_FROM_EMAIL: 'EduVoucher <admin@example.com>',
        ADMIN_INVITATION_EMAIL_MAX_ATTEMPTS: 5,
        ADMIN_INVITATION_EMAIL_BATCH_SIZE: 25,
        ADMIN_INVITATION_EMAIL_POLL_INTERVAL_MS: 5000,
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
  });
});

const privacyHmacKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
