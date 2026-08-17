import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNavGraph, distance, isFullyConnected, nodePosition, parseTownMap,
  pathCost, pathLength, polyline, route, NavError,
} from '../src/space/navgraph.ts';
import mapJson from '../../../world/map.json' with { type: 'json' };
import type { TownMap } from '../src/types/map.ts';
import type { NodeId } from '../src/types/ids.ts';
import { asId } from '../src/types/ids.ts';

const map = parseTownMap(mapJson);
const g = buildNavGraph(map);

test('map: Alder Bend has the town it was authored to have', () => {
  assert.equal(map.name, 'Alder Bend');
  const types = new Map<string, number>();
  for (const b of map.buildings) types.set(b.type, (types.get(b.type) ?? 0) + 1);

  assert.ok(types.get('home')! >= 17, 'not enough houses for the founding households');
  for (const required of ['market', 'restaurant', 'bar', 'factory', 'farm', 'bank',
    'clinic', 'town_hall', 'newspaper', 'school', 'square', 'vacant_commercial']) {
    assert.equal(types.get(required), 1, `expected exactly one ${required}`);
  }
});

test('map: nothing is sited outside the town bounds', () => {
  for (const n of map.nodes) {
    assert.ok(n.position.x >= 0 && n.position.x <= map.bounds.width, `${n.id} x`);
    assert.ok(n.position.y >= 0 && n.position.y <= map.bounds.height, `${n.id} y`);
  }
  for (const b of map.buildings) {
    assert.ok(b.position.x - b.footprint.x / 2 >= 0, `${b.id} hangs off the west edge`);
    assert.ok(b.position.x + b.footprint.x / 2 <= map.bounds.width, `${b.id} hangs off the east edge`);
    assert.ok(b.position.y - b.footprint.y / 2 >= 0, `${b.id} hangs off the north edge`);
    assert.ok(b.position.y + b.footprint.y / 2 <= map.bounds.height, `${b.id} hangs off the south edge`);
  }
});

test('map: no two buildings occupy the same ground', () => {
  const b = map.buildings;
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) {
      const a = b[i]!;
      const c = b[j]!;
      const overlapX = Math.abs(a.position.x - c.position.x) < (a.footprint.x + c.footprint.x) / 2;
      const overlapY = Math.abs(a.position.y - c.position.y) < (a.footprint.y + c.footprint.y) / 2;
      assert.ok(!(overlapX && overlapY), `${a.name} overlaps ${c.name}`);
    }
  }
});

test('nav: every building can be reached from every other', () => {
  const { connected, unreachable } = isFullyConnected(g);
  assert.ok(connected, `unreachable pairs: ${unreachable.slice(0, 3).map(([a, c]) => `${a}->${c}`).join(', ')}`);
});

test('nav: every building has a door, and every door names its building', () => {
  for (const b of map.buildings) {
    assert.equal(g.entranceOf.get(b.id), b.entranceNode);
    assert.equal(g.doorOf.get(b.entranceNode), b.id);
    const node = g.nodes.get(b.entranceNode)!;
    assert.equal(node.kind, 'door');
    // A door must sit near its own building, not across town.
    assert.ok(distance(node.position, b.position) < 40, `${b.name}'s door is adrift`);
  }
});

test('nav: routes start where asked and end where asked', () => {
  const market = g.entranceOf.get(asId('bld_market'))!;
  const factory = g.entranceOf.get(asId('bld_factory'))!;
  const path = route(g, market, factory);
  assert.equal(path[0], market);
  assert.equal(path[path.length - 1], factory);
  assert.ok(path.length > 2, 'the market and the factory are not neighbours');
  assert.equal(new Set(path).size, path.length, 'route revisits a node');
});

test('nav: routing to yourself is a single point', () => {
  const home = g.entranceOf.get(asId('bld_home_01'))!;
  assert.deepEqual(route(g, home, home), [home]);
  assert.equal(pathCost(g, home, home), 0);
});

