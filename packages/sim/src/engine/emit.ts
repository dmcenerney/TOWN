import type { SimEvent, EventType, EventVisibility } from '../types/events.ts';
import type { EventId, CitizenId } from '../types/ids.ts';
import type { World } from '../types/world.ts';
import { clockString, dayOf } from '../core/clock.ts';

export interface EmitSpec {
  type: EventType;
  actors: string[];
  locationId?: string | null;
  visibility?: EventVisibility;
  importance?: number;
  witnesses?: CitizenId[];
  payload?: Record<string, unknown>;
  visual?: SimEvent['visual'];
}

/**
 * Emit an event. IDs are derived from (day, tick, sequence) and the sequence
 * counter lives in world state, so a replay produces byte-identical ids.
 */
export function emit(w: World, sink: SimEvent[], spec: EmitSpec): SimEvent {
  const day = dayOf(w.tick);
  const seq = w.eventSeq++;
  const e: SimEvent = {
    id: `e_${String(day).padStart(5, '0')}_${String(seq).padStart(6, '0')}` as EventId,
    tick: w.tick,
    day,
    time: clockString(w.tick),
    type: spec.type,
    actors: spec.actors,
    locationId: spec.locationId ?? null,
    visibility: spec.visibility ?? 'public',
    importance: clamp01(spec.importance ?? 0.1),
    witnesses: spec.witnesses ?? [],
    payload: spec.payload ?? {},
  };
  if (spec.visual) e.visual = spec.visual;
  sink.push(e);
  return e;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
