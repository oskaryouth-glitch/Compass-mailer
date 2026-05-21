#!/usr/bin/env node
// Run once after creating your Neon database: `node setup-db.js`
// Creates the clients table and seeds the 3 initial clients (idempotent).

require('dotenv').config();
const { sql } = require('./db');

const seedClients = [
  { name: 'Alex Cushner',  email: 'alexcushner@gmail.com',     addr: '30 Sarah Dr',     city: 'Mill Valley',   state: 'CA', zip: '94941' },
  { name: 'A. Curtis',     email: 'acurtis1982@gmail.com',     addr: '633 Chestnut St', city: 'San Francisco', state: 'CA', zip: '94133' },
  { name: 'Jackie Carmel', email: 'jackie.f.carmel@gmail.com', addr: '2775 Vallejo St', city: 'San Francisco', state: 'CA', zip: '94123' },
];

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set. Add it to your .env file.');
    process.exit(1);
  }

  console.log('Creating tables…');
  await sql`
    CREATE TABLE IF NOT EXISTS app_state (
      key        text PRIMARY KEY,
      value      jsonb NOT NULL,
      updated_at timestamptz DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS clients (
      id            serial PRIMARY KEY,
      name          text NOT NULL,
      email         text NOT NULL,
      addr          text NOT NULL,
      city          text NOT NULL,
      state         text NOT NULL,
      zip           text NOT NULL,
      sqft          int,
      beds          numeric,
      baths         numeric,
      purchase      int,
      purchase_date date,
      last_sent     timestamptz,
      last_val      int,
      created_at    timestamptz DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS value_history (
      id          serial PRIMARY KEY,
      client_id   int REFERENCES clients(id) ON DELETE CASCADE,
      recorded_at timestamptz DEFAULT now(),
      value       bigint NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS value_history_client_idx ON value_history (client_id, recorded_at)`;
  console.log('  ✓ Tables ready.');

  const existing = await sql`SELECT count(*)::int AS n FROM clients`;
  if (existing[0].n > 0) {
    console.log(`  ↪ ${existing[0].n} clients already in DB, skipping seed.`);
  } else {
    console.log('Seeding clients…');
    for (const c of seedClients) {
      await sql`
        INSERT INTO clients (name, email, addr, city, state, zip)
        VALUES (${c.name}, ${c.email}, ${c.addr}, ${c.city}, ${c.state}, ${c.zip})
      `;
      console.log(`  ✓ ${c.name}`);
    }
  }
  console.log('Done.');
  process.exit(0);
})().catch(e => {
  console.error('Setup failed:', e.message);
  process.exit(1);
});
