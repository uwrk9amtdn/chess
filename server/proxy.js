// Who is on the other end of a request: their address, and whether they
// came over HTTPS, as the HTTPS proxy in front of the server reports it.
//
// The proxy's word on the visitor's address (X-Real-IP, else the last entry
// of X-Forwarded-For, which the proxy adds) and protocol (X-Forwarded-Proto)
// is only taken from the addresses it connects from (`proxies`, by default
// the server itself); anyone else sending those headers gains nothing. A
// proxy that serves nothing but HTTPS and does not say so in
// X-Forwarded-Proto can be vouched for with `proxyHttps`.

export const LOOPBACK = ['127.0.0.1', '::1'];

// An IPv4 address the way Node may write it, "::ffff:1.2.3.4", made plain.
export const plain = (address) => String(address ?? '').replace(/^::ffff:(?=\d+\.)/, '');

// The proxy settings, from a list of addresses (LOOPBACK if none) and
// whether the proxy serves only HTTPS.
export const proxySettings = ({ proxies = LOOPBACK, proxyHttps = false } = {}) => ({
  proxies: new Set(proxies.map(plain)),
  proxyHttps,
});

// { address, https, viaProxy, local } for a request (or a WebSocket's
// upgrade request).
export function origin(req, { proxies, proxyHttps }) {
  const remote = plain(req.socket.remoteAddress);
  const realIp = req.headers['x-real-ip'];
  const forwarded = req.headers['x-forwarded-for'];
  if (proxies.has(remote) && (realIp || forwarded)) {
    const address = plain(realIp ? String(realIp).trim() : String(forwarded).split(',').pop().trim());
    const proto = req.headers['x-forwarded-proto'];
    return { address, https: proto ? proto === 'https' : proxyHttps, viaProxy: true, local: false };
  }
  return { address: remote, https: false, viaProxy: false, local: LOOPBACK.includes(remote) };
}
