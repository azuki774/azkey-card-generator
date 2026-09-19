import type { FastifyReply, FastifyRequest } from 'fastify';

export const CARD_REQUEST_HEADER = 'x-card-request';
export const CARD_REQUEST_VALUE = '1';

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function sendCrossSiteForbidden(reply: FastifyReply) {
  return reply
    .code(403)
    .type('application/json')
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send({
      error: {
        code: 'forbidden',
        message: 'リクエストが許可されていません。',
      },
    });
}

// Route-attached preHandler for POST /cards. Attached via the route options in
// app.ts, so Fastify routing (including query strings and encoded paths that
// resolve to /cards) decides coverage — this hook never matches on raw
// request.url and therefore cannot be bypassed with e.g. "/cards?x=1".
export async function guardCrossSiteCardsRequest(request: FastifyRequest, reply: FastifyReply) {
  // Fetch Metadata: allow browsers only when the request is same-origin.
  // Absent metadata (e.g. curl / direct clients) falls through to the
  // dedicated-header check below. same-site / none / cross-site are rejected
  // because legitimate browser use is always a same-origin fetch.
  const fetchSite = headerValue(request.headers['sec-fetch-site']);
  if (fetchSite !== undefined && fetchSite !== 'same-origin') {
    return sendCrossSiteForbidden(reply);
  }

  // Dedicated non-simple header. Cross-origin simple form/urlencoded requests
  // cannot set this without a CORS preflight, which this server never grants.
  // Do not replace this with Origin allow-listing based on forwarded headers.
  if (headerValue(request.headers[CARD_REQUEST_HEADER]) !== CARD_REQUEST_VALUE) {
    return sendCrossSiteForbidden(reply);
  }
}
