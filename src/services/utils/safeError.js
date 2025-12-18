function truncate(str, maxLen) {
  const s = String(str ?? '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

function formatErrorForLog(err, opts = {}) {
  const maxLen = Number.isFinite(opts.maxLen) ? opts.maxLen : 500;

  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return truncate(err, maxLen);
  if (typeof err === 'number' || typeof err === 'boolean') return truncate(String(err), maxLen);

  const name = err?.name ? String(err.name) : 'Error';
  const message = err?.message ? String(err.message) : String(err);

  const code = err?.code ? String(err.code) : undefined;
  const status = err?.response?.status;
  const method = err?.config?.method || err?.response?.config?.method;
  const url = err?.config?.url || err?.response?.config?.url;

  const parts = [];
  if (code) parts.push(`code=${code}`);
  if (typeof status === 'number') parts.push(`status=${status}`);
  if (method) parts.push(`method=${String(method).toUpperCase()}`);
  if (url) parts.push(`url=${url}`);

  const suffix = parts.length ? ` (${parts.join(', ')})` : '';
  return truncate(`${name}: ${message}${suffix}`, maxLen);
}

module.exports = { formatErrorForLog };
