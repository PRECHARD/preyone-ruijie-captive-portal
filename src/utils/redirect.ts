import { Request } from 'express';

export function isSafeSameOriginUrl(rawUrl: string, origin: string): boolean {
  try {
    const url = new URL(rawUrl, origin);
    return url.origin === origin;
  } catch {
    return false;
  }
}

export function buildRuijieSuccessUrl(req: Request, sessionToken: string): string {
  const base = process.env.RUIJIE_SUCCESS_URL;
  if (base) {
    try {
      const url = new URL(base);
      url.searchParams.set('token', sessionToken);
      return url.toString();
    } catch (err) {
      console.warn('Invalid RUIJIE_SUCCESS_URL value:', base, err);
    }
  }

  const originalUrl = req.query.url as string | undefined;
  const origin = `${req.protocol}://${req.get('host')}`;
  if (originalUrl && isSafeSameOriginUrl(originalUrl, origin)) {
    return new URL(originalUrl, origin).toString();
  }

  return '/success.html';
}
