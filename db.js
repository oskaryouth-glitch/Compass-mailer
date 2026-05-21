const { neon } = require('@neondatabase/serverless');

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL not set — DB calls will fail.');
}

const sql = neon(process.env.DATABASE_URL);

async function listClients() {
  return await sql`
    SELECT id, name, email, addr, city, state, zip, sqft, beds, baths,
           purchase, purchase_date AS "purchaseDate",
           last_sent AS "lastSent", last_val AS "lastVal"
    FROM clients
    ORDER BY id
  `;
}

async function getClient(id) {
  const rows = await sql`
    SELECT id, name, email, addr, city, state, zip, sqft, beds, baths,
           purchase, purchase_date AS "purchaseDate",
           last_sent AS "lastSent", last_val AS "lastVal"
    FROM clients
    WHERE id = ${id}
  `;
  return rows[0] || null;
}

async function recordSend(id, lastVal) {
  await sql`
    UPDATE clients
    SET last_sent = NOW(), last_val = ${lastVal}
    WHERE id = ${id}
  `;
}

async function upsertClient(c) {
  if (c.id) {
    await sql`
      UPDATE clients SET
        name = ${c.name}, email = ${c.email}, addr = ${c.addr},
        city = ${c.city}, state = ${c.state}, zip = ${c.zip},
        sqft = ${c.sqft || null}, beds = ${c.beds || null}, baths = ${c.baths || null},
        purchase = ${c.purchase || null},
        purchase_date = ${c.purchaseDate || null}
      WHERE id = ${c.id}
    `;
    return c.id;
  } else {
    const rows = await sql`
      INSERT INTO clients (name, email, addr, city, state, zip, sqft, beds, baths, purchase, purchase_date)
      VALUES (${c.name}, ${c.email}, ${c.addr}, ${c.city}, ${c.state}, ${c.zip},
              ${c.sqft || null}, ${c.beds || null}, ${c.baths || null},
              ${c.purchase || null}, ${c.purchaseDate || null})
      RETURNING id
    `;
    return rows[0].id;
  }
}

async function deleteClient(id) {
  await sql`DELETE FROM clients WHERE id = ${id}`;
}

// Partial update — only writes provided keys. Used to backfill sqft/beds/baths
// /purchase/purchase_date when fetchEstimate discovers them on Zillow.
async function patchClient(id, patch) {
  const allowed = ['sqft','beds','baths','purchase','purchase_date','last_val'];
  const entries = Object.entries(patch).filter(([k,v]) => allowed.includes(k) && v != null);
  if (!entries.length) return;
  // Build the SET clause as a sequence of tagged-template fragments
  for (const [col, val] of entries) {
    if (col === 'sqft')          await sql`UPDATE clients SET sqft         = ${val} WHERE id = ${id}`;
    else if (col === 'beds')     await sql`UPDATE clients SET beds         = ${val} WHERE id = ${id}`;
    else if (col === 'baths')    await sql`UPDATE clients SET baths        = ${val} WHERE id = ${id}`;
    else if (col === 'purchase') await sql`UPDATE clients SET purchase     = ${val} WHERE id = ${id}`;
    else if (col === 'purchase_date') await sql`UPDATE clients SET purchase_date = ${val} WHERE id = ${id}`;
    else if (col === 'last_val') await sql`UPDATE clients SET last_val     = ${val} WHERE id = ${id}`;
  }
}

async function replaceAllClients(clients) {
  // Used by the dashboard's "save all clients" button.
  // Simpler than diffing — wipe and reinsert in a single transaction.
  await sql`TRUNCATE clients RESTART IDENTITY CASCADE`;
  for (const c of clients) {
    await sql`
      INSERT INTO clients (name, email, addr, city, state, zip, sqft, beds, baths, purchase, purchase_date, last_sent, last_val)
      VALUES (${c.name}, ${c.email}, ${c.addr}, ${c.city}, ${c.state}, ${c.zip},
              ${c.sqft || null}, ${c.beds || null}, ${c.baths || null},
              ${c.purchase || null}, ${c.purchaseDate || null},
              ${c.lastSent || null}, ${c.lastVal || null})
    `;
  }
}

async function recordHistory(clientId, value) {
  await sql`INSERT INTO value_history (client_id, value) VALUES (${clientId}, ${value})`;
}

async function getHistory(clientId) {
  return await sql`
    SELECT recorded_at AS "recordedAt", value
    FROM value_history
    WHERE client_id = ${clientId}
    ORDER BY recorded_at ASC
  `;
}

async function getState(key) {
  const rows = await sql`SELECT value FROM app_state WHERE key = ${key}`;
  return rows[0]?.value || null;
}

async function setState(key, value) {
  await sql`
    INSERT INTO app_state (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

module.exports = {
  sql, listClients, getClient, recordSend, upsertClient, deleteClient, replaceAllClients,
  getState, setState, patchClient, recordHistory, getHistory,
};
