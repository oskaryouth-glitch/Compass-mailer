require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const path = require('path');

const db = require('./db');
const market = require('./marketRates');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const APIFY_TOKEN          = process.env.APIFY_TOKEN;
const GMAIL_CLIENT_ID      = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET  = process.env.GMAIL_CLIENT_SECRET;
const OAUTH_REDIRECT_URI   = process.env.OAUTH_REDIRECT_URI || 'http://localhost:3000/auth/callback';
const CRON_SECRET          = process.env.CRON_SECRET || '';

const gmailConfigured = !!(GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET);

function getOAuthClient() {
  return new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, OAUTH_REDIRECT_URI);
}

// ── Gmail OAuth ───────────────────────────────────────────────────────────────
app.get('/auth/connect', (req, res) => {
  if (!gmailConfigured) return res.status(500).send('GMAIL_CLIENT_ID/SECRET not set.');
  const url = getOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const oauth = getOAuthClient();
    const { tokens } = await oauth.getToken(req.query.code);
    oauth.setCredentials(tokens);
    const { data } = await google.oauth2({ version: 'v2', auth: oauth }).userinfo.get();
    await db.setState('gmail_tokens', tokens);
    await db.setState('gmail_profile', { email: data.email, name: data.name });
    res.redirect('/?connected=gmail');
  } catch (e) {
    console.error('OAuth callback error:', e);
    res.status(500).send('OAuth failed: ' + e.message);
  }
});

async function getGmailAuth() {
  const tokens = await db.getState('gmail_tokens');
  if (!tokens) return null;
  const oauth = getOAuthClient();
  oauth.setCredentials(tokens);
  // Auto-refresh: if Google issues new tokens during a refresh, persist them.
  oauth.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await db.setState('gmail_tokens', merged);
  });
  return oauth;
}

// ── Property valuation ───────────────────────────────────────────────────────
// fetchEstimate(client) is the abstraction every other piece of the app calls.
// It returns { price, beds, baths, sqft, purchasePrice, purchaseDate, comparables, ... }
//
// CURRENT IMPLEMENTATION: Apify + Zillow.
//   * maxcopell/zillow-detail-scraper for the home itself (Zestimate + history)
//   * maxcopell/zillow-scraper for "currently for sale nearby" comparables
//
// FUTURE: swap to a direct MLS source for higher accuracy. To do that, replace
// the body of fetchEstimate() with the MLS actor call and keep the return
// shape identical. Nothing else in the app needs to change.

async function fetchComparables(lat, lng, homeType, refSqft, streetWord) {
  if (lat == null || lng == null) return [];
  const delta = 0.012; // ~0.75 mi box
  const sqs = {
    isMapVisible: true,
    isListVisible: true,
    mapBounds: { north: lat+delta, south: lat-delta, east: lng+delta, west: lng-delta },
    filterState: { sort: { value: 'days' } },
  };
  const url = `https://www.zillow.com/homes/for_sale/?searchQueryState=${encodeURIComponent(JSON.stringify(sqs))}`;
  try {
    const res = await axios.post(
      `https://api.apify.com/v2/acts/maxcopell~zillow-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=120`,
      { searchUrls: [{ url }], extractionMethod: 'MAP_MARKERS' },
      { headers: { 'Content-Type': 'application/json' }, timeout: 130000 }
    );
    const raw = Array.isArray(res.data) ? res.data : [];
    const comps = raw.map(p => {
      const hi = (p.hdpData && p.hdpData.homeInfo) || {};
      return {
        address:  p.address || hi.streetAddress,
        price:    hi.zestimate || hi.price || null,
        beds:     hi.bedrooms ?? null,
        baths:    hi.bathrooms ?? null,
        sqft:     hi.livingArea ?? null,
        homeType: hi.homeType ?? null,
        lat:      hi.latitude  ?? p.latLong?.latitude,
        lng:      hi.longitude ?? p.latLong?.longitude,
      };
    }).filter(c => c.address && c.price);

    // Filter to similar properties so we don't mix condos with mansions
    const matchesType = c => !homeType || !c.homeType || c.homeType === homeType;
    const matchesSize = c => {
      if (!refSqft) return true;
      // When we know our home's sqft, reject comps with missing/zero sqft data
      if (!c.sqft || c.sqft <= 0) return false;
      return c.sqft >= refSqft * 0.5 && c.sqft <= refSqft * 1.7;
    };
    const sameStreet  = c => streetWord && (c.address || '').toLowerCase().includes(streetWord);
    const dist = c => Math.hypot((c.lat||lat)-lat, (c.lng||lng)-lng);

    const filtered = comps.filter(c => matchesType(c) && matchesSize(c));
    // Prefer same-street, then closest
    return filtered
      .sort((a, b) => (sameStreet(b) - sameStreet(a)) || (dist(a) - dist(b)))
      .slice(0, 3);
  } catch (e) {
    console.error('[comps] failed:', e.message);
    return [];
  }
}

