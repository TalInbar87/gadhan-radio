// Shared Google service-account → access-token helper for Edge Functions.
// Builds a JWT with the requested scope and exchanges it at oauth2.googleapis.com.

import { create, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

export async function getGoogleAccessToken(saJson: string, scope: string): Promise<string> {
  const sa = JSON.parse(saJson) as { client_email: string; private_key: string };
  const pem = sa.private_key.replace(/\\n/g, '\n');

  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const now = getNumericDate(0);
  const jwt = await create(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: sa.client_email,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: getNumericDate(60 * 30),
    },
    key,
  );

  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!tokRes.ok) throw new Error(`Google token exchange failed: ${await tokRes.text()}`);
  const tok = await tokRes.json();
  return tok.access_token as string;
}
