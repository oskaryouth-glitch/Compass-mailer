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
// (a) same home type, (b) sqft within 50%-150% of subject, (c) prefer same
// street/building, then closest by geo distance.
function pickComparables(nearbyHomes, subject) {
  if (!Array.isArray(nearbyHomes) || !nearbyHomes.length) return [];

  const comps = nearbyHomes.map(normalizeNearbyHome).filter(c => c.address && c.price && c.sqft > 0);
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

// Appraiser-style sales-comparison valuation (USPAP-flavored), but also
// honest about hot-market reality. We compute three views:
//   1. "Paper" estimate — median adjusted $/sqft (USPAP standard, conservative)
//   2. "Most similar comp" estimate — the single closest-by-sqft comp's $/sqft
//      applied to the subject. Shows what the most directly relevant trade implies.
//   3. Comp range — low and high adjusted values across all comps.
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

  // Median adjusted $/sqft (conservative paper number)
  const sortedByPpsf = [...adjusted].sort((a, b) => a.adjustedPpsf - b.adjustedPpsf);
  const mid = Math.floor(sortedByPpsf.length / 2);
  const medianPpsf = sortedByPpsf.length % 2 === 1
    ? sortedByPpsf[mid].adjustedPpsf
    : (sortedByPpsf[mid-1].adjustedPpsf + sortedByPpsf[mid].adjustedPpsf) / 2;

  // Most-similar comp by sqft distance (the single most-defensible single reference)
  const mostSimilar = [...adjusted].sort((a, b) => a.sizeDelta - b.sizeDelta)[0];

  const paperEstimate     = Math.round(medianPpsf * subject.sqft);
  const marketEstimate    = Math.round(mostSimilar.adjustedPpsf * subject.sqft);
  const low               = Math.round(sortedByPpsf[0].adjustedPpsf * subject.sqft);
  const high              = Math.round(sortedByPpsf[sortedByPpsf.length-1].adjustedPpsf * subject.sqft);

  return {
    estimate:     paperEstimate, // back-compat: existing field name
    paperEstimate,
    marketEstimate,
    low,
    high,
    medianPpsf:   Math.round(medianPpsf),
    mostSimilar:  {
      address: mostSimilar.address,
      price:   Math.round(mostSimilar.price),
      sqft:    mostSimilar.sqft,
      ppsf:    Math.round(mostSimilar.ppsf),
      sizeDeltaPct: Math.round(mostSimilar.sizeDelta * 100),
      status:  mostSimilar.homeStatus,
      isAgentIntel: mostSimilar.homeStatus === 'AGENT_INTEL',
    },
    compsUsed:  adjusted,
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

  // Record this snapshot so the graph builds real history over time
  await db.recordHistory(client.id, v.price);
  const history = await db.getHistory(client.id);

  // Merge backfilled fields back into the client object so the email/preview see them
  const mergedClient = { ...client, ...patch, purchaseDate: patch.purchase_date || client.purchaseDate };

  // If this client has manual off-market comps from Max's expertise, fold
  // them into the appraisal math alongside the Zillow nearbyHomes. They
  // typically include sales Zillow under-weights (off-market luxury, etc).
  if (mergedClient.manualComps?.length) {
    const subjectForAppraisal = {
      sqft: v.sqft, beds: v.beds, baths: v.baths,
    };
    const combinedComps = [
      ...(v.comparables || []),
      ...mergedClient.manualComps.map(mc => ({
        address:    mc.address,
        price:      mc.price,
        sqft:       mc.sqft,
        beds:       mc.beds,
        baths:      mc.baths,
        homeStatus: 'AGENT_INTEL',
        homeType:   v.homeType, // assume same as subject — Max wouldn't add unrelated comps
      })),
    ];
    const reAppraisal = computeAppraisalEstimate(subjectForAppraisal, combinedComps);
    if (reAppraisal) v.appraisal = reAppraisal;
  }

  // Add derived "average appreciation per month since purchase"
  const purchase     = mergedClient.purchase     || v.purchasePrice;
  const purchaseDate = mergedClient.purchaseDate || v.purchaseDate;
  let monthlyAppreciation = null, monthsHeld = null;
  if (purchase && purchaseDate) {
    const ms = Date.now() - new Date(purchaseDate).getTime();
    monthsHeld = Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24 * 30.4375)));
    monthlyAppreciation = Math.round((v.price - purchase) / monthsHeld);
  }

  // Layer in market intel: mortgage rate context, SF-metro annualized return,
  // and zip-level transaction activity. All run in parallel and degrade
  // gracefully if any external source fails.
  const [rateContext, marketReturn, zipStats] = await Promise.all([
    market.getRateContext(purchaseDate, purchase, v.price),
    market.getMarketReturn(purchaseDate),
    zipActivity.getZipActivity(APIFY_TOKEN, v.lat, v.lng, v.zipcode),
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
    zipStats,
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

  function statusLabel(s) {
    if (s === 'FOR_SALE')      return 'For sale';
    if (s === 'SOLD')          return 'Recently sold';
    if (s === 'PENDING')       return 'Pending';
    return 'Off market'; // OTHER or unknown
  }
  function statusColor(s) {
    if (s === 'FOR_SALE')      return '#1a4a7a';
    if (s === 'SOLD')          return '#5a4a1f';
    if (s === 'PENDING')       return '#7a5018';
    return '#999';
  }
  const compsHtml = (valData.comparables || []).slice(0, 4).map(c => `
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

    ${valData.boutiquePremium ? `
    <div style="background:#fef3e0;border:1px solid #ead9b6;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#6a4f1a">
      <strong>Heads up:</strong> ${valData.boutiquePremium.note}
    </div>` : ''}

    ${valData.appraisal && valData.appraisal.compsUsed?.length >= 3 ? `
    <div style="background:#f3f0e8;border:1px solid #e1d9c4;border-radius:8px;padding:14px 16px;margin-bottom:20px">
      <div style="font-size:11px;font-weight:700;color:#5a4a1f;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Compass valuation analysis</div>
      <div style="font-size:12px;color:#666;margin-bottom:10px;line-height:1.5">Two ways of reading the comps from ${valData.appraisal.compsUsed.length} ${valData.homeType === 'CONDO' ? 'same-building/same-street condo' : 'same-street'} sales:</div>

      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px">
        <tr><td style="padding:5px 0;color:#666"><strong>Paper value</strong> (USPAP median $/sqft)</td>
            <td style="padding:5px 0;text-align:right;font-weight:700">$${valData.appraisal.paperEstimate.toLocaleString()}</td></tr>
        <tr><td style="padding:5px 0;color:#666"><strong>Market signal</strong> (most-similar comp implied)</td>
            <td style="padding:5px 0;text-align:right;font-weight:700;color:${valData.appraisal.marketEstimate > valData.appraisal.paperEstimate ? '#2d7a3a' : '#1a1a1a'}">$${valData.appraisal.marketEstimate.toLocaleString()}</td></tr>
      </table>

      ${valData.appraisal.mostSimilar ? `
      <div style="font-size:12px;color:#666;background:#fff;border-radius:5px;padding:8px 10px;line-height:1.5;margin-bottom:10px">
        Most-similar comp: <strong style="color:#1a1a1a">${valData.appraisal.mostSimilar.address}</strong>${valData.appraisal.mostSimilar.isAgentIntel ? ' (agent intel)' : ''}, ${valData.appraisal.mostSimilar.sqft.toLocaleString()} sqft (only ${valData.appraisal.mostSimilar.sizeDeltaPct}% size delta) at <strong style="color:#1a1a1a">$${valData.appraisal.mostSimilar.price.toLocaleString()}</strong> ($${valData.appraisal.mostSimilar.ppsf.toLocaleString()}/sqft).
      </div>` : ''}

      <table style="width:100%;border-collapse:collapse;font-size:12px;border-top:1px solid #e1d9c4;padding-top:8px">
        <tr><td style="padding:6px 0 0;color:#888">Full comp range (adjusted)</td>
            <td style="padding:6px 0 0;text-align:right;font-weight:500;color:#888">$${valData.appraisal.low.toLocaleString()} &ndash; $${valData.appraisal.high.toLocaleString()}</td></tr>
        <tr><td style="padding:3px 0;color:#888">Zillow Zestimate</td>
            <td style="padding:3px 0;text-align:right;font-weight:500;color:#888">$${val.toLocaleString()}</td></tr>
      </table>
    </div>` : ''}

    ${(() => {
      const af = valData.appraiserFacts || {};
      const facts = [];
      if (af.view?.length)            facts.push(`<strong>View:</strong> ${af.view.join(', ')}`);
      if (af.parkingCapacity > 0)     facts.push(`<strong>Parking:</strong> ${af.parkingCapacity} ${af.hasGarage ? 'garage' : 'spaces'}`);
      if (af.patioAndPorch?.length)   facts.push(`<strong>Outdoor:</strong> ${af.patioAndPorch.join(', ')}`);
      if (af.numberOfUnitsInCommunity)facts.push(`<strong>Building:</strong> ${af.numberOfUnitsInCommunity} units total`);
      if (af.yearBuiltEffective && af.yearBuiltEffective !== valData.yearBuilt) facts.push(`<strong>Effective year built:</strong> ${af.yearBuiltEffective} (last major renovation)`);
      if (af.propertyCondition)       facts.push(`<strong>Condition:</strong> ${af.propertyCondition}`);
      // Pull mined description features (e.g., "Golden Gate Bridge view, Gardens, High-end finishes")
      const descFacts = valData.descriptionFeatures || [];
      if (descFacts.length)           facts.push(`<strong>Highlights from listing:</strong> ${descFacts.join(', ')}`);
      return facts.length ? `
      <p style="font-size:12px;color:#666;line-height:1.6;margin:0 0 20px;padding:10px 14px;background:#fafaf8;border-radius:6px">
        <span style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px">About your home</span>
        ${facts.join(' &nbsp;·&nbsp; ')}
      </p>` : '';
    })()}

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

    ${valData.zipStats && (valData.zipStats.currentMonth > 0 || valData.zipStats.yearAgoMonth > 0) ? `
    <div style="background:#f0f4ed;border:1px solid #d1ddc3;border-radius:8px;padding:14px 16px;margin-bottom:20px">
      <div style="font-size:11px;font-weight:700;color:#3b5a1f;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">${valData.zipStats.zipcode} sales activity</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><td style="padding:3px 0;color:#666">Homes sold in last 30 days</td>
            <td style="padding:3px 0;text-align:right;font-weight:700">${valData.zipStats.currentMonth}</td></tr>
        ${valData.zipStats.yearAgoMonth > 0 ? `
        <tr><td style="padding:3px 0;color:#666">Same month last year</td>
            <td style="padding:3px 0;text-align:right;font-weight:600">${valData.zipStats.yearAgoMonth}</td></tr>
        ${(() => {
          const delta = valData.zipStats.currentMonth - valData.zipStats.yearAgoMonth;
          const pct = valData.zipStats.yearAgoMonth ? ((delta / valData.zipStats.yearAgoMonth) * 100) : 0;
          const color = delta >= 0 ? '#2d7a3a' : '#c0392b';
          return `<tr><td style="padding:6px 0 0;color:#1a1a1a;font-weight:600;border-top:1px solid #d1ddc3">Year over year</td>
                  <td style="padding:6px 0 0;text-align:right;font-weight:700;color:${color};border-top:1px solid #d1ddc3">${delta >= 0 ? '+' : ''}${delta} sales (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)</td></tr>`;
        })()}
        ` : ''}
        ${valData.zipStats.medianPrice ? `
        <tr><td style="padding:3px 0;color:#666;font-size:12px">Median sale price this month</td>
            <td style="padding:3px 0;text-align:right;font-weight:500;font-size:12px">$${valData.zipStats.medianPrice.toLocaleString()}</td></tr>` : ''}
      </table>
    </div>` : ''}

    ${(client.manualComps && client.manualComps.length) ? `
    <p style="font-size:13px;font-weight:600;margin:0 0 8px;text-transform:uppercase;letter-spacing:.05em;color:#5a4a1f">Off-market sales I've seen</p>
    <div style="font-size:11px;color:#888;margin-bottom:8px;font-style:italic">From my private intel, not on Zillow or the public MLS:</div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;border-top:1px solid #e1d9c4;background:#fdfaf0">
      ${client.manualComps.map(c => `
      <tr style="border-bottom:1px solid #f0e9d4">
        <td style="padding:8px 6px;font-size:13px">
          <div style="font-weight:600;color:#1a1a1a">${c.address}</div>
          <div style="font-size:11px;color:#888;margin-top:1px">
            ${c.beds != null ? c.beds + 'bd · ' : ''}${c.baths != null ? c.baths + 'ba · ' : ''}${c.sqft ? c.sqft.toLocaleString() + ' sf' : ''}
            ${c.soldDate ? ' &nbsp;·&nbsp; sold ' + new Date(c.soldDate).toLocaleDateString('en-US',{month:'short',year:'numeric'}) : ''}
          </div>
          ${c.note ? `<div style="font-size:11px;color:#5a4a1f;margin-top:2px;font-style:italic">${c.note}</div>` : ''}
        </td>
        <td style="padding:8px 6px;text-align:right;font-weight:700;font-size:13px;vertical-align:top">
          $${Math.round(c.price).toLocaleString()}
          ${c.sqft ? `<div style="font-size:10px;color:#aaa;font-weight:400;margin-top:1px">$${Math.round(c.price/c.sqft).toLocaleString()}/sf</div>` : ''}
        </td>
      </tr>`).join('')}
    </table>` : ''}

    ${compsHtml ? `
    <p style="font-size:13px;font-weight:600;margin:0 0 8px;text-transform:uppercase;letter-spacing:.05em;color:#888">Comparable properties on your street</p>
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
    const cleaned = incoming
      .filter(c => c && c.address && c.price)
      .map(c => ({
        address:  String(c.address).trim(),
        price:    Number(c.price),
        beds:     c.beds  != null ? Number(c.beds)  : null,
        baths:    c.baths != null ? Number(c.baths) : null,
        sqft:     c.sqft  != null ? Number(c.sqft)  : null,
        soldDate: c.soldDate || null,
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
