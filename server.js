require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const path = require('path');

const db = require('./db');
const market = require('./marketRates');
const zipActivity = require('./zipActivity');

// Mine listing description text for appraiser-relevant features that may not
// appear in Zillow's structured fields (Curtis's outdoor space is a good example).
function extractDescriptionFeatures(desc) {
  if (!desc || typeof desc !== 'string') return [];
  const t = desc.toLowerCase();
  const found = [];
  // Views
  if (/golden gate|bridge view/.test(t))             found.push('Golden Gate Bridge view');
  else if (/bay view|water view/.test(t))            found.push('Water/Bay view');
  else if (/city view|panoramic|skyline/.test(t))    found.push('Panoramic/city view');
  // Outdoor space
  if (/\bgarden(s)?\b/.test(t))                      found.push('Garden(s)');
  if (/\bpatio\b/.test(t))                           found.push('Patio');
  if (/\bdeck\b/.test(t))                            found.push('Deck');
  if (/\b(roof[ -]?deck|rooftop)\b/.test(t))         found.push('Roof deck');
  if (/\bbalcony\b/.test(t))                         found.push('Balcony');
  if (/\bterrace\b/.test(t))                         found.push('Terrace');
  if (/\b(back|front)[ -]?yard\b/.test(t))           found.push('Yard');
  if (/\bcourtyard\b/.test(t))                       found.push('Courtyard');
  // Condition / quality
  if (/turn[ -]?key|move[ -]in (ready|condition)/.test(t)) found.push('Turn-key');
  if (/\brenovat(ed|ion)|remodel(ed|led)?/.test(t))  found.push('Recently renovated');
  if (/\bhigh[ -]?end\b/.test(t))                    found.push('High-end finishes');
  return [...new Set(found)];
}

// Compare unit-suffix patterns: if subject has no APT/Unit suffix but most
// comps do, subject is likely in a smaller (boutique) building, which usually
// commands a 5-20% premium that median-$/sqft from comps does NOT capture.
function detectBoutiquePremium(subjectAddr, comps) {
  const hasUnit = a => /\b(apt|unit|#|suite|ste)\b/i.test(a || '') || /\bAPT\s+/.test(a || '');
  const subjHasUnit = hasUnit(subjectAddr);
  if (subjHasUnit) return null; // subject is in a multi-unit building — not boutique
  const compsCount = comps?.length || 0;
  if (compsCount < 2) return null;
  const compsWithUnit = comps.filter(c => hasUnit(c.address)).length;
  const ratio = compsWithUnit / compsCount;
  if (ratio >= 0.4) {
    return {
      compsInLargerBuildings: compsWithUnit,
      totalComps: compsCount,
      note: `Subject is in a smaller building; ${compsWithUnit} of ${compsCount} comps are in larger multi-unit buildings. Boutique buildings typically command a 5-20% per-sqft premium not reflected in the median comp $/sqft.`,
    };
  }
  return null;
}

const app = express();
app.use(express.json({ limit: '5mb' }));

// ── HTTP Basic Auth ──────────────────────────────────────────────────────────
// Gate the whole dashboard + API behind a single username/password pair.
// Vercel Cron is skipped (it has its own CRON_SECRET).
const AUTH_USER     = process.env.AUTH_USER;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;

app.use((req, res, next) => {
  // Cron endpoint authenticates with CRON_SECRET, not basic auth
  if (req.path === '/api/cron/monthly') return next();
  // If basic auth isn't configured, allow through (local dev)
  if (!AUTH_USER || !AUTH_PASSWORD) return next();

  const sendChallenge = () => {
    res.set('WWW-Authenticate', 'Basic realm="Compass Mailer"');
    res.status(401).send('Authentication required');
  };

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return sendChallenge();

  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const user = decoded.slice(0, i);
    const pass = decoded.slice(i + 1);
    if (user === AUTH_USER && pass === AUTH_PASSWORD) return next();
  } catch { /* fall through */ }
  return sendChallenge();
});

// Serve dashboard from /web (not /public — Vercel auto-serves /public from
// edge cache, which would bypass our basic-auth middleware).
app.use(express.static(path.join(__dirname, 'web')));

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

// Convert a raw nearbyHome entry from the detail scraper into our comp shape.
function normalizeNearbyHome(n) {
  const addr = n.address?.streetAddress || n.address || null;
  return {
    address:    addr,
    price:      n.price || n.zestimate || null,
    beds:       n.bedrooms ?? null,
    baths:      n.bathrooms ?? null,
    sqft:       n.livingArea ?? null,
    lotSize:    n.lotSize ?? null,
    homeType:   n.homeType ?? null,
    homeStatus: n.homeStatus ?? null,
    lat:        n.latitude,
    lng:        n.longitude,
    zpid:       n.zpid,
    detailUrl:  n.hdpUrl ? 'https://www.zillow.com' + n.hdpUrl : null,
  };
}

// Pick the best comparables for sales-comparison valuation:
// (a) actually SOLD (drop OTHER off-market with Zestimates, drop FOR_SALE
//     listings — Max's rule: "money in the bank or it doesn't count"),
// (b) same home type, (c) sqft within 50%-150% of subject,
// (d) prefer same street/building, then closest by geo distance.
function pickComparables(nearbyHomes, subject) {
  if (!Array.isArray(nearbyHomes) || !nearbyHomes.length) return [];

  const isSold = s => s === 'SOLD' || s === 'RECENTLY_SOLD' || s === 'SOLD_OFF_MARKET';
  const comps = nearbyHomes
    .map(normalizeNearbyHome)
    .filter(c => c.address && c.price && c.sqft > 0)
    .filter(c => isSold(c.homeStatus));
  const subType  = subject.homeType;
  const subSqft  = subject.sqft;
  const subLat   = subject.lat;
  const subLng   = subject.lng;
  // Use street's first significant word, e.g., "Chestnut" or "Vallejo"
  const streetWord = (subject.streetAddr || '').replace(/^\d+\s+/, '').split(/\s+/)[0].toLowerCase();

  const matchesType = c => !subType || !c.homeType || c.homeType === subType;
  const matchesSize = c => !subSqft || (c.sqft >= subSqft * 0.5 && c.sqft <= subSqft * 1.5);
  const sameStreet  = c => streetWord && (c.address || '').toLowerCase().includes(streetWord);
  const distance    = c => (subLat != null && c.lat != null) ? Math.hypot(c.lat - subLat, c.lng - subLng) : Infinity;

  return comps
    .filter(c => matchesType(c) && matchesSize(c))
    .sort((a, b) => (sameStreet(b) - sameStreet(a)) || (distance(a) - distance(b)))
    .slice(0, 6);
}

