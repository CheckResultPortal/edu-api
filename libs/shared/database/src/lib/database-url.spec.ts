import { databaseUrlFromEnvironment } from './database-url';

describe('databaseUrlFromEnvironment', () => {
  it('returns the configured PostgreSQL connection URL', () => {
    expect(
      databaseUrlFromEnvironment({
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
      }),
    ).toBe('postgresql://user:password@localhost:5432/database');
  });

  it('rejects a missing connection URL', () => {
    expect(() => databaseUrlFromEnvironment({})).toThrow('DATABASE_URL');
  });
});
