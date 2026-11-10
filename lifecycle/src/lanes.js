// The lifecycle service as a PE Source (ROADMAP phase 6).
//
// A frame's lanes are the reserved input cells 2–7 of the clone running its
// step (owner, 2026-11-09). The template is the existing domain machine; its
// clone carries the machine's input region in its block's input quarter, and
// the cells the machine declares reserved there are free for the frame. The
// lifecycle service allocates them when the clone is made, declares a sensor
// source over them on that engine instance's PE, writes the frame's
// observations into them, and frees them when the clone is recycled: the
// allocation lives exactly as long as the clone.
//
// The PE source is the block's, not the clone's: one per engine instance and
// block (lifecycle-<engine>-block-<k>), declared on first use and kept. A PE
// keeps the last values a source wrote when the source is removed (all three
// voting PEs, measured 2026-11-09), so a removed source would leave the
// previous frame's lanes in the next clone's reserved cells. Freeing lanes
// therefore writes zeros and leaves the block's source holding them.
//
// Each lane is one observation of the frame (1 while it holds, else 0):
export const LANES = Object.freeze([
  { cell: 2, observation: 'entered', meaning: 'the asset is in its workflow (the frame is open)' },
  { cell: 3, observation: 'pinned', meaning: 'a frame document has been re-pinned since the frame was built' },
  { cell: 4, observation: 'approved', meaning: 'an approve decision on the exact pinned revision' },
  { cell: 5, observation: 'rework', meaning: 'a rework decision, until the next step resumes' },
  { cell: 6, observation: 'resumed', meaning: 'the current continuation is resumed: a step is running' },
  { cell: 7, observation: 'stale', meaning: 'the workflow head is STALE' }
]);
const FIRST = LANES[0].cell;
const WIDTH = LANES.length;
const ZEROS = LANES.map(() => 0);
// RealityEngine_CI SURFACE_SPEC.md, "The clone space".
const BAND = { offset: 20480, length: 65536 };

export function laneValues(f, current) {
  const o = f.observed || {};
  const values = {
    entered: f.status === 'open',
    pinned: !!o.pinned,
    approved: !!o.approved,
    rework: !!o.rework,
    resumed: f.status === 'open' && current?.status === 'resumed',
    stale: f.headStatus === 'STALE'
  };
  return LANES.map((l) => (values[l.observation] ? 1 : 0));
}

