import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { pool } from './db.js';

const applied = await migrate();
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

const app = await buildApp({ logger: true });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
app.log.info(`Payment provider: ${config.PAYMENT_PROVIDER}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
