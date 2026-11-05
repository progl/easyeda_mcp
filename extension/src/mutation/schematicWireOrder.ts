import { apiError } from "../helpers.js";

export type WireOrderItem = { primitiveId: string; line: unknown };
type Segment = { x1: number; y1: number; x2: number; y2: number };
function lineSegments(line: unknown, id: string): Segment[] {
  if (!Array.isArray(line) || !line.length) throw apiError("invalid_wire_order_input", `Invalid wire line: ${id}.`);
  const paths = Array.isArray(line[0]) ? line : [line];
  const segments: Segment[] = [];
  for (const path of paths) {
    if (
      !Array.isArray(path) ||
      path.length < 4 ||
      path.length % 2 ||
      !path.every((value) => typeof value === "number" && Number.isFinite(value))
    )
      throw apiError(
        "invalid_wire_order_input",
        `Wire ${id} requires finite even-coordinate paths with at least two points.`
      );
    for (let i = 0; i < path.length - 2; i += 2) {
      const [x1, y1, x2, y2] = path.slice(i, i + 4) as number[];
      if (x1 === x2 && y1 === y2) throw apiError("invalid_wire_order_input", `Zero-length wire segment: ${id}.`);
      if (x1 !== x2 && y1 !== y2)
        throw apiError("invalid_wire_order_input", `Only orthogonal wire geometry is supported: ${id}.`);
      segments.push({ x1, y1, x2, y2 });
    }
  }
  return segments;
}
function inventory(wires: readonly WireOrderItem[], label: string): Map<string, Segment[]> {
  if (!Array.isArray(wires)) throw apiError("invalid_wire_order_input", `${label} wire inventory must be an array.`);
  const result = new Map<string, Segment[]>();
  for (const wire of wires) {
    if (!wire || typeof wire.primitiveId !== "string" || !wire.primitiveId.trim())
      throw apiError("invalid_wire_order_input", `${label} wire ID must be a nonempty string.`);
    if (result.has(wire.primitiveId))
      throw apiError("invalid_wire_order_input", `Duplicate ${label} wire ID: ${wire.primitiveId}.`);
    result.set(wire.primitiveId, lineSegments(wire.line, wire.primitiveId));
  }
  return result;
}
function intersects(a: Segment, b: Segment): boolean {
  // Both paths are orthogonal. Inclusive bounding-box intersection also catches shared endpoints
  // and collinear overlap. No net-name exception is guessed by this geometry-only helper.
  return (
    Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2)) <= Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2)) &&
    Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2)) <= Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2))
  );
}
/**
 * Pure ordering guard, not a replacement for final geometry/connectivity validation.
 * If A's desired geometry touches B's old geometry, B must be written first.
 * The caller must independently confirm each write before dispatching the next ID.
 * Existing shared endpoints are treated conservatively because input carries no net identity.
 */
export function buildSafeWireOrder(
  baselineWires: readonly WireOrderItem[],
  desiredWires: readonly WireOrderItem[]
): string[] {
  const baseline = inventory(baselineWires, "baseline"),
    desired = inventory(desiredWires, "desired");
  for (const id of desired.keys())
    if (!baseline.has(id))
      throw apiError("invalid_wire_order_input", `Desired wire ID is missing from baseline: ${id}.`);
  const ids = [...desired.keys()].sort();
  const before = new Map(ids.map((id) => [id, new Set<string>()]));
  const after = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const id of ids) {
    for (const [other, oldSegments] of baseline) {
      if (other === id || !desired.get(id)!.some((a) => oldSegments.some((b) => intersects(a, b)))) continue;
      if (!desired.has(other))
        throw apiError(
          "wire_order_stationary_collision",
          `Desired wire ${id} touches stationary/unselected baseline wire ${other}; no writes are safe.`,
          { wireId: id, blockingWireId: other }
        );
      before.get(id)!.add(other);
      after.get(other)!.add(id);
    }
  }
  const ready = ids.filter((id) => !before.get(id)!.size),
    order: string[] = [];
  while (ready.length) {
    ready.sort();
    const id = ready.shift()!;
    order.push(id);
    for (const next of after.get(id)!) {
      before.get(next)!.delete(id);
      if (!before.get(next)!.size) ready.push(next);
    }
  }
  if (order.length !== ids.length) {
    const cycleCandidates = ids.filter((id) => before.get(id)!.size);
    throw apiError(
      "wire_order_cycle",
      `Cyclic wire geometry dependencies prevent a safe in-place write order: ${cycleCandidates.slice(0, 12).join(", ")}.`,
      { blockedWireIds: cycleCandidates.slice(0, 12), blockedCount: cycleCandidates.length }
    );
  }
  return order;
}
