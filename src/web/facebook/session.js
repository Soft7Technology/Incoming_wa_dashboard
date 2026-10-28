'use strict';
(() => {
  // The cookie is HttpOnly. Neither application credentials nor dashboard tokens
  // are requested, stored or reused by these public workspaces.
  let pending;
  function ready() {
    if (!pending) pending = fetch('/v1/facebook/session', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(25000),
    }).then(async response => {
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || 'Could not open your workspace.');
      return result.data;
    });
    return pending;
  }
  window.metaWorkspace = {
    ready,
    async fetch(url, options = {}) {
      await ready();
      return fetch(url, { ...options, credentials: 'same-origin' });
    },
  };
})();