// Sales-comparison valuation that leans into the upper part of the market.
// Instead of the USPAP median (which gives a conservative paper number), we
// anchor on the 75th percentile of adjusted $/sqft and quote a RANGE that goes
// up to the 90th percentile (or the top off-market comp). The bottom of the
// range gets dropped — a client at the top of their market doesn't need to
// see "$10M floor" comps in their email.
function percentile(sortedAsc, p) {
  if (!sortedAsc?.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(sortedAsc.length * p)));
  return sortedAsc[idx];
}

function computeAppraisalEstimate(subject, comps) {
  if (!subject.sqft || !comps?.length) return null;

  // Per-bed / per-bath adjustments are conservative & relative
  const adjusted = comps.map(c => {
    if (!c.sqft || !c.price) return null;
    const cPpsf = c.price / c.sqft;
    const bedDelta  = ((subject.beds  ?? 0) - (c.beds  ?? 0));
    const bathDelta = ((subject.baths ?? 0) - (c.baths ?? 0));
    const adjPct = Math.max(-0.20, Math.min(0.20, bedDelta * 0.04 + bathDelta * 0.03));
    const sizeDelta = Math.abs(c.sqft - subject.sqft) / subject.sqft;
    return {
      ...c,
      ppsf: cPpsf,
      adjustedPpsf: cPpsf * (1 + adjPct),
      adjPct,
      sizeDelta,
    };
  }).filter(Boolean);

  if (!adjusted.length) return null;

  const sortedPpsf = adjusted.map(c => c.adjustedPpsf).sort((a, b) => a - b);
  const medianPpsf       = percentile(sortedPpsf, 0.50);
  const upperPpsf        = percentile(sortedPpsf, 0.75); // 75th pct, top quartile
  const top90Ppsf        = percentile(sortedPpsf, 0.90); // 90th pct
  const maxPpsf          = sortedPpsf[sortedPpsf.length - 1];

  // Most-similar comp by sqft distance — kept for the "most similar" callout
  const mostSimilar = [...adjusted].sort((a, b) => a.sizeDelta - b.sizeDelta)[0];

  // Top comps by price (for display in email — the impressive ones only)
  const topCompsByPrice = [...adjusted]
    .sort((a, b) => b.price - a.price)
    .slice(0, 5);

  const lowRangeEstimate  = Math.round(upperPpsf * subject.sqft);          // bottom of presented range
  const highRangeEstimate = Math.round(Math.max(top90Ppsf, maxPpsf * 0.85) * subject.sqft); // top of range
  const paperEstimate     = Math.round(medianPpsf * subject.sqft);         // kept internal
  const marketEstimate    = Math.round(mostSimilar.adjustedPpsf * subject.sqft);

  return {
    // back-compat field
    estimate: lowRangeEstimate,
    // new range-based fields used by the email
    rangeLow:  lowRangeEstimate,
    rangeHigh: highRangeEstimate,
    // legacy fields preserved (used elsewhere or for debugging)
    paperEstimate,
    marketEstimate,
    medianPpsf: Math.round(medianPpsf),
    upperPpsf:  Math.round(upperPpsf),
    top90Ppsf:  Math.round(top90Ppsf),
    mostSimilar: {
      address: mostSimilar.address,
      price:   Math.round(mostSimilar.price),
      sqft:    mostSimilar.sqft,
      ppsf:    Math.round(mostSimilar.ppsf),
      sizeDeltaPct: Math.round(mostSimilar.sizeDelta * 100),
      status:  mostSimilar.homeStatus,
      isAgentIntel: mostSimilar.homeStatus === 'AGENT_INTEL',
    },
    topCompsByPrice,
    compsUsed: adjusted,
  };
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

  // Pull appraiser-relevant facts (view, parking, condition) from resoFacts
  const rf = p.resoFacts || {};
  const appraiserFacts = {
    view:                rf.view?.length ? rf.view : null,
    hasView:             rf.hasView || !!rf.waterViewYN,
    hasWaterfrontView:   !!rf.hasWaterfrontView,
    parkingCapacity:     rf.parkingCapacity ?? null,
    hasGarage:           rf.hasGarage ?? null,
    parkingFeatures:     rf.parkingFeatures?.length ? rf.parkingFeatures : null,
    patioAndPorch:       rf.patioAndPorchFeatures?.length ? rf.patioAndPorchFeatures : null,
    lotFeatures:         rf.lotFeatures?.length ? rf.lotFeatures : null,
    exteriorFeatures:    rf.exteriorFeatures?.length ? rf.exteriorFeatures : null,
    yearBuiltEffective:  rf.yearBuiltEffective ?? null,
    propertyCondition:   rf.propertyCondition ?? null,
    storiesTotal:        rf.storiesTotal ?? null,
    numberOfUnitsInCommunity: rf.numberOfUnitsInCommunity ?? null,
    buildingName:        rf.buildingName ?? null,
    associationFee:      rf.associationFee ?? p.monthlyHoaFee ?? null,
  };

  // Appraiser-style comparables come from nearbyHomes (Zillow's curated
  // list of same-building/same-street properties), not a separate search.
  const subject = {
    addr: client.addr, streetAddr: p.streetAddress,
    homeType: p.homeType, sqft: p.livingArea, beds: p.bedrooms, baths: p.bathrooms,
    lat: p.latitude, lng: p.longitude,
  };
  const comparables = pickComparables(p.nearbyHomes, subject);
  // Appraisal computed BELOW (in fetchAndPersist) so it can also include
  // the client's manual off-market comps from Max's expertise.
  const appraisal   = computeAppraisalEstimate(subject, comparables);

  // Premium factors not captured in the median-$/sqft math
  const descriptionFeatures = extractDescriptionFeatures(p.description);
  const boutiquePremium     = (p.homeType === 'CONDO' || p.homeType === 'APARTMENT')
    ? detectBoutiquePremium(p.streetAddress || client.addr, comparables)
    : null;

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
    zipcode:        p.zipcode || client.zip,
    lat:            p.latitude,
    lng:            p.longitude,
    appraiserFacts,
    comparables,
    appraisal,
    descriptionFeatures,
    boutiquePremium,
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

  // Merge backfilled fields back into the client object so the email/preview see them
  const mergedClient = { ...client, ...patch, purchaseDate: patch.purchase_date || client.purchaseDate };

  // If this client has manual off-market comps from Max's expertise, fold
  // them into the appraisal math alongside the Zillow nearbyHomes. They
  // typically include sales Zillow under-weights (off-market luxury, etc).
  if (mergedClient.manualComps?.length) {
    const subjectForAppraisal = {
      sqft: v.sqft, beds: v.beds, baths: v.baths,
    };
    // Sold-only rule: drop manual comps with status 'asking'. They're listed
    // but the money hasn't changed hands. Anything without an explicit status
    // gets inferred — soldDate present => sold, otherwise asking (filtered out).
    const soldManualComps = mergedClient.manualComps.filter(mc => {
      if (mc.status === 'asking') return false;
      if (mc.status === 'sold_mls' || mc.status === 'sold_off_mls') return true;
      // No explicit status: include only if we have a soldDate
      return !!mc.soldDate;
    });
    const combinedComps = [
      ...(v.comparables || []),
      ...soldManualComps.map(mc => {
        const statusMap = {
          sold_mls:     'SOLD',
          sold_off_mls: 'SOLD_OFF_MARKET',
        };
        const homeStatus = statusMap[mc.status]
          || (mc.soldDate ? 'SOLD_OFF_MARKET' : 'SOLD');
        return {
          address:    mc.address,
          price:      mc.price,
          sqft:       mc.sqft,
          beds:       mc.beds,
          baths:      mc.baths,
          dom:        mc.dom ?? null,
          soldDate:   mc.soldDate ?? null,
          homeStatus,
          homeType:   v.homeType,
          isAgentIntel: true,
        };
      }),
    ];
    const reAppraisal = computeAppraisalEstimate(subjectForAppraisal, combinedComps);
    if (reAppraisal) v.appraisal = reAppraisal;
  }

  // Headline number: midpoint of our Compass range. This is THE value we
  // present to the client; Zillow Zestimate becomes a small reference line.
  // Falls back to Zillow Zestimate if no comp-based appraisal was computed.
  const compassValue = v.appraisal
    ? Math.round((v.appraisal.rangeLow + v.appraisal.rangeHigh) / 2)
    : v.price;

  // Record THIS snapshot (the Compass headline) so the graph builds real
  // history of OUR number over time, not Zillow's.
  await db.recordHistory(client.id, compassValue);
  const history = await db.getHistory(client.id);

  // All gain / monthly / annualized math uses the Compass headline, not Zillow.
  const purchase     = mergedClient.purchase     || v.purchasePrice;
  const purchaseDate = mergedClient.purchaseDate || v.purchaseDate;
  let monthlyAppreciation = null, monthsHeld = null;
  if (purchase && purchaseDate) {
    const ms = Date.now() - new Date(purchaseDate).getTime();
    monthsHeld = Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24 * 30.4375)));
    monthlyAppreciation = Math.round((compassValue - purchase) / monthsHeld);
  }

  // Layer in market intel: mortgage rate context, SF-metro annualized return,
  // and zip-level transaction activity. All run in parallel and degrade
  // gracefully if any external source fails.
  const [rateContext, marketReturn, zipStats] = await Promise.all([
    market.getRateContext(purchaseDate, purchase, compassValue),
    market.getMarketReturn(purchaseDate),
    zipActivity.getZipActivity(APIFY_TOKEN, v.lat, v.lng, v.zipcode),
  ]);

  // Annualized return on THEIR home (so we can compare to the market)
  let homeAnnualized = null;
  if (purchase && monthsHeld) {
    const years = monthsHeld / 12;
    if (years > 0 && purchase > 0) {
      homeAnnualized = Math.pow(compassValue / purchase, 1 / years) - 1;
    }
  }

  const enriched = {
    ...v, history, monthlyAppreciation, monthsHeld,
    rateContext, marketReturn, homeAnnualized,
    zipStats, compassValue,
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
  // PRIMARY value shown to client = Compass headline (midpoint of our range).
  // Zillow Zestimate becomes a small reference footnote.
  const val = valData.compassValue || valData.price;
  const zestimate = valData.price; // Zillow Zestimate, for reference line
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

  function statusLabel(s) {
    if (s === 'FOR_SALE')        return 'On market';
    if (s === 'SOLD')            return 'Recently sold';
    if (s === 'SOLD_OFF_MARKET') return 'Sold off-market';
    if (s === 'PENDING')         return 'Pending';
    return 'Off market';
  }
  function statusColor(s) {
    if (s === 'FOR_SALE')        return '#1a4a7a';
    if (s === 'SOLD')            return '#666';
    if (s === 'SOLD_OFF_MARKET') return '#5a4a1f';
    if (s === 'PENDING')         return '#7a5018';
    return '#999';
  }
  // Prefer the appraisal's "top comps by price" so we show the impressive ones
  // first. Fall back to the raw nearbyHomes comparables if the appraisal block
  // didn't compute (e.g. subject sqft unknown).
  const displayComps = (valData.appraisal?.topCompsByPrice?.length
      ? valData.appraisal.topCompsByPrice
      : (valData.comparables || []))
    .slice(0, 5);
  const compsHtml = displayComps.map(c => `
    <tr style="border-bottom:1px solid #f4f1ec">
      <td style="padding:8px 0;font-size:13px">
        <div style="font-weight:600;color:#1a1a1a">${c.address}</div>
        <div style="font-size:11px;color:#888;margin-top:1px">
          ${c.beds ?? '?'}bd · ${c.baths ?? '?'}ba · ${c.sqft ? c.sqft.toLocaleString() + ' sf' : 'sqft —'}
          &nbsp;·&nbsp; <span style="color:${statusColor(c.homeStatus)};font-weight:600">${statusLabel(c.homeStatus)}</span>
        </div>
      </td>
      <td style="padding:8px 0;text-align:right;font-weight:700;font-size:13px;vertical-align:top">
        $${Math.round(c.price || 0).toLocaleString()}
        ${c.sqft ? `<div style="font-size:10px;color:#aaa;font-weight:400;margin-top:1px">$${Math.round(c.price/c.sqft).toLocaleString()}/sf</div>` : ''}
      </td>
    </tr>`).join('');

  // "Your story so far" — narrative timeline format. Replaces the dense table.
  const sqft    = client.sqft || valData.sqft;
  const gain    = gainSincePurchase;
  const gainPct = purchase ? ((val - purchase) / purchase) * 100 : null;
  const ppsf    = sqft ? Math.round(val / sqft) : null;
  const purchaseMonthYear = purchaseDate
    ? new Date(purchaseDate).toLocaleDateString('en-US',{month:'long',year:'numeric'})
    : null;
  // Format months held as years + months
  const yearsHeld = valData.monthsHeld ? Math.floor(valData.monthsHeld / 12) : null;
  const remainderMonths = valData.monthsHeld ? valData.monthsHeld % 12 : null;
  const durationStr = yearsHeld != null
    ? (yearsHeld > 0
        ? `${yearsHeld} year${yearsHeld === 1 ? '' : 's'}${remainderMonths ? ` and ${remainderMonths} month${remainderMonths === 1 ? '' : 's'}` : ''}`
        : `${remainderMonths} month${remainderMonths === 1 ? '' : 's'}`)
    : null;
  const purchaseHtml = (purchase && purchaseDate) ? `
    <div style="background:#fff;border:1px solid #e8e6e0;border-radius:8px;padding:18px 20px;margin-bottom:24px">
      <div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px">Your story so far</div>

      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:6px">
        <div>
          <div style="font-size:11px;color:#888;margin-bottom:2px">${purchaseMonthYear}</div>
          <div style="font-size:17px;font-weight:700;color:#1a1a1a">$${purchase.toLocaleString()}</div>
          <div style="font-size:11px;color:#888;margin-top:2px">Purchase price</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:#888;margin-bottom:2px">Today</div>
          <div style="font-size:17px;font-weight:700;color:#1a1a1a">$${val.toLocaleString()}</div>
          <div style="font-size:11px;color:#888;margin-top:2px">Compass estimate</div>
        </div>
      </div>

      <div style="height:6px;background:linear-gradient(90deg,#e8e6e0,${gain >= 0 ? '#2d7a3a' : '#c0392b'});border-radius:3px;margin:14px 0 8px"></div>
      <div style="text-align:center;font-size:11px;color:#888;margin-bottom:18px">
        ${durationStr ? `Over ${durationStr}` : 'Since purchase'}
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:13px">
        ${gain != null ? `
        <tr><td style="padding:4px 0;color:#666">Equity added to your home</td>
            <td style="padding:4px 0;text-align:right;font-weight:700;color:${gain >= 0 ? '#2d7a3a' : '#c0392b'};font-size:14px">
              ${gain >= 0 ? '+' : '−'}$${Math.abs(gain).toLocaleString()}${gainPct != null ? `<span style="font-weight:500;color:#888;font-size:12px"> &nbsp;(${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%)</span>` : ''}
            </td></tr>` : ''}
        ${valData.monthlyAppreciation != null ? `
        <tr><td style="padding:4px 0;color:#666">Average per month</td>
            <td style="padding:4px 0;text-align:right;font-weight:600;color:${valData.monthlyAppreciation >= 0 ? '#2d7a3a' : '#c0392b'}">
              ≈ ${valData.monthlyAppreciation >= 0 ? '+' : '−'}$${Math.abs(valData.monthlyAppreciation).toLocaleString()}/mo
            </td></tr>` : ''}
        ${valData.homeAnnualized != null ? `
        <tr><td style="padding:4px 0;color:#666">Annualized return</td>
            <td style="padding:4px 0;text-align:right;font-weight:600;color:${valData.homeAnnualized >= 0 ? '#2d7a3a' : '#c0392b'}">
              ${valData.homeAnnualized >= 0 ? '+' : '−'}${Math.abs(valData.homeAnnualized * 100).toFixed(1)}%/yr
            </td></tr>` : ''}
        ${ppsf ? `
        <tr><td style="padding:4px 0;color:#666">Current value per sqft</td>
            <td style="padding:4px 0;text-align:right;font-weight:600">$${ppsf.toLocaleString()}/sf</td></tr>` : ''}
      </table>
    </div>` : '';

  const html = `
  <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#1a1a1a">
    <div style="border-bottom:2px solid #1a1a1a;padding-bottom:12px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:flex-end">
      <span style="font-size:20px;font-weight:700;letter-spacing:-0.5px">Compass</span>
      <span style="font-size:12px;color:#888">${new Date().toLocaleDateString('en-US',{month:'long',year:'numeric'})}</span>
    </div>

    <p style="font-size:15px;margin:0 0 20px">Hi ${firstName},</p>
    <p style="font-size:15px;margin:0 0 24px;line-height:1.6">Here's your monthly home value update for <strong>${client.addr}, ${client.city}</strong>.</p>

    <div style="background:#f8f8f8;border-radius:8px;padding:28px 24px;text-align:center;margin-bottom:24px">
      <div style="font-size:13px;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em">Estimated value</div>
      <div style="font-size:44px;font-weight:800;letter-spacing:-1.5px;color:#1a1a1a;line-height:1">$${Math.round(val).toLocaleString()}</div>
      ${valData.appraisal && valData.appraisal.rangeLow && valData.appraisal.rangeHigh ? `
      <div style="font-size:13px;color:#666;margin-top:8px;font-weight:500">Market range: $${valData.appraisal.rangeLow.toLocaleString()} – $${valData.appraisal.rangeHigh.toLocaleString()}</div>` : ''}
      <div style="font-size:14px;color:${(change ?? 0) >= 0 ? '#2d7a3a' : '#c0392b'};margin-top:10px;font-weight:500">${changeLine}</div>
      ${zestimate && zestimate !== val ? `
      <div style="font-size:11px;color:#aaa;margin-top:14px;padding-top:12px;border-top:1px solid #eee">Zillow Zestimate for reference: $${zestimate.toLocaleString()}</div>` : ''}
    </div>

    ${purchaseHtml}

    ${valData.boutiquePremium ? `
    <div style="background:#fef3e0;border:1px solid #ead9b6;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#6a4f1a">
      <strong>Heads up:</strong> ${valData.boutiquePremium.note}
    </div>` : ''}

    ${valData.appraisal && valData.appraisal.compsUsed?.length >= 3 && valData.appraisal.mostSimilar ? `
    <div style="font-size:12px;color:#666;line-height:1.5;margin:0 0 20px;padding:10px 14px;background:#fafaf8;border-radius:6px">
      Anchored on <strong style="color:#1a1a1a">${valData.appraisal.mostSimilar.address}</strong>${valData.appraisal.mostSimilar.isAgentIntel ? ' (off-market intel)' : ''}, ${valData.appraisal.mostSimilar.sqft.toLocaleString()} sqft (${valData.appraisal.mostSimilar.sizeDeltaPct}% size delta) at <strong style="color:#1a1a1a">$${valData.appraisal.mostSimilar.price.toLocaleString()}</strong>. Range based on ${valData.appraisal.compsUsed.length} comparable sales weighted toward the upper market.
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
      <div style="font-size:10px;color:#8aa3b8;margin-top:8px;line-height:1.4">Source: FRED Case-Shiller San Francisco Home Price Index (SFXRSA), monthly through ${valData.marketReturn.indexDate}. Metro-wide index, may not capture luxury-segment heat.</div>
    </div>` : ''}

    ${(() => {
      // Similar luxury activity computed from the actual comp set so a $23M
      // client sees high-end sales, not the $1M condo sales sharing their zip.
      // Includes DOM-based market-heat signal.
      const luxComps = (valData.appraisal?.compsUsed || [])
        .filter(c => c.price && c.sqft)
        .filter(c => c.sqft >= valData.sqft * 0.5 && c.sqft <= valData.sqft * 1.7)
        .sort((a, b) => b.price - a.price);
      if (luxComps.length < 3) return '';
      const top = luxComps.slice(0, Math.min(8, luxComps.length));
      const prices = top.map(c => c.price).sort((a, b) => a - b);
      const med = prices[Math.floor(prices.length / 2)];
      const high = prices[prices.length - 1];
      const lo = prices[0];

      // DOM analytics — only counts comps that have a DOM value
      const withDom = top.filter(c => c.dom != null);
      let domLine = '';
      let heatLine = '';
      if (withDom.length >= 2) {
        const avgDom = Math.round(withDom.reduce((s, c) => s + c.dom, 0) / withDom.length);
        const under30 = withDom.filter(c => c.dom < 30).length;
        const under14 = withDom.filter(c => c.dom < 14).length;
        let heat, heatColor;
        if (avgDom < 14)       { heat = 'very competitive market — bidding war territory';     heatColor = '#c0392b'; }
        else if (avgDom < 30)  { heat = 'hot market with strong buyer demand';                  heatColor = '#c0392b'; }
        else if (avgDom < 60)  { heat = 'active market, balanced between buyers and sellers';   heatColor = '#7a5018'; }
        else                   { heat = 'softer market — homes taking longer to sell';          heatColor = '#3b5a1f'; }
        domLine = `
          <tr><td style="padding:3px 0;color:#666">Average days on market</td>
              <td style="padding:3px 0;text-align:right;font-weight:700">${avgDom} days</td></tr>
          <tr><td style="padding:3px 0;color:#666">Sold in under 30 days</td>
              <td style="padding:3px 0;text-align:right;font-weight:600">${under30} of ${withDom.length}${under14 ? ` (${under14} in under 2 weeks)` : ''}</td></tr>`;
        heatLine = `
          <div style="font-size:12px;color:${heatColor};margin-top:10px;padding-top:8px;border-top:1px solid #d1ddc3;line-height:1.5">
            <strong>Read:</strong> ${heat}.
          </div>`;
      }
      return `
      <div style="background:#f0f4ed;border:1px solid #d1ddc3;border-radius:8px;padding:14px 16px;margin-bottom:20px">
        <div style="font-size:11px;font-weight:700;color:#3b5a1f;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Similar luxury activity nearby</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td style="padding:3px 0;color:#666">Recent comparable sales</td>
              <td style="padding:3px 0;text-align:right;font-weight:700">${top.length}</td></tr>
          <tr><td style="padding:3px 0;color:#666">Sale price range</td>
              <td style="padding:3px 0;text-align:right;font-weight:600">$${(lo/1000000).toFixed(1)}M &ndash; $${(high/1000000).toFixed(1)}M</td></tr>
          <tr><td style="padding:3px 0;color:#666">Median sale price</td>
              <td style="padding:3px 0;text-align:right;font-weight:600">$${med.toLocaleString()}</td></tr>
          ${domLine}
        </table>
        ${heatLine}
      </div>`;
    })()}

    ${(() => {
      // Only show SOLD manual comps. Listed-but-not-sold comps don't count.
      const sold = (client.manualComps || []).filter(c =>
        c.status === 'sold_mls' || c.status === 'sold_off_mls' || (!c.status && c.soldDate)
      );
      if (!sold.length) return '';
      const hasOffMarket = sold.some(c => c.status === 'sold_off_mls');
      const label = hasOffMarket ? 'Sold comps I\'m tracking (incl. off-market)' : 'Sold comps I\'m tracking';
      return `
      <p style="font-size:13px;font-weight:600;margin:0 0 8px;text-transform:uppercase;letter-spacing:.05em;color:#5a4a1f">${label}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;border-top:1px solid #e1d9c4;background:#fdfaf0">
        ${sold.map(c => {
          const offMkt = c.status === 'sold_off_mls';
          const tag = offMkt ? '<span style="color:#5a4a1f;font-weight:700">Off-market</span>' : '<span style="color:#666">Sold</span>';
          const dateStr = c.soldDate ? new Date(c.soldDate).toLocaleDateString('en-US',{month:'short',year:'numeric'}) : null;
          return `
        <tr style="border-bottom:1px solid #f0e9d4">
          <td style="padding:8px 6px;font-size:13px">
            <div style="font-weight:600;color:#1a1a1a">${c.address}</div>
            <div style="font-size:11px;color:#888;margin-top:1px">
              ${c.beds != null ? c.beds + 'bd · ' : ''}${c.baths != null ? c.baths + 'ba · ' : ''}${c.sqft ? c.sqft.toLocaleString() + ' sf' : ''}
              &nbsp;·&nbsp; ${tag}${dateStr ? ' ' + dateStr : ''}
            </div>
            ${c.note ? `<div style="font-size:11px;color:#5a4a1f;margin-top:2px;font-style:italic">${c.note}</div>` : ''}
          </td>
          <td style="padding:8px 6px;text-align:right;font-weight:700;font-size:13px;vertical-align:top">
            $${Math.round(c.price).toLocaleString()}
            ${c.sqft ? `<div style="font-size:10px;color:#aaa;font-weight:400;margin-top:1px">$${Math.round(c.price/c.sqft).toLocaleString()}/sf</div>` : ''}
          </td>
        </tr>`;
        }).join('')}
      </table>`;
    })()}

    ${compsHtml ? `
    <p style="font-size:13px;font-weight:600;margin:0 0 8px;text-transform:uppercase;letter-spacing:.05em;color:#888">Top comparable sales in your area</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;border-top:1px solid #eee">
      ${compsHtml}
    </table>` : ''}

    ${gain != null && valData.monthlyAppreciation != null ? `
    <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#444">
      Since you bought ${client.addr}${purchaseDate ? ' in ' + new Date(purchaseDate).toLocaleDateString('en-US',{month:'long',year:'numeric'}) : ''}, it's ${gain >= 0 ? 'appreciated' : 'softened'} <strong style="color:${gain >= 0 ? '#2d7a3a' : '#c0392b'}">${gain >= 0 ? '+' : '−'}$${Math.abs(gain).toLocaleString()}</strong>, averaging about <strong>${valData.monthlyAppreciation >= 0 ? '+' : '−'}$${Math.abs(valData.monthlyAppreciation).toLocaleString()}/month</strong>.
    </p>` : ''}
    <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#444">
      Thinking about selling, refinancing, or just curious about the ${market} market right now? Reply anytime, I'm always happy to chat.
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

// Render the email as a standalone HTML page so the user can preview it in a
// real browser tab (not the cramped dashboard pane). Reuses the previewHtml
// from the most recent fetch.
app.get('/api/preview/:id', async (req, res) => {
  try {
    const client = await db.getClient(parseInt(req.params.id));
    if (!client) return res.status(404).send('Client not found');
    const v = await fetchAndPersist(client);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <title>Email preview — ${client.name}</title>
  <style>
    body { margin:0; padding:24px; background:#f5f4f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
    .frame { max-width:600px; margin:0 auto; background:#fff; border-radius:8px; padding:32px; box-shadow:0 2px 12px rgba(0,0,0,.06) }
    .meta { max-width:600px; margin:0 auto 14px; font-size:12px; color:#888 }
  </style>
</head><body>
  <div class="meta">
    <strong>To:</strong> ${client.email} &nbsp;·&nbsp;
    <strong>Subject:</strong> Your ${client.addr} home value, ${new Date().toLocaleDateString('en-US',{month:'long',year:'numeric'})}
  </div>
  <div class="frame">${v.previewHtml || '(no preview)'}</div>
</body></html>`);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
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

