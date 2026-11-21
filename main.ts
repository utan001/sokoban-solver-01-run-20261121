// A Sokoban solver for make.fun's sokoban-solver-01: a push-based A* with dead-square pruning and an
// assignment heuristic, run room by room when the level decomposes at its doors (single cells whose
// removal disconnects the floor — the generated levels hang one to four rooms off a hallway through
// one door each, boxes never leave their room, and a level's push optimum is the sum of its rooms'),
// and over the whole board when it does not. The search budgets are expansion counts, never the clock,
// so two executions write the same bytes.
//
// Answers are solution.txt per instance: the player's moves in LURD (lowercase walks, uppercase
// pushes), replayed by the checker.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DIRS = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
] as const;

/** A parsed level: walls, goals, boxes and the player, cells indexed y * w + x. */
interface Level {
  w: number;
  h: number;
  size: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goal = new Uint8Array(size);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, size, wall, goal, boxes, player };
}

/** Replays moves on the level (the checker's rules). Returns the end state, or null on an illegal step. */
function replay(lv: Level, moves: string): { boxes: number[]; player: number; pushes: number } | null {
  const box = new Uint8Array(lv.size);
  for (const b of lv.boxes) box[b] = 1;
  let player = lv.player;
  let pushes = 0;
  for (const ch of moves) {
    const low = ch.toLowerCase();
    const dir = DIRS.find((d) => d[2] === low);
    if (!dir) return null;
    const d = dir[1] * lv.w + dir[0];
    const next = player + d;
    if (next < 0 || next >= lv.size || lv.wall[next]) return null;
    if (box[next]) {
      const beyond = next + d;
      if (beyond < 0 || beyond >= lv.size || lv.wall[beyond] || box[beyond]) return null;
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  const boxes: number[] = [];
  for (let i = 0; i < lv.size; i++) if (box[i]) boxes.push(i);
  return { boxes, player, pushes };
}

function solved(lv: Level, boxes: number[]): boolean {
  return boxes.every((b) => lv.goal[b] === 1);
}

/** BFS over cells the player can walk to (walls and boxes block). Returns parent dirs per cell (-2 unreached). */
function walkReach(lv: Level, start: number, boxSet: Set<number>, allowed: Uint8Array): Int16Array {
  const parent = new Int16Array(lv.size).fill(-2);
  parent[start] = -1;
  const queue = [start];
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q]!;
    for (let di = 0; di < 4; di++) {
      const d = DIRS[di]!;
      const nx = (c % lv.w) + d[0];
      const ny = Math.floor(c / lv.w) + d[1];
      if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) continue;
      const nc = ny * lv.w + nx;
      if (parent[nc] !== -2 || lv.wall[nc] || !allowed[nc] || boxSet.has(nc)) continue;
      parent[nc] = di;
      queue.push(nc);
    }
  }
  return parent;
}

/** The walk string from the BFS tree to a target cell. */
function walkPath(lv: Level, parent: Int16Array, target: number): string {
  let s = '';
  for (let c = target; parent[c]! >= 0; c = c - (DIRS[parent[c]!]![1] * lv.w + DIRS[parent[c]!]![0])) {
    s = DIRS[parent[c]!]![2] + s;
  }
  return s;
}

interface PushProblem {
  pAllowed: Uint8Array; // cells the player may occupy (walk to, stand on)
  bAllowed: Uint8Array; // cells a box may occupy
  goals: number[];
  doors: Set<number> | null; // cells the player must still be able to reach at the end (null: no need)
  cap: number; // expansion budget (work, not time)
}

/**
 * Push-optimal A* for one (sub-)problem. Returns the move string (walks + pushes), or null when it
 * gives up. The heuristic is the min-cost assignment of boxes to goals over single-box push distances
 * (permutations for few boxes, the sum of minima otherwise), which never overestimates.
 */