async function fetchEstimate(client) {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not configured');

  const fullAddress = `${client.addr}, ${client.city}, ${client.state} ${client.zip}`;

  const res = await axios.post(
    `https://api.apify.com/v2/acts/maxcopell~zillow-detail-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=300`,
    { addresses: [fullAddress], propertyStatus: 'RECENTLY_SOLD' },
    { headers: { 'Content-Type': 'application/json' }, timeout: 320000 }
  );

  const items = Array.isArray(res.data) ? res.data : [];
  if (!items.length) throw new Error(`No Zillow data found for "${fullAddress}"`);
  const p = items[0];

  const val = p.zestimate ?? p.price;
  if (!val) throw new Error('Zillow has no Zestimate for this property');

  // Purchase price/date = the most recent "Sold" event in price history.
  let purchasePrice = null, purchaseDate = null;
  const sold = (p.priceHistory || []).filter(h => h.event === 'Sold')
                                     .sort((a,b) => (b.time||0) - (a.time||0));
  if (sold[0]) {
    purchasePrice = sold[0].price;
    purchaseDate  = sold[0].date;
  } else if (p.lastSoldPrice && p.dateSold) {
    purchasePrice = p.lastSoldPrice;
    purchaseDate  = new Date(p.dateSold).toISOString().slice(0, 10);
  }

  // Comparables (separate actor call, parallel-safe)
  const streetWord  = (client.addr.replace(/^\d+\s+/, '').split(/\s+/)[0] || '').toLowerCase();
  const comparables = await fetchComparables(p.latitude, p.longitude, p.homeType, p.livingArea, streetWord);

  return {
    price: val,
    source: 'zillow_zestimate',
    priceRangeLow:  Math.round(val * 0.95),
    priceRangeHigh: Math.round(val * 1.05),
    beds:           p.bedrooms  ?? null,
    baths:          p.bathrooms ?? null,
    sqft:           p.livingArea ?? null,
    homeType:       p.homeType ?? null,
    yearBuilt:      p.yearBuilt ?? null,
    taxAssessedValue: p.taxAssessedValue ?? null,
    purchasePrice,
    purchaseDate,
    zillowUrl:      p.hdpUrl ? 'https://www.zillow.com' + p.hdpUrl : null,
    comparables,
  };
}

// Wrapper that fetches AND backfills client fields in the DB so the
// dashboard's Property Details pane fills in after the first fetch.
// Process an array N at a time. Apify free tier limits concurrent actor runs,
// and each estimate call spawns 2 (detail + search). With concurrency=2 we
// cap at 4 concurrent runs which stays safely under the free-tier ceiling.
async function mapInBatches(items, fn, concurrency = 2) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    out.push(...await Promise.all(items.slice(i, i + concurrency).map(fn)));
  }
  return out;
}

