// Test-only guard. Loaded before Pi/providers in EVERY mock parent/child Node.
// The preflight cannot accidentally call a foundation model, even on misrouting.
const net = require('node:net');
const allowed = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function check(host) {
  if (!allowed.has(host)) throw new Error('Preflight forbids non-loopback network connections');
}
const fetch = globalThis.fetch;
globalThis.fetch = function(input, options) {
  check(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname);
  const headers = new Headers(options?.headers || input?.headers);
  headers.set('x-pi-bench-guard', 'loopback-only');
  return fetch.call(this, input, {...options, headers});
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  if (typeof options === 'object') {
    if (!options.path) check(options.host || options.hostname || options.servername || 'localhost');
  } else if (typeof options === 'number' || /^\d+$/.test(String(options))) {
    check(typeof args[1] === 'string' ? args[1] : 'localhost');
  } else if (typeof options !== 'string') {
    throw new Error('Unrecognized preflight socket target');
  }
  return connect.apply(this, args);
};
process.env.PI_BENCH_NETWORK_GUARD = 'loopback-only';
if (process.env.PI_BENCH_GUARD_LOG) require('node:fs').appendFileSync(process.env.PI_BENCH_GUARD_LOG,
  JSON.stringify({type:'guard_bootstrap',pid:process.pid,owner:process.env.PI_BENCH_OWNER,guard:'loopback-only'})+'\n');
