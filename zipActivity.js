// Zip-level transaction volume via Zillow recently_sold search.
// Pulls last 12 months of sold listings around a property's lat/lng,
// then filters client-side to the exact zip and computes:
//   - count in the last 30 days (current month proxy)
//   - count in the same month a year ago (YoY)
//   - dollar volume + median price for current month
//
// Cached per zip for 7 days via app_state so multiple clients in the same
// zip don't trigger duplicate Apify calls.

const axios = require('axios');
const db = require('./db');

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function buildSoldUrl(lat, lng, deltaDeg = 0.08) {
  const sqs = {
    isMapVisible: true,
    isListVisible: true,
    mapBounds: {
      north: lat + deltaDeg, south: lat - deltaDeg,
      east:  lng + deltaDeg, west:  lng - deltaDeg,
    },
    filterState: {
      sort: { value: 'globalrelevanceex' },
      isRecentlySold:      { value: true },
      isForSaleByAgent:    { value: false },
      isForSaleByOwner:    { value: false },
      isNewConstruction:   { value: false },
      isComingSoon:        { value: false },
      isAuction:           { value: false },
      isForSaleForeclosure:{ value: false },
      doz: { value: '12m' }, // last 12 months
    },
  };
  return `https://www.zillow.com/homes/recently_sold/?searchQueryState=${encodeURIComponent(JSON.stringify(sqs))}`;
}

async function fetchSoldYear(apifyToken, lat, lng) {
  const url = buildSoldUrl(lat, lng);
  const res = await axios.post(
    `https://api.apify.com/v2/acts/maxcopell~zillow-scraper/run-sync-get-dataset-items?token=${apifyToken}&timeout=180`,
    { searchUrls: [{ url }], extractionMethod: 'MAP_MARKERS' },
    { headers: { 'Content-Type': 'application/json' }, timeout: 200000 }
  );
  const raw = Array.isArray(res.data) ? res.data : [];
  return raw.map(p => {
    const hi = p.hdpData?.homeInfo || {};
    return {
      addr:     p.address || hi.streetAddress,
      zip:      hi.zipcode || null,
      price:    hi.price ?? null,
      dateSold: hi.dateSold ?? null, // epoch ms
      beds:     hi.bedrooms ?? null,
      baths:    hi.bathrooms ?? null,
      sqft:     hi.livingArea ?? null,
      homeType: hi.homeType ?? null,
    };
  }).filter(x => x.addr && x.dateSold);
}

async function getZipActivity(apifyToken, lat, lng, zipcode) {
  if (!apifyToken || lat == null || lng == null || !zipcode) return null;

  // Cache by zip — other clients in the same zip will reuse this.
  const cacheKey = `zip_activity_${zipcode}`;
  const cached = await db.getState(cacheKey);
  let sold;
  if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    sold = cached.sold;
  } else {
    try {
      sold = await fetchSoldYear(apifyToken, lat, lng);
      await db.setState(cacheKey, { fetchedAt: Date.now(), sold });
    } catch (e) {
      console.error('[zipActivity] fetch failed:', e.message);
      return null;
    }
  }
  if (!Array.isArray(sold)) return null;

  // Filter to exact zip
  const inZip = sold.filter(s => s.zip === zipcode);
  if (!inZip.length) return { zipcode, currentMonth: 0, yearAgoMonth: 0, medianPrice: null };

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  // Current 30-day window
  const cur = inZip.filter(s => (now - s.dateSold) <= 30 * DAY);
  // 30-day window centered on 365 days ago (so a ~60-day band)
  const yearAgo = inZip.filter(s => {
    const days = (now - s.dateSold) / DAY;
    return days >= 335 && days <= 395;
  });

  const median = arr => {
    if (!arr.length) return null;
    const sorted = arr.slice().sort((a,b) => a-b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid-1] + sorted[mid]) / 2);
  };

  return {
    zipcode,
    currentMonth: cur.length,
    yearAgoMonth: yearAgo.length,
    medianPrice:  median(cur.map(s => s.price).filter(Boolean)),
    medianPriceYoY: median(yearAgo.map(s => s.price).filter(Boolean)),
    recentSales:  cur.sort((a,b) => b.dateSold - a.dateSold).slice(0, 5),
  };
}

module.exports = { getZipActivity };
