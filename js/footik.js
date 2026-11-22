// Foot IK for the Quaternius rig.
//
// Bones live in the skeleton's space: getAbsolutePosition() is the joint you
// see, and the mesh world matrix takes it to the world. (getFinalMatrix() on
// this rig is the frozen bind matrix and does not follow bone edits, so it is
// never used here.)
//
// Each frame, after the animation has been evaluated:
//   1. find the ankle and the ball of each foot; cast down onto the arena's
//      flat tops and sloped planes;
//   2. lower the pelvis when a planted foot is out of leg reach;
//   3. solve the 2-bone hip/knee/ankle chain, with the knee leading the body's
//      facing so it bends forward instead of inheriting the clip;
//   4. hold the sole at its bind-pose pitch on the surface: a flat floor gives
//      a flat foot and a ramp gives a foot parallel to the ramp. The bind dip
//      (how far the ball sits below the ankle) is measured once, from the rest
//      pose, because this rig's foot bones are not axis-aligned to the world;
//   5. if a standing foot has nothing under it, hang the leg straight down to
//      its reach instead of freezing the clip's mid-stride pose in the air.
//
// The support foot is planted, plus the other foot while standing. Walking
// keeps the clip's swing on the free foot. A planted foot keeps its contact
// point; re-targeting from an already-corrected ankle would walk the foot.
(() => {
  "use strict";

  const B = BABYLON;
  const ANKLE_HEIGHT = 0.104;    // bind-pose ankle height above the sole
  const MAX_PELVIS_DROP = 0.45;  // deepest squat the grounder may use
  const CONTACT_NEAR = 0.02;     // foot this close to the target: fully planted
  const CONTACT_FAR = 0.18;      // above this: leave the swing alone
  const REPLACE_RATE = 7;        // how fast a hanging foot slides onto a ledge
  const SMOOTH = 18;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const angleDelta = (a, b) => {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  };

  function rotationBetween(from, to) {
    const a = from.normalizeToNew();
    const b = to.normalizeToNew();
    const d = B.Vector3.Dot(a, b);
    if (d < -0.9999) {
      let axis = B.Vector3.Cross(B.Axis.Y, a);
      if (axis.lengthSquared() < 1e-6) axis = B.Vector3.Cross(B.Axis.X, a);
      return B.Quaternion.RotationAxis(axis.normalize(), Math.PI);
    }
    const c = B.Vector3.Cross(a, b);
    return new B.Quaternion(c.x, c.y, c.z, 1 + d).normalize();
  }

  function create(scene, options) {
    const colliders = (options && options.colliders) || [];
    const slopes = (options && options.slopes) || [];
    const mesh = options && options.mesh;
    const getState = (options && options.getState) || (() => ({ grounded: true }));
    if (!mesh || !mesh.skeleton) return null;

    const skeleton = mesh.skeleton;
    const find = (name) => skeleton.bones.find((b) => b.name === name) || null;
    const hips = find("DEF-hips");
    const legs = {
      left: { thigh: find("DEF-thigh.L"), shin: find("DEF-shin.L"), foot: find("DEF-foot.L"), toe: find("DEF-toe.L"), weight: 0, place: null, ledge: null, ledgeYaw: 0 },
      right: { thigh: find("DEF-thigh.R"), shin: find("DEF-shin.R"), foot: find("DEF-foot.R"), toe: find("DEF-toe.R"), weight: 0, place: null, ledge: null, ledgeYaw: 0 },
    };
    for (const leg of Object.values(legs)) {
      if (!leg.thigh || !leg.shin || !leg.foot || !leg.toe) return null;
    }
    if (!hips) return null;

    const stats = { left: {}, right: {}, pelvisDrop: 0 };
    const invMesh = new B.Matrix();
    const invMeshRot = new B.Matrix();
    const tmp = new B.Matrix();
    const dropBones = [];
    let meshWorld = new B.Matrix();

    const bonePos = (bone) => bone.getAbsolutePosition();
    const boneRot = (bone) => bone.getAbsoluteMatrix().getRotationMatrix();
    const toWorld = (p) => B.Vector3.TransformCoordinates(p, meshWorld);
    const toBone = (p) => B.Vector3.TransformCoordinates(p, invMesh);

    // Bind pose: the foot's own pitch on a level floor. The ball sits a few
    // centimetres below the ankle there, and holding that offset along whatever
    // surface the foot is on is what makes a sole lie flat. (The rig's foot
    // bones have no world-aligned "up" axis, so a local axis guess cannot.)
    const restDip = { left: 0, right: 0 };
    const restDir = { left: null, right: null };
    if (typeof skeleton.returnToRest === "function") skeleton.returnToRest();
    skeleton.prepare();
    mesh.computeWorldMatrix(true);
    {
      const up = B.Vector3.TransformNormal(
        B.Axis.Y, mesh.getWorldMatrix().getRotationMatrix().clone().invert(),
      ).normalize();
      for (const side of ["left", "right"]) {
        const leg = legs[side];
        const dir = bonePos(leg.toe).subtract(bonePos(leg.foot));
        restDip[side] = B.Vector3.Dot(dir, up);
        restDir[side] = dir;
      }
    }

    // Downward ray against flat box tops (the arena is built from boxes).
    function groundAt(x, y, z, maxDrop) {
      let best = null;
      for (const c of colliders) {
        if (x < c.min.x || x > c.max.x || z < c.min.z || z > c.max.z) continue;
        const top = c.max.y;
        if (top > y + 1e-3 || top < y - maxDrop) continue;
        if (best == null || top > best) best = top;
      }
      return best;
    }

    // Surface under a point with its normal: a flat box top or a slope plane.
    function surfaceAt(x, y, z, maxDrop) {
      let best = null;
      for (const c of colliders) {
        if (x < c.min.x || x > c.max.x || z < c.min.z || z > c.max.z) continue;
        const top = c.max.y;
        if (top > y + 1e-3 || top < y - maxDrop) continue;
        if (best == null || top > best.y) best = { y: top, nx: 0, ny: 1, nz: 0, slope: null };
      }
      for (const s of slopes) {
        if (!s.contains(x, z)) continue;
        const h = s.height(x, z);
        if (h > y + 1e-3 || h < y - maxDrop) continue;
        if (best == null || h > best.y) best = { y: h, nx: s.normal.x, ny: s.normal.y, nz: s.normal.z, slope: s };
      }
      return best;
    }

    // Nearest spot at the platform's height around a foot that hangs over an
    // edge. Searching outward in rings keeps the correction small, and only a
    // top at platform level counts (never the floor far below), so the foot
    // steps back onto the ledge instead of floating.
    function findFooting(ankle, platformY) {
      for (let ring = 1; ring <= 6; ring++) {
        const radius = ring * 0.05;
        for (let i = 0; i < 12; i++) {
          const angle = (i / 12) * Math.PI * 2;
          const x = ankle.x + Math.cos(angle) * radius;
          const z = ankle.z + Math.sin(angle) * radius;
          const g = groundAt(x, platformY + 0.05, z, 0.2);
          if (g != null && Math.abs(g - platformY) < 0.04) return { x, z };
        }
      }
      return null;
    }

    // Can this leg put its ankle on the target without the pelvis sinking
    // further than the IK allows? A foot standing on a step beside the other
    // one is reachable and must be planted; only a foot hanging over a real
    // drop is out of reach.
    function footReachable(leg, target, maxDrop) {
      const hip = bonePos(leg.thigh);
      const reach = B.Vector3.Distance(hip, bonePos(leg.shin))
        + B.Vector3.Distance(bonePos(leg.shin), bonePos(leg.foot));
      return B.Vector3.Distance(hip, target) <= reach * 0.985 + maxDrop;
    }

    // Translate a bone down by dy in bone space. The hips alone are not enough
    // on this rig: its thigh roots are siblings of the hips, not children, so
    // the legs would stay put while the torso sank. Assign a new Vector3: the
    // property setter dirties the bone, while mutating in place leaves the
    // matrix cache stale and prepare() keeps reusing the old matrix.
    function applyDrop(bone, dy) {
      const parent = bone.getParent();
      if (!parent) return;
      const base = bone.position.clone();
      const abs = bonePos(bone);
      const inv = parent.getAbsoluteMatrix().clone().invert();
      const local = B.Vector3.TransformCoordinates(new B.Vector3(abs.x, abs.y - dy, abs.z), inv);
      bone.position = new B.Vector3(local.x, local.y, local.z);
      dropBones.push({ bone, base, applied: bone.position.clone() });
    }

    function hasAncestor(bone, ancestor) {
      for (let p = bone.getParent(); p; p = p.getParent()) if (p === ancestor) return true;
      return false;
    }

    // Replace a bone's orientation with world-rotation `delta` in bone space,
    // scaled by weight. Matrix-based on purpose: this build has no static
    // Quaternion.multiply, and this keeps the row-vector convention explicit.
    function rotateWorld(target, delta, weight) {
      if (weight <= 0.002) return;
      const d = weight >= 0.999 ? delta : B.Quaternion.Slerp(B.Quaternion.Identity(), delta, weight);
      const now = boneRot(target);
      const rotated = now.multiply(d.toRotationMatrix(tmp));
      const parent = target.getParent();
      const local = parent
        ? rotated.multiply(boneRot(parent).clone().invert())
        : rotated;
      target.rotationQuaternion = B.Quaternion.FromRotationMatrix(local);
    }

    // Knees lead the body: project the facing direction onto the plane
    // perpendicular to the hip->ankle line. This replaces "inherit whatever
    // the clip's knee happened to do", which is what let a pose look broken
    // once the ankle was moved.
    function kneeBend(toTarget) {
      const facing = (getState() || {}).facing || 0;
      const fwd = B.Vector3.TransformNormal(
        new B.Vector3(Math.sin(facing), 0, Math.cos(facing)), invMeshRot,
      ).normalize();
      const bend = fwd.subtract(toTarget.scale(B.Vector3.Dot(fwd, toTarget)));
      if (bend.lengthSquared() < 1e-6) return new B.Vector3(0, 0, 1);
      return bend.normalize();
    }

    function solveLeg(leg, side, target, weight, normal) {
      const H = bonePos(leg.thigh).clone();
      const K = bonePos(leg.shin).clone();
      const A = bonePos(leg.foot).clone();
      const L1 = Math.max(0.05, B.Vector3.Distance(H, K));
      const L2 = Math.max(0.05, B.Vector3.Distance(K, A));

      const toTarget = target.subtract(H);
      let dist = toTarget.length();
      if (dist < 1e-4) return;
      toTarget.scaleInPlace(1 / dist);
      dist = clamp(dist, Math.abs(L1 - L2) + 0.01, (L1 + L2) * 0.998);

      const along = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
      const height = Math.sqrt(Math.max(0, L1 * L1 - along * along));
      const bend = kneeBend(toTarget);
      const knee = H.add(toTarget.scale(along)).add(bend.scale(height));

      rotateWorld(leg.thigh, rotationBetween(K.subtract(H), knee.subtract(H)), weight);
      skeleton.prepare();

      const K2 = bonePos(leg.shin).clone();
      const A2 = bonePos(leg.foot).clone();
      rotateWorld(leg.shin, rotationBetween(A2.subtract(K2), target.subtract(K2)), weight);
      skeleton.prepare();

      // Sole: keep the bind-pose ball-below-ankle offset along the surface
      // normal, and let the foot's heading follow the animated ankle->ball.
      // A level floor therefore reproduces the bind foot, and a ramp or rock
      // gives a sole parallel to it.
      const ankle = bonePos(leg.foot);
      const ball = bonePos(leg.toe);
      const dir = ball.subtract(ankle);
      const n = normal || B.Vector3.TransformNormal(B.Axis.Y, invMeshRot).normalize();
      const dip = restDip[side];
      let tangent = dir.subtract(n.scale(B.Vector3.Dot(dir, n)));
      if (tangent.lengthSquared() < 1e-8) {
        tangent = restDir[side].subtract(n.scale(B.Vector3.Dot(restDir[side], n)));
      }
      const tangentLen = Math.sqrt(Math.max(0, dir.lengthSquared() - dip * dip));
      if (tangent.lengthSquared() < 1e-10 || tangentLen < 1e-5) return;
      const desired = tangent.normalize().scale(tangentLen).add(n.scale(dip));
      rotateWorld(leg.foot, rotationBetween(dir, desired), weight);
      skeleton.prepare();
    }

    function reset() {
      for (const d of dropBones) d.bone.position = d.base.clone();
      dropBones.length = 0;
      legs.left.weight = 0;
      legs.right.weight = 0;
      legs.left.place = null;
      legs.right.place = null;
      legs.left.contact = null;
      legs.right.contact = null;
      legs.left.ledge = null;
      legs.right.ledge = null;
      legs.left.ledgeYaw = 0;
      legs.right.ledgeYaw = 0;
      skeleton.prepare();
    }

    function update(dt) {
      const state = getState() || {};
      skeleton.prepare();

      // If the clip animates a translated bone, the animation has just written
      // it; where it did not, undo last frame's drop so it cannot accumulate.
      if (dropBones.length) {
        let restored = false;
        for (const d of dropBones) {
          if (B.Vector3.DistanceSquared(d.bone.position, d.applied) < 1e-12) {
            d.bone.position = d.base.clone();
            restored = true;
          }
        }
        dropBones.length = 0;
        if (restored) skeleton.prepare();
      }

      mesh.computeWorldMatrix(true);
      meshWorld.copyFrom(mesh.getWorldMatrix());
      meshWorld.invertToRef(invMesh);
      meshWorld.getRotationMatrix().invertToRef(invMeshRot);

      const grounded = !!state.grounded;
      const idle = (state.speed || 0) < 0.25;
      const feet = {};
      for (const side of ["left", "right"]) {
        const leg = legs[side];
        const ankleWorld = toWorld(bonePos(leg.foot));
        const ballWorld = toWorld(bonePos(leg.toe));
        // Probe the heel and the ball: a foot whose toe overhangs the next
        // step still rests on the tread under the heel.
        const heel = surfaceAt(ankleWorld.x, ankleWorld.y + 0.35, ankleWorld.z, 1.0);
        const ball = surfaceAt(ballWorld.x, ballWorld.y + 0.35, ballWorld.z, 1.0);
        const hit = heel == null ? ball : ball == null ? heel : (ball.y >= heel.y ? ball : heel);
        // On a plane the ankle height comes from the surface under the ankle,
        // not from the higher of heel/ball: using the ball would lift the foot
        // by the slope across its own length. Steps still use the higher top.
        const ground = hit == null ? null
          : hit.slope ? hit.slope.height(ankleWorld.x, ankleWorld.z) : hit.y;
        const normal = hit == null
          ? { x: 0, y: 1, z: 0 }
          : { x: hit.nx, y: hit.ny, z: hit.nz };
        const targetX = ankleWorld.x + normal.x * ANKLE_HEIGHT;
        const targetZ = ankleWorld.z + normal.z * ANKLE_HEIGHT;
        const targetY = ground == null ? null : ground + normal.y * ANKLE_HEIGHT;
        const gap = targetY == null ? 99 : ankleWorld.y - targetY;
        feet[side] = { ankleWorld, ballWorld, ground, normal, targetX, targetY, targetZ, gap, dangle: null };
      }

      // A foot hanging over an edge while standing has no ground within reach;
      // look for the nearest tread at the platform height and let the foot
      // step back onto it (the idle equivalent of shifting your weight).
      const platform = Math.max(
        feet.left.ground == null ? -Infinity : feet.left.ground,
        feet.right.ground == null ? -Infinity : feet.right.ground,
      );
      for (const side of ["left", "right"]) {
        const leg = legs[side];
        const f = feet[side];
        const face = state.facing || 0;
        if (!grounded || !idle) {
          leg.ledge = null;
        } else if (leg.ledge && Math.abs(angleDelta(leg.ledgeYaw, face)) > 0.05) {
          leg.ledge = null;
        } else if (leg.ledge == null && Number.isFinite(platform) && f.ground == null) {
          leg.ledge = findFooting(f.ankleWorld, platform);
          if (leg.ledge) leg.ledgeYaw = face;
        }
        f.footing = leg.ledge || null;

        // Nothing under the foot and nothing to step onto: dangle it. A frozen
        // clip pose with the knee up is what made a leg look like it was
        // floating in mid-air.
        if (grounded && idle && !f.footing && f.ground == null) {
          const hip = toWorld(bonePos(leg.thigh));
          const reach = B.Vector3.Distance(toWorld(bonePos(leg.thigh)), toWorld(bonePos(leg.shin)))
            + B.Vector3.Distance(toWorld(bonePos(leg.shin)), toWorld(bonePos(leg.foot)));
          f.dangle = new B.Vector3(hip.x, hip.y - reach * 0.97, hip.z);
        }
      }

      const contact = (gap) => gap <= CONTACT_NEAR ? 1
        : gap >= CONTACT_FAR ? 0
        : 1 - (gap - CONTACT_NEAR) / (CONTACT_FAR - CONTACT_NEAR);

      let wantL = 0, wantR = 0;
      if (grounded) {
        const cL = contact(feet.left.gap);
        const cR = contact(feet.right.gap);
        const reachable = (side) => {
          const f = feet[side];
          if (f.ground == null || f.targetY == null) return false;
          return footReachable(legs[side], toBone(new B.Vector3(f.targetX, f.targetY, f.targetZ)), MAX_PELVIS_DROP);
        };
        if (idle) {
          // standing: each foot plants on the surface under it, so one foot
          // can rest on a step while the other stands on the floor.
          wantL = reachable("left") ? 1 : cL;
          wantR = reachable("right") ? 1 : cR;
        } else if (cL >= cR) wantL = cL;
        else wantR = cR;
        // plant the lower foot while moving; a level pair plants both
        if (!idle && Math.abs(feet.left.gap - feet.right.gap) < 0.06) { wantL = cL; wantR = cR; }
        if (feet.left.footing || feet.left.dangle) wantL = 1;
        if (feet.right.footing || feet.right.dangle) wantR = 1;
      }
      const k = 1 - Math.exp(-SMOOTH * Math.max(0, dt || 1 / 60));
      legs.left.weight += (wantL - legs.left.weight) * k;
      legs.right.weight += (wantR - legs.right.weight) * k;

      // pelvis: drop the hips when a planted ankle is out of leg reach
      let drop = 0;
      const targets = {};
      for (const side of ["left", "right"]) {
        const leg = legs[side];
        const f = feet[side];
        if (f.ground == null && !f.footing && !f.dangle) continue;
        let px = f.targetX, pz = f.targetZ, py = f.targetY;
        if (f.dangle) {
          px = f.dangle.x;
          py = f.dangle.y;
          pz = f.dangle.z;
          leg.place = null;
          leg.contact = null;
        } else if (f.footing) {
          if (!leg.place) leg.place = new B.Vector3(px, 0, pz);
          const kr = 1 - Math.exp(-REPLACE_RATE * Math.max(0, dt || 1 / 60));
          leg.place.x += (f.footing.x - leg.place.x) * kr;
          leg.place.z += (f.footing.z - leg.place.z) * kr;
          px = leg.place.x;
          pz = leg.place.z;
          py = platform + ANKLE_HEIGHT;
        } else if (leg.place) {
          leg.place = null;
        }
        // A planted foot keeps its ground point: re-targeting from the ankle
        // after the IK has rotated it walks the foot along the surface.
        if (!f.footing && !f.dangle) {
          if (leg.weight > 0.5) {
            if (!leg.contact) leg.contact = { x: px, z: pz };
            px = leg.contact.x;
            pz = leg.contact.z;
          } else {
            leg.contact = { x: px, z: pz };
          }
        } else if (f.footing) {
          leg.contact = null;
        }
        if (py == null) continue;
        const target = toBone(new B.Vector3(px, py, pz));
        targets[side] = target;
        if (leg.weight < 0.05 || f.dangle) continue;
        const H = bonePos(leg.thigh);
        const K = bonePos(leg.shin);
        const A = bonePos(leg.foot);
        const reach = B.Vector3.Distance(H, K) + B.Vector3.Distance(K, A);
        drop = Math.max(drop, (B.Vector3.Distance(H, target) - reach * 0.985) * leg.weight);
      }
      drop = clamp(drop, 0, MAX_PELVIS_DROP);
      stats.pelvisDrop = drop;
      if (drop > 0.001) {
        applyDrop(hips, drop);
        for (const side of ["left", "right"]) {
          const thigh = legs[side].thigh;
          if (!hasAncestor(thigh, hips)) applyDrop(thigh, drop);
        }
        skeleton.prepare();
      }

      for (const side of ["left", "right"]) {
        const leg = legs[side];
        const f = feet[side];
        stats[side] = {
          ground: f.ground,
          gap: Number(f.gap.toFixed(3)),
          weight: Number(leg.weight.toFixed(2)),
          footing: !!f.footing,
          dangle: !!f.dangle,
          normal: f.normal,
          ankleWorld: f.ankleWorld,
          ballWorld: f.ballWorld,
          targetWorld: f.targetY == null ? null : new B.Vector3(f.targetX, f.targetY, f.targetZ),
          targetBone: targets[side] || null,
        };
        if (targets[side] && leg.weight > 0.01) {
          const n = f.normal;
          const normalBone = f.dangle ? B.Vector3.TransformNormal(B.Axis.Y, invMeshRot).normalize() : B.Vector3.TransformNormal(
            new B.Vector3(n.x, n.y, n.z), invMeshRot,
          ).normalize();
          solveLeg(leg, side, targets[side], leg.weight, normalBone);
        }
      }
      return stats;
    }

    return { update, reset, stats, legs, skeleton };
  }

  window.createFootIK = create;
})();