export function mountLanes(ctx) {
  const { route, need, allow, d, commit, receipt, actor, now, link } = ctx;
  d().lanes ||= {};
  const live = () => Object.values(d().lanes).filter((a) => a.status === 'live');
  const frameOf = (fid) => { const f = d().frames[fid]; need(f, 404, 'frame not found'); return f; };
  const currentOf = (f) => f.continuations.find((x) => x.continuationId === f.current);

  // Writes values to a block's lane source, declaring it on its PE the first
  // time (or again, if the PE has lost it, e.g. after a restart).
  const declared = new Set();
  async function writeLanes(a, values) {
    const key = `${a.engineId}|${a.block}`;
    if (declared.has(key)) {
      try { return await link.push(a.engineId, a.sensorId, values); } catch { declared.delete(key); }
    }
    // The full sensor shape every voting PE accepts, declared inactive: a
    // value earns activity.
    // A PE may already hold it from before this process started: a refused
    // declaration still tries the push, which is what has to succeed.
    try {
      await link.declare(a.engineId, {
        id: a.sourceId, type: 'sensor', name: `lifecycle lanes ${a.engineId} block ${a.block}`, sensorId: a.sensorId, region: a.region,
        lastValue: [], lastUpdated: null, ttlMs: 24 * 3600 * 1000, origin: 'lifecycle', active: false
      });
    } catch { /* the push below decides */ }
    declared.add(key);
    return link.push(a.engineId, a.sensorId, values);
  }

  // Pushes a frame's lanes to every live allocation it holds. A failure is
  // recorded on the allocation and in the log; it never fails the change that
  // caused it, and never passes silently.
  async function refresh(frameId) {
    const f = d().frames[frameId];
    if (!f) return;
    const values = laneValues(f, currentOf(f));
    for (const a of live().filter((x) => x.frameId === frameId)) {
      a.values = values;
      a.pushedAt = now();
      if (!link.configured) continue;
      try { await writeLanes(a, values); delete a.error; }
      catch (e) {
        a.error = e.message;
        commit({ type: 'lanes.push-failed', assetId: frameId, frameId, cloneId: a.cloneId, error: e.message, by: 'lifecycle' });
      }
    }
  }

  async function release(a, by, why) {
    if (link.configured) {
      try { await writeLanes(a, ZEROS); delete a.error; }
      catch (e) { a.error = e.message; }
    }
    a.values = ZEROS;
    a.status = 'released';
    a.releasedAt = now();
    a.releasedBecause = why;
    const r = receipt('lanes-released', { frameId: a.frameId, cloneId: a.cloneId, engineId: a.engineId, region: a.region, why, by });
    commit({ type: 'lanes.released', assetId: a.frameId, frameId: a.frameId, cloneId: a.cloneId, why, by, receiptId: r.id, ...(a.error ? { error: a.error } : {}) });
    return r;
  }
  const releaseFrame = async (frameId, by, why) => {
    for (const a of live().filter((x) => x.frameId === frameId)) await release(a, by, why);
  };

  // The prologue reports the clone it made (the engine's clone 201, plus the
  // envelope): the frame's lanes are allocated in its reserved cells.
  route('POST', '/frames/:id/clones', async ({ params, body: given, principal }) => {
    allow(principal, 'engine');
    // The engine's clone 201 as it stands (SURFACE_SPEC.md, "POST
    // /api/engine/clone/machine/:machineId") names the instance
    // `engineInstance`; `engineId` is accepted as the continuation's name for it.
    const body = { ...given, engineId: given.engineId ?? given.engineInstance };
    const f = frameOf(params.id);
    need(f.status === 'open', 409, `frame is ${f.status}`);
    const c = currentOf(f);
    need(c.status === 'resumed', 409, `the current continuation ${c.continuationId} is ${c.status}: clone after resuming it`);
    need(body.engineId === c.next.engineId, 409, `the step runs on ${c.next.engineId}, not ${body.engineId}`);
    need(typeof body.envelopeId === 'string' && body.envelopeId, 400, 'envelopeId required');
    need(body.cloneId === `${c.next.templateId}.${body.engineId}.${body.envelopeId}`, 409, `the clone must be of ${c.next.templateId} on ${body.engineId} for envelope ${body.envelopeId}`);
    need(body.assetId === undefined || body.assetId === f.frameId, 409, 'the clone is bound to another assetID');
    need(Number.isInteger(body.generation), 400, 'generation required');
    const input = body.input || {};
    need(Number.isInteger(input.offset) && Number.isInteger(input.length), 400, 'input {offset, length} required');
    need(input.length >= FIRST + WIDTH, 409, `the clone's input region has no cells ${FIRST}–${FIRST + WIDTH - 1}`);
    const region = { offset: input.offset + FIRST, length: WIDTH };
    need(region.offset >= BAND.offset && region.offset + region.length <= BAND.offset + BAND.length, 400, 'the lanes must lie in the clone band');
    const block = (input.offset - BAND.offset) / 64;
    need(Number.isInteger(block), 400, 'the clone\'s input region must start its block');
    need(!live().some((x) => x.cloneId === body.cloneId), 409, 'this clone already holds lanes');
    const overlap = live().find((x) => x.engineId === body.engineId && x.region.offset < region.offset + region.length && region.offset < x.region.offset + x.region.length);
    need(!overlap, 409, `cells [${region.offset}:${region.offset + region.length - 1}] are held by ${overlap?.cloneId}`);
    // The template must declare these cells reserved: they are the frame's
    // only because the machine leaves them free.
    let reserved = 'unchecked';
    if (link.configured) {
      const cells = await link.reservedCells(body.engineId, c.next.templateId);
      const missing = LANES.map((l) => l.cell).filter((k) => !cells.includes(k));
      need(!missing.length, 409, `${c.next.templateId} does not declare input cells ${missing.join(', ')} reserved`);
      reserved = 'reserved';
    }
    const a = {
      allocationId: `lanes-${body.cloneId}`, frameId: f.frameId, continuationId: c.continuationId, engineId: body.engineId,
      cloneId: body.cloneId, generation: body.generation, templateId: c.next.templateId, region, reserved,
      block, sourceId: `lifecycle-${body.engineId}-block-${block}`, sensorId: `lifecycle.${body.engineId}.block-${block}`, status: 'live', allocatedAt: now(),
      wired: link.configured, values: laneValues(f, c)
    };
    if (link.configured) await writeLanes(a, a.values);
    d().lanes[a.allocationId] = a;
    const by = actor(principal);
    const r = receipt('lanes-allocated', { frameId: f.frameId, cloneId: a.cloneId, engineId: a.engineId, generation: a.generation, region, wired: a.wired, by });
    commit({ type: 'lanes.allocated', assetId: f.frameId, frameId: f.frameId, cloneId: a.cloneId, engineId: a.engineId, region, wired: a.wired, by, receiptId: r.id });
    return [201, { ...a, receipt: r.id }];
  });

  // The epilogue recycled the clone: its lanes are freed.
  route('DELETE', '/frames/:id/clones/:cloneId', async ({ params, query, principal }) => {
    allow(principal, 'engine');
    frameOf(params.id);
    const a = live().find((x) => x.frameId === params.id && x.cloneId === params.cloneId);
    need(a, 404, 'no live lanes for that clone');
    const g = query.get('generation');
    need(g !== null && /^\d+$/.test(g), 400, 'generation required');
    need(Number(g) === a.generation, 409, `generation ${g} is not the clone's (${a.generation})`);
    const r = await release(a, actor(principal), 'recycled');
    return [200, { ...a, receipt: r.id }];
  });

  route('GET', '/lanes', ({ principal }) => { need(principal.kind !== 'agent', 403, 'forbidden'); return [200, { lanes: LANES, live: live() }]; });

  return { refresh, releaseFrame };
}
