import { describe, it, expect } from 'vitest';
import { parseHttpResponse } from '../src/utils/lenientHttp';

describe('parseHttpResponse', () => {
  it('parses a well-formed response', () => {
    const raw =
      'HTTP/1.1 200 OK\r\n' +
      'Content-Type: application/json\r\n' +
      'Content-Length: 17\r\n' +
      '\r\n' +
      '{"status":"OK"}' +
      '';

    const res = parseHttpResponse(raw);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.json).toEqual({ status: 'OK' });
  });

  // This is the real defect: Pesepay's nginx continues the HSTS header value on
  // a second line using a bare LF. Node's llhttp, undici and
  // https.Agent({ insecureHTTPParser: true }) all reject this with
  // HPE_CR_EXPECTED. Only curl tolerated it, which is why every payment failed
  // from Node while a shell probe looked healthy.
  it('accepts a header value folded with a bare LF instead of CRLF', () => {
    const raw =
      'HTTP/1.1 400 \r\n' +
      'Server: nginx/1.18.0 (Ubuntu)\r\n' +
      'Content-Type: application/json\r\n' +
      'Transfer-Encoding: chunked\r\n' +
      'Strict-Transport-Security: max-age=31536000;\n' +
      ' includeSubDomains\r\n' +
      '\r\n' +
      '12\r\n' +
      '{"message":"nope"}\r\n' +
      '0\r\n\r\n';

    const res = parseHttpResponse(raw);
    expect(res.status).toBe(400);
    // The folded continuation is rejoined onto the previous header value.
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers.server).toBe('nginx/1.18.0 (Ubuntu)');
    // Chunked body is de-chunked correctly. 0x12 == 18 == len('{"message":"nope"}')
    expect(res.json).toEqual({ message: 'nope' });
  });

  it('dechunks a chunked body', () => {
    const raw =
      'HTTP/1.1 200 OK\r\n' +
      'Transfer-Encoding: chunked\r\n' +
      '\r\n' +
      '7\r\n{"a":1,\r\n' +
      '6\r\n"b":2}\r\n' +
      '0\r\n\r\n';

    const res = parseHttpResponse(raw);
    expect(res.json).toEqual({ a: 1, b: 2 });
  });

  it('honours chunk extensions after the size', () => {
    const raw =
      'HTTP/1.1 200 OK\r\n' +
      'Transfer-Encoding: chunked\r\n' +
      '\r\n' +
      '7;name=value\r\n{"a":1}\r\n' +
      '0\r\n\r\n';

    expect(parseHttpResponse(raw).json).toEqual({ a: 1 });
  });

  it('truncates to Content-Length when the body is over-long', () => {
    const raw =
      'HTTP/1.1 200 OK\r\n' +
      'Content-Length: 7\r\n' +
      '\r\n' +
      '{"a":1}trailing-garbage';

    expect(parseHttpResponse(raw).json).toEqual({ a: 1 });
  });

  it('lowercases header names and trims values', () => {
    const raw =
      'HTTP/1.1 200 OK\r\n' +
      'X-Mixed-Case:   spaced   \r\n' +
      '\r\n';

    const res = parseHttpResponse(raw);
    expect(res.headers['x-mixed-case']).toBe('spaced');
  });

  it('leaves body undefined for a non-JSON payload instead of throwing', () => {
    const raw = 'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 2\r\n\r\noh ';
    const res = parseHttpResponse(raw);
    expect(res.status).toBe(502);
    expect(res.json).toBeUndefined();
    expect(res.body).toBe('oh');
  });

  it('rejects a response with no header terminator', () => {
    expect(() => parseHttpResponse('HTTP/1.1 200 OK\r\nContent-Type: application/json')).toThrow(
      /no header terminator/i
    );
  });

  it('rejects a response with a bad status line', () => {
    expect(() => parseHttpResponse('NOT-HTTP\r\n\r\nbody')).toThrow(/bad status line/i);
  });

  it('handles a 404 whose body carries a "status":"404" field', () => {
    const body = '{"timestamp":"2026-09-29T09:43:17.943+0000","message":"Transaction record was not found","status":"404"}';
    const raw = `HTTP/1.1 404 \r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`;

    const res = parseHttpResponse(raw);
    expect(res.status).toBe(404);
    expect(res.json.status).toBe('404');
  });
});
