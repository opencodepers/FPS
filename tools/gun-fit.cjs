// Measures how the rifle model is actually oriented once Babylon has imported
// it, and verifies the rotation that aims its barrel along the body's forward.
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

function rotationFromTo(a, b) {
  const q = new BABYLON.Quaternion();
  const d = BABYLON.Vector3.Dot(a, b);
  if (d > 0.999999) return BABYLON.Quaternion.Identity();
  if (d < -0.999999) {
    let axis = BABYLON.Vector3.Cross(BABYLON.Axis.Y, a);
    if (axis.lengthSquared() < 1e-6) axis = BABYLON.Vector3.Cross(BABYLON.Axis.X, a);
    BABYLON.Quaternion.RotationAxisToRef(axis.normalize(), Math.PI, q);
    return q;
  }
  const axis = BABYLON.Vector3.Cross(a, b).normalize();
  BABYLON.Quaternion.RotationAxisToRef(axis, Math.acos(Math.min(1, Math.max(-1, d))), q);
  return q;
}

function rotateByQ(v, q) {
  const m = new BABYLON.Matrix();
  BABYLON.Matrix.FromQuaternionToRef(q, m);
  return BABYLON.Vector3.TransformNormal(v, m);
}

function fitAxes(barrel, up) {
  const q1 = rotationFromTo(barrel, BABYLON.Axis.Z);
  const up1 = rotateByQ(up, q1);
  const roll = -Math.atan2(up1.x, up1.y);
  const q2 = new BABYLON.Quaternion();
  BABYLON.Quaternion.RotationAxisToRef(BABYLON.Axis.Z, roll, q2);
  const out = new BABYLON.Quaternion();
  q1.multiplyToRef(q2, out);
  return out;
}

(async () => {
  vm.runInThisContext(fs.readFileSync("vendor/babylon.js", "utf8"));
  vm.runInThisContext(fs.readFileSync("vendor/babylon.glTF2FileLoader.js", "utf8"));
  const B = global.BABYLON;
  const scene = new B.Scene(new B.NullEngine());
  new B.FreeCamera("cam", new B.Vector3(0, 2, 6), scene);
  const url = "data:model/gltf-binary;base64," + fs.readFileSync("game-ready/pirate_rifle.glb").toString("base64");
  const r = await B.SceneLoader.ImportMeshAsync(null, "", url, scene, null, ".glb");
  const meshes = r.meshes.filter((m) => m.getTotalVertices && m.getTotalVertices() > 0);
  for (const m of meshes) m.computeWorldMatrix(true);
  const centerOf = (m) => m.getBoundingInfo().boundingBox.centerWorld.clone();
  const all = meshes.reduce((a, m) => a.addInPlace(centerOf(m)), new B.Vector3()).scaleInPlace(1 / meshes.length);
  const barrelMesh = meshes.find((m) => /barrel/i.test(m.name));
  const scopeMesh = meshes.find((m) => /scope/i.test(m.name));
  const fmt = (v) => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;

  console.log("gun center", fmt(all));
  for (const m of meshes) console.log("  " + m.name.padEnd(32), fmt(centerOf(m)));
  if (!barrelMesh || !scopeMesh) { console.log("missing barrel/scope mesh"); process.exit(1); }
  const barrel = centerOf(barrelMesh).subtract(all).normalize();
  const up = centerOf(scopeMesh).subtract(all).normalize();
  console.log("barrel dir (as imported):", fmt(barrel));
  console.log("scope/up dir (as imported):", fmt(up));
  const q = fitAxes(barrel, up);
  const barrelOut = rotateByQ(barrel, q);
  const upOut = rotateByQ(up, q);
  console.log("after fit: barrel", fmt(barrelOut), "want (0, 0, 1)");
  console.log("after fit: up    ", fmt(upOut), "want (0, 1, 0)");
  console.log("q =", q.x.toFixed(4), q.y.toFixed(4), q.z.toFixed(4), q.w.toFixed(4));
})().catch((e) => { console.log("FAILED:", e.message); process.exit(1); });