test('nav: cost is symmetric and obeys the triangle inequality', () => {
  const ids = map.buildings.map((b) => b.entranceNode);
  for (let i = 0; i < ids.length; i += 3) {
    for (let j = 0; j < ids.length; j += 5) {
      const a = ids[i]!;
      const b = ids[j]!;
      assert.equal(pathCost(g, a, b).toFixed(6), pathCost(g, b, a).toFixed(6));
      const via = ids[(i + j) % ids.length]!;
      assert.ok(
        pathCost(g, a, b) <= pathCost(g, a, via) + pathCost(g, via, b) + 1e-6,
        `detour through ${via} beats the direct route from ${a} to ${b}`,
      );
    }
  }
});

test('nav: Floyd-Warshall agrees with a plain Dijkstra', () => {
  const dijkstra = (from: NodeId): Map<NodeId, number> => {
    const dist = new Map<NodeId, number>();
    for (const id of g.order) dist.set(id, Infinity);
    dist.set(from, 0);
    const unvisited = new Set(g.order);
    while (unvisited.size > 0) {
      let best: NodeId | null = null;
      let bestD = Infinity;
      for (const id of unvisited) {
        const d = dist.get(id)!;
        if (d < bestD) { bestD = d; best = id; }
      }
      if (!best || bestD === Infinity) break;
      unvisited.delete(best);
      for (const edge of g.neighbours.get(best)!) {
        const alt = bestD + edge.length / edge.speedFactor;
        if (alt < dist.get(edge.to)!) dist.set(edge.to, alt);
      }
    }
    return dist;
  };

  for (const from of [g.order[0]!, g.order[20]!, g.entranceOf.get(asId('bld_bar'))!]) {
    const truth = dijkstra(from);
    for (const to of g.order) {
      assert.ok(
        Math.abs(pathCost(g, from, to) - truth.get(to)!) < 1e-6,
        `disagreement ${from} -> ${to}: table ${pathCost(g, from, to)}, dijkstra ${truth.get(to)}`,
      );
    }
  }
});

test('nav: the returned path really is walkable, edge by edge', () => {
  const from = g.entranceOf.get(asId('bld_farm'))!;
  const to = g.entranceOf.get(asId('bld_sycamore'))!;
  const path = route(g, from, to);
  for (let i = 1; i < path.length; i++) {
    const hop = g.neighbours.get(path[i - 1]!)!.some((n) => n.to === path[i]);
    assert.ok(hop, `no edge between ${path[i - 1]} and ${path[i]}`);
  }
  // Walking distance should be within reason of the crow-flying distance.
  const straight = distance(nodePosition(g, from), nodePosition(g, to));
  const walked = pathLength(g, path);
  assert.ok(walked >= straight - 1e-6, 'a route shorter than a straight line');
  assert.ok(walked < straight * 2.5, `route is a scenic ${walked.toFixed(0)}m for a ${straight.toFixed(0)}m hop`);
});

test('nav: polyline matches the node positions', () => {
  const path = route(g, g.order[3]!, g.order[40]!);
  const line = polyline(g, path);
  assert.equal(line.length, path.length);
  line.forEach((p, i) => assert.deepEqual(p, nodePosition(g, path[i]!)));
});

test('nav: unknown nodes are refused, not guessed at', () => {
  assert.throws(() => route(g, asId('n_nowhere'), g.order[0]!), NavError);
  assert.throws(() => route(g, g.order[0]!, asId('n_nowhere')), NavError);
});

test('nav: a broken map is rejected at load, not discovered at runtime', () => {
  const orphan = {
    ...map,
    nodes: [...map.nodes, { id: asId<NodeId>('n_island'), position: { x: 5, y: 5 }, kind: 'street' as const }],
  } as TownMap;
  const built = buildNavGraph(orphan);
  assert.equal(isFullyConnected(built).connected, false, 'an unconnected node should be caught');

  assert.throws(
    () => buildNavGraph({ ...map, edges: [...map.edges, { a: asId('n_ghost'), b: map.nodes[0]!.id, speedFactor: 1 }] } as TownMap),
    NavError,
  );
  assert.throws(() => parseTownMap({ name: 'x' }), NavError);
});