function solvePush(lv: Level, prob: PushProblem, startBoxes: number[], startPlayer: number): string | null {
  const { pAllowed: allowed, bAllowed, goals } = prob;
  const goalSet = new Set(goals);
  const size = lv.size;
  const w = lv.w;

  // Single-box push distances to each goal (reverse BFS over box positions; a push into b from a needs
  // the stand cell behind a free). dist[g][cell] = pushes, -1 unreachable.
  const dist: Int32Array[] = goals.map((g) => {
    const dg = new Int32Array(size).fill(-1);
    dg[g] = 0;
    const queue = [g];
    for (let q = 0; q < queue.length; q++) {
      const x = queue[q]!;
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di]!;
        const dx = d[0];
        const dy = d[1];
        const bx = (x % w) - dx;
        const by = Math.floor(x / w) - dy;
        const sx = bx - dx;
        const sy = by - dy;
        if (bx < 0 || by < 0 || bx >= w || by >= lv.h || sx < 0 || sy < 0 || sx >= w || sy >= lv.h) continue;
        const b = by * w + bx;
        const stand = sy * w + sx;
        if (dg[b] !== -1 || lv.wall[b] || !bAllowed[b] || lv.wall[stand] || !allowed[stand]) continue;
        dg[b] = dg[x]! + 1;
        queue.push(b);
      }
    }
    return dg;
  });
  const live = new Uint8Array(size);
  for (const dg of dist) for (let i = 0; i < size; i++) if (dg[i]! >= 0) live[i] = 1;
  for (const b of startBoxes) if (!live[b]) return null; // a box starts on a dead square

  const nBoxes = startBoxes.length;
  const heuristic = (boxes: number[]): number => {
    if (nBoxes <= 6) {
      // exact assignment by permutation
      let best = Infinity;
      const used = new Array<boolean>(goals.length).fill(false);
      const go = (bi: number, acc: number): void => {
        if (acc >= best) return;
        if (bi === nBoxes) {
          best = acc;
          return;
        }
        for (let gi = 0; gi < goals.length; gi++) {
          if (used[gi]) continue;
          const dd = dist[gi]![boxes[bi]!]!;
          if (dd < 0) continue;
          used[gi] = true;
          go(bi + 1, acc + dd);
          used[gi] = false;
        }
      };
      go(0, 0);
      return best;
    }
    let sum = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (let gi = 0; gi < goals.length; gi++) {
        const dd = dist[gi]![b]!;
        if (dd >= 0 && dd < m) m = dd;
      }
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  };

  // A 2x2 of walls and boxes with a box off its goal can never be undone.
  const deadBlock = (boxSet: Set<number>, cell: number): boolean => {
    const cx = cell % w;
    const cy = Math.floor(cell / w);
    for (const [ox, oy] of [
      [-1, -1],
      [-1, 0],
      [0, -1],
      [0, 0],
    ] as const) {
      const x0 = cx + ox;
      const y0 = cy + oy;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= lv.h) continue;
      const cells = [y0 * w + x0, y0 * w + x0 + 1, (y0 + 1) * w + x0, (y0 + 1) * w + x0 + 1];
      let allSolid = true;
      let offGoal = false;
      for (const c of cells) {
        if (lv.wall[c]) continue;
        if (boxSet.has(c)) {
          if (!goalSet.has(c)) offGoal = true;
          continue;
        }
        allSolid = false;
        break;
      }
      if (allSolid && offGoal) return true;
    }
    return false;
  };

  interface Node {
    boxes: number[];
    player: number; // the cell the player actually stands on
    parent: number;
    seg: string; // walk + push letters from the parent node to this one
    g: number;
  }
  const nodes: Node[] = [];
  const visited = new Map<string, number>();
  const heap: { f: number; g: number; seq: number; id: number }[] = [];
  let seq = 0;
  const heapPush = (f: number, g: number, id: number): void => {
    heap.push({ f, g, seq: seq++, id });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const a = heap[i]!;
      const b = heap[p]!;
      if (a.f < b.f || (a.f === b.f && (a.g > b.g || (a.g === b.g && a.seq < b.seq)))) {
        heap[i] = b;
        heap[p] = a;
        i = p;
      } else break;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length) {
          const a = heap[c + 1]!;
          const b = heap[c]!;
          if (a.f < b.f || (a.f === b.f && (a.g > b.g || (a.g === b.g && a.seq < b.seq)))) c++;
        }
        const a = heap[c]!;
        const b = heap[i]!;
        if (a.f < b.f || (a.f === b.f && (a.g > b.g || (a.g === b.g && a.seq < b.seq)))) {
          heap[i] = a;
          heap[c] = b;
          i = c;
        } else break;
      }
    }
    return top.id;
  };
  const keyOf = (boxes: number[], canon: number): string => String.fromCharCode(...boxes, canon);
  const canonOf = (boxes: number[], player: number): number => {
    const parent = walkReach(lv, player, new Set(boxes), allowed);
    let m = player;
    for (let i = 0; i < size; i++) if (parent[i] !== -2 && i < m) m = i;
    return m;
  };
  const exitOk = (boxes: number[], player: number): boolean => {
    if (prob.doors === null) return true;
    const parent = walkReach(lv, player, new Set(boxes), allowed);
    for (const dcell of prob.doors) if (parent[dcell] !== -2) return true;
    return false;
  };

  const h0 = heuristic(startBoxes);
  if (h0 === Infinity) return null;
  nodes.push({ boxes: startBoxes, player: startPlayer, parent: -1, seg: '', g: 0 });
  visited.set(keyOf(startBoxes, canonOf(startBoxes, startPlayer)), 0);
  heapPush(h0, 0, 0);

  let expanded = 0;
  while (heap.length > 0 && expanded < prob.cap) {
    const id = heapPop();
    const node = nodes[id]!;
    if (node.boxes.every((b) => goalSet.has(b)) && exitOk(node.boxes, node.player)) {
      let moves = '';
      for (let t = id; t > 0; t = nodes[t]!.parent) moves = nodes[t]!.seg + moves;
      return moves;
    }
    expanded++;
    const boxSet = new Set(node.boxes);
    const reach = walkReach(lv, node.player, boxSet, allowed);
    for (let bi = 0; bi < node.boxes.length; bi++) {
      const b = node.boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di]!;
        const dv = d[1] * w + d[0];
        const stand = b - dv;
        const dest = b + dv;
        if (stand < 0 || stand >= size || reach[stand] === -2) continue;
        if (dest < 0 || dest >= size || lv.wall[dest] || !bAllowed[dest] || boxSet.has(dest)) continue;
        if (!live[dest]) continue; // dead square (goals are live)
        const nb = node.boxes.slice();
        nb[bi] = dest;
        nb.sort((a, b2) => a - b2);
        const nSet = new Set(nb);
        if (deadBlock(nSet, dest)) continue;
        const h = heuristic(nb);
        if (h === Infinity) continue;
        const g = node.g + 1;
        const key = keyOf(nb, canonOf(nb, b));
        const seen = visited.get(key);
        if (seen !== undefined && seen <= g) continue;
        visited.set(key, g);
        const seg = walkPath(lv, reach, stand) + d[2].toUpperCase();
        nodes.push({ boxes: nb, player: b, parent: id, seg, g });
        heapPush(g + h, g, nodes.length - 1);
      }
    }
  }
  return null;
}

