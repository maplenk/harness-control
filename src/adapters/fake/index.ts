/**
 * Scriptable fakes for adapter/transport conformance testing (PLAN §19):
 * - `in-process.js`: SPI-level fake (`InProcessFakeAdapter`) — capability
 *   gating, streaming, permissions, cancellation, resume, classification.
 * - `scenario.js` + `child.js` + `fake-acp-child.mjs`: wire-level fake — a
 *   real child process speaking NDJSON JSON-RPC, scripted via a JSON file
 *   (fragmentation, malformed/oversized lines, stderr noise, handshake
 *   stalls, late updates, permission requests, error envelopes, ignored
 *   cancels, unexpected exits). Substrate for §19 tests 1–8/21.
 */
export * from './scenario.js';
export * from './in-process.js';
export * from './child.js';
