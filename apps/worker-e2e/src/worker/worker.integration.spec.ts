import { validateWorkerEnvironment } from '@edu-api/config';

describe('Worker integration', () => {
  it('accepts its required worker environment', () => {
    expect(
      validateWorkerEnvironment({
        LOG_LEVEL: 'error',
        NODE_ENV: 'test',
        SERVICE_NAME: 'worker',
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
      }),
    ).toMatchObject({
      NODE_ENV: 'test',
      SERVICE_NAME: 'worker',
    });
  });
});
