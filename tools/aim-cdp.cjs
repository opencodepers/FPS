// Real-time headless probe. Headless --screenshot mode renders a handful of
// frames, far too few for the aim camera or a hold cross-fade to settle, so this
// drives Chrome over CDP instead: real wall-clock waits, real mouse buttons.
//
//   node tools/aim-cdp.cjs <out.png> [url] [--aim] [--hold]
//
// Prints one JSON line "STATE" with camera distance and animation weights.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const args = process.argv.slice(2);
const out = args[0] || "shots/cdp.png";
const url = (args[1] && !args[1].startsWith("--")) ? args[1] : "http://localhost:5173/";
const wantAim = args.includes("--aim");
const wantHold = args.includes("--hold");
const port = 9333;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "aimcdp-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--enable-unsafe-swiftshader", "--use-angle=swiftshader",
  "--window-size=900,700", "--hide-scrollbars",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("chrome devtools never answered");
}

(async () => {
  const ws = new WebSocket(await target());
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg.error); pending.delete(msg.id); return; }
    if (msg.method === "Runtime.consoleAPICalled") logs.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    if (msg.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + msg.params.exceptionDetails.text);
  });
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url });
  await sleep(6000); // GLB decode + first pose

  const evalJson = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result ? r.result.value : null;
  };
  const state = () => evalJson(`(() => {
    const a = window.__anim, p = window.__player;
    if (!a || !p) return { ready: false };
    const g = {}; for (const k in a.groups) g[k] = a.groups[k] ? +a.groups[k].weight.toFixed(2) : null;
    return { ready: true, aim: p.aim !== undefined ? +p.aim.toFixed(2) : -1, groups: g,
      hold: a.hold ? +a.hold.weight.toFixed(2) : null,
      holdRun: a.holdRun ? +a.holdRun.weight.toFixed(2) : null,
      runHold: a.runHold ? +a.runHold().toFixed(2) : null,
      lean: p.state.turnLean,
      ammo: (document.getElementById("ammo") || {}).textContent || null,
      toast: (document.getElementById("toast") || {}).className || null,
      weapon: window.__weapon ? window.__weapon.state() : null };
  })()`);

  if (args.includes("--look")) {
    // Mouse look: the only thing aiming adds to the render loop is camYaw motion,
    // and that is where a bad number would turn the pose into garbage.
    // Report the peak lateral lean reached while the camera spins, so the turn
    // lean amplitude can be read as a number instead of guessed from a still.
    const peak = await evalJson('(() => { let i = 0, peak = 0; return new Promise((r) => { const t = setInterval(() => { window.__player.camYaw += 0.12; peak = Math.max(peak, Math.abs(window.__player.state.turnLean)); if (++i > 20) { clearInterval(t); r(+peak.toFixed(4)); } }, 30); }); })()');
    console.log("LEANMAX " + peak);
    await sleep(800);
  }
  if (args.includes("--move")) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 });
    await sleep(1500);
  }
  // A human clicks the canvas first (pointer lock), and that click is also a
  // shot in the real game, so reproduce it: lock, then hold F, then fire.
  if (args.includes("--lock")) {
    await send("Page.bringToFront");
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 450, y: 380, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 450, y: 380, button: "left", buttons: 0, clickCount: 1 });
    await sleep(400);
    console.log("LOCKED " + JSON.stringify(await evalJson("({ locked: !!document.pointerLockElement, scripts: [...document.scripts].map(s => s.src.split('/').pop()) })")));
  }
  if (wantHold) { await send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyF", key: "f", windowsVirtualKeyCode: 70 }); await sleep(1500); }
  // A fast human click: press and release back-to-back, with no frame in
  // between. Polling a held-button flag at frame rate drops this click.
  if (args.includes("--tap")) {
    await send("Page.bringToFront");
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 450, y: 400, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 450, y: 400, button: "left", buttons: 0, clickCount: 1 });
    await sleep(600);
    console.log("TAP_STATE " + JSON.stringify(await evalJson("({ w: window.__weapon ? window.__weapon.state() : null, gunhint: (document.getElementById('gunhint') || {}).className })")));
  }
  // Firing needs the rifle up, so this runs after --hold.
  if (args.includes("--fire")) {
    await send("Page.bringToFront");
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 450, y: 400, button: "left", buttons: 1, clickCount: 1 });
    await sleep(700);
    if (!(await evalJson("window.__weapon ? window.__weapon.state().shots : 0"))) {
      await evalJson('dispatchEvent(new MouseEvent("mousedown",{button:0,buttons:1,bubbles:true}))');
      await sleep(700);
    }
    const st = await evalJson("window.__weapon ? window.__weapon.state() : null");
    console.log("FIRE_STATE " + JSON.stringify(st));
    console.log("FIRE_LOG " + JSON.stringify(logs.filter((l) => /^FIRE /.test(l)).slice(0, 4)));
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 450, y: 400, button: "left", buttons: 0, clickCount: 1 });
    await evalJson('dispatchEvent(new MouseEvent("mouseup",{button:0,buttons:0,bubbles:true}))');
  }
  if (wantAim) {
    await send("Page.bringToFront");
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 450, y: 400, button: "right", buttons: 2, clickCount: 1 });
    await sleep(1200);
    let a = await evalJson("window.__player && window.__player.aim ? window.__player.aim : -1");
    if (!(a > 0.3)) {
      // CDP mouse input is reliable in headed Chrome only; fall back to the
      // same DOM event the page listens for.
      await evalJson('dispatchEvent(new MouseEvent("mousedown",{button:2,buttons:2,bubbles:true}))');
      await sleep(1800);
      a = await evalJson("window.__player && window.__player.aim ? window.__player.aim : -1");
    }
    console.log("AIM " + a);
  }
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("STATE " + JSON.stringify(await state()));
  const bad = logs.filter((l) => /EXCEPTION|JSERR|missing clip|not defined/i.test(l));
  if (bad.length) console.log("BAD " + JSON.stringify(bad.slice(0, 5)));
  ws.close();
  chrome.kill();
  process.exit(0);
})().catch((err) => { console.error("probe failed:", err.message); chrome.kill(); process.exit(1); });
