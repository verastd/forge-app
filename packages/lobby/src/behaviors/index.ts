/**
 * Shared behaviours (ADR-009): the catalog every behaviour is an entry in, the
 * budget each is held to, the entities they act on and who decides them, and
 * the world those entities live in. Pure and transport-free: the feeds in
 * apps/web carry the messages today, and the world participant will run the
 * same code when authority moves there.
 */
export * from './budget.js';
export * from './catalog.js';
export * from './entity.js';
export * from './world.js';
