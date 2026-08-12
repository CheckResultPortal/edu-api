import { killPort } from '@nx/node/utils';

module.exports = async function () {
  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await killPort(port);
};