/** Cells from which a box can be pushed to some goal (single box, ignoring the others), by reverse BFS. */
function liveSquares(lv: Level): Uint8Array {
  const live = new Uint8Array(lv.size);
  const queue: number[] = [];
  for (let i = 0; i < lv.size; i++) if (lv.goal[i]) { live[i] = 1; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const x = queue[q]!;
    const xx = x % lv.w;
    const xy = Math.floor(x / lv.w);
    for (const d of DIRS) {
      const bx = xx - d[0];
      const by = xy - d[1];
      const sx = bx - d[0];
      const sy = by - d[1];
      if (bx < 0 || by < 0 || bx >= lv.w || by >= lv.h || sx < 0 || sy < 0 || sx >= lv.w || sy >= lv.h) continue;
      const b = by * lv.w + bx;
      const stand = sy * lv.w + sx;
      if (live[b] || lv.wall[b] || lv.wall[stand]) continue;
      live[b] = 1;
      queue.push(b);
    }
  }
  return live;
}

interface Room {
  boxes: number[];
  goals: number[];
}

/**
 * The level's rooms, the generator's own partition: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor; each part left that holds a box is a room.
 * Null when the level is no set of rooms (a box in the hallway, a part whose boxes and goals differ
 * in number, a goal on a cut square).
 */