// Minimal CSV parser — handles standard CSV with quoted fields containing
// commas, but doesn't support multi-line quoted fields. SFAR/Rapattoni
// exports are well-formed so this is fine.
function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter(l => l.length);
  for (const line of lines) {
    const fields = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else cur += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { fields.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    fields.push(cur);
    rows.push(fields);
  }
  return rows;
}

// Heuristic column matcher — handles SFAR / Rapattoni / generic MLS naming.
// Each canonical key has an array of header-text patterns it accepts (lowercase).
const CSV_COLUMN_PATTERNS = {
  address:   ['address','street address','full address','street number name'],
  streetNum: ['street number','street #','st no'],
  streetName:['street name','street','street name direction'],
  city:      ['city'],
  state:     ['state','st'],
  zip:       ['zip','zipcode','zip code','postal'],
  price:     ['close price','closed price','sold price','sale price','list/close $','close $','last sale price','price'],
  beds:      ['beds','bedrooms','bd','br'],
  baths:     ['baths','bathrooms','ba','total bathrooms'],
  sqft:      ['sqft','sq ft','sq.ft.','living area','approx sqft','sqft (approx)','square feet'],
  soldDate:  ['close date','closed date','contractual date','sold date','sale date'],
  subtype:   ['subtype','subtype description','property subtype','type'],
  mlsOrigin: ['mls origin','source mls','listing source'],
  units:     ['# of units','num units','units in building','units'],
  subdistrict:['subdistrict','neighborhood','district'],
  listing:   ['listing #','listing number','mls #','mls number'],
};

