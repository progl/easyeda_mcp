import { apiError } from "../helpers.js";
const EPS = 1e-6;
type Point = { x: number; y: number };
type Segment = [Point, Point];
export type NamedStubSelection = { pinNumber: string; wireId: string };
const point = (x: number, y: number): Point => ({ x, y });
const near = (a: number, b: number) => Math.abs(a - b) <= EPS;
const samePoint = (a: Point, b: Point) => near(a.x, b.x) && near(a.y, b.y);
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function on(p: Point, [a, b]: Segment) {
  return (
    Math.abs(cross(a, b, p)) <= EPS * Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)) &&
    p.x >= Math.min(a.x, b.x) - EPS &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    p.y >= Math.min(a.y, b.y) - EPS &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}
function intersects([a, b]: Segment, [c, d]: Segment) {
  if (on(a, [c, d]) || on(b, [c, d]) || on(c, [a, b]) || on(d, [a, b])) return true;
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}
function segments(line: any): Segment[] {
  if (!Array.isArray(line) || !line.length) throw apiError("unsafe_named_stub", "Native wire line array required.");
  if (line.every(Array.isArray)) return line.flatMap(segments);
  if (line.length < 4 || line.length % 2 || !line.every(Number.isFinite))
    throw apiError("unsafe_named_stub", "Native wire coordinates incomplete.");
  const result: Segment[] = [];
  for (let i = 0; i + 3 < line.length; i += 2)
    result.push([point(line[i], line[i + 1]), point(line[i + 2], line[i + 3])]);
  return result;
}
export function parseReviewedPinContract(value: any) {
  const valid = (v: any) => typeof v === "string" && !!v && v === v.trim() && v.length <= 128;
  if (
    !value ||
    Object.keys(value).some((k) => !["mapping", "extraNCpins"].includes(k)) ||
    !Array.isArray(value.mapping) ||
    value.mapping.length !== 2 ||
    value.mapping.some(
      (p: any) =>
        !p ||
        Object.keys(p).some((k) => !["oldPinNumber", "newPinNumber"].includes(k)) ||
        !valid(p.oldPinNumber) ||
        !valid(p.newPinNumber)
    ) ||
    new Set(value.mapping.map((p: any) => p.oldPinNumber)).size !== 2 ||
    new Set(value.mapping.map((p: any) => p.newPinNumber)).size !== 2 ||
    !Array.isArray(value.extraNCpins) ||
    value.extraNCpins.length !== 1 ||
    value.extraNCpins.some(
      (p: any) =>
        !p ||
        Object.keys(p).some((k) => !["pinNumber", "reviewedRole", "evidence"].includes(k)) ||
        !valid(p.pinNumber) ||
        p.reviewedRole !== "mechanical" ||
        typeof p.evidence !== "string" ||
        !p.evidence.trim() ||
        p.evidence.length > 2000
    ) ||
    value.mapping.some((p: any) => p.newPinNumber === value.extraNCpins[0].pinNumber)
  )
    throw apiError(
      "invalid_pin_contract",
      "Explicit unique2-pin full mapping and exactly one reviewed mechanical extraNC pin/evidence required."
    );
  return {
    mapping: value.mapping.map((p: any) => ({ oldPinNumber: p.oldPinNumber, newPinNumber: p.newPinNumber })),
    extraNCpins: value.extraNCpins.map((p: any) => ({
      pinNumber: p.pinNumber,
      reviewedRole: "mechanical",
      evidence: p.evidence
    }))
  };
}
function direction(pin: any) {
  const r = ((pin.Rotation % 360) + 360) % 360;
  if (near(r, 0)) return 1;
  if (near(r, 180)) return -1;
  throw apiError(
    "unsupported_stub_geometry",
    `Pin ${pin.pinNumber}: only documented-by-readback horizontal native rotations0/180 are supported; no vertical orientation guess.`
  );
}
export function buildNamedStubPlan(
  snapshot: any,
  oldId: string,
  newId: string,
  selections: NamedStubSelection[],
  reviewedPinContract?: any
) {
  const old = snapshot.components.find((c: any) => c.PrimitiveId === oldId && c.ComponentType === "part"),
    fresh = snapshot.components.find((c: any) => c.PrimitiveId === newId && c.ComponentType === "part");
  if (
    !old ||
    !fresh ||
    oldId === newId ||
    old.Rotation !== fresh.Rotation ||
    old.Mirror !== fresh.Mirror ||
    ![old.X, old.Y, fresh.X, fresh.Y].every(Number.isFinite)
  )
    throw apiError(
      "unsafe_named_stub",
      "Two distinct native parts with equal rotation/mirror and finite poses required."
    );
  const a = snapshot.pins
    .filter((p: any) => p.componentId === oldId)
    .sort((x: any, y: any) => x.pinNumber.localeCompare(y.pinNumber));
  const b = snapshot.pins.filter((p: any) => p.componentId === newId);
  const contract = reviewedPinContract === undefined ? undefined : parseReviewedPinContract(reviewedPinContract);
  const mappedNumber = (number: string) =>
    contract ? contract.mapping.find((p: any) => p.oldPinNumber === number)?.newPinNumber : number;
  if (
    contract &&
    (a.length !== 2 ||
      b.length !== 3 ||
      !contract.mapping.every(
        (p: any) =>
          a.some((q: any) => q.pinNumber === p.oldPinNumber) && b.some((q: any) => q.pinNumber === p.newPinNumber)
      ) ||
      !contract.extraNCpins.every((p: any) => b.some((q: any) => q.pinNumber === p.pinNumber && q.net === "")))
  )
    throw apiError(
      "invalid_pin_contract",
      "Reviewed contract must cover exactly all2 original and all3 staged native pins, with exact extra native NC."
    );
  if (
    !a.length ||
    a.length > 100 ||
    (!contract && a.length !== b.length) ||
    new Set(a.map((p: any) => p.pinNumber)).size !== a.length ||
    new Set(b.map((p: any) => p.pinNumber)).size !== b.length ||
    !a.every((p: any) => b.some((q: any) => q.pinNumber === mappedNumber(p.pinNumber)))
  )
    throw apiError("unsafe_named_stub", "Complete identical unique pin-number sets required.");
  if (
    !Array.isArray(selections) ||
    selections.some(
      (s) => !s || typeof s.pinNumber !== "string" || !s.pinNumber || typeof s.wireId !== "string" || !s.wireId
    ) ||
    selections.length !== a.length ||
    new Set(selections.map((s) => s.pinNumber)).size !== a.length ||
    new Set(selections.map((s) => s.wireId)).size !== a.length ||
    !a.every((p: any) => selections.some((s) => s.pinNumber === p.pinNumber))
  )
    throw apiError("unsafe_named_stub", "Explicit one distinct wireId per original pin number required.");
  const allWires = snapshot.wires.map((w: any) => ({ raw: w, segments: segments(w.Line) }));
  const projected = b.map((p: any) => ({ ...p, X: old.X + p.X - fresh.X, Y: old.Y + p.Y - fresh.Y }));
  const stubs = a.map((p: any) => {
    const q = b.find((q: any) => q.pinNumber === mappedNumber(p.pinNumber)),
      selection = selections.find((s) => s.pinNumber === p.pinNumber)!;
    const hits = allWires.filter((w: any) => w.raw.PrimitiveId === selection.wireId);
    if (
      hits.length !== 1 ||
      hits[0].segments.length !== 1 ||
      typeof p.net !== "string" ||
      !p.net ||
      hits[0].raw.Net !== p.net ||
      q.net !== ""
    )
      throw apiError(
        "unsafe_named_stub",
        `Pin ${p.pinNumber}: selected single native wire must have the exact explicit named net; staged pin must be NC.`
      );
    const wire = hits[0].raw,
      segment: Segment = hits[0].segments[0],
      origin = point(p.X, p.Y);
    if (
      ![p.X, p.Y, q.X, q.Y].every(Number.isFinite) ||
      !near(segment[0].y, segment[1].y) ||
      samePoint(segment[0], segment[1]) ||
      (!samePoint(origin, segment[0]) && !samePoint(origin, segment[1]))
    )
      throw apiError(
        "unsafe_named_stub",
        `Pin ${p.pinNumber}: exact endpoint of one nonzero horizontal stub required.`
      );
    const far = samePoint(origin, segment[0]) ? segment[1] : segment[0],
      length = Math.abs(far.x - origin.x);
    if (Math.sign(far.x - origin.x) !== direction(p))
      throw apiError(
        "unsafe_named_stub",
        `Pin ${p.pinNumber}: old stub must extend outwards from its native pin rotation.`
      );
    for (const other of allWires)
      if (other.raw.PrimitiveId !== wire.PrimitiveId && other.segments.some((s: Segment) => intersects(segment, s)))
        throw apiError(
          "unsafe_named_stub",
          `Pin ${p.pinNumber}: selected wire ${wire.PrimitiveId} touches/crosses another wire ${other.raw.PrimitiveId}; no shared/branched stubs.`
        );
    if (snapshot.pins.some((r: any) => r.PrimitiveId !== p.PrimitiveId && on(point(r.X, r.Y), segment)))
      throw apiError("unsafe_named_stub", `Pin ${p.pinNumber}: selected stub touches another native pin.`);
    if (
      snapshot.components.some(
        (c: any) =>
          ![oldId, newId].includes(c.PrimitiveId) &&
          Number.isFinite(c.X) &&
          Number.isFinite(c.Y) &&
          on(point(c.X, c.Y), segment)
      )
    )
      throw apiError(
        "unsafe_named_stub",
        `Pin ${p.pinNumber}: selected stub touches another component/netflag anchor.`
      );
    const at = projected.find((r: any) => r.pinNumber === q.pinNumber),
      end = point(at.X + direction(q) * length, at.Y);
    return {
      pinNumber: q.pinNumber,
      ...(contract ? { oldPinNumber: p.pinNumber } : {}),
      net: p.net,
      oldWireId: wire.PrimitiveId,
      oldLine: wire.Line,
      oldPinId: p.PrimitiveId,
      stagedPinId: q.PrimitiveId,
      newPinRotation: q.Rotation,
      newLine: [at.X, at.Y, end.x, end.y],
      color: wire.Color,
      lineWidth: wire.LineWidth,
      lineType: wire.LineType
    };
  });
  const removed = new Set(stubs.map((s: any) => s.oldWireId));
  for (const stub of stubs) {
    const line: Segment = [point(stub.newLine[0], stub.newLine[1]), point(stub.newLine[2], stub.newLine[3])];
    for (const w of allWires)
      if (!removed.has(w.raw.PrimitiveId) && w.segments.some((s: Segment) => intersects(line, s)))
        throw apiError(
          "unsafe_named_stub",
          `New pin ${stub.pinNumber} stub intersects kept wire ${w.raw.PrimitiveId}.`
        );
    if (
      snapshot.pins.some((p: any) => ![oldId, newId].includes(p.componentId) && on(point(p.X, p.Y), line)) ||
      projected.some((p: any) => p.pinNumber !== stub.pinNumber && on(point(p.X, p.Y), line))
    )
      throw apiError("unsafe_named_stub", `New pin ${stub.pinNumber} stub touches another kept/projected pin.`);
    if (
      snapshot.components.some(
        (c: any) =>
          ![oldId, newId].includes(c.PrimitiveId) &&
          Number.isFinite(c.X) &&
          Number.isFinite(c.Y) &&
          on(point(c.X, c.Y), line)
      )
    )
      throw apiError("unsafe_named_stub", `New pin ${stub.pinNumber} stub touches a kept component/netflag anchor.`);
    for (const other of stubs)
      if (
        other !== stub &&
        intersects(line, [point(other.newLine[0], other.newLine[1]), point(other.newLine[2], other.newLine[3])])
      )
        throw apiError("unsafe_named_stub", `New pin ${stub.pinNumber} stub touches another proposed stub.`);
  }
  const extraNCpins = contract?.extraNCpins.map((extra: any) => {
    const p = projected.find((p: any) => p.pinNumber === extra.pinNumber);
    if (
      !p ||
      ![p.X, p.Y, p.Rotation].every(Number.isFinite) ||
      allWires.some(
        (w: any) => !removed.has(w.raw.PrimitiveId) && w.segments.some((line: Segment) => on(point(p.X, p.Y), line))
      ) ||
      snapshot.pins.some(
        (q: any) => ![oldId, newId].includes(q.componentId) && samePoint(point(p.X, p.Y), point(q.X, q.Y))
      ) ||
      projected.some((q: any) => q.pinNumber !== p.pinNumber && samePoint(point(p.X, p.Y), point(q.X, q.Y))) ||
      snapshot.components.some(
        (c: any) => ![oldId, newId].includes(c.PrimitiveId) && samePoint(point(p.X, p.Y), point(c.X, c.Y))
      )
    )
      throw apiError("unsafe_named_stub", "Projected extraNC pin touches kept native geometry; no original delete.");
    return { ...extra, net: "", X: p.X, Y: p.Y, Rotation: p.Rotation };
  });
  return {
    ...(contract ? { reviewedPinContract: contract, extraNCpins } : {}),
    wireStrategy: "recreateNamedStubs" as const,
    oldWireIds: stubs.map((s: any) => s.oldWireId),
    stubs,
    allNativePinNetsMustRemain: true
  };
}
