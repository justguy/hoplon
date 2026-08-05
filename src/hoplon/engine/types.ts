/**
 * engine/types.ts — HoplonEngine interface, HoplonAdapters, HoplonEngineConfig.
 *
 * All public methods return Promise<T> (invariant H3 — no callbacks, no event emitters).
 * Every async method accepts an optional AbortSignal (H12).
 * The engine never owns retry or escalation policy (invariant H4).
 *
 * EXCEPTIONS (synchronous methods):
 *   compressRetryContext — pure data transform over AuditViolation arrays (recs §15.9, LC9).
 *   computeMinimalPatch  — pure byte-range arithmetic over violation data (recs §15.5, LC5).
 * Both are no-I/O, no-async functions that return values directly (not Promises).
 */

import type { HoplonAdaptersDefinition } from './adapterTypes.js';
import type { HoplonEngineConfigDefinition } from './configTypes.js';
import type { HoplonEngineOperationsPart01 } from './HoplonEngineOperationsPart01.js';
import type { HoplonEngineOperationsPart02 } from './HoplonEngineOperationsPart02.js';
import type { HoplonEngineOperationsPart03 } from './HoplonEngineOperationsPart03.js';

export interface HoplonAdapters extends HoplonAdaptersDefinition {}

export interface HoplonEngineConfig extends HoplonEngineConfigDefinition {}

export interface HoplonEngine extends
  HoplonEngineOperationsPart01,
  HoplonEngineOperationsPart02,
  HoplonEngineOperationsPart03 {}
