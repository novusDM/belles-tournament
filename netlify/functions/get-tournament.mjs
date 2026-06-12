// Public read endpoint the browser hits: /.netlify/functions/get-tournament
// Returns the cached tournament JSON. If the cache is empty (first deploy,
// before the scheduled job has run) or older than 30 min, it scrapes once
// inline, refreshes the cache, and returns fresh data. Viewers never hit
// NCS directly and there is no API key anywhere in the browser.

import { getStore } from '@netlify/blobs';
import { scrapeAll } from '../../lib/scrape.mjs';

const MAX_AGE = 30 * 60 * 1000; // 30 minutes

export default async () => {
  const store = getStore('tournament');
  let data = null;

  try {
    data = await store.get('latest', { type: 'json' });
  } catch {
    data = null;
  }

  const age = data?.fetchedAt ? Date.now() - data.fetchedAt : Infinity;

  // Cold or stale -> scrape once, write back, return fresh.
  if (!data || age > MAX_AGE) {
    try {
      data = await scrapeAll();
      await store.setJSON('latest', data);
    } catch (err) {
      // If a live scrape fails but we have *some* old data, serve it anyway.
      if (data) {
        return json({ ...data, stale: true, warning: err.message });
      }
      return json({ error: err.message }, 502);
    }
  }

  return json(data);
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60', // edge can hold it 60s
      'Access-Control-Allow-Origin': '*',
    },
  });
}
