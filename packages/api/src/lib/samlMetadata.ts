// Fetches and parses an IdP's SAML metadata XML into the pieces we need to both
// validate the connection and construct a passport-saml SAML instance.

/** Blocks obvious SSRF targets (loopback, link-local, private ranges, cloud metadata). */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true; // cloud metadata
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 127 || a === 0 || a === 10 || a === 169) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

export interface ParsedIdpMetadata {
  ok: boolean;
  error?: string;
  httpStatus?: number;
  entityId?: string | undefined;
  /** SSO endpoint to use (prefers HTTP-Redirect, falls back to first available). */
  entryPoint?: string | undefined;
  /** All SSO endpoint Locations found. */
  ssoUrls?: string[];
  /** Bindings advertised (short names, e.g. HTTP-Redirect). */
  bindings?: string[];
  /** Signing certificate(s), base64 DER with whitespace stripped. */
  certs?: string[];
}

/** Fetches the metadata URL (with SSRF + timeout guards) and parses it. */
export async function fetchIdpMetadata(url: string): Promise<ParsedIdpMetadata> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, error: 'Invalid URL.' }; }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must use http or https.' };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, error: 'Refusing to fetch internal or private network addresses.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let xml = '';
  let httpStatus = 0;
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { Accept: 'application/samlmetadata+xml, application/xml, text/xml, */*' },
    });
    httpStatus = resp.status;
    if (!resp.ok) return { ok: false, httpStatus, error: `Metadata endpoint returned HTTP ${resp.status}.` };
    xml = (await resp.text()).slice(0, 2_000_000); // cap at 2 MB
  } catch (e: unknown) {
    const aborted = (e as { name?: string })?.name === 'AbortError';
    return { ok: false, error: aborted ? 'Request timed out after 8s.' : 'Could not reach the metadata URL.' };
  } finally {
    clearTimeout(timeout);
  }

  return parseIdpMetadataXml(xml, httpStatus);
}

/** Parses already-fetched metadata XML. Exported for unit-style reuse. */
export function parseIdpMetadataXml(xml: string, httpStatus = 0): ParsedIdpMetadata {
  if (!/<(?:\w+:)?EntityDescriptor[\s>]/i.test(xml)) {
    return { ok: false, httpStatus, error: 'Response is not a SAML EntityDescriptor document.' };
  }
  if (!/<(?:\w+:)?IDPSSODescriptor[\s>]/i.test(xml)) {
    return { ok: false, httpStatus, error: 'Metadata has no IDPSSODescriptor — this does not look like Identity Provider metadata.' };
  }

  const entityId = /entityID\s*=\s*"([^"]+)"/i.exec(xml)?.[1];

  // SingleSignOnService Location + Binding attributes.
  const ssoUrls: string[] = [];
  const bindings: string[] = [];
  let redirectUrl: string | undefined;
  let firstUrl: string | undefined;
  const ssoRe = /<(?:\w+:)?SingleSignOnService\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = ssoRe.exec(xml)) !== null) {
    const tag = match[0];
    const loc = /Location\s*=\s*"([^"]+)"/i.exec(tag)?.[1];
    const bind = /Binding\s*=\s*"([^"]+)"/i.exec(tag)?.[1];
    if (loc) {
      if (!ssoUrls.includes(loc)) ssoUrls.push(loc);
      if (!firstUrl) firstUrl = loc;
      if (bind && /HTTP-Redirect/i.test(bind) && !redirectUrl) redirectUrl = loc;
    }
    if (bind) {
      const short = bind.split(':').pop() ?? bind;
      if (!bindings.includes(short)) bindings.push(short);
    }
  }

  if (ssoUrls.length === 0) {
    return { ok: false, httpStatus, entityId, error: 'No SingleSignOnService endpoint found in the metadata.' };
  }

  // X509 signing certificates.
  const certs: string[] = [];
  const certRe = /<(?:\w+:)?X509Certificate[^>]*>([\s\S]*?)<\/(?:\w+:)?X509Certificate>/gi;
  while ((match = certRe.exec(xml)) !== null) {
    const raw = match[1]?.replace(/\s+/g, '');
    if (raw && !certs.includes(raw)) certs.push(raw);
  }

  return {
    ok: true,
    httpStatus,
    entityId,
    entryPoint: redirectUrl ?? firstUrl,
    ssoUrls,
    bindings,
    certs,
  };
}
