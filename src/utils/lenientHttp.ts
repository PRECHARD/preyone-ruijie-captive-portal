import * as tls from 'tls';
import { URL } from 'url';

export interface LenientResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the body is JSON, otherwise undefined. */
  json?: any;
  /** Raw body text, always populated. */
  body: string;
}

export interface LenientRequestOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Override the default User-Agent, mainly for diagnostics. */
  userAgent?: string;
}

/**
 * Minimal, deliberately lenient HTTP/1.1 client for talking to the Pesepay API.
 *
 * WHY THIS EXISTS
 * ---------------
 * Pesepay's edge (nginx 1.18) returns a malformed response header:
 *
 *     Strict-Transport-Security: max-age=31536000;
 *      includeSubDomains
 *
 * The header value is continued on a second line using a bare LF, i.e. obsolete
 * line-folding with no carriage return. RFC 7230 requires CRLF, and every strict
 * parser rejects it:
 *
 *     - axios / Node http  -> HPE_CR_EXPECTED "Missing expected CR after header value"
 *     - native fetch/undici-> "Response does not match the HTTP/1.1 protocol"
 *     - https.Agent({ insecureHTTPParser: true }) -> still HPE_CR_EXPECTED
 *
 * Only `curl` tolerates it, which is why the gateway looked healthy from a shell
 * while every payment failed from Node. Rather than hand-roll TLS framing we
 * speak HTTP/1.1 over `node:tls` and parse the response ourselves, folding
 * continuation lines the way RFC 7230 section 3.2.4 describes.
 *
 * Certificate validation is left at the Node default (on), so this is not a
 * downgrade in transport security - only in header parsing leniency.
 */

function dechunk(input: string): string {
  const out: string[] = [];
  let rest = input;

  for (;;) {
    // Chunk size is hex, optionally followed by chunk extensions after ";".
    const lineEnd = rest.indexOf('\n');
    if (lineEnd === -1) break;

    const sizeLine = rest.slice(0, lineEnd).trim();
    rest = rest.slice(lineEnd + 1);

    const size = parseInt(sizeLine.split(';')[0], 16);
    if (!Number.isFinite(size) || size <= 0) break;

    out.push(rest.slice(0, size));
    rest = rest.slice(size + 2); // skip CRLF that follows the chunk data
  }

  return out.join('');
}

/**
 * Parses a raw HTTP/1.1 response, tolerating a bare LF used as a line break
 * inside a folded header value. Exported for unit testing.
 */
export function parseHttpResponse(raw: string): LenientResponse {
  let boundary = raw.indexOf('\r\n\r\n');
  let separatorLength = 4;
  if (boundary === -1) {
    boundary = raw.indexOf('\n\n');
    separatorLength = 2;
  }
  if (boundary === -1) {
    throw new Error('Malformed HTTP response: no header terminator found');
  }

  const head = raw.slice(0, boundary);
  const bodyRaw = raw.slice(boundary + separatorLength);

  // Split on CRLF *or* bare LF. This is the whole point: Pesepay's folded
  // header arrives as "value\n continuation".
  const lines = head.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error('Malformed HTTP response: empty status line');
  }

  const statusMatch = lines[0].match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
  if (!statusMatch) {
    throw new Error('Malformed HTTP response: bad status line');
  }
  const status = parseInt(statusMatch[1], 10);

  const headers: Record<string, string> = {};
  let lastName: string | null = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    if (/^[ \t]/.test(line)) {
      // Obsolete line folding: a continuation of the previous header value.
      if (lastName) {
        headers[lastName] = `${headers[lastName]} ${line.trim()}`;
      }
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === -1) continue;

    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = value;
    lastName = name;
  }

  let body = bodyRaw;
  const transferEncoding = (headers['transfer-encoding'] || '').toLowerCase();
  if (transferEncoding.includes('chunked')) {
    body = dechunk(bodyRaw);
  } else if (headers['content-length']) {
    const length = parseInt(headers['content-length'], 10);
    if (Number.isFinite(length)) body = bodyRaw.slice(0, length);
  }

  let json: any;
  try {
    json = body.trim() ? JSON.parse(body) : undefined;
  } catch {
    json = undefined;
  }

  return { status, headers, json, body };
}

export function lenientRequest(options: LenientRequestOptions): Promise<LenientResponse> {
  const { url, method = 'GET', headers = {}, body, timeoutMs = 30000, userAgent } = options;

  return new Promise<LenientResponse>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`Invalid request URL: ${url}`));
      return;
    }

    if (target.protocol !== 'https:') {
      reject(new Error(`Refusing non-HTTPS request to ${target.protocol}//${target.host}`));
      return;
    }

    const port = target.port ? parseInt(target.port, 10) : 443;
    const path = `${target.pathname}${target.search}`;

    const requestLines = [
      `${method} ${path} HTTP/1.1`,
      `Host: ${target.host}`,
      `User-Agent: ${userAgent || 'preyone-portal/1.0'}`,
      'Accept: application/json',
      // Ask the server to close so we know the response is complete without
      // having to track Content-Length or chunk boundaries on a reused socket.
      'Connection: close',
    ];
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null && value !== '') {
        requestLines.push(`${name}: ${value}`);
      }
    }
    const payload = body ?? '';
    if (payload) {
      requestLines.push('Content-Type: application/json');
      requestLines.push(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}`);
    }

    const request = `${requestLines.join('\r\n')}\r\n\r\n${payload}`;

    const chunks: Buffer[] = [];
    let settled = false;
    let totalBytes = 0;
    // Guards against a hostile or broken endpoint streaming without end.
    const MAX_BYTES = 1024 * 1024;

    const socket = tls.connect(
      {
        host: target.hostname,
        port,
        // Required for SNI/certificate validation to target the right name.
        servername: target.hostname,
      },
      () => {
        socket.write(request);
      }
    );

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs, () => {
      fail(new Error(`Request to ${target.host} timed out after ${timeoutMs}ms`));
    });

    socket.on('error', (err: Error) => {
      fail(new Error(`Network error contacting ${target.host}: ${err.message}`));
    });

    socket.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BYTES) {
        fail(new Error(`Response from ${target.host} exceeded ${MAX_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    socket.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(parseHttpResponse(raw));
      } catch (err: any) {
        reject(new Error(`Unreadable response from ${target.host}: ${err.message}`));
      }
    });

    socket.on('close', () => {
      // TLS sockets can surface 'end' then 'close', but some paths only emit
      // 'close'. Parse whatever we have rather than hanging until timeout.
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        fail(new Error(`Connection to ${target.host} closed without a response`));
        return;
      }
      settled = true;
      try {
        resolve(parseHttpResponse(raw));
      } catch (err: any) {
        reject(new Error(`Unreadable response from ${target.host}: ${err.message}`));
      }
    });
  });
}
