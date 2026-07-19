/**
 * Generic ACP stdio transport + session adapter (PLAN §10). The transport
 * owns wire mechanics (framing, bounds, lifecycle, process-group reaping);
 * the session adapter implements the §9 SPI over it (handshake/capability
 * probe, identity confirmation, turn boundaries, permission mediation).
 */
export * from './transport.js';
export * from './session.js';
