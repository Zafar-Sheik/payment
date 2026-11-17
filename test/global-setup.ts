import pg from 'pg';

/** Recreate the test database schema from scratch, then run migrations. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://pay:pay@localhost:5432/payments_test';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  process.env.DATABASE_URL = url;
  const { migrate } = await import('../src/migrate.js');
  const { pool } = await import('../src/db.js');
  await migrate();
  await pool.end();
}
