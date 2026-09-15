import type { Blob } from "./types";

export function connectedComponents(mask: Uint8Array, w: number, h: number): Blob[] {
  const labels = new Int32Array(mask.length).fill(0);
  const parent: number[] = [0];

  const find = (x: number): number => {
    let r = x;
    while ((parent[r] as number) !== r) r = parent[r] as number;
    let c = x;
    while ((parent[c] as number) !== c) {
      const next = parent[c] as number;
      parent[c] = r;
      c = next;
    }
    return r;
  };

  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  let next = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] === 0) continue;
      const neighbors: number[] = [];
      for (const [dx, dy] of [
        [-1, 0],
        [-1, -1],
        [0, -1],
        [1, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const l = labels[ny * w + nx] as number;
        if (l > 0) neighbors.push(l);
      }
      if (neighbors.length === 0) {
        labels[i] = next;
        parent[next] = next;
        next++;
      } else {
        const m = Math.min(...neighbors);
        labels[i] = m;
        for (const n of neighbors) union(m, n);
      }
    }
  }

  const acc = new Map<number, Blob>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x] as number;
      if (l === 0) continue;
      const root = find(l);
      let b = acc.get(root);
      if (!b) {
        b = { area: 0, cx: 0, cy: 0, minX: x, minY: y, maxX: x, maxY: y };
        acc.set(root, b);
      }
      b.area++;
      b.cx += x;
      b.cy += y;
      if (x < b.minX) b.minX = x;
      if (y < b.minY) b.minY = y;
      if (x > b.maxX) b.maxX = x;
      if (y > b.maxY) b.maxY = y;
    }
  }

  const blobs: Blob[] = [];
  for (const b of acc.values()) {
    b.cx /= b.area;
    b.cy /= b.area;
    blobs.push(b);
  }
  return blobs;
}

export function filterByArea(blobs: Blob[], minArea: number, maxArea: number): Blob[] {
  return blobs.filter((b) => b.area >= minArea && b.area <= maxArea);
}

export function medianArea(blobs: Blob[]): number {
  if (blobs.length === 0) return 0;
  const areas = blobs.map((b) => b.area).sort((a, b) => a - b);
  const mid = Math.floor(areas.length / 2);
  return areas.length % 2 === 0
    ? ((areas[mid - 1] as number) + (areas[mid] as number)) / 2
    : (areas[mid] as number);
}
