import { buildApi } from './api';
import { loadConfig } from './config';
import { createTaskQueue } from './queue';
import { createRepository } from './repository';

const config = loadConfig();
const repository = createRepository(config.databaseUrl);
const queue = createTaskQueue(config.redisUrl);
const app = await buildApi({ config, repository, queue });

const shutdown = async () => {
  await app.close();
  await queue.close();
  await repository.close();
};

process.on('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
process.on('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });

await app.listen({ host: config.host, port: config.port });
