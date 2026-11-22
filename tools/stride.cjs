// Measures a clip's stride: the glTF keyframes are read directly, written onto
// the Babylon bones at each sample time, and the ankle is measured in world
// space. This bypasses the animation groups (whose clock is 0 under NullEngine).
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
global.performance = global.performance || { now: () => Date.now() };

const file = "game-ready/quaternius_mannequin.glb";
const raw = fs.readFileSync(file);
const jsonLen = raw.readUInt32LE(12);
const gltf = JSON.parse(raw.slice(20, 20 + jsonLen).toString("utf8"));
const binStart = 20 + jsonLen + 8;
const COMPS = { SCALAR: 1, VEC3: 3, VEC4: 4 };

function readAccessor(i) {
  const a = gltf.accessors[i];
  const bv = gltf.bufferViews[a.bufferView];
  const c = COMPS[a.type];
  const base = binStart + (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = [];
  for (let k = 0; k < a.count * c; k++) out.push(raw.readFloatLE(base + k * 4));
  return { v: out, c, n: a.count };
}

function localChannels(anim) {
  const tracks = [];
  for (const ch of anim.channels) {
    const s = anim.samplers[ch.sampler];
    const t = readAccessor(s.input);
    const v = readAccessor(s.output);
    tracks.push({ node: ch.target.node, path: ch.target.path, t: t.v, v: v.v, c: v.c });
  }
  return tracks;
}

function valueAt(track, time) {
  const n = track.c;
  const times = track.t;
  let i = 0;
  while (i < times.length - 1 && times[i + 1] < time) i++;
  const t0 = times[i], t1 = times[Math.min(i + 1, times.length - 1)];
  const f = t1 > t0 ? Math.min(1, Math.max(0, (time - t0) / (t1 - t0))) : 0;
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = track.v[i * n + k];
    const b = track.v[Math.min(i + 1, track.t.length - 1) * n + k];
    out.push(a + (b - a) * f);
  }
  return out;
}

(async () => {
  vm.runInThisContext(fs.readFileSync("vendor/babylon.js", "utf8"));
  vm.runInThisContext(fs.readFileSync("vendor/babylon.glTF2FileLoader.js", "utf8"));
  const B = global.BABYLON;
  const scene = new B.Scene(new B.NullEngine());
  new B.FreeCamera("cam", new B.Vector3(0, 2, 6), scene);
  const url = "data:model/gltf-binary;base64," + raw.toString("base64");
  const r = await B.SceneLoader.ImportMeshAsync(null, "", url, scene, null, ".glb");
  const skinned = r.meshes.find((m) => m.skeleton);
  const skel = skinned.skeleton;
  skinned.computeWorldMatrix(true);
  const byName = new Map(skel.bones.map((b) => [b.name, b]));
  const foot = byName.get("DEF-foot.L");
  const toe = byName.get("DEF-toe.L");
  const nodeName = (i) => gltf.nodes[i].name;

  for (const name of ["Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop"]) {
    const anim = gltf.animations.find((a) => a.name === name);
    const tracks = localChannels(anim);
    const end = Math.max(...tracks.map((tr) => tr.t[tr.t.length - 1]));
    const N = 48;
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9, minY = 1e9, maxY = -1e9;
    const pos = [];
    for (let i = 0; i <= N; i++) {
      const time = (i / N) * end;
      for (const tr of tracks) {
        const bone = byName.get(nodeName(tr.node));
        if (!bone) continue;
        const val = valueAt(tr, time);
        if (tr.path === "translation") bone.setPosition(new B.Vector3(val[0], val[1], val[2]));
        else if (tr.path === "rotation") bone.setRotationQuaternion(new B.Quaternion(val[0], val[1], val[2], val[3]));
        else if (tr.path === "scale") bone.setScale(new B.Vector3(val[0], val[1], val[2]));
      }
      skel.prepare();
      const p = foot.getAbsolutePosition().clone();
      pos.push(p);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const spanX = maxX - minX, spanZ = maxZ - minZ;
    const span = Math.max(spanX, spanZ);
    // During stance the planted foot slides backwards at exactly the speed the
    // clip was authored for. Take those frames (ankle near its lowest) and
    // average the horizontal velocity.
    const dt = end / N;
    const speeds = [];
    for (let i = 1; i < pos.length; i++) {
      if (pos[i].y > minY + 0.04 && pos[i - 1].y > minY + 0.04) continue;
      speeds.push(Math.hypot(pos[i].x - pos[i - 1].x, pos[i].z - pos[i - 1].z) / dt);
    }
    speeds.sort((a, b) => a - b);
    const stance = speeds.length ? speeds[Math.floor(speeds.length / 2)] : 0;
    console.log(name + ": " + end.toFixed(2) + "s | ankle x " + spanX.toFixed(3) + " z " + spanZ.toFixed(3) +
      " | stride " + span.toFixed(3) + " m | stride/cycle " + (span / end).toFixed(2) +
      " | stance speed " + stance.toFixed(2) + " m/s | ankle y " + minY.toFixed(3) + ".." + maxY.toFixed(3) +
      " | stance frames " + speeds.length);
  }
})().catch((e) => { console.log("FAILED:", e.message, e.stack); process.exit(1); });