function roomsOf(lv: Level): Room[] | null {
  const live = liveSquares(lv);
  const row = Math.floor(lv.player / lv.w);
  const cut = new Uint8Array(lv.size);
  for (let i = row * lv.w; i < (row + 1) * lv.w; i++) if (!lv.wall[i] && !live[i]) cut[i] = 1;
  if (lv.boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(lv.size).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < lv.size; s++) {
    if (lv.wall[s] || cut[s] || part[s] >= 0) continue;
    const id = rooms.length;
    const squares = [s];
    part[s] = id;
    for (let i = 0; i < squares.length; i++) {
      const c = squares[i]!;
      const cx = c % lv.w;
      const cy = Math.floor(c / lv.w);
      for (const d of DIRS) {
        const nx = cx + d[0];
        const ny = cy + d[1];
        if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) continue;
        const nc = ny * lv.w + nx;
        if (lv.wall[nc] || cut[nc] || part[nc] >= 0) continue;
        part[nc] = id;
        squares.push(nc);
      }
    }
    rooms.push({ boxes: [], goals: [] });
  }
  for (const b of lv.boxes) rooms[part[b]!]!.boxes.push(b);
  for (let i = 0; i < lv.size; i++) {
    if (!lv.goal[i]) continue;
    if (part[i] < 0) return null; // a goal on a cut square
    rooms[part[i]!]!.goals.push(i);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solves room by room: for each room, a push search over the whole board with the other rooms'
 * boxes standing as walls (at their goals once their room is done), the player walking on from
 * where the last room left it. A room's optimum under this search is its share of the level's.
 */
function solveByRooms(lv: Level): string | null {
  const rooms = roomsOf(lv);
  if (rooms === null || rooms.length === 0) return null;
  const all = new Uint8Array(lv.size).fill(1);
  let boxes = lv.boxes.slice();
  let player = lv.player;
  let moves = '';
  for (const room of rooms) {
    const wall = new Uint8Array(lv.wall);
    for (const b of boxes) if (!room.boxes.includes(b)) wall[b] = 1;
    const sub: Level = { ...lv, wall };
    const seg = solvePush(sub, { pAllowed: all, bAllowed: all, goals: room.goals, doors: null, cap: 2_000_000 }, room.boxes.slice().sort((a, b) => a - b), player);
    if (seg === null) return null;
    moves += seg;
    const after = replay(lv, moves);
    if (after === null) return null;
    boxes = after.boxes;
    player = after.player;
    if (!room.goals.every((g) => after.boxes.includes(g))) return null;
  }
  return solved(lv, boxes) ? moves : null;
}

/** Whole-board push A* fallback. */
function solveWhole(lv: Level): string | null {
  const allowed = new Uint8Array(lv.size).fill(1);
  const goals: number[] = [];
  for (let i = 0; i < lv.size; i++) if (lv.goal[i]) goals.push(i);
  return solvePush(lv, { pAllowed: allowed, bAllowed: allowed, goals, doors: null, cap: 600_000 }, lv.boxes.slice(), lv.player);
}

function solve(text: string): string {
  const lv = parseLevel(text);
  if (solved(lv, lv.boxes)) return '';
  const decomposed = solveByRooms(lv);
  if (decomposed !== null) {
    const end = replay(lv, decomposed);
    if (end !== null && solved(lv, end.boxes)) return decomposed;
  }
  const whole = solveWhole(lv);
  if (whole !== null) {
    const end = replay(lv, whole);
    if (end !== null && solved(lv, end.boxes)) return whole;
  }
  return '';
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
