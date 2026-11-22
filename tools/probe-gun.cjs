// Probe: bounds and structure of the downloaded rifle, plus the rig's hand bones.
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
  const B = global.BABYLON;
  const scene = new B.Scene(new B.NullEngine());
  const load = async (file) => {
    const url = "data:model/gltf-binary;base64," + fs.readFileSync(file).toString("base64");
    return B.SceneLoader.ImportMeshAsync(null, "", url, scene, null, ".glb");
  };

  const gun = await load("game-ready/pirate_rifle.glb");
  const meshes = gun.meshes.filter((m) => m.getTotalVertices && m.getTotalVertices() > 0);
  console.log("gun meshes: " + meshes.length + ", roots: " + meshes.filter((m) => !m.parent).length);
  const scene2 = new B.Scene(new B.NullEngine());
  const all = [];
  for (const m of meshes) all.push(m.name);
  console.log("gun mesh names: " + all.slice(0, 10).join(", "));
  const { min, max } = meshes[0].getHierarchyBoundingVectors ? meshes[0].getHierarchyBoundingVectors(true) : { min: null, max: null };
  let mn = new B.Vector3(Infinity, Infinity, Infinity), mx = new B.Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of meshes) {
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    mn = B.Vector3.Minimize(mn, bb.minimumWorld);
    mx = B.Vector3.Maximize(mx, bb.maximumWorld);
  }
  console.log("gun bounds min=" + mn.toString() + " max=" + mx.toString());
  console.log("gun size = " + (mx.x - mn.x).toFixed(3) + " x " + (mx.y - mn.y).toFixed(3) + " x " + (mx.z - mn.z).toFixed(3) + " m");
  console.log("gun node names: " + gun.transformNodes.slice(0, 12).map((n) => n.name).join(", "));

  const char = await load("game-ready/quaternius_mannequin.glb");
  const sk = char.meshes.find((m) => m.skeleton);
  console.log("bones with hand/arm: " + sk.skeleton.bones.map((b) => b.name).filter((n) => /hand|arm|wrist|prop|weapon/i.test(n)).join(", "));
})().catch((e) => { console.log("FAILED:", e.message); console.log(e.stack); process.exit(1); });
