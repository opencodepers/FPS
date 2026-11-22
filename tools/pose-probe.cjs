// Applies a clip's glTF keyframes onto the Babylon skeleton and prints where
// the arms actually are, in mesh space (Y up, character at the origin).
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

const CLIP = process.argv[2] || "Pistol_Aim_Neutral";
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

function valueAt(track, time) {
  const n = track.c, times = track.t;
  let i = 0;
  while (i < times.length - 1 && times[i + 1] < time) i++;
  const t0 = times[i], t1 = times[Math.min(i + 1, times.length - 1)];
  const f = t1 > t0 ? Math.min(1, Math.max(0, (time - t0) / (t1 - t0))) : 0;
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = track.v[i * n + k];
    const b = track.v[Math.min(i + 1, times.length - 1) * n + k];
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
  const byName = new Map(skel.bones.map((b) => [b.name, b]));
  const anim = gltf.animations.find((a) => a.name === CLIP);
  if (!anim) { console.log("missing clip", CLIP); process.exit(1); }
  const tracks = anim.channels.map((ch) => {
    const s = anim.samplers[ch.sampler];
    return { node: ch.target.node, path: ch.target.path, t: readAccessor(s.input).v, v: readAccessor(s.output).v, c: readAccessor(s.output).c };
  });
  const end = Math.max(...tracks.map((tr) => tr.t[tr.t.length - 1]));
  const names = ["DEF-hips", "DEF-spine.003", "DEF-upper_arm.R", "DEF-forearm.R", "DEF-hand.R", "DEF-upper_arm.L", "DEF-forearm.L", "DEF-hand.L"];
  for (const t of [0, end * 0.5]) {
    for (const tr of tracks) {
      const bone = byName.get(gltf.nodes[tr.node].name);
      if (!bone) continue;
      const val = valueAt(tr, t);
      if (tr.path === "translation") bone.setPosition(new B.Vector3(val[0], val[1], val[2]));
      else if (tr.path === "rotation") bone.setRotationQuaternion(new B.Quaternion(val[0], val[1], val[2], val[3]));
      else if (tr.path === "scale") bone.setScale(new B.Vector3(val[0], val[1], val[2]));
    }
    skel.prepare();
    const p = (n) => byName.get(n).getAbsolutePosition();
    const hr = p("DEF-hand.R"), hl = p("DEF-hand.L");
    const f = (v) => [v.x.toFixed(3), v.y.toFixed(3), v.z.toFixed(3)].join(", ");
    console.log("\n" + CLIP + " @ t=" + t.toFixed(2) + "s");
    for (const n of names) console.log("  " + n.padEnd(16), f(p(n)));
    console.log("  hand R -> hand L:", f(hl.subtract(hr)), " distance", B.Vector3.Distance(hr, hl).toFixed(3));
  }
})().catch((e) => { console.log("FAILED:", e.message); process.exit(1); });
