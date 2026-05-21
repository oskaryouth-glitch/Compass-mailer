// Fetches free, no-auth market data from FRED:
//   MORTGAGE30US — 30yr fixed mortgage rate (weekly)
//   SFXRSA       — Case-Shiller San Francisco Home Price Index (monthly)
//
// We cache the full series in the app_state Postgres table for 24h so we
// don't refetch on every estimate. The series are small (~5k rows each).

const axios = require('axios');
const db = require('./db');

const SERIES = {
  MORTGAGE30US: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US',
  SFXRSA:       'https://fred.stlouisfed.org/graph/fredgraph.csv?id=SFXRSA',
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function parseCsv(csv) {
  const lines = csv.trim().split('\n');
  lines.shift(); // header
  return lines.map(line => {
    const [date, value] = line.split(',');
    const n = parseFloat(value);
    if (!date || Number.isNaN(n)) return null;
    return { date, t: new Date(date).getTime(), value: n };
  }).filter(Boolean);
}

async function loadSeries(id) {
  const cacheKey = `fred_${id}`;
  const cached = await db.getState(cacheKey);
  if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.points;
  }
  const res = await axios.get(SERIES[id], { timeout: 30000, responseType: 'text' });
  const points = parseCsv(res.data);
  await db.setState(cacheKey, { fetchedAt: Date.now(), points });
  return points;
}

// Find the data point closest to the target date (no extrapolation)
function nearestOnOrBefore(points, targetDate) {
  if (!points?.length || !targetDate) return null;
  const t = new Date(targetDate).getTime();
  let best = null;
  for (const p of points) {
    if (p.t <= t && (!best || p.t > best.t)) best = p;
  }
  return best || points[0]; // fall back to earliest if target predates the series
}

function latest(points) {
  return points?.length ? points[points.length - 1] : null;
}

// Monthly P&I for a 30yr fixed loan
function monthlyPI(loanAmount, annualRatePct) {
  if (!loanAmount || !annualRatePct) return null;
  const r = (annualRatePct / 100) / 12;
  const n = 360;
  if (r === 0) return loanAmount / n;
  return Math.round(loanAmount * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1));
}

async function getRateContext(purchaseDate, purchasePrice, currentValue) {
  if (!purchaseDate || !purchasePrice || !currentValue) return null;
  try {
    const mortgage = await loadSeries('MORTGAGE30US');
    const rateAtPurchase = nearestOnOrBefore(mortgage, purchaseDate);
    const rateToday      = latest(mortgage);
    if (!rateAtPurchase || !rateToday) return null;

    // Assume 80% LTV for the comparison (industry standard)
    const ltv = 0.80;
    const lockedLoan  = purchasePrice * ltv;
    const buyerLoan   = currentValue  * ltv;
    const lockedMonthly = monthlyPI(lockedLoan, rateAtPurchase.value);
    const buyerMonthly  = monthlyPI(buyerLoan, rateToday.value);
    const advantage     = (buyerMonthly && lockedMonthly) ? buyerMonthly - lockedMonthly : null;

    return {
      rateAtPurchase: rateAtPurchase.value,
      rateToday:      rateToday.value,
      rateDate:       rateToday.date,
      lockedMonthly,
      buyerMonthly,
      advantage,
      ltv,
    };
  } catch (e) {
    console.error('[marketRates] mortgage fetch failed:', e.message);
    return null;
  }
}

async function getMarketReturn(purchaseDate) {
  if (!purchaseDate) return null;
  try {
    const sf = await loadSeries('SFXRSA');
    const atPurchase = nearestOnOrBefore(sf, purchaseDate);
    const now        = latest(sf);
    if (!atPurchase || !now) return null;
    const years = (now.t - atPurchase.t) / (365.25 * 24 * 3600 * 1000);
    if (years <= 0) return null;
    const totalReturn = (now.value / atPurchase.value) - 1;
    const annualized  = Math.pow(now.value / atPurchase.value, 1 / years) - 1;
    return { totalReturn, annualized, years, indexDate: now.date };
  } catch (e) {
    console.error('[marketRates] SF index fetch failed:', e.message);
    return null;
  }
}

module.exports = { getRateContext, getMarketReturn };