async function fetchAndPersist(client) {
  const v = await fetchEstimate(client);
  const patch = {};
  if (!client.sqft  && v.sqft)         patch.sqft  = v.sqft;
  if (!client.beds  && v.beds  != null) patch.beds  = v.beds;
  if (!client.baths && v.baths != null) patch.baths = v.baths;
  if (!client.purchase     && v.purchasePrice) patch.purchase      = v.purchasePrice;
  if (!client.purchaseDate && v.purchaseDate)  patch.purchase_date = v.purchaseDate;
  if (Object.keys(patch).length) await db.patchClient(client.id, patch);

  // Record this snapshot so the graph builds real history over time
  await db.recordHistory(client.id, v.price);
  const history = await db.getHistory(client.id);

  // Merge backfilled fields back into the client object so the email/preview see them
  const mergedClient = { ...client, ...patch, purchaseDate: patch.purchase_date || client.purchaseDate };

  // Add derived "average appreciation per month since purchase"
  const purchase     = mergedClient.purchase     || v.purchasePrice;
  const purchaseDate = mergedClient.purchaseDate || v.purchaseDate;
  let monthlyAppreciation = null, monthsHeld = null;
  if (purchase && purchaseDate) {
    const ms = Date.now() - new Date(purchaseDate).getTime();
    monthsHeld = Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24 * 30.4375)));
    monthlyAppreciation = Math.round((v.price - purchase) / monthsHeld);
  }

  // Layer in market intel: mortgage rate context + SF-metro annualized return.
  // These run in parallel and degrade gracefully if FRED is down.
  const [rateContext, marketReturn] = await Promise.all([
    market.getRateContext(purchaseDate, purchase, v.price),
    market.getMarketReturn(purchaseDate),
  ]);

  // Annualized return on THEIR home (so we can compare to the market)
  let homeAnnualized = null;
  if (purchase && monthsHeld) {
    const years = monthsHeld / 12;
    if (years > 0 && purchase > 0) {
      homeAnnualized = Math.pow(v.price / purchase, 1 / years) - 1;
    }
  }

  const enriched = {
    ...v, history, monthlyAppreciation, monthsHeld,
    rateContext, marketReturn, homeAnnualized,
  };

  // Render the actual email HTML so the dashboard preview matches what gets sent
  const profile = await db.getState('gmail_profile');
  const senderName = profile?.name || 'Max from Compass';
  const previewHtml = buildEmail(mergedClient, enriched, senderName).html;

  return { ...enriched, previewHtml };
}

// Map city to a friendlier "market" label used in the email body.
function marketName(city) {
  const c = (city || '').toLowerCase();
  if (['mill valley','tiburon','sausalito','corte madera','larkspur','belvedere','ross','kentfield','san rafael','novato','greenbrae'].includes(c)) return 'Marin';
  if (c === 'san francisco') return 'San Francisco';
  if (['oakland','berkeley','emeryville','alameda','piedmont'].includes(c)) return 'East Bay';
  if (['palo alto','menlo park','mountain view','atherton','los altos','redwood city','san mateo'].includes(c)) return 'Peninsula';
  return city || 'local';
}

