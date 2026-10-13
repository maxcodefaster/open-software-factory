// Served by Forgejo's native custom-public-assets handler, on the Forge origin.
// Top-level navigation also sends its SameSite=Lax browser cookie across origins.
export function forgeBrowserLogoutPage(factoryURL: string) {
  const target = new URL(factoryURL);
  if (target.username || target.password || !["http:", "https:"].includes(target.protocol))
    throw new Error("Factory logout destination is invalid");
  const destination = JSON.stringify(target.origin).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="referrer" content="no-referrer"><title>Signing out</title>
<body><p role="status">Signing out of Git…</p>
<script type="module">
try {
  const response = await fetch('/user/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('Sign-out failed');
  const check = await fetch('/user/settings', { credentials: 'same-origin', cache: 'no-store' });
  if (new URL(check.url).pathname !== '/user/login') throw new Error('Sign-out is unconfirmed');
  location.replace(${destination});
} catch {
  document.querySelector('[role="status"]').textContent = 'Git sign-out could not be confirmed. Reload to retry.';
}
</script></body></html>`;
}
