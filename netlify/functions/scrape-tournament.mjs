// Scheduled function — runs on Netlify's servers every 30 minutes,
// scrapes NCS, and writes the result to a Netlify Blobs store.
// This is what keeps the cache fresh even when nobody has the page open.
//
// The schedule is declared in the exported config below (Netlify Functions v2).

import { getStore } from '@netlify/blobs';
import { scrapeAll } from '../../lib/scrape.mjs';

export default async () => {
  try {
    const data = await scrapeAll();
    const store = getStore('tournament');
    await store.setJSON('latest', data);
    console.log(`[scrape] cached ${data.schedule?.games?.length || 0} games at ${new Date().toISOString()}`);
    return new Response('ok');
  } catch (err) {
    console.error('[scrape] failed:', err);
    return new Response('scrape failed: ' + err.message, { status: 500 });
  }
};

// Every 30 minutes, on the hour and half-hour.
export const config = {
  schedule: '*/30 * * * *',
};