// ── Email builder ─────────────────────────────────────────────────────────────
function buildEmail(client, valData, senderName) {
  const val = valData.price;
  const prev = client.lastVal;
  const change = (prev && prev !== val) ? val - prev : null;
  const purchase     = client.purchase     || valData.purchasePrice;
  const purchaseDate = client.purchaseDate || valData.purchaseDate;
  const gainSincePurchase = (purchase && val) ? val - purchase : null;

  // Hero change line: prefer month-over-month → since-purchase → first reading.
  let changeLine;
  if (change != null) {
    changeLine = `${change >= 0 ? '▲ Up' : '▼ Down'} $${Math.abs(Math.round(change)).toLocaleString()} since last month`;
  } else if (gainSincePurchase != null) {
    const sign = gainSincePurchase >= 0 ? '▲ Up' : '▼ Down';
    const pct  = (gainSincePurchase / purchase) * 100;
    const when = purchaseDate ? ` since you bought it (${new Date(purchaseDate).toLocaleDateString('en-US',{month:'short',year:'numeric'})})` : ' since purchase';
    changeLine = `${sign} $${Math.abs(gainSincePurchase).toLocaleString()} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)${when}`;
  } else {
    changeLine = 'First estimate on record';
  }

  const firstName = client.name.split(' ')[0];
  const market    = marketName(client.city);

  const compsHtml = (valData.comparables || []).slice(0, 3).map(c => `
    <tr>
      <td style="padding:6px 0;color:#555;font-size:13px">${c.address}</td>
      <td style="padding:6px 0;text-align:right;font-weight:600;font-size:13px">$${Math.round(c.price || 0).toLocaleString()}</td>
    </tr>`).join('');

  // Purchase-gain block: only if we know what they paid
  const sqft     = client.sqft || valData.sqft;
  const gain     = gainSincePurchase;
  const gainPct  = purchase ? ((val - purchase) / purchase) * 100 : null;
  const ppsf     = sqft ? Math.round(val / sqft) : null;
  const purchaseHtml = purchase ? `
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:13px">
      <tr><td style="padding:4px 0;color:#888">Purchased${purchaseDate ? ' ' + new Date(purchaseDate).toLocaleDateString('en-US',{month:'short',year:'numeric'}) : ''}</td>
          <td style="padding:4px 0;text-align:right;font-weight:600">$${purchase.toLocaleString()}</td></tr>
      ${gain != null ? `
      <tr><td style="padding:4px 0;color:#888">Gain since purchase</td>
          <td style="padding:4px 0;text-align:right;font-weight:700;color:${gain >= 0 ? '#2d7a3a' : '#c0392b'}">
            ${gain >= 0 ? '+' : '−'}$${Math.abs(gain).toLocaleString()}${gainPct != null ? ` (${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%)` : ''}
          </td></tr>` : ''}
      ${valData.monthlyAppreciation != null ? `
      <tr><td style="padding:4px 0;color:#888">Average per month</td>
          <td style="padding:4px 0;text-align:right;font-weight:600;color:${valData.monthlyAppreciation >= 0 ? '#2d7a3a' : '#c0392b'}">
            ≈ ${valData.monthlyAppreciation >= 0 ? '+' : '−'}$${Math.abs(valData.monthlyAppreciation).toLocaleString()}/mo
            <span style="font-weight:400;color:#aaa">over ${valData.monthsHeld} mo</span>
          </td></tr>` : ''}
      ${ppsf ? `
      <tr><td style="padding:4px 0;color:#888">Price per sqft</td>
          <td style="padding:4px 0;text-align:right;font-weight:600">$${ppsf.toLocaleString()}</td></tr>` : ''}
    </table>` : '';

  const html = `
  <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#1a1a1a">
    <div style="border-bottom:2px solid #1a1a1a;padding-bottom:12px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:flex-end">
      <span style="font-size:20px;font-weight:700;letter-spacing:-0.5px">Compass</span>
      <span style="font-size:12px;color:#888">${new Date().toLocaleDateString('en-US',{month:'long',year:'numeric'})}</span>
    </div>

    <p style="font-size:15px;margin:0 0 20px">Hi ${firstName},</p>
    <p style="font-size:15px;margin:0 0 24px;line-height:1.6">Here's your monthly home value update for <strong>${client.addr}, ${client.city}</strong>.</p>

    <div style="background:#f8f8f8;border-radius:8px;padding:24px;text-align:center;margin-bottom:24px">
      <div style="font-size:13px;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em">Estimated value</div>
      <div style="font-size:40px;font-weight:700;letter-spacing:-1px">$${Math.round(val).toLocaleString()}</div>
      <div style="font-size:14px;color:${change >= 0 ? '#2d7a3a' : '#c0392b'};margin-top:8px">${changeLine}</div>
      <div style="font-size:12px;color:#aaa;margin-top:6px">Range: $${Math.round(valData.priceRangeLow).toLocaleString()} – $${Math.round(valData.priceRangeHigh).toLocaleString()}</div>
    </div>

    ${purchaseHtml}

    ${valData.rateContext ? `
    <div style="background:#fff8e1;border:1px solid #f0e2b8;border-radius:8px;padding:14px 16px;margin-bottom:20px">
      <div style="font-size:11px;font-weight:700;color:#8a6d1f;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Your rate lock</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><td style="padding:3px 0;color:#666">30-year fixed when you bought</td>
            <td style="padding:3px 0;text-align:right;font-weight:600">${valData.rateContext.rateAtPurchase.toFixed(2)}%</td></tr>
        <tr><td style="padding:3px 0;color:#666">30-year fixed today</td>
            <td style="padding:3px 0;text-align:right;font-weight:600">${valData.rateContext.rateToday.toFixed(2)}%</td></tr>
        ${valData.rateContext.lockedMonthly && valData.rateContext.buyerMonthly ? `
        <tr><td style="padding:3px 0;color:#666">Buyer purchasing today (80% down) pays</td>
            <td style="padding:3px 0;text-align:right;font-weight:600">$${valData.rateContext.buyerMonthly.toLocaleString()}/mo</td></tr>
        <tr><td style="padding:3px 0;color:#666">You're estimated to pay</td>
            <td style="padding:3px 0;text-align:right;font-weight:600">$${valData.rateContext.lockedMonthly.toLocaleString()}/mo</td></tr>
        ${valData.rateContext.advantage && valData.rateContext.advantage > 0 ? `
        <tr><td style="padding:6px 0 0;color:#1a1a1a;font-weight:600;border-top:1px solid #f0e2b8">Your rate-lock advantage</td>
            <td style="padding:6px 0 0;text-align:right;font-weight:700;color:#2d7a3a;border-top:1px solid #f0e2b8">~$${valData.rateContext.advantage.toLocaleString()}/mo</td></tr>` : ''}
        ` : ''}
      </table>
    </div>` : ''}

    ${(valData.homeAnnualized != null && valData.marketReturn) ? `
    <div style="background:#eef5fa;border:1px solid #d2e2ee;border-radius:8px;padding:14px 16px;margin-bottom:24px">
      <div style="font-size:11px;font-weight:700;color:#1a4a7a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Your home vs the SF market</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><td style="padding:3px 0;color:#666">Your home, annualized return</td>
            <td style="padding:3px 0;text-align:right;font-weight:700;color:${valData.homeAnnualized >= 0 ? '#2d7a3a' : '#c0392b'}">${(valData.homeAnnualized*100).toFixed(1)}%/yr</td></tr>
        <tr><td style="padding:3px 0;color:#666">SF metro average (Case-Shiller)</td>
            <td style="padding:3px 0;text-align:right;font-weight:600">${(valData.marketReturn.annualized*100).toFixed(1)}%/yr</td></tr>
        <tr><td style="padding:6px 0 0;color:#1a1a1a;font-weight:600;border-top:1px solid #d2e2ee">${(valData.homeAnnualized - valData.marketReturn.annualized) >= 0 ? 'Outperforming the market by' : 'Underperforming the market by'}</td>
            <td style="padding:6px 0 0;text-align:right;font-weight:700;color:${(valData.homeAnnualized - valData.marketReturn.annualized) >= 0 ? '#2d7a3a' : '#c0392b'};border-top:1px solid #d2e2ee">${(valData.homeAnnualized - valData.marketReturn.annualized) >= 0 ? '+' : ''}${((valData.homeAnnualized - valData.marketReturn.annualized)*100).toFixed(1)} pp/yr</td></tr>
      </table>
    </div>` : ''}

    ${compsHtml ? `
    <p style="font-size:13px;font-weight:600;margin:0 0 8px;text-transform:uppercase;letter-spacing:.05em;color:#888">Currently for sale nearby</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;border-top:1px solid #eee">
      ${compsHtml}
    </table>` : ''}

    ${gain != null && valData.monthlyAppreciation != null ? `
    <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#444">
      Since you bought ${client.addr}${purchaseDate ? ' in ' + new Date(purchaseDate).toLocaleDateString('en-US',{month:'long',year:'numeric'}) : ''}, it's ${gain >= 0 ? 'appreciated' : 'softened'} <strong style="color:${gain >= 0 ? '#2d7a3a' : '#c0392b'}">${gain >= 0 ? '+' : '−'}$${Math.abs(gain).toLocaleString()}</strong>, averaging about <strong>${valData.monthlyAppreciation >= 0 ? '+' : '−'}$${Math.abs(valData.monthlyAppreciation).toLocaleString()}/month</strong>. ${gain >= 0 ? "That's compounding equity working in your favor." : "The market has cooled in your segment, but long-term Bay Area fundamentals remain strong. Worth a conversation if you're weighing options."}
    </p>` : ''}
    <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#444">
      The ${market} market continues to favor sellers, with limited inventory and steady Bay Area demand. Thinking about selling, refinancing, or just curious how the neighborhood is shifting? Reply anytime, I'm always happy to chat.
    </p>

    <div style="border-top:1px solid #eee;padding-top:16px;font-size:13px;color:#888">
      <strong style="color:#1a1a1a">${senderName}</strong> · Compass Real Estate<br>
      Reply to this email anytime. I read every one.
    </div>
  </div>`;

  return {
    to: client.email,
    subject: `Your ${client.addr} home value, ${new Date().toLocaleDateString('en-US',{month:'long',year:'numeric'})}`,
    html,
  };
}

