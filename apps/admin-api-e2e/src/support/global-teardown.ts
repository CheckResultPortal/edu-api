import { killPort } from '@nx/node/utils';

module.exports = async function () {
  const port = process.env.PORT ? Number(process.env.PORT) : 3002;
  await killPort(port);
};
