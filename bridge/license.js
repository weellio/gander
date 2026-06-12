// Gander — optional Gumroad license verification.
//
// Licensing is OFF unless a Gumroad product is configured (so dev/free use is
// frictionless). To gate a paid build, set the product permalink — via
// AOC_GUMROAD_PRODUCT env, aoc-config.json {"gumroadProduct":"..."}, or the
// PRODUCT constant below — and have buyers put their key in aoc-config.json
// {"license":"..."} (or AOC_LICENSE).
//
// Philosophy: a local tool can't be truly DRM-locked, so this is honor-system —
// it filters casual sharing and FAILS OPEN when offline or Gumroad is down, so a
// paying user is never locked out by a flaky network.

const https = require('https');

const PRODUCT = process.env.AOC_GUMROAD_PRODUCT || ''; // baked-in default for distributable builds

function verify(licenseKey, productOverride) {
  return new Promise((resolve) => {
    const product = productOverride || PRODUCT;
    if (!product) return resolve({ licensed: true, mode: 'unconfigured' });
    if (!licenseKey) return resolve({ licensed: false, mode: 'missing', message: 'No license key set (aoc-config.json "license").' });

    const body = new URLSearchParams({
      product_permalink: product,
      license_key: licenseKey,
      increment_uses_count: 'false',
    }).toString();

    const req = https.request(
      {
        host: 'api.gumroad.com', path: '/v2/licenses/verify', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
        timeout: 6000,
      },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          try {
            const j = JSON.parse(b);
            const p = j && j.purchase;
            if (j.success && p && !p.refunded && !p.chargebacked && !p.disputed) {
              resolve({ licensed: true, mode: 'verified', email: p.email || null });
            } else {
              resolve({ licensed: false, mode: 'invalid', message: j.message || 'Invalid or refunded license.' });
            }
          } catch (_) {
            resolve({ licensed: true, mode: 'offline' }); // unparseable -> fail open
          }
        });
      }
    );
    req.on('error', () => resolve({ licensed: true, mode: 'offline' }));
    req.on('timeout', () => { req.destroy(); resolve({ licensed: true, mode: 'offline' }); });
    req.end(body);
  });
}

module.exports = { verify, PRODUCT };