function findColumn(headers, key) {
  const patterns = CSV_COLUMN_PATTERNS[key] || [];
  const lower = headers.map(h => (h || '').toLowerCase().trim());
  for (const p of patterns) {
    const i = lower.findIndex(h => h === p);
    if (i >= 0) return i;
  }
  // Fallback to partial match
  for (const p of patterns) {
    const i = lower.findIndex(h => h.includes(p));
    if (i >= 0) return i;
  }
  return -1;
}

function rowToComp(row, idx) {
  const get = key => {
    const i = idx[key];
    return i >= 0 ? (row[i] || '').trim() : '';
  };
  const toMoney = s => {
    const n = Number.parseFloat((s || '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const toInt = s => {
    const n = Number.parseInt((s || '').replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  const toFloat = s => {
    const n = Number.parseFloat((s || '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  // Build full address from whatever fields exist
  let address = get('address');
  if (!address) {
    const num = get('streetNum'), name = get('streetName'), city = get('city'), state = get('state'), zip = get('zip');
    address = [num + ' ' + name, city, state + ' ' + zip].map(s => s.trim()).filter(Boolean).join(', ');
  }
  if (!address) return null;

  const price = toMoney(get('price'));
  if (!price) return null;

  // Extract zip from address if needed
  let zip = get('zip');
  if (!zip) {
    const m = address.match(/\b(\d{5})\b/);
    if (m) zip = m[1];
  }

  return {
    address,
    price,
    beds:     toInt(get('beds')),
    baths:    toFloat(get('baths')),
    sqft:     toInt(get('sqft')),
    soldDate: get('soldDate') || null,
    note:     get('mlsOrigin') ? `MLS Origin: ${get('mlsOrigin')}${get('subdistrict') ? ' · ' + get('subdistrict') : ''}` : null,
    zip,
    subtype:  get('subtype'),
  };
}

// Bulk CSV import: takes the raw CSV body, parses it, and distributes rows
// to clients by zip + sqft proximity. Returns a per-client summary.
app.post('/api/import-csv', async (req, res) => {
  try {
    const csv = req.body.csv || '';
    if (!csv || typeof csv !== 'string' || csv.length < 50) {
      return res.status(400).json({ error: 'No CSV body provided' });
    }
    const rows = parseCsv(csv);
    if (rows.length < 2) return res.status(400).json({ error: 'CSV has no data rows' });

    const headers = rows[0];
    const idx = {};
    for (const k of Object.keys(CSV_COLUMN_PATTERNS)) idx[k] = findColumn(headers, k);
    if (idx.price === -1) return res.status(400).json({ error: 'Could not find a price/sold-price column. Header row received: ' + headers.join(', ') });

    const comps = rows.slice(1).map(r => rowToComp(r, idx)).filter(Boolean);
    const clients = await db.listClients();

    // Match comps to clients: same zip, similar property type (SFR-vs-condo),
    // sqft within 50%-200% of subject
    const replace = req.body.replace === true; // if true, wipe existing manual_comps first
    const perClient = {};

    for (const c of clients) {
      const subjectIsCondo = /condo/i.test('') || c.beds === null; // weak signal w/o homeType in DB
      const candidates = comps
        .filter(comp => comp.zip && comp.zip === c.zip)
        .filter(comp => !c.sqft || !comp.sqft || (comp.sqft >= c.sqft * 0.5 && comp.sqft <= c.sqft * 2.0))
        .sort((a, b) => {
          if (!c.sqft) return 0;
          const da = Math.abs((a.sqft || c.sqft) - c.sqft);
          const db = Math.abs((b.sqft || c.sqft) - c.sqft);
          return da - db;
        })
        .slice(0, 10) // cap per client
        .map(({ zip, subtype, ...keep }) => keep); // strip routing fields

      const existing = replace ? [] : (c.manualComps || []);
      // Dedupe by address (case-insensitive)
      const seen = new Set(existing.map(e => (e.address || '').toLowerCase()));
      const additions = candidates.filter(comp => !seen.has(comp.address.toLowerCase()));
      const merged = [...existing, ...additions].slice(-10);

      if (additions.length || replace) {
        await db.setManualComps(c.id, merged);
      }
      perClient[c.id] = {
        name: c.name,
        zip: c.zip,
        matchedThisZip: comps.filter(comp => comp.zip === c.zip).length,
        added: additions.length,
        totalNow: merged.length,
      };
    }

    res.json({
      ok: true,
      totalRows: comps.length,
      headersDetected: idx,
      perClient,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Parse pasted text from Rapattoni MLS / SFAR.
// Each listing is a block of ~17 fields on consecutive lines (one field per
// line), often prefixed by icon labels like "location_city" or "store" and
// followed by icon labels like "history attach_money map ...".
// We detect each block by the leading listing-number line.
function parseRapattoniText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const isIconLine = s => /^(history|attach_money|attach_file|map|photo_library|theaters|location_city|store|edit|settings|help)$/.test(s);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^\d{7,9}$/.test(lines[i])) continue;
    const listing = lines[i];
    let j = i + 1;
    // Skip optional icon-label prefix lines
    while (j < lines.length && isIconLine(lines[j])) j++;
    // Now grab the next 17 non-empty fields, skipping any icon lines mixed in
    const fields = [];
    while (fields.length < 17 && j < lines.length) {
      const l = lines[j++];
      if (l && !isIconLine(l)) fields.push(l);
    }
    if (fields.length < 16) continue;
    const [address, bd, ba, sqftRaw, priceRaw, type, subtype, status, dateStr, dom, city, area, subdistrict, unitsRaw, origin, parking] = fields;
    const price = parseInt(priceRaw.replace(/[^0-9]/g, ''), 10);
    if (!price || !address) continue;
    const sqft = sqftRaw ? parseInt(sqftRaw.replace(/[,]/g, ''), 10) || null : null;
    const beds = parseInt(bd, 10) || null;
    const baMatch = ba.match(/^(\d+(?:\.\d+)?)/);
    const baths = baMatch ? parseFloat(baMatch[1]) : null;
    let soldDate = null;
    const dm = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2})/);
    if (dm) soldDate = `20${dm[3]}-${dm[1].padStart(2,'0')}-${dm[2].padStart(2,'0')}`;
    out.push({
      listing, address, beds, baths, sqft, price, type, subtype, status,
      soldDate, dom: parseInt(dom,10)||null, city, area, subdistrict,
      units: parseInt(unitsRaw, 10) || null,
      mlsOrigin: origin,
    });
  }
  return out;
}

app.post('/api/import-paste', async (req, res) => {
  try {
    const text = req.body.text || '';
    if (!text || text.length < 100) return res.status(400).json({ error: 'No text content provided' });

    const parsed = parseRapattoniText(text);
    if (!parsed.length) return res.status(400).json({ error: 'No valid listings detected. Expected Rapattoni / SFAR paste format.' });

    const replace = req.body.replace === true;
    const clients = await db.listClients();
    const perClient = {};

    for (const c of clients) {
      // Decide subject property class from the client's known sqft / structure
      const subjectSqft = c.sqft || 0;
      const wantHouse = subjectSqft > 2500; // heuristic
      const wantTypes = wantHouse ? ['HSL1'] : ['CNDO','TCLA','COOP'];

      const matches = parsed
        .filter(comp => wantTypes.includes(comp.type))
        .filter(comp => comp.sqft && (!subjectSqft ||
          (comp.sqft >= subjectSqft * 0.5 && comp.sqft <= subjectSqft * 2.0)))
        .sort((a,b) => {
          if (!subjectSqft) return 0;
          return Math.abs(a.sqft - subjectSqft) - Math.abs(b.sqft - subjectSqft);
        })
        .slice(0, 10);

      // Build the manual-comp shape
      const newComps = matches.map(comp => {
        const ppsf = comp.sqft ? Math.round(comp.price / comp.sqft) : null;
        const labelStatus = comp.status === 'Sold Off MLS' ? 'SOLD OFF MLS via SFAR' : 'SFAR Closed';
        const noteBits = [labelStatus, comp.subdistrict];
        if (comp.units) noteBits.push(`${comp.units} units`);
        if (ppsf) noteBits.push(`$${ppsf.toLocaleString()}/sqft`);
        return {
          address: `${comp.address}, ${comp.city}, CA`,
          price: comp.price,
          beds: comp.beds,
          baths: comp.baths,
          sqft: comp.sqft,
          dom: comp.dom,
          soldDate: comp.soldDate,
          note: noteBits.filter(Boolean).join('. '),
        };
      });

      const existing = replace ? [] : (c.manualComps || []);
      const seen = new Set(existing.map(e => (e.address||'').toLowerCase()));
      const additions = newComps.filter(comp => !seen.has(comp.address.toLowerCase()));
      const combined = [...existing, ...additions].slice(0, 10);

      if (additions.length || replace) await db.setManualComps(c.id, combined);
      perClient[c.id] = {
        name: c.name,
        candidates: matches.length,
        added: additions.length,
        totalNow: combined.length,
      };
    }

    res.json({
      ok: true,
      totalParsed: parsed.length,
      byDistrict: parsed.reduce((acc, c) => { acc[c.area] = (acc[c.area]||0)+1; return acc; }, {}),
      byType: parsed.reduce((acc, c) => { acc[c.type] = (acc[c.type]||0)+1; return acc; }, {}),
      perClient,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Quick-add a manual comp by address or Zillow URL. We call the
// zillow-detail-scraper to look it up, then auto-append as a manual comp.
// Solves: Max sees a $50M sale on Zillow → one paste → it lands in the client's
// comp list without retyping beds/baths/sqft.
app.post('/api/clients/:id/comp-lookup', async (req, res) => {
  try {
    if (!APIFY_TOKEN) return res.status(400).json({ error: 'Apify not configured' });
    const id = parseInt(req.params.id);
    const client = await db.getClient(id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const input = (req.body.address || '').trim();
    if (!input) return res.status(400).json({ error: 'Address or URL required' });

    // Accept either a plain address or a Zillow URL
    let lookupAddress = input;
    const urlMatch = input.match(/zillow\.com\/homedetails\/([^/]+)\//);
    if (urlMatch) {
      // Slug "2898-Vallejo-St-San-Francisco-CA-94123" → readable address
      lookupAddress = urlMatch[1].replace(/-/g, ' ').trim();
    }

    const lookup = await axios.post(
      `https://api.apify.com/v2/acts/maxcopell~zillow-detail-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=300`,
      { addresses: [lookupAddress], propertyStatus: 'RECENTLY_SOLD' },
      { headers: { 'Content-Type': 'application/json' }, timeout: 320000 }
    );
    const items = Array.isArray(lookup.data) ? lookup.data : [];
    if (!items.length) return res.status(404).json({ error: 'Property not found on Zillow' });
    const p = items[0];

    // Pick the best price: most recent Sold > Zestimate > lastSoldPrice > price
    const lastSold = (p.priceHistory || []).filter(h => h.event === 'Sold')
      .sort((a,b) => (b.time||0) - (a.time||0))[0];
    const usingSale = !!lastSold;
    const price = lastSold?.price || p.zestimate || p.lastSoldPrice || p.price;
    if (!price) return res.status(400).json({ error: 'Zillow has no price for this property' });

    const fullAddr = `${p.streetAddress}, ${p.city}, ${p.state} ${p.zipcode}`;
    const soldDate = lastSold?.date || (p.dateSold ? new Date(p.dateSold).toISOString().slice(0,10) : null);

    let note;
    if (usingSale) {
      note = `Sold ${lastSold.date} ($${Math.round(price/Math.max(p.livingArea||1,1)).toLocaleString()}/sqft). Via Zillow lookup.`;
    } else if (p.zestimate) {
      note = `Zillow Zestimate $${p.zestimate.toLocaleString()}. Not yet recorded as sold. Via Zillow lookup.`;
    } else {
      note = `Via Zillow lookup.`;
    }

    const newComp = {
      address:  fullAddr,
      price:    Math.round(price),
      beds:     p.bedrooms ?? null,
      baths:    p.bathrooms ?? null,
      sqft:     p.livingArea ?? null,
      soldDate,
      note,
    };

    const existing = client.manualComps || [];
    // Avoid duplicates by address (case-insensitive)
    const dedup = existing.filter(c => (c.address || '').toLowerCase() !== fullAddr.toLowerCase());
    const combined = [...dedup, newComp].slice(-10); // cap 10 per client
    await db.setManualComps(id, combined);
    res.json({ ok: true, added: newComp, comps: combined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual off-market comps — Max's expert intel that no scraper can find.
// Body: { comps: [{ address, price, beds?, baths?, sqft?, soldDate?, note? }, ...] }
app.put('/api/clients/:id/manual-comps', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const incoming = Array.isArray(req.body.comps) ? req.body.comps : [];
    // Light validation: each must have at minimum an address and a price
    const allowedStatuses = ['asking', 'sold_mls', 'sold_off_mls'];
    const cleaned = incoming
      .filter(c => c && c.address && c.price)
      .map(c => ({
        address:  String(c.address).trim(),
        price:    Number(c.price),
        beds:     c.beds  != null ? Number(c.beds)  : null,
        baths:    c.baths != null ? Number(c.baths) : null,
        sqft:     c.sqft  != null ? Number(c.sqft)  : null,
        dom:      c.dom   != null ? Number(c.dom)   : null,
        soldDate: c.soldDate || null,
        // Status defaults: explicit value > soldDate-implies-sold > asking
        status:   allowedStatuses.includes(c.status) ? c.status : (c.soldDate ? 'sold_mls' : 'asking'),
        note:     c.note ? String(c.note).trim().slice(0, 200) : null,
      }))
      .slice(0, 10); // cap at 10 per client
    await db.setManualComps(id, cleaned);
    res.json({ ok: true, comps: cleaned });
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
