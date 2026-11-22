// Headless controller test: builds the arena, loads the character and drives
// the player through flat ground, the human-scale stairs (up and down), walls,
// step blocks and the camera, at 60 Hz and at a very small timestep.
const fs = require("fs"), vm = require("vm");
global.window = global;
global.navigator = { userAgent: "node" };
global.document = {
  createElement() { return { getContext() { return null; }, style: {}, addEventListener() {}, removeEventListener() {} }; },
  addEventListener() {}, removeEventListener() {},
  documentElement: { style: {} }, body: { appendChild() {} },
  getElementById() { return null; }, pointerLockElement: null,
};
global.require = (id) => (id === "babylonjs" ? global.BABYLON : undefined);
global.location = { protocol: "http:" };
global.atob = (s) => Buffer.from(s, "base64").toString("binary");
global.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };

(async () => {
  vm.runInThisContext(fs.readFileSync("vendor/babylon.js", "utf8"));
  vm.runInThisContext(fs.readFileSync("vendor/babylon.glTF2FileLoader.js", "utf8"));
  vm.runInThisContext(fs.readFileSync("js/world.js", "utf8"));
  vm.runInThisContext(fs.readFileSync("js/controller.js", "utf8"));
  vm.runInThisContext(fs.readFileSync("js/animations.js", "utf8"));
  vm.runInThisContext(fs.readFileSync("js/footik.js", "utf8"));
  const B = global.BABYLON;
  const scene = new B.Scene(new B.NullEngine());
  const camera = new B.FreeCamera("cam", new B.Vector3(0, 2.4, 20), scene);
  camera.inputs.clear();

  const arena = global.Arena.build(scene);
  const S = arena.stairs;
  const url = "data:model/gltf-binary;base64," + fs.readFileSync("game-ready/quaternius_mannequin.glb").toString("base64");
  const r = await B.SceneLoader.ImportMeshAsync(null, "", url, scene, null, ".glb");
  const mannequin = new B.TransformNode("mannequin", scene);
  r.meshes.forEach((m) => { if (!m.parent) m.parent = mannequin; });

  // Flat-foot reference from the bind pose, captured before any clip runs.
  const bindSkinned = r.meshes.find((m) => m.skeleton);
  if (bindSkinned.skeleton.returnToRest) bindSkinned.skeleton.returnToRest();
  bindSkinned.skeleton.prepare();
  bindSkinned.computeWorldMatrix(true);
  const bindBone = (n) => B.Vector3.TransformCoordinates(
    bindSkinned.skeleton.bones.find((b) => b.name === n).getAbsolutePosition(), bindSkinned.getWorldMatrix());
  const bindDip = bindBone("DEF-toe.L").y - bindBone("DEF-foot.L").y;

  const animator = global.createAnimator(scene);
  const player = global.createPlayer(scene, camera, arena.colliders, arena.spawn, arena.slopes);
  const P = player.state;

  const centreInsideAny = () => arena.colliders.some((c) =>
    P.pos.x > c.min.x && P.pos.x < c.max.x &&
    P.pos.z > c.min.z && P.pos.z < c.max.z &&
    P.pos.y < c.max.y - 0.02 && P.pos.y + 1.74 > c.min.y);

  const step = (dt, cmd) => {
    player.update(dt, { forward: 0, right: 0, walk: false, sprint: false, jump: false, ...cmd });
    animator.update(dt, P.speed, P.grounded, P.justLanded, P.climb);
  };
  const sim = (cmd, seconds, dt = 1 / 60) => {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) step(dt, cmd);
  };

  const results = [];
  const check = (name, ok, detail = "") => results.push([name, !!ok, detail]);

  sim({}, 0.4);
  check("idle at spawn", P.state === "idle" && animator.weights.idle > 0.85, "idle w=" + animator.weights.idle.toFixed(2));

  const z0 = P.pos.z;
  sim({ forward: 1 }, 2);
  check("walk speed ~2.0", Math.abs(P.speed - 2.0) < 0.2, "speed=" + P.speed.toFixed(2));
  check("walk clip dominant", animator.weights.walk > 0.8, "walk w=" + animator.weights.walk.toFixed(2));
  check("walk moves forward", P.pos.z < z0 - 2, "z " + z0.toFixed(1) + " -> " + P.pos.z.toFixed(1));
  check("stays on floor", Math.abs(P.pos.y) < 0.01 && P.grounded, "y=" + P.pos.y.toFixed(3));

  player.reset(); player.camYaw = -Math.PI / 2;
  sim({ forward: 1, sprint: true }, 2.5);
  check("sprint speed ~7.4", Math.abs(P.speed - 7.4) < 0.3, "speed=" + P.speed.toFixed(2));
  check("sprint clip dominant", animator.weights.sprint > 0.7, "w=" + animator.weights.sprint.toFixed(2));

  player.reset(); sim({}, 0.35);
  player.update(1 / 60, { forward: 0, right: 0, jump: true });
  let apex = 0;
  for (let i = 0; i < 40; i++) { player.update(1 / 60, { forward: 0, right: 0 }); apex = Math.max(apex, P.pos.y); animator.update(1 / 60, P.speed, P.grounded, P.justLanded, P.climb); }
  check("jump height", apex > 1.0 && apex < 2.0, "apex=" + apex.toFixed(2));
  sim({}, 0.6);
  check("lands cleanly", P.grounded && Math.abs(P.pos.y) < 0.02, "y=" + P.pos.y.toFixed(3));

  player.reset(); P.pos.set(9, 0, 16); player.camYaw = -Math.PI / 2;
  sim({ forward: 1, sprint: true }, 2.6);
  check("wall blocks player", P.pos.x > 21.9 && P.pos.x < 22.2, "x=" + P.pos.x.toFixed(2));
  check("no penetration at wall", !centreInsideAny(), "y=" + P.pos.y.toFixed(2));

  // ---------------------------------------------------------------- geometry
  check("stair rise is 7 in", Math.abs(S.rise - 0.1778) < 1e-6, "rise=" + S.rise.toFixed(4) + " m");
  check("stair tread is 11 in", Math.abs(S.tread - 0.2794) < 1e-6, "tread=" + S.tread.toFixed(4) + " m");
  check("comfort 2R+T ~ 25 in", Math.abs(2 * S.rise + S.tread - 0.635) < 1e-6, (2 * S.rise + S.tread).toFixed(3) + " m");

  const tops = [];
  for (let k = 1; k <= S.count; k++) {
    const m = scene.getMeshByName("step" + k);
    if (m) tops.push(m.getBoundingInfo().boundingBox.maximumWorld.y);
  }
  const uniform = tops.length === S.count && tops.every((y, i) => Math.abs(y - (i + 1) * S.rise) < 2e-3);
  check("17 uniform rises", S.count === 17 && uniform, "steps=" + tops.length + " top=" + (tops[tops.length - 1] || 0).toFixed(3));

  const landing = scene.getMeshByName("stairLanding");
  const landingTop = landing ? landing.getBoundingInfo().boundingBox.maximumWorld.y : -1;
  check("landing at 8 rises", Math.abs(landingTop - S.landingY) < 2e-3, "y=" + landingTop.toFixed(3));

  const railParts = scene.meshes.filter((m) => /^(rail|bal|post)/.test(m.name));
  check("handrails + balusters", railParts.length >= 20, "parts=" + railParts.length);

  // ------------------------------------------------------- tall wall vs step
  player.reset(); P.pos.set(0, 0, -12); player.camYaw = Math.PI / 2;
  let towerMaxY = 0;
  for (let i = 0; i < 300; i++) { step(1 / 60, { forward: 1 }); towerMaxY = Math.max(towerMaxY, P.pos.y); }
  check("wall is not stepped onto", P.pos.x > -5.7 && P.pos.x < -5.5 && towerMaxY < 0.01,
    "x=" + P.pos.x.toFixed(2) + " maxY=" + towerMaxY.toFixed(2));

  // ------------------------------------------------------------- ascent
  player.reset(); P.pos.set(S.centerX, 0, 2); player.camYaw = 0;
  let topY = 0, maxClimb = 0, maxLean = 0, minClimbSpeed = 9, airUp = 0;
  let maxVisualUp = 0, prevVisualUp = null, prevPhysUp = P.pos.y, maxPhysUp = 0, pierced = false;
  for (let i = 0; i < 480; i++) {
    step(1 / 60, { forward: 1 });
    topY = Math.max(topY, P.pos.y);
    if (P.pos.z < S.bottomZ + 0.2 && P.grounded) {
      maxClimb = Math.max(maxClimb, P.climb);
      maxLean = Math.max(maxLean, P.lean);
      if (P.climb > 0.5) minClimbSpeed = Math.min(minClimbSpeed, P.speed);
      if (centreInsideAny()) pierced = true;
    }
    if (P.state === "air") airUp++;
    maxPhysUp = Math.max(maxPhysUp, Math.abs(P.pos.y - prevPhysUp));
    prevPhysUp = P.pos.y;
    if (prevVisualUp != null) maxVisualUp = Math.max(maxVisualUp, Math.abs(mannequin.position.y - prevVisualUp));
    prevVisualUp = mannequin.position.y;
  }
  check("climbs to the tower top", Math.abs(topY - S.top) < 0.01, "top=" + topY.toFixed(3));
  check("climb + lean detected", maxClimb > 0.35 && maxLean > 0.03, "climb=" + maxClimb.toFixed(2) + " lean=" + maxLean.toFixed(3));
  check("uphill slows the player", minClimbSpeed < 1.8, "speed=" + minClimbSpeed.toFixed(2));
  check("never airborne walking up", airUp === 0, "airFrames=" + airUp);
  check("step-up visual is eased", maxVisualUp < 0.1 && maxVisualUp < maxPhysUp * 0.6,
    "visual=" + maxVisualUp.toFixed(3) + " physics=" + maxPhysUp.toFixed(3));
  check("no penetration on stairs", !pierced);

  // ------------------------------------------------------------- descent
  player.reset(); P.pos.set(S.centerX, S.top, -9); player.camYaw = Math.PI;
  let airDown = 0, maxVisualDown = 0, prevVisualDown = null;
  for (let i = 0; i < 480; i++) {
    step(1 / 60, { forward: 1 });
    if (P.state === "air") airDown++;
    if (prevVisualDown != null) maxVisualDown = Math.max(maxVisualDown, Math.abs(mannequin.position.y - prevVisualDown));
    prevVisualDown = mannequin.position.y;
  }
  check("descends without air flicker", airDown === 0, "airFrames=" + airDown);
  check("step-down visual is eased", maxVisualDown < 0.1, "visual=" + maxVisualDown.toFixed(3));
  check("reaches the arena floor", P.pos.y < 0.01 && P.pos.z > 0, "y=" + P.pos.y.toFixed(3) + " z=" + P.pos.z.toFixed(1));
  check("climb decays on flat", Math.abs(P.climb) < 0.12, "climb=" + P.climb.toFixed(2));

  // --------------------------------------------------- very small timestep
  player.reset(); P.pos.set(S.centerX, 0, 1); player.camYaw = 0;
  let slowTop = 0, slowAir = 0;
  for (let i = 0; i < 1800; i++) {
    step(1 / 240, { forward: 1 });
    slowTop = Math.max(slowTop, P.pos.y);
    if (P.state === "air") slowAir++;
  }
  check("tiny timestep still climbs", slowTop > S.top - 0.01 && slowAir === 0,
    "top=" + slowTop.toFixed(3) + " air=" + slowAir);

  // ------------------------------------------------------------- ramp + rock
  const ramp = arena.slopes.find((s) => s.name === "ramp");
  const rock = arena.slopes.find((s) => s.name === "rock");
  check("ramp and rock exist", !!ramp && !!rock && arena.slopes.length === 2, "slopes=" + arena.slopes.length);
  check("ramp is 1.18 m over 6 m",
    ramp && Math.abs(ramp.height(-13, 1.5) - 1.2) < 1e-6 &&
    Math.abs(ramp.height(-13, 7.5) - 0.02) < 0.01 && ramp.normal.y > 0.9,
    ramp ? "rise=" + (ramp.height(-13, 1.5) - ramp.height(-13, 7.5)).toFixed(2) + " ny=" + ramp.normal.y.toFixed(3) : "missing");
  check("rock top is a slope",
    rock && rock.height(5, -19.2) - rock.height(5, -16.5) > 0.5 && rock.normal.y > 0.9,
    rock ? "drop=" + (rock.height(5, -19.2) - rock.height(5, -16.5)).toFixed(2) + " ny=" + rock.normal.y.toFixed(3) : "missing");

  player.reset(); P.pos.set(-17, 0, 7.8); P.vel.set(0, 0, 0); player.camYaw = 0;
  let rampAir = 0, rampTop = 0, rampFrames = 0;
  while (rampFrames < 400 && P.pos.y < 1.15) {
    step(1 / 60, { forward: 1 });
    rampTop = Math.max(rampTop, P.pos.y);
    if (P.state === "air") rampAir++;
    rampFrames++;
  }
  check("walks up the ramp", P.pos.y >= 1.15 && rampAir === 0,
    "top=" + rampTop.toFixed(2) + " air=" + rampAir + " frames=" + rampFrames);

  player.reset(); P.pos.set(5.2, 0, -15.6); P.vel.set(0, 0, 0); player.camYaw = 0;
  sim({ forward: 1 }, 1.4);
  check("walks onto the sloped rock", P.pos.y > 0.15 && P.pos.y < 0.85 && P.grounded,
    "y=" + P.pos.y.toFixed(2) + " z=" + P.pos.z.toFixed(1));

  player.reset(); P.pos.set(-15.2, 0, 3.0); P.vel.set(0, 0, 0); player.camYaw = Math.PI / 2;
  sim({ forward: 1 }, 1.4);
  check("ramp side blocks at floor level", P.pos.x > -15.9 && P.pos.y < 0.02,
    "x=" + P.pos.x.toFixed(2) + " y=" + P.pos.y.toFixed(2));

  // ---------------------------------------------------------- step blocks
  player.reset(); P.pos.set(-2, 0, 21); player.camYaw = 0;
  let stepY = 0;
  for (let i = 0; i < 140; i++) { step(1 / 60, { forward: 1 }); stepY = Math.max(stepY, P.pos.y); }
  check("step-up climbs blocks", stepY > 0.5, "maxY=" + stepY.toFixed(2));

  // ---------------------------------------------------------------- camera
  player.reset();
  sim({ forward: 1, sprint: true }, 4);
  check("camera above floor", camera.position.y > 0.2, "camY=" + camera.position.y.toFixed(2));
  check("camera follows", B.Vector3.Distance(camera.position, P.pos) < 6, "dist=" + B.Vector3.Distance(camera.position, P.pos).toFixed(2));

  // Looking up drops the camera behind the character; across the ramp's far
  // side the sight line must pull in instead of passing through the wedge.
  player.reset();
  P.pos.set(-14.9, 0, 4.0);
  player.camYaw = -Math.PI / 2;
  player.camPitch = -0.22;
  sim({}, 1.5);
  const head = new B.Vector3(P.pos.x, P.pos.y + 1.42, P.pos.z);
  let throughRamp = false;
  for (let i = 1; i <= 24; i++) {
    const t = i / 24;
    const x = head.x + (camera.position.x - head.x) * t;
    const y = head.y + (camera.position.y - head.y) * t;
    const z = head.z + (camera.position.z - head.z) * t;
    if (ramp.contains(x, z) && y < ramp.height(x, z)) throughRamp = true;
  }
  check("camera does not see through the ramp", !throughRamp,
    "cam=(" + camera.position.x.toFixed(2) + "," + camera.position.y.toFixed(2) + ")");
  check("camera arm pulls in at the ramp", B.Vector3.Distance(camera.position, head) < 4.1,
    "arm=" + B.Vector3.Distance(camera.position, head).toFixed(2));

  // ------------------------------------------------------ catwalk falling
  const CW_TOP = S.top + 0.35;
  player.reset();
  P.pos.set(2, CW_TOP, -12); P.vel.set(0, 0, 0); player.camYaw = -Math.PI / 2;
  sim({ forward: 1, sprint: true }, 1.8);
  check("can run off the catwalk end", P.pos.x > 4 && P.pos.y < 0.05 && P.grounded,
    "x=" + P.pos.x.toFixed(2) + " y=" + P.pos.y.toFixed(2));

  player.reset();
  P.pos.set(0, CW_TOP, -12); P.vel.set(0, 0, 0); player.camYaw = 0;
  for (let i = 0; i < 120; i++) step(1 / 60, { forward: 1, jump: i === 12 });
  check("can jump the catwalk rail", P.pos.z < -13.1 && P.pos.y < 0.05,
    "z=" + P.pos.z.toFixed(2) + " y=" + P.pos.y.toFixed(2));

  // --------------------------------------------------- standing on an edge
  // A shallow edge is a straddle: the centre can pass it while a foot stays
  // on the step and the other leg reaches the lower surface.
  player.reset();
  P.pos.set(-2, 0.4, 19.15); P.vel.set(0, 0, 0); player.camYaw = Math.PI;
  sim({}, 0.6);
  check("straddles a shallow step edge",
    P.grounded && Math.abs(P.pos.y - 0.4) < 0.02,
    "y=" + P.pos.y.toFixed(2) + " grounded=" + P.grounded);

  // A tall ledge must not hold the body up: hovering on one leg with the
  // other dangling in the air is the pose that looked broken on the ramp.
  player.reset();
  P.pos.set(16, 1.2, -1.9); P.vel.set(0, 0, 0); player.camYaw = Math.PI;
  sim({}, 0.9);
  check("falls from a tall ledge instead of hovering",
    P.grounded && P.pos.y < 0.05,
    "y=" + P.pos.y.toFixed(2) + " grounded=" + P.grounded);

  player.reset();
  P.pos.set(16, 1.2, -2.3); P.vel.set(0, 0, 0); player.camYaw = Math.PI;
  let prevEdgeZ = P.pos.z, maxEdgeJump = 0;
  for (let i = 0; i < 90; i++) {
    step(1 / 60, { forward: 1 });
    maxEdgeJump = Math.max(maxEdgeJump, Math.abs(P.pos.z - prevEdgeZ));
    prevEdgeZ = P.pos.z;
  }
  check("leaving a ledge does not shove the body sideways",
    maxEdgeJump < 0.12 && P.pos.y < 0.05,
    "maxDz=" + maxEdgeJump.toFixed(3) + " y=" + P.pos.y.toFixed(2));

  // ------------------------------------------------------- shooter controls
  player.reset();
  P.pos.set(0, 0, 10);
  player.camYaw = 0;
  sim({}, 0.5);
  const camFwd = new B.Vector3(-Math.sin(player.camYaw), 0, -Math.cos(player.camYaw));
  const camRight = new B.Vector3(camFwd.z, 0, -camFwd.x);
  mannequin.computeWorldMatrix(true);
  const meshFwd = B.Vector3.TransformNormal(B.Axis.Z, mannequin.getWorldMatrix());
  check("character faces the camera forward",
    meshFwd.x * camFwd.x + meshFwd.z * camFwd.z > 0.99 && Math.abs(P.facing - Math.PI) < 0.03,
    "mesh dot=" + (meshFwd.x * camFwd.x + meshFwd.z * camFwd.z).toFixed(3));

  const d0 = P.pos.clone();
  sim({ right: 1 }, 0.55);
  const dMove = P.pos.subtract(d0);
  check("D strafes to the camera's right", dMove.x * camRight.x + dMove.z * camRight.z > 0.4,
    "dot=" + (dMove.x * camRight.x + dMove.z * camRight.z).toFixed(2));
  check("strafing does not turn the body", Math.abs(P.facing - Math.PI) < 0.03,
    "facing=" + P.facing.toFixed(2));

  const s0 = P.pos.clone();
  sim({ forward: -1 }, 0.55);
  check("S backs up while facing forward",
    Math.abs(P.facing - Math.PI) < 0.03 &&
    (P.pos.x - s0.x) * camFwd.x + (P.pos.z - s0.z) * camFwd.z < -0.3,
    "facing=" + P.facing.toFixed(2));

  // ---------------------------------------------------------------- foot IK
  const skinned = r.meshes.find((m) => m.skeleton);
  let groundedFlag = true;
  const ik = global.createFootIK(scene, {
    colliders: arena.colliders,
    slopes: arena.slopes,
    mesh: skinned,
    getState: () => ({ grounded: groundedFlag }),
  });
  check("foot IK initialises", !!ik, ik ? "leg bones found" : "missing bones");
  check("after-animation hook available", !!scene.onAfterAnimationsObservable, "scene.onAfterAnimationsObservable");

  const walkGroup = scene.animationGroups.find((g) => g.name === "Walk_Loop");
  walkGroup.weight = 1;
  const boneOf = (n) => scene.skeletons[0].bones.find((b) => b.name === n);
  const boneWorld = (name) => B.Vector3.TransformCoordinates(
    boneOf(name).getAbsolutePosition(), skinned.getWorldMatrix());
  const footWorld = (side) => boneWorld("DEF-foot." + side);
  const ballWorld = (side) => boneWorld("DEF-toe." + side);
  const ikStep = () => {
    walkGroup.goToFrame(10);
    scene.skeletons[0].prepare();
    ik.update(1 / 60);
  };

  mannequin.position.set(0, -0.08, 8);
  mannequin.rotationQuaternion = B.Quaternion.Identity();
  mannequin.computeWorldMatrix(true);
  ik.reset();
  for (let i = 0; i < 12; i++) ikStep();
  const flatSide = ik.stats.left.weight >= ik.stats.right.weight ? "left" : "right";
  const flatTag = flatSide === "left" ? "L" : "R";
  const flat = ik.stats[flatSide];
  const flatAnkle = footWorld(flatTag), flatBall = ballWorld(flatTag);
  check("IK finds the floor", flat.ground != null && Math.abs(flat.ground) < 1e-3, "ground=" + flat.ground);
  check("IK plants the support ankle", Math.abs(flatAnkle.y - (flat.ground + 0.104)) < 0.03, "ankleY=" + flatAnkle.y.toFixed(3));
  check("sole keeps its bind angle on the floor",
    Math.abs((flatBall.y - flatAnkle.y) - bindDip) < 0.03,
    "dip=" + (flatBall.y - flatAnkle.y).toFixed(3) + " bind=" + bindDip.toFixed(3));

  mannequin.position.set(S.centerX, S.rise - 0.12, -1.282);
  mannequin.computeWorldMatrix(true);
  ik.reset();
  for (let i = 0; i < 12; i++) ikStep();
  const stairSide = ik.stats.left.weight >= ik.stats.right.weight ? "left" : "right";
  const stairTag = stairSide === "left" ? "L" : "R";
  const stair = ik.stats[stairSide];
  const stairAnkle = footWorld(stairTag);
  check("IK finds a stair tread", stair.ground != null && stair.ground > S.rise - 0.01, "ground=" + stair.ground);
  check("IK lifts the foot onto the tread", stair.ground != null && Math.abs(stairAnkle.y - (stair.ground + 0.104)) < 0.04,
    "ankleY=" + stairAnkle.y.toFixed(3) + " target=" + (stair.ground + 0.104).toFixed(3));
  check("pelvis drop stays bounded", ik.stats.pelvisDrop >= 0 && ik.stats.pelvisDrop <= 0.46, "drop=" + ik.stats.pelvisDrop.toFixed(3));

  groundedFlag = false;
  ik.reset();
  mannequin.position.set(0, 0.6, 8);
  mannequin.computeWorldMatrix(true);
  skinned.computeWorldMatrix(true);
  walkGroup.goToFrame(10);
  scene.skeletons[0].prepare();
  const airBefore = footWorld("L").clone();
  for (let i = 0; i < 6; i++) ik.update(1 / 60);
  check("IK leaves airborne feet alone", B.Vector3.Distance(airBefore, footWorld("L")) < 1e-3,
    "moved=" + B.Vector3.Distance(airBefore, footWorld("L")).toFixed(4));

  // stand on the tower edge with one foot over a 3 m drop: it must step in
  groundedFlag = true;
  ik.reset();
  if (scene.skeletons[0].returnToRest) scene.skeletons[0].returnToRest();
  mannequin.position.set(-18, S.top, -12);
  mannequin.rotationQuaternion = B.Quaternion.Identity();
  mannequin.computeWorldMatrix(true);
  skinned.computeWorldMatrix(true);
  for (let i = 0; i < 60; i++) ik.update(1 / 60);
  const ledgeAnkles = [footWorld("L"), footWorld("R")];
  const ledgeFeet = [ik.stats.left, ik.stats.right];
  check("ledge foot finds the platform", ledgeFeet.some((f) => f.footing),
    JSON.stringify(ledgeFeet.map((f) => ({ ground: f.ground, footing: f.footing }))));
  check("no floating foot on the ledge",
    ledgeAnkles.every((a) => Math.abs(a.y - (S.top + 0.104)) < 0.04),
    "ankleY=" + ledgeAnkles.map((a) => a.y.toFixed(3)).join(","));
  check("ledge foot is pulled onto the tower",
    ledgeAnkles.every((a) => a.x > -18.02 && a.x < -17.85),
    "ankleX=" + ledgeAnkles.map((a) => a.x.toFixed(3)).join(","));

  // stand on the floor beside stepLow with one foot on the tread and one on
  // the floor: both must plant, the raised one without being pulled down
  groundedFlag = true;
  ik.reset();
  if (scene.skeletons[0].returnToRest) scene.skeletons[0].returnToRest();
  mannequin.rotationQuaternion = B.Quaternion.Identity();
  mannequin.position.set(-1.05, 0, 19.4);
  mannequin.computeWorldMatrix(true);
  skinned.computeWorldMatrix(true);
  for (let i = 0; i < 60; i++) ik.update(1 / 60);
  const straddleL = footWorld("L"), straddleR = footWorld("R");
  check("step straddle plants the raised foot",
    ik.stats.left.ground > 0.15 && Math.abs(straddleL.y - 0.304) < 0.03 && ik.stats.left.weight > 0.8,
    "ground=" + (ik.stats.left.ground || 0).toFixed(2) + " ankleY=" + straddleL.y.toFixed(3) + " w=" + ik.stats.left.weight);
  check("step straddle keeps the lower foot on the floor",
    ik.stats.right.ground != null && ik.stats.right.ground < 0.01 && Math.abs(straddleR.y - 0.104) < 0.03 && ik.stats.right.weight > 0.8,
    "ground=" + (ik.stats.right.ground != null ? ik.stats.right.ground.toFixed(2) : "null") + " ankleY=" + straddleR.y.toFixed(3) + " w=" + ik.stats.right.weight);

  // standing on the step with the other foot stretched down to the floor: the
  // pelvis sinks and that foot reaches the floor instead of being pulled up
  ik.reset();
  if (scene.skeletons[0].returnToRest) scene.skeletons[0].returnToRest();
  mannequin.rotationQuaternion = B.Quaternion.Identity();
  mannequin.position.set(-1.05, 0.2, 19.4);
  mannequin.computeWorldMatrix(true);
  skinned.computeWorldMatrix(true);
  for (let i = 0; i < 120; i++) ik.update(1 / 60);
  const stretchL = footWorld("L"), stretchR = footWorld("R");
  check("lower foot stretches down from the step",
    Math.abs(stretchR.y - 0.104) < 0.03 && Math.abs(stretchL.y - 0.304) < 0.03 &&
    ik.stats.right.weight > 0.8 && ik.stats.left.weight > 0.8 && ik.stats.pelvisDrop > 0.12,
    "ankleY=" + stretchL.y.toFixed(3) + "," + stretchR.y.toFixed(3) + " drop=" + ik.stats.pelvisDrop.toFixed(3));

  // feet on the sloped ramp and rock: height follows the surface, sole tips to
  // the surface normal, toe lies in the plane
  const ikOnSlope = (slope, x, z) => {
    ik.reset();
    if (scene.skeletons[0].returnToRest) scene.skeletons[0].returnToRest();
    mannequin.rotationQuaternion = B.Quaternion.Identity();
    mannequin.position.set(x, slope.height(x, z), z);
    mannequin.computeWorldMatrix(true);
    skinned.computeWorldMatrix(true);
    for (let i = 0; i < 60; i++) ik.update(1 / 60);
    const side = ik.stats.left.weight >= ik.stats.right.weight ? "left" : "right";
    const tag = side === "left" ? "L" : "R";
    const ankle = footWorld(tag), toe = ballWorld(tag);
    const st = ik.stats[side];
    const n = st.normal;
    const surf = st.ground == null ? null : slope.height(ankle.x, ankle.z);
    const toePlane = (toe.x - ankle.x) * n.x + (toe.y - ankle.y) * n.y + (toe.z - ankle.z) * n.z;
    return { st, ankle, n, surf, toePlane };
  };
  const rampFoot = ikOnSlope(ramp, -17, 4.5);
  check("foot follows the ramp height",
    rampFoot.surf != null && Math.abs(rampFoot.st.ground - rampFoot.surf) < 0.03,
    "ground=" + (rampFoot.st.ground || 0).toFixed(3) + " surface=" + (rampFoot.surf || 0).toFixed(3));
  check("ramp ankle sits off the slope normal",
    Math.abs(rampFoot.ankle.y - (rampFoot.st.ground + 0.104 * rampFoot.n.y)) < 0.02 && rampFoot.n.y < 0.995,
    "ankleY=" + rampFoot.ankle.y.toFixed(3) + " ny=" + rampFoot.n.y.toFixed(3));
  check("ramp sole follows the surface normal",
    Math.abs(rampFoot.toePlane) < 0.035 && rampFoot.toePlane !== 0,
    "toePlane=" + rampFoot.toePlane.toFixed(3));

  const rockFoot = ikOnSlope(rock, 5.2, -18);
  check("foot follows the rock height",
    rockFoot.surf != null && Math.abs(rockFoot.st.ground - rockFoot.surf) < 0.03,
    "ground=" + (rockFoot.st.ground || 0).toFixed(3) + " surface=" + (rockFoot.surf || 0).toFixed(3));
  check("rock sole follows the surface normal",
    Math.abs(rockFoot.toePlane) < 0.035 && rockFoot.n.y < 0.995,
    "toePlane=" + rockFoot.toePlane.toFixed(3) + " ny=" + rockFoot.n.y.toFixed(3));

  let pass = 0;
  for (const [name, ok, detail] of results) {
    console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  (" + detail + ")" : ""));
    if (ok) pass++;
  }
  console.log(pass + "/" + results.length + " checks passed | anim groups " + scene.animationGroups.length + " | colliders " + arena.colliders.length);
  if (pass !== results.length) process.exitCode = 1;
})().catch((e) => { console.log("FAILED:", e.message, (e.stack || "").split("\n")[1]); process.exit(1); });
