#!/usr/bin/env node
// Dump every recoverable piece of state from the Neon database to a single
// JSON file under /backups. Includes:
//   * clients (with their manual_comps)
//   * value_history (full chart data)
//   * gmail_profile (sender name/email — NOT tokens)
//
// gmail_tokens are deliberately skipped — they're security-sensitive and
// Max can always re-authenticate via /auth/connect to regenerate them.
//
// Run periodically:
//   node backup-db.js
// or schedule via cron/launchd.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set.');
    process.exit(1);
  }

  const clients = await db.listClients();
  for (const c of clients) {
    c.history = await db.getHistory(c.id);
  }

  const gmailProfile = await db.getState('gmail_profile');

  const backup = {
    schemaVersion: 1,
    backedUpAt: new Date().toISOString(),
    counts: {
      clients:       clients.length,
      manualComps:   clients.reduce((s, c) => s + (c.manualComps?.length || 0), 0),
      valueHistory:  clients.reduce((s, c) => s + (c.history?.length || 0), 0),
    },
    gmailProfile,
    clients,
  };

  const dir = path.join(__dirname, 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));

  console.log(`Backup written: backups/backup-${stamp}.json`);
  console.log(`  clients:       ${backup.counts.clients}`);
  console.log(`  manual_comps:  ${backup.counts.manualComps}`);
  console.log(`  value_history: ${backup.counts.valueHistory}`);
  process.exit(0);
})().catch(e => {
  console.error('Backup failed:', e.message);
  process.exit(1);
});
