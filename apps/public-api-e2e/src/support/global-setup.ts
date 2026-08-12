import { waitForPortOpen } from '@nx/node/utils';

module.exports = async function () {
  const host = process.env.HOST ?? 'localhost';
  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await waitForPortOpen(port, { host });
};
