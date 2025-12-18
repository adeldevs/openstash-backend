function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);

    url.hash = '';

    const trackingPrefixes = ['utm_', 'ref', 'ref_', 'source', 'cmpid', 'cid'];
    for (const key of Array.from(url.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (trackingPrefixes.some((p) => lower === p || lower.startsWith(p))) {
        url.searchParams.delete(key);
      }
    }

    // Sort params for stable hashing
    const sorted = Array.from(url.searchParams.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    url.search = '';
    for (const [k, v] of sorted) url.searchParams.append(k, v);

    // Normalize trailing slash (keep root)
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.toString();
  } catch {
    return rawUrl;
  }
}

function domainFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return undefined;
  }
}

module.exports = { normalizeUrl, domainFromUrl };
