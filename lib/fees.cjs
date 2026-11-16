// The platform fee. One place, shared by the payments code (charges), build.js (the providers page)
// and the API config the dashboard reads, so what we show can't drift from what we charge.
//
// Tiered per job, like tax brackets: 10% of the first $1,000, 5% of everything above it. Card
// processing (~3%) comes out of our share, so above $1,000 we keep about 2%. Small jobs stay worth
// our while; a $15,000 landscape install costs the pro $800 instead of $1,500, which is less than
// a lead service plus their own card processing, so big jobs have no reason to leave the platform.
const FEE_TIERS = [
  { upToCents: 100_000, percent: 10 },
  { upToCents: null, percent: 5 },
];

// HOA give-back is paid out of our fee on resident bookings. Our fee is ~5% on big jobs and card
// processing takes ~3%, so 1.5% is the most we can give back without losing money on any job.
// schema.sql holds the same limit (give_back_bps <= 150).
const MAX_GIVE_BACK_BPS = 150;

function feeFor(cents, tiers = FEE_TIERS) {
  let fee = 0, from = 0;
  for (const t of tiers) {
    const to = t.upToCents == null ? cents : Math.min(cents, t.upToCents);
    if (to > from) fee += ((to - from) * t.percent) / 100;
    if (t.upToCents == null || cents <= t.upToCents) break;
    from = t.upToCents;
  }
  return Math.round(fee);
}

// "10% of each job, and 5% of anything over $1,000"
function feeSummary(tiers = FEE_TIERS) {
  const [base, over] = tiers;
  return `${base.percent}% of each job, and ${over.percent}% of anything over $${(base.upToCents / 100).toLocaleString("en-US")}`;
}

module.exports = { FEE_TIERS, MAX_GIVE_BACK_BPS, feeFor, feeSummary };
