// STUB — a documented integration point for real SMS dispatch (WP7), not
// wired into the frontend by default. The in-app Alert Log (see
// pipeline/tti.ts + app.js's renderAlertLogPanel) is what the deployed site
// actually shows; nothing calls this function automatically.
//
// Off by default in every environment, including Netlify: it requires ALL
// four env vars below to be set AND ALERTS_LIVE_DISPATCH_ENABLED==="true"
// before it will even attempt to contact Twilio. On Netlify, none of these
// are set unless a site owner deliberately adds them — see netlify.toml,
// which declares this function's directory but sets none of these vars.
//
// To actually wire this up (out of scope for this project as shipped):
//   1. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, and
//      ALERTS_LIVE_DISPATCH_ENABLED=true as Netlify environment variables.
//   2. Add the `twilio` npm package as a dependency.
//   3. Call this function from the frontend's alert-log reveal logic
//      (app.js's renderAlertLogPanel) instead of leaving it in-app only.
//   4. Decide who "to" actually is — this stub deliberately takes no
//      recipient input, since there is no real subscriber list in this
//      project; that's a product decision for whoever wires this up for
//      real, not something to fabricate here.

export default async function handler(request) {
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'];
  const missing = required.filter((k) => !process.env[k]);
  const enabled = process.env.ALERTS_LIVE_DISPATCH_ENABLED === 'true';

  if (!enabled || missing.length > 0) {
    return new Response(JSON.stringify({
      dispatched: false,
      reason: !enabled
        ? 'ALERTS_LIVE_DISPATCH_ENABLED is not set to "true" — live SMS dispatch is off by default.'
        : `Missing required env var(s): ${missing.join(', ')}`,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ dispatched: false, reason: 'Invalid JSON body.' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  if (!body?.message || !body?.to) {
    return new Response(JSON.stringify({ dispatched: false, reason: 'Request body must include { to, message }.' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }

  // Deliberately not implemented further — actually calling Twilio here
  // requires the `twilio` package (not a dependency of this project) and a
  // real decision about rate limiting, recipient consent, and cost, none of
  // which belong in a stub. See the module comment above for what's needed.
  return new Response(JSON.stringify({
    dispatched: false,
    reason: 'Twilio call not implemented — this stub only proves the env-flag gate works. See the file header comment for what real wiring would need.',
  }), { status: 501, headers: { 'content-type': 'application/json' } });
}

export const config = { path: '/api/send-alert' };
