// Third-person character controller: capsule-vs-AABB collision with real stair
// handling, acceleration/friction, walk/sprint/jump, and a spring-arm camera.
//
// The arena is axis-aligned boxes plus planar sloped surfaces. Ground probing
// on boxes is an exact AABB test; slopes are height functions over convex
// footprints shared with the mesh and the foot IK, so what you see, stand on
// and see the camera collide with is the same surface. Only tops within the
// step limit can be climbed; a taller face blocks.
(() => {
  "use strict";

  const RADIUS = 0.36;
  const HEIGHT = 1.74;
  const STEP = 0.45;          // highest rise the controller climbs on its own
  const MIN_TREAD = 0.18;     // a step needs a standable tread, not a thin lip
  const GRAVITY = 22;
  const JUMP_SPEED = 7.7;
  const WALK_SPEED = 2.0;
  const SPRINT_SPEED = 7.4;
  const CAM_DIST = 4.3;
  const AIM_DIST = 1.75;       // right-click: tight over-the-shoulder view
  const AIM_SIDE = 0.52;
  const AIM_FOV = 0.62;
  // U cycles the camera around the character: chase, front, side.
  const VIEW_YAW = [0, Math.PI, Math.PI * 0.5];
  const SLOPE_SLOW = 0.38;    // uphill speed lost at climb = 1
  const DOWNHILL_SLOW = 0.12;
  const LEAN_MAX = 0.16;      // radians of forward lean at climb = 1
  const SLOPE_WINDOW = 0.6;   // metres of ground travel per slope sample
  const FOOT_SIDE = 0.13;     // half the stance width for edge balance
  const FOOT_LONG = 0.15;     // heel-to-toe reach of the balance footprint
  const STRADDLE = 0.45;      // deepest drop the other leg can reach from an edge
  const EPS = 1e-4;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const angleDelta = (a, b) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
  const approach = (v, target, delta) => (v < target ? Math.min(v + delta, target) : Math.max(v - delta, target));

  function create(scene, camera, colliders, spawn, slopes) {
    const ramps = slopes || [];
    const pos = spawn.clone();
    const vel = new BABYLON.Vector3();
    const state = {
      pos,
      vel,
      speed: 0,
      grounded: false,
      airTime: 0,
      justJumped: false,
      justLanded: false,
      coyoteTimer: 0,
      jumpBufferTimer: 0,
      state: "idle",
      climb: 0,       // rise over run from real motion: + up, - down
      lean: 0,        // radians of forward lean on the character root
      turnLean: 0,    // radians of lateral lean into turns (mouse look)
      facing: 0,      // world yaw the character faces (camera forward)
      stepOffset: 0,
    };

    let camYaw = 0;
    let camPitch = 0.24;
    let camDist = CAM_DIST;
    let aim = 0;        // 0 hip camera, 1 fully aiming
    let aimHeld = false;
    let camMode = 0;
    let viewOffset = 0;
    let visualY = pos.y;
    let facingYaw = camYaw + Math.PI; // shooter: body looks where the camera looks
    let climbTarget = 0;
    let slopeY = 0;
    let slopeD = 0;
    let camShake = 0;
    const camTarget = pos.add(new BABYLON.Vector3(0, 1.45, 0));
    const camPos = new BABYLON.Vector3(0, 2.4, spawn.z + 4.3);

    const root = scene.getTransformNodeByName("mannequin");
    if (root) root.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(facingYaw, 0, 0);

    // ---------------------------------------------------------------- helpers
    const overlaps = (c) =>
      pos.x + RADIUS > c.min.x + EPS &&
      pos.x - RADIUS < c.max.x - EPS &&
      pos.z + RADIUS > c.min.z + EPS &&
      pos.z - RADIUS < c.max.z - EPS &&
      pos.y < c.max.y - EPS &&
      pos.y + HEIGHT > c.min.y + EPS;

    // centre of the capsule inside a box footprint (support, not blocking)
    const centreOver = (c, x, z, pad = 0.01) =>
      x + pad > c.min.x && x - pad < c.max.x &&
      z + pad > c.min.z && z - pad < c.max.z;

    // Where the feet are in the body's facing frame. A body can stand with one
    // foot on a ledge and the centre already past its edge, the way a person
    // balances on one leg instead of dropping the moment the weight shifts.
    const stance = [0, 0, 0, 0].map(() => ({ x: 0, z: 0 }));
    function updateStance() {
      const fx = Math.sin(facingYaw), fz = Math.cos(facingYaw);
      const rx = fz, rz = -fx;
      let i = 0;
      for (const s of [-1, 1]) {
        for (const l of [-1, 1]) {
          stance[i].x = pos.x + rx * s * FOOT_SIDE + fx * l * FOOT_LONG;
          stance[i].z = pos.z + rz * s * FOOT_SIDE + fz * l * FOOT_LONG;
          i++;
        }
      }
    }

    function stanceOver(c) {
      for (const p of stance) if (centreOver(c, p.x, p.z)) return true;
      return false;
    }

    // Highest flat top under the stance footprint, not just the centre.
    function supportStance(fromY, maxDrop) {
      updateStance();
      let best = null;
      for (const p of stance) {
        const s = supportAt(p.x, p.z, fromY, maxDrop);
        if (s != null && (best == null || s > best)) best = s;
      }
      return best;
    }

    // Downward probe: highest top face at or below fromY under (x, z). This is
    // the step "raycast"; walls and crates are excluded by the height window.
    function supportAt(x, z, fromY, maxDrop) {
      let best = null;
      for (const c of colliders) {
        if (!centreOver(c, x, z)) continue;
        const top = c.max.y;
        if (top > fromY + 0.02 || top < fromY - maxDrop) continue;
        if (best == null || top > best) best = top;
      }
      // sloped surfaces: the surface height at this exact point
      for (const s of ramps) {
        if (!s.contains(x, z)) continue;
        const h = s.height(x, z);
        if (h > fromY + 0.02 || h < fromY - maxDrop) continue;
        if (best == null || h > best) best = h;
      }
      return best;
    }

    // A low ceiling above the feet would stop a step-up into it.
    function clearOverhead(x, y, z) {
      for (const c of colliders) {
        if (c.min.y <= y + 0.05 || c.min.y >= y + HEIGHT) continue;
        if (x + RADIUS <= c.min.x + EPS || x - RADIUS >= c.max.x - EPS) continue;
        if (z + RADIUS <= c.min.z + EPS || z - RADIUS >= c.max.z - EPS) continue;
        return false;
      }
      return true;
    }

    function moveVertical(dy) {
      const from = pos.y;
      pos.y += dy;
      if (dy > 0) {
        for (const c of colliders) {
          if (!overlaps(c)) continue;
          if (c.min.y < from + HEIGHT - 0.02) continue; // underside is below the head
          pos.y = Math.min(pos.y, c.min.y - HEIGHT);
          vel.y = 0;
        }
        return;
      }
      // land on a flat top under the body, including one still under a foot
      // when the centre has just passed an edge
      updateStance();
      let support = null;
      for (const c of colliders) {
        if (!stanceOver(c)) continue;
        const top = c.max.y;
        if (top > from + 0.02 || top < pos.y - 0.02) continue;
        if (support == null || top > support) support = top;
      }
      // a slope is continuous ground, so follow it up within one step instead
      // of flickering airborne on a frame where the surface rose a few cm
      for (const s of ramps) {
        if (!s.contains(pos.x, pos.z)) continue;
        const h = s.height(pos.x, pos.z);
        if (h > from + STEP || h < pos.y - 0.02) continue;
        if (support == null || h > support) support = h;
      }
      // A foot still on the surface may hold the body up only when the centre
      // can also reach a surface within a straddle. A tall ledge or the side
      // of the ramp must drop you instead of hovering with a leg in the air.
      if (support != null && supportAt(pos.x, pos.z, from, STRADDLE) == null) support = null;
      if (support != null) {
        pos.y = support;
        vel.y = 0;
        if (!state.grounded && state.airTime > 0.12) { state.justLanded = true; camShake = 0.35; }
        state.grounded = true;
      }
    }

    function moveHorizontal(axis, amount) {
      if (amount === 0) return;
      const before = pos[axis];
      pos[axis] += amount;
      for (const c of colliders) {
        if (!overlaps(c)) continue;

        // Climbable step: shallow rise and a tread deep enough to stand on.
        // The capsule may pass the riser; the centre-over-tread lift in
        // update() raises the player one rise at a time. Tall boxes and thin
        // lips fail this test, so walls block and thin trim cannot snag.
        if (state.grounded) {
          const lift = c.max.y - pos.y;
          const run = axis === "x" ? c.max.x - c.min.x : c.max.z - c.min.z;
          if (lift > 0.02 && lift <= STEP && run >= MIN_TREAD) continue;
        }

        // Resolve only the face the movement heads into. A capsule already
        // past a box is leaving it (stepping off a ledge, falling beside a
        // slab or rail), so pushing it back to a face is what teleported the
        // character sideways off edges. `before` is the pre-move centre.
        if (before < c.min[axis] - EPS && amount > 0) pos[axis] = c.min[axis] - RADIUS;
        else if (before > c.max[axis] + EPS && amount < 0) pos[axis] = c.max[axis] + RADIUS;
        else continue;
        vel[axis] = 0;
      }

      // A slope is only a step. Where its face is taller than a step at the
      // new point it is a hillside wall: stop at the edge, without shoving.
      for (const s of ramps) {
        if (!s.contains(pos.x, pos.z)) continue;
        if (s.height(pos.x, pos.z) - pos.y > STEP) {
          pos[axis] = before;
          vel[axis] = 0;
        }
      }
    }

    // A slope is a solid wedge: a planar top over a convex footprint, skirted
    // down to the ground. Sampling finds the first point inside it, so the
    // camera pulls in both when the sight line crosses the top and when it
    // enters through the side. The 5 cm step is hidden by the 0.28 m arm pad.
    function raySlope(origin, dir, s, maxDist) {
      const step = 0.05;
      for (let t = step; t < maxDist; t += step) {
        const x = origin.x + dir.x * t;
        const z = origin.z + dir.z * t;
        if (!s.contains(x, z)) continue;
        if (origin.y + dir.y * t <= s.height(x, z)) return t;
      }
      return null;
    }

    function rayBox(origin, dir, c, maxDist) {
      let tmin = 0;
      let tmax = maxDist;
      for (const axis of ["x", "y", "z"]) {
        const o = origin[axis];
        const d = dir[axis];
        if (Math.abs(d) < 1e-8) {
          if (o < c.min[axis] || o > c.max[axis]) return null;
        } else {
          let t1 = (c.min[axis] - o) / d;
          let t2 = (c.max[axis] - o) / d;
          if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
          tmin = Math.max(tmin, t1);
          tmax = Math.min(tmax, t2);
          if (tmin > tmax) return null;
        }
      }
      return tmin;
    }

    // ---------------------------------------------------------------- input
    const input = { forward: 0, right: 0, walk: false, sprint: false, jump: false };

    const canvas = scene.getEngine().getRenderingCanvas();
    if (canvas && typeof canvas.addEventListener === "function") {
      canvas.addEventListener("click", () => {
        if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
      });
      document.addEventListener("mousemove", (e) => {
        if (document.pointerLockElement !== canvas) return;
        camYaw += e.movementX * 0.0021;
        camPitch = clamp(camPitch + e.movementY * 0.0017, -0.22, 1.02);
      });
      document.addEventListener("pointerlockchange", () => {
        const hint = document.getElementById("hint");
        if (hint) hint.classList.toggle("hidden", document.pointerLockElement === canvas);
      });
    }

    // ---------------------------------------------------------------- update
    function update(dt, cmd) {
      state.justJumped = false;
      state.justLanded = false;

      const startX = pos.x, startY = pos.y, startZ = pos.z;
      const forward = cmd.forward || 0;
      const right = cmd.right || 0;
      const wish = new BABYLON.Vector3();
      if (forward || right) {
        const fwd = new BABYLON.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
        // left-handed basis: screen right is up x forward, not -up x forward
        const rgt = new BABYLON.Vector3(fwd.z, 0, -fwd.x);
        wish.copyFrom(fwd.scale(forward)).addInPlace(rgt.scale(right));
        if (wish.lengthSquared() > 0) wish.normalize();
      }

      // Uphill costs speed, downhill is a little quicker. Climb comes from
      // real motion over a short distance, so no stair metadata is needed.
      const terrain = 1 - SLOPE_SLOW * clamp(state.climb, 0, 1) - DOWNHILL_SLOW * clamp(-state.climb, 0, 1);
      const targetSpeed = (cmd.sprint ? SPRINT_SPEED : WALK_SPEED) * terrain;
      const wanted = wish.scale(targetSpeed);
      const accel = state.grounded ? (wish.lengthSquared() > 0 ? 30 : 26) : 7;
      vel.x = approach(vel.x, wanted.x, accel * dt);
      vel.z = approach(vel.z, wanted.z, accel * dt);

      // Coyote time: keep a short window after leaving a ledge.
      if (state.grounded) state.coyoteTimer = 0.12;
      else state.coyoteTimer = Math.max(0, state.coyoteTimer - dt);
      // Jump buffering: remember a jump pressed slightly before landing.
      if (cmd.jump) state.jumpBufferTimer = 0.12;
      else state.jumpBufferTimer = Math.max(0, state.jumpBufferTimer - dt);

      const canJump = state.grounded || state.coyoteTimer > 0;
      if (state.jumpBufferTimer > 0 && canJump) {
        vel.y = JUMP_SPEED;
        state.grounded = false;
        state.coyoteTimer = 0;
        state.jumpBufferTimer = 0;
        state.justJumped = true;
        pos.y += 0.03;
      }
      vel.y -= GRAVITY * dt;

      const wasGrounded = state.grounded;
      state.grounded = false;
      moveVertical(vel.y * dt);
      moveHorizontal("x", vel.x * dt);
      moveHorizontal("z", vel.z * dt);

      // The capsule centre is now over a tread: step up one rise, or follow
      // the surface down one rise. Doing both in the same frame keeps the
      // capsule on the stair line instead of hovering past a tread edge.
      if (state.grounded) {
        const up = supportAt(pos.x, pos.z, pos.y + STEP, STEP);
        const down = supportAt(pos.x, pos.z, pos.y + 0.02, STEP);
        if (up != null && up > pos.y + 0.02 && clearOverhead(pos.x, up + 0.002, pos.z)) {
          pos.y = up;
          vel.y = 0;
        } else if (down != null && down < pos.y - 0.02) {
          // keep a straddle: while a foot still rests on the higher surface
          // within reach, the body has not stepped down yet
          const held = supportStance(pos.y + 0.02, STRADDLE);
          if (held == null || held < pos.y - 0.02) {
            pos.y = down;
            vel.y = 0;
          }
        }
      }

      // walking off a shallow step: snap down instead of going airborne
      if (wasGrounded && !state.grounded && vel.y <= 0) {
        const landing = supportAt(pos.x, pos.z, pos.y + STEP, STEP);
        if (landing != null) {
          pos.y = landing;
          vel.y = 0;
          state.grounded = true;
        }
      }
      state.airTime = state.grounded ? 0 : state.airTime + dt;

      // slope from real motion: height gained over ground distance travelled
      if (state.grounded) {
        slopeY += pos.y - startY;
        slopeD += Math.hypot(pos.x - startX, pos.z - startZ);
        if (slopeD >= SLOPE_WINDOW) {
          const slope = slopeY / slopeD;
          climbTarget = Math.abs(slope) < 0.1 ? 0 : clamp(slope, -1.2, 1.2);
          slopeY = 0;
          slopeD = 0;
        } else if (wish.lengthSquared() < 0.01) {
          climbTarget += (0 - climbTarget) * (1 - Math.exp(-3 * dt));
        }
      } else {
        slopeY = 0;
        slopeD = 0;
        climbTarget += (0 - climbTarget) * (1 - Math.exp(-4 * dt));
      }
      state.climb += (climbTarget - state.climb) * (1 - Math.exp(-10 * dt));
      const leanTarget = clamp(state.climb, 0, 1) * LEAN_MAX;
      state.lean += (leanTarget - state.lean) * (1 - Math.exp(-9 * dt));

      // Procedural lean into turns: tilt the spine sideways based on camera
      // rotation (mouse look). Lean magnitude scales with turn rate.
      if (state._prevCamYaw === undefined) state._prevCamYaw = camYaw;
      const turnRate = angleDelta(state._prevCamYaw, camYaw) / Math.max(dt, 1e-4);
      state._prevCamYaw = camYaw;
      // Kept subtle: the root tilt rotates the whole character, so a big value
      // reads as the mannequin falling over rather than leaning into a turn.
      const turnLeanTarget = clamp(-turnRate * 0.025, -0.07, 0.07);
      state.turnLean += (turnLeanTarget - state.turnLean) * (1 - Math.exp(-8 * dt));

      // Shooter facing: the body always points where the camera looks, so A/D
      // strafe sideways and S backs up instead of turning the character round.
      const faceTarget = camYaw + Math.PI;
      let faceDiff = faceTarget - facingYaw;
      while (faceDiff > Math.PI) faceDiff -= Math.PI * 2;
      while (faceDiff < -Math.PI) faceDiff += Math.PI * 2;
      facingYaw += faceDiff * (1 - Math.exp(-16 * dt));
      state.facing = facingYaw;

      state.speed = Math.hypot(vel.x, vel.z);
      state.state = !state.grounded ? "air"
        : state.speed < 0.15 ? "idle"
        : state.climb > 0.25 ? "climb"
        : state.speed < 2.6 ? "walk" : state.speed < 5.4 ? "jog" : "sprint";

      // ease the mesh height: steps become a short glide instead of a pop.
      // Airborne motion is not smoothed, so falls and landings stay precise.
      if (state.grounded) {
        visualY += (pos.y - visualY) * (1 - Math.exp(-20 * dt));
        const lag = pos.y - visualY;
        if (Math.abs(lag) > 0.22) visualY = pos.y - Math.sign(lag) * 0.22;
      } else {
        visualY = pos.y;
      }
      state.stepOffset = visualY - pos.y;
      if (root) {
        root.position.x = pos.x;
        root.position.z = pos.z;
        root.position.y = visualY;
        // yaw + forward lean in one explicit quaternion: pitch is about the
        // local X, so the body tips toward the direction it is facing
        root.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(facingYaw, state.lean, state.turnLean);
      }

      // ------------------------------------------------------------ camera
      aim += ((aimHeld ? 1 : 0) - aim) * (1 - Math.exp(-12 * dt));
      const distTarget = CAM_DIST + (AIM_DIST - CAM_DIST) * aim;
      // the camera mode yaw is eased, so U swings the view around instead of
      // cutting to the new angle
      viewOffset += (VIEW_YAW[camMode] - viewOffset) * (1 - Math.exp(-9 * dt));
      const viewYaw = camYaw + viewOffset;
      // aim slides the view over the right shoulder and raises it to the head
      const side = new BABYLON.Vector3(-Math.cos(viewYaw), 0, Math.sin(viewYaw));
      const target = new BABYLON.Vector3(pos.x, visualY + 1.42 + 0.16 * aim, pos.z)
        .addInPlace(side.scale(AIM_SIDE * aim));
      camTarget.addInPlace(target.subtract(camTarget).scale(1 - Math.exp(-22 * dt)));
      const sprintFov = (cmd.sprint && state.speed > 2.6) ? 0.06 : 0;
      camera.fov = 0.8 + (AIM_FOV - 0.8) * aim + sprintFov;

      const cosP = Math.cos(camPitch);
      const dir = new BABYLON.Vector3(Math.sin(viewYaw) * cosP, Math.sin(camPitch), Math.cos(viewYaw) * cosP);
      let allowed = distTarget;
      for (const c of colliders) {
        const t = rayBox(camTarget, dir, c, distTarget);
        if (t != null && t > 0) allowed = Math.min(allowed, t - 0.28);
      }
      for (const s of ramps) {
        const t = raySlope(camTarget, dir, s, distTarget);
        if (t != null && t > 0) allowed = Math.min(allowed, t - 0.28);
      }
      allowed = clamp(allowed, 0.6, distTarget);
      camDist += (allowed - camDist) * (1 - Math.exp(-16 * dt));

      const want = camTarget.add(dir.scale(camDist));
      want.y = Math.max(want.y, 0.28);
      camShake = Math.max(0, camShake - dt * 2.5);
      const shakeOff = camShake > 0 ? new BABYLON.Vector3((Math.random()-.5)*camShake, (Math.random()-.5)*camShake*.6, (Math.random()-.5)*camShake) : BABYLON.Vector3.Zero();
      camPos.addInPlace(want.subtract(camPos).scale(1 - Math.exp(-24 * dt)));
      camera.position.copyFrom(camPos.add(shakeOff));
      camera.setTarget(camTarget);
    }

    function setAim(held) {
      aimHeld = !!held;
    }

    function setCamera(mode) {
      camMode = ((Math.round(mode) % VIEW_YAW.length) + VIEW_YAW.length) % VIEW_YAW.length;
      return camMode;
    }

    function nextCamera() {
      return setCamera(camMode + 1);
    }

    function reset() {
      pos.copyFrom(spawn);
      vel.set(0, 0, 0);
      camYaw = 0;
      camPitch = 0.24;
      camDist = CAM_DIST;
      viewOffset = VIEW_YAW[camMode];
      visualY = spawn.y;
      facingYaw = camYaw + Math.PI;
      state.facing = facingYaw;
      climbTarget = 0;
      slopeY = 0;
      slopeD = 0;
      state.climb = 0;
      state.lean = 0;
      state.turnLean = 0;
      state.grounded = false;
      state.airTime = 0;
      if (root) {
        root.position.copyFrom(pos);
        root.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(facingYaw, 0, 0);
      }
    }

    return {
      state, update, reset, input, setAim, setCamera, nextCamera,
      get camMode() { return camMode; },
      get aim() { return aim; },
      get camYaw() { return camYaw; }, set camYaw(v) { camYaw = v; },
      get camPitch() { return camPitch; }, set camPitch(v) { camPitch = v; },
    };
  }

  window.createPlayer = create;
})();