// ── Send via Gmail API ────────────────────────────────────────────────────────
async function sendEmail(oauth, senderName, emailData) {
  const gmail = google.gmail({ version: 'v1', auth: oauth });
  const raw = Buffer.from(
    `From: ${senderName} <me>\r\n` +
    `To: ${emailData.to}\r\n` +
    `Subject: ${emailData.subject}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/html; charset=utf-8\r\n\r\n` +
    emailData.html
  ).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

  return gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// ── API routes ────────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const [clients, profile, tokens] = await Promise.all([
      db.listClients(),
      db.getState('gmail_profile'),
      db.getState('gmail_tokens'),
    ]);
    // Attach value history to each client so the dashboard spark can render on load
    const withHistory = await Promise.all(clients.map(async c => ({
      ...c,
      history: await db.getHistory(c.id),
    })));
    res.json({
      gmailConfigured: gmailConfigured,
      gmailConnected:  !!tokens,
      apifyConfigured: !!APIFY_TOKEN,
      senderEmail:     profile?.email || null,
      senderName:      profile?.name  || null,
      clients: withHistory,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/estimate/:id', async (req, res) => {
  try {
    const client = await db.getClient(parseInt(req.params.id));
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const data = await fetchAndPersist(client);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fetch-all', async (req, res) => {
  try {
    const clients = await db.listClients();
    const results = await mapInBatches(clients, (async c => {
      try {
        const data = await fetchAndPersist(c);
        return { id: c.id, name: c.name, ok: true, data };
      } catch (e) {
        return { id: c.id, name: c.name, ok: false, error: e.message };
      }
    }));
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function processOneClient(client, oauth, senderName) {
  try {
    const valData   = await fetchAndPersist(client);
    const emailData = buildEmail(client, valData, senderName);
    await sendEmail(oauth, senderName, emailData);
    await db.recordSend(client.id, valData.price);
    return { id: client.id, name: client.name, ok: true, val: valData.price };
  } catch (e) {
    return { id: client.id, name: client.name, ok: false, error: e.message };
  }
}

app.post('/api/send/:id', async (req, res) => {
  try {
    const oauth = await getGmailAuth();
    if (!oauth) return res.status(400).json({ error: 'Gmail not connected. Visit /auth/connect.' });
    const profile = await db.getState('gmail_profile');
    const client  = await db.getClient(parseInt(req.params.id));
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const r = await processOneClient(client, oauth, profile?.name || 'Compass Agent');
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send-all', async (req, res) => {
  try {
    const oauth = await getGmailAuth();
    if (!oauth) return res.status(400).json({ error: 'Gmail not connected. Visit /auth/connect.' });
    const profile = await db.getState('gmail_profile');
    const senderName = profile?.name || 'Compass Agent';
    const clients = await db.listClients();
    const results = await mapInBatches(clients, (c => processOneClient(c, oauth, senderName)));
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clients', async (req, res) => {
  try {
    await db.replaceAllClients(req.body.clients || []);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Vercel Cron endpoint ──────────────────────────────────────────────────────
// Vercel calls this on the schedule defined in vercel.json. The request comes
// with Authorization: Bearer ${CRON_SECRET}. Refuse anything else.
app.get('/api/cron/monthly', async (req, res) => {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  console.log('[CRON] Running monthly send…');
  try {
    const oauth = await getGmailAuth();
    if (!oauth) return res.status(400).json({ error: 'Gmail not connected' });
    const profile = await db.getState('gmail_profile');
    const senderName = profile?.name || 'Compass Agent';
    const clients = await db.listClients();
    const results = await mapInBatches(clients, (c => processOneClient(c, oauth, senderName)));
    results.forEach(r => console.log(`[CRON] ${r.ok ? 'sent' : 'FAILED'} ${r.name}${r.ok ? ' → $' + r.val : ': ' + r.error}`));
    res.json({ ran: new Date().toISOString(), results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Only start the listener when run directly (not when required by api/index.js)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Compass Mailer running at http://localhost:${PORT}`));
}

module.exports = app;
