// Verifies the rifle-binding math the game uses: mount the baked rifle under a
// node whose transform is copied from the animated DEF-hand.R bone matrix, then
// measure where the rifle ends up at the aim pose.
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
const file = "game-ready/character_rifle.glb";
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
    const a = track.v[i * n + k], b = track.v[Math.min(i + 1, times.length - 1) * n + k];
    out.push(a + (b - a) * f);
  }
  return out;
}

(async () => {
  vm.runInThisContext(fs.readFileSync("vendor/babylon.js", "utf8"));
  vm.runInThisContext(fs.readFileSync("vendor/glTF2FileLoader.js".replace("glTF2FileLoader", "babylon.glTF2FileLoader"), "utf8"));
  const B = global.BABYLON;
  const scene = new B.Scene(new B.NullEngine());
  new B.FreeCamera("cam", new B.Vector3(0, 2, 6), scene);
  const url = "data:model/gltf-binary;base64," + raw.toString("base64");
  const r = await B.SceneLoader.ImportMeshAsync(null, "", url, scene, null, ".glb");
  const skinned = r.meshes.find((m) => m.skeleton);
  const skel = skinned.skeleton;
  const byName = new Map(skel.bones.map((b) => [b.name, b]));
  const rifle = r.meshes.filter((m) => m.getTotalVertices && m.getTotalVertices() > 0 && /Body\.002|Barrel|Scope/i.test(m.name));
  const barrel = rifle.find((m) => /barrel/i.test(m.name));
  const scope = rifle.find((m) => /scope/i.test(m.name));
  const fmt = (v) => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
  const centerOf = (m) => { m.computeWorldMatrix(true); return m.getBoundingInfo().boundingBox.centerWorld.clone(); };
  const center = () => rifle.reduce((a, m) => a.addInPlace(centerOf(m)), new B.Vector3()).scaleInPlace(1 / rifle.length);

  // --- the binding the game performs -------------------------------------
  const rifleRoot = (r.transformNodes || []).find((n) => n.name === "Sketchfab_model");
  const handBone = byName.get("DEF-hand.R");
  const mount = new B.TransformNode("gunMount", scene);
  mount.rotationQuaternion = B.Quaternion.Identity();
  rifleRoot.parent = mount; // local transform is kept: it is bone-relative

  const anim = gltf.animations.find((a) => a.name === CLIP);
  if (!anim) { console.log("missing clip", CLIP); process.exit(1); }
  const tracks = anim.channels.map((ch) => {
    const s = anim.samplers[ch.sampler];
    return { node: ch.target.node, path: ch.target.path, t: readAccessor(s.input).v, v: readAccessor(s.output).v, c: readAccessor(s.output).c };
  });
  const end = Math.max(...tracks.map((tr) => tr.t[tr.t.length - 1]));

  function applyTime(t) {
    for (const tr of tracks) {
      const bone = byName.get(gltf.nodes[tr.node].name);
      if (!bone) continue;
      const val = valueAt(tr, t);
      if (tr.path === "translation") bone.setPosition(new B.Vector3(val[0], val[1], val[2]));
      else if (tr.path === "rotation") bone.setRotationQuaternion(new B.Quaternion(val[0], val[1], val[2], val[3]));
      else if (tr.path === "scale") bone.setScale(new B.Vector3(val[0], val[1], val[2]));
    }
    skel.prepare();
    for (const b of skel.bones) b.computeWorldMatrix(true);
    skinned.computeWorldMatrix(true);
    // the per-frame line from js/main.js
    const m = skinned.getWorldMatrix().multiply(handBone.getAbsoluteMatrix());
    m.decompose(mount.scaling, mount.rotationQuaternion, mount.position);
    for (const b of skel.bones) b.computeWorldMatrix(true);
  }

  // --- which API gives the bone's BIND frame, and does the delta reproduce
  // the baked placement at bind and follow the hand at the aim pose?
  const skinW = skinned.getWorldMatrix().clone();
  const handNode = (r.transformNodes || []).find((n) => n.name === "DEF-hand.R");
  const rifleWorld0 = rifleRoot.getWorldMatrix().clone();
  const abs0 = handBone.getAbsoluteMatrix().clone();
  const fin0 = handBone.getFinalMatrix ? handBone.getFinalMatrix().clone() : null;
  const sc = (m) => B.Vector3.TransformNormal(B.Axis.X, m).length().toFixed(5);
  console.log("\nBIND checks (scale of X axis)");
  console.log("  rifleWorld0 scale", sc(rifleWorld0), " handNode world", handNode ? sc(handNode.getWorldMatrix()) : "-", " handAbs", sc(abs0), " handFinal", fin0 ? sc(fin0) : "-");
  const pw = B.Vector3.TransformCoordinates(B.Vector3.Zero(), rifleWorld0);
  const show = (label, rest) => {
    const off = rest.invert().multiply(skinW.clone().invert().multiply(rifleWorld0));
    const p = B.Vector3.TransformCoordinates(B.Vector3.Zero(), skinW.multiply(rest).multiply(off));
    const d = p.subtract(pw).length();
    console.log(`  ${label}: reproduced (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}) want (${pw.x.toFixed(3)}, ${pw.y.toFixed(3)}, ${pw.z.toFixed(3)}) err ${d.toFixed(4)}`);
    return off;
  };
  console.log("  using handAbs");
  show("abs", abs0);
  global.__offset = fin0 ? show("final", fin0) : show("abs2", abs0);

  for (const t of [0, end * 0.5]) {
    applyTime(t);
    const hand = handBone.getAbsolutePosition();
    const all = center();
    const barrelDir = centerOf(barrel).subtract(all).normalize();
    const upDir = centerOf(scope).subtract(all).normalize();
    const ang = Math.acos(Math.max(-1, Math.min(1, B.Vector3.Dot(barrelDir, B.Axis.Z)))) * 180 / Math.PI;
    console.log(`\n${CLIP} @ t=${t.toFixed(3)}s (bound)`);
    console.log("  hand.R pos     ", fmt(hand));
    console.log("  rifle center   ", fmt(all));
    console.log("  grip->center   ", fmt(all.subtract(hand)), " |dist|", all.subtract(hand).length().toFixed(3));
    console.log("  barrel dir     ", fmt(barrelDir), " (want (0,0,1))  angle", ang.toFixed(1), "deg");
    console.log("  scope dir      ", fmt(upDir), " (want (0,1,0))");
  }
})().catch((e) => { console.log("FAILED:", e.stack || e.message); process.exit(1); });
