import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['src/lib/queue.factory.ts'],
    rules: { '@nx/enforce-module-boundaries': 'off' },
  },
];
