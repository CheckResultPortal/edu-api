import {
  validateAdminApiEnvironment,
  validatePublicApiEnvironment,
  validateWorkerEnvironment,
} from './environment';

describe('environment validation', () => {
  describe('public API', () => {
    it('applies valid defaults', () => {
      const configuration = validatePublicApiEnvironment({
        SERVICE_NAME: 'public-api',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
      });

      expect(configuration).toEqual({
        NODE_ENV: 'development',
        SERVICE_NAME: 'public-api',
        LOG_LEVEL: 'log',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
        HOST: '0.0.0.0',
        PORT: 3001,
      });
    });

    it('converts PORT from a string to a number', () => {
      const configuration = validatePublicApiEnvironment({
        SERVICE_NAME: 'public-api',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
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
          PORT: '70000',
        }),
      ).toThrow('Invalid environment configuration');
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
      });

      expect(configuration.PORT).toBe(3002);
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
      });

      expect(configuration).toEqual({
        NODE_ENV: 'test',
        SERVICE_NAME: 'worker',
        LOG_LEVEL: 'debug',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
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
