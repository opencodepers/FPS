// Blockout test arena: everything is an axis-aligned box so the player
// controller can resolve collisions cheaply and predictably.
(() => {
  "use strict";

  function gridTexture(scene) {
    const S = 256;
    const data = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const major = x % 128 === 0 || y % 128 === 0;
        const line = x % 32 === 0 || y % 32 === 0;
        const c = major ? [138, 166, 184] : line ? [118, 146, 164] : [96, 126, 144];
        const i = (y * S + x) * 4;
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
      }
    }
    const tex = new BABYLON.RawTexture(
      data, S, S, BABYLON.Engine.TEXTUREFORMAT_RGBA, scene, false, false,
      BABYLON.Texture.NEAREST_SAMPLINGMODE,
    );
    tex.uScale = 11;
    tex.vScale = 11;
    tex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    return tex;
  }

  function build(scene) {
    const colliders = [];
    const meshes = [];

    const mat = (name, hex, roughness = 0.85) => {
      const m = new BABYLON.PBRMaterial(name, scene);
      m.albedoColor = BABYLON.Color3.FromHexString(hex);
      m.metallic = 0;
      m.roughness = roughness;
      m.environmentIntensity = 0;
      return m;
    };
    const MAT = {
      wall: mat("matWall", "#d6d9dd", 0.92),
      wallDark: mat("matWallDark", "#b9c0c8", 0.9),
      crate: mat("matCrate", "#e0a13a", 0.65),
      crateDark: mat("matCrateDark", "#c8862a", 0.7),
      accent: mat("matAccent", "#2f5d73", 0.75),
      rail: mat("matRail", "#9aa6b2", 0.45),
      ramp: mat("matRamp", "#c9ced4", 0.9),
      rock: mat("matRock", "#7f776e", 0.97),
    };
    MAT.ramp.backFaceCulling = false;
    MAT.rock.backFaceCulling = false;

    const register = (mesh, collide = true) => {
      mesh.receiveShadows = true;
      meshes.push(mesh);
      if (collide) {
        mesh.computeWorldMatrix(true);
        const bb = mesh.getBoundingInfo().boundingBox;
        colliders.push({ min: bb.minimumWorld.clone(), max: bb.maximumWorld.clone(), mesh });
      }
      return mesh;
    };

    // y is the bottom of the box
    const box = (name, w, h, d, x, y, z, material, collide = true) => {
      const m = BABYLON.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
      m.position.set(x, y + h / 2, z);
      m.material = material;
      return register(m, collide);
    };

    // ---------------------------------------------------------------- ground
    const floorMat = new BABYLON.PBRMaterial("matFloor", scene);
    floorMat.albedoTexture = gridTexture(scene);
    floorMat.metallic = 0;
    floorMat.roughness = 0.96;
    floorMat.environmentIntensity = 0;
    box("floor", 46, 1, 46, 0, -1, 0, floorMat);

    // ---------------------------------------------------------------- shell
    const W = 23;
    box("wallNorth", 46, 6, 1, 0, 0, -W, MAT.wall);
    box("wallSouth", 46, 6, 1, 0, 0, W, MAT.wall);
    box("wallWest", 1, 6, 46, -W, 0, 0, MAT.wall);
    box("wallEast", 1, 6, 46, W, 0, 0, MAT.wall);

    // ---------------------------------------------------------------- tower + stairs
    // Human stair proportions: 7 in rise (0.1778 m) and 11 in tread
    // (0.2794 m), so 2R + T = 0.635 m (25 in, the comfortable range).
    // Dimensions are uniform; two flights of 8 and 9 rises are split by a
    // 1.2 m landing, putting the tower top at 17 rises = 3.02 m.
    const RISE = 0.1778;
    const TREAD = 0.2794;
    const STEPS_LOWER = 8;
    const STEPS_UPPER = 9;
    const STEPS_TOTAL = STEPS_LOWER + STEPS_UPPER;
    const LANDING_DEPTH = 1.2;
    const STAIR_X = -12;
    const STAIR_W = 3;
    const TOWER_FRONT_Z = -7.0;
    const TOP_Y = STEPS_TOTAL * RISE;
    const LANDING_Y = STEPS_LOWER * RISE;

    // Layout is measured down from the tower face so the top tread meets it.
    const landingBack = TOWER_FRONT_Z + STEPS_UPPER * TREAD;
    const landingFront = landingBack + LANDING_DEPTH;
    const stairBottomZ = landingFront + STEPS_LOWER * TREAD;

    box("tower", 12, TOP_Y, 10, -12, 0, -12, MAT.wallDark);

    const nosing = (name, y, z) =>
      box(name, STAIR_W + 0.05, 0.026, 0.05, STAIR_X, y, z, MAT.accent, false);

    const stepMesh = (k, zFront) => {
      const h = k * RISE;
      const m = box("step" + k, STAIR_W, h, TREAD, STAIR_X, 0, zFront - TREAD / 2, MAT.wall);
      nosing("nose" + k, h - 0.026, zFront - 0.012);
      return m;
    };

    for (let k = 1; k <= STEPS_LOWER; k++) stepMesh(k, stairBottomZ - (k - 1) * TREAD);
    box("stairLanding", STAIR_W, LANDING_Y, LANDING_DEPTH, STAIR_X, 0, (landingFront + landingBack) / 2, MAT.wall);
    nosing("landingNose", LANDING_Y - 0.026, landingFront - 0.012);
    for (let j = 1; j <= STEPS_UPPER; j++) stepMesh(STEPS_LOWER + j, landingBack - (j - 1) * TREAD);

    // Handrails, balusters and landing rails are visual only: colliders stay
    // axis-aligned boxes so the controller's step tests remain exact.
    const RAIL_H = 0.9;
    const railX = [STAIR_X - STAIR_W / 2 - 0.07, STAIR_X + STAIR_W / 2 + 0.07];

    const flightRail = (tag, zBottom, zTop, yBottom, yTop, nosings) => {
      const run = zBottom - zTop;
      const rise = yTop - yBottom;
      const angle = Math.atan2(rise, run);
      const midZ = (zBottom + zTop) / 2;
      const midY = (yBottom + yTop) / 2 + RAIL_H;
      for (const x of railX) {
        const rail = box("rail" + tag, 0.09, 0.09, Math.hypot(run, rise), x, midY - 0.045, midZ, MAT.rail, false);
        rail.rotation.x = angle;
        for (const [z, y] of [[zBottom, yBottom], [zTop, yTop]]) {
          box("post" + tag, 0.1, RAIL_H + 0.06, 0.1, x, y, z, MAT.rail, false);
        }
        for (const s of nosings) {
          const t = (zBottom - s.z) / run;
          const h = yBottom + RAIL_H + t * rise - 0.045 - s.y;
          if (h > 0.06) box("bal" + tag, 0.045, h, 0.045, x, s.y, s.z, MAT.rail, false);
        }
      }
    };

    const lowerNosings = [];
    for (let k = 1; k <= STEPS_LOWER; k++) lowerNosings.push({ z: stairBottomZ - (k - 1) * TREAD, y: k * RISE });
    const upperNosings = [];
    for (let j = 1; j <= STEPS_UPPER; j++) upperNosings.push({ z: landingBack - (j - 1) * TREAD, y: (STEPS_LOWER + j) * RISE });

    flightRail("Lower", stairBottomZ, landingFront, RISE, LANDING_Y, lowerNosings);
    flightRail("Upper", landingBack, TOWER_FRONT_Z, (STEPS_LOWER + 1) * RISE, TOP_Y, upperNosings);
    for (const x of railX) {
      box("railLanding", 0.09, 0.09, LANDING_DEPTH, x, LANDING_Y + RAIL_H - 0.045, (landingFront + landingBack) / 2, MAT.rail, false);
    }

    // catwalk off the tower
    box("catwalk", 10, 0.35, 2, -1, TOP_Y, -12, MAT.wall);
    box("railNorth", 10, 0.9, 0.12, -1, TOP_Y + 0.35, -13.05, MAT.rail);
    box("railSouth", 10, 0.9, 0.12, -1, TOP_Y + 0.35, -10.95, MAT.rail);
    box("catwalkPostA", 0.4, TOP_Y, 0.4, 3.4, 0, -13, MAT.rail);
    box("catwalkPostB", 0.4, TOP_Y, 0.4, 3.4, 0, -11, MAT.rail);

    // ---------------------------------------------------------------- tunnel
    box("tunnelWest", 0.4, 2.6, 9, 10, 0, 6, MAT.wallDark);
    box("tunnelEast", 0.4, 2.6, 9, 14, 0, 6, MAT.wallDark);
    box("tunnelRoof", 4.6, 0.3, 9, 12, 2.3, 6, MAT.wall);
    box("tunnelLamp", 0.8, 0.08, 0.8, 12, 2.28, 6, MAT.accent, false);

    // ---------------------------------------------------------------- crates
    const crate = (name, size, x, y, z, dark = false) =>
      box(name, size, size, size, x, y, z, dark ? MAT.crateDark : MAT.crate);
    crate("crate1", 1.5, 5.0, 0, 11.0);
    crate("crate2", 1.2, 5.0, 1.5, 11.0);
    crate("crate3", 1.0, 6.4, 0, 11.6, true);
    crate("crate4", 1.3, 3.4, 0, 12.0);
    crate("crate5", 1.0, 3.4, 1.3, 12.0, true);
    crate("crate6", 1.6, -4.0, 0, 14.0, true);
    crate("crate7", 1.2, -5.4, 0, 14.6);

    // ---------------------------------------------------------------- low cover
    box("coverA", 4, 0.95, 0.5, 3.5, 0, 5, MAT.accent);
    box("coverB", 0.5, 0.95, 3, -5, 0, 2.5, MAT.accent);
    box("coverC", 3, 0.8, 0.5, 6.5, 0, 1.0, MAT.wallDark);
    box("coverD", 0.5, 1.2, 4, -8, 0, 6, MAT.wallDark);

    // ---------------------------------------------------------------- jump gap
    box("ledgeA", 4, 1.2, 4, 16, 0, -4, MAT.wallDark);
    box("ledgeB", 4, 1.2, 4, 16, 0, -10.4, MAT.wallDark);
    box("ledgeTrim", 4.2, 0.1, 0.2, 16, 1.2, -2.05, MAT.accent, false);

    // ---------------------------------------------------------------- step-up test
    box("stepLow", 2, 0.2, 0.6, -2, 0, 19.4, MAT.wallDark);
    box("stepMid", 2, 0.4, 0.6, -2, 0, 18.8, MAT.wallDark);
    box("stepHigh", 2, 0.62, 0.6, -2, 0, 18.2, MAT.wallDark);

    // ------------------------------------------------------- ramp + rock
    // Sloped walking surfaces: a planar top described by a height function
    // over a convex footprint, with the mesh built from the same function.
    // What you see, what the controller stands on and what the foot IK probes
    // are therefore exactly the same surface.
    const slopes = [];

    const pointInPoly = (poly, x, z) => {
      for (let i = 0; i < poly.length; i++) {
        const [x1, z1] = poly[i];
        const [x2, z2] = poly[(i + 1) % poly.length];
        if ((x2 - x1) * (z - z1) - (z2 - z1) * (x - x1) < -1e-9) return false;
      }
      return true;
    };

    const ccw = (poly) => {
      let area = 0;
      for (let i = 0; i < poly.length; i++) {
        const [x1, z1] = poly[i];
        const [x2, z2] = poly[(i + 1) % poly.length];
        area += x1 * z2 - x2 * z1;
      }
      return area < 0 ? poly.slice().reverse() : poly;
    };

    const addSlope = (name, polyIn, height, normal, material) => {
      const poly = ccw(polyIn);
      const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
      const cz = poly.reduce((s, p) => s + p[1], 0) / poly.length;
      const positions = [];
      const indices = [];
      const normals = [];
      const baseY = -0.35;

      const tri = (ax, ay, az, bx, by, bz, qx, qy, qz, nx, ny, nz) => {
        const start = positions.length / 3;
        positions.push(ax, ay, az, bx, by, bz, qx, qy, qz);
        normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
        indices.push(start, start + 1, start + 2);
      };

      // top: fan from the centroid (convex, planar)
      for (let i = 0; i < poly.length; i++) {
        const [x1, z1] = poly[i];
        const [x2, z2] = poly[(i + 1) % poly.length];
        tri(cx, height(cx, cz), cz, x1, height(x1, z1), z1, x2, height(x2, z2), z2,
          normal.x, normal.y, normal.z);
      }
      // side walls sunk into the floor, normals pointing away from the middle
      for (let i = 0; i < poly.length; i++) {
        const [x1, z1] = poly[i];
        const [x2, z2] = poly[(i + 1) % poly.length];
        const y1 = height(x1, z1);
        const y2 = height(x2, z2);
        let ox = (x1 + x2) / 2 - cx;
        let oz = (z1 + z2) / 2 - cz;
        const len = Math.hypot(ox, oz) || 1;
        ox /= len;
        oz /= len;
        const start = positions.length / 3;
        positions.push(x1, y1, z1, x2, y2, z2, x2, baseY, z2, x1, baseY, z1);
        normals.push(ox, 0, oz, ox, 0, oz, ox, 0, oz, ox, 0, oz);
        indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      }

      const vd = new BABYLON.VertexData();
      vd.positions = positions;
      vd.indices = indices;
      vd.normals = normals;
      const mesh = new BABYLON.Mesh(name, scene);
      vd.applyToMesh(mesh, true);
      mesh.material = material;
      mesh.receiveShadows = true;
      meshes.push(mesh);

      const entry = {
        name,
        height,
        normal,
        contains: (x, z) => pointInPoly(poly, x, z),
        mesh,
      };
      slopes.push(entry);
      return entry;
    };

    // ramp: 2.4 m wide, 6 m run, 1.18 m rise, low edge south, landing at the top
    const RAMP = { x: -17, w: 2.4, zLow: 7.5, zHigh: 1.5, yLow: 0.02, yHigh: 1.2 };
    const rampK = (RAMP.yHigh - RAMP.yLow) / (RAMP.zHigh - RAMP.zLow);
    const rampHeight = (x, z) => RAMP.yLow + (z - RAMP.zLow) * rampK;
    addSlope("ramp", [
      [RAMP.x - RAMP.w / 2, RAMP.zHigh], [RAMP.x + RAMP.w / 2, RAMP.zHigh],
      [RAMP.x + RAMP.w / 2, RAMP.zLow], [RAMP.x - RAMP.w / 2, RAMP.zLow],
    ], rampHeight, new BABYLON.Vector3(0, 1, -rampK).normalize(), MAT.ramp);
    box("rampTop", RAMP.w, RAMP.yHigh, 1.2, RAMP.x, 0, RAMP.zHigh - 0.6, MAT.wallDark);

    // rock: irregular footprint, planar top rising to the north (~12°)
    const ROCK = { zLow: -16.2, zHigh: -19.4, yLow: 0.05, yHigh: 0.72 };
    const rockK = (ROCK.yHigh - ROCK.yLow) / (ROCK.zHigh - ROCK.zLow);
    const rockHeight = (x, z) => ROCK.yLow + (z - ROCK.zLow) * rockK;
    addSlope("rock", [
      [3.0, -16.6], [4.6, -16.1], [6.4, -16.5], [7.2, -17.6],
      [6.9, -19.0], [5.6, -19.6], [4.0, -19.3], [3.1, -18.2],
    ], rockHeight, new BABYLON.Vector3(0, 1, -rockK).normalize(), MAT.rock);

    // ---------------------------------------------------------------- pillars
    box("pillarA", 0.9, 5, 0.9, -9, 0, -19, MAT.wall);
    box("pillarB", 0.9, 5, 0.9, 9, 0, -19, MAT.wall);
    box("pillarC", 0.9, 3.5, 0.9, 18, 0, 14, MAT.wallDark);

    return {
      colliders,
      slopes,
      meshes,
      spawn: new BABYLON.Vector3(0, 0, 16),
      bounds: { size: 46 },
      stairs: {
        rise: RISE,
        tread: TREAD,
        count: STEPS_TOTAL,
        lower: STEPS_LOWER,
        upper: STEPS_UPPER,
        landingY: LANDING_Y,
        landingDepth: LANDING_DEPTH,
        top: TOP_Y,
        bottomZ: stairBottomZ,
        topZ: TOWER_FRONT_Z,
        width: STAIR_W,
        centerX: STAIR_X,
        slope: Math.atan2(RISE, TREAD),
      },
    };
  }

  window.Arena = { build };
})();
