import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { V, sweep, path, airfoil, ellipse, canvasTex, orient } from './geom.js';

// Specialized Shiv Expert 2018（S 號）。車頭朝 +Z，騎士右側（傳動側）為 -X。
export const WHEEL_R = 0.336;
export const CRANK = 0.172;
export const BB = V(0, 0.27, -0.07);
const RA = V(0, WHEEL_R, -0.49), FA = V(0, WHEEL_R, 0.5);

const AF = airfoil(32, 0.82), EL = ellipse(20);
const C = (w, h) => () => [w, h];
const taper = (w0, h0, w1, h1) => (t) => [w0 + (w1 - w0) * t, h0 + (h1 - h0) * t];

export function buildBike() {
  const g = new THREE.Group();
  const add = (o, parent = g) => { o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } }); parent.add(o); return o; };
  const mesh = (geo, mat, parent) => add(new THREE.Mesh(geo, mat), parent);
  const tube = (pts, prof, size, mat, opt = {}, parent) => mesh(sweep(path(pts, opt.n || 24), prof, size, opt), mat, parent);

  const carbon = new THREE.MeshPhysicalMaterial({ color: 0x0b0c0f, roughness: 0.3, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.06 });
  const orange = new THREE.MeshPhysicalMaterial({ color: 0xff4614, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.1 });
  const silver = new THREE.MeshStandardMaterial({ color: 0xc4c8ce, metalness: 1, roughness: 0.28 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x2a2c31, metalness: 0.85, roughness: 0.38 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 });
  const tape = new THREE.MeshStandardMaterial({ color: 0xc81e2a, roughness: 0.75 });
  const fwd = V(0, 0, 1);

  // ---------- 車架 ----------
  tube([V(0, 0.6, 0.405), V(0, 0.815, 0.343)], AF, C(0.044, 0.105), carbon, { lead: fwd }); // 頭管
  const dtPts = [V(0, 0.66, 0.37), V(0, 0.47, 0.165), V(0, 0.3, -0.045)];
  tube(dtPts, AF, taper(0.052, 0.105, 0.06, 0.08), carbon, { lead: V(0, -1, 1) }); // 下管
  tube([V(0, 0.255, -0.08), V(0, 0.45, -0.115), V(0, 0.65, -0.178), V(0, 0.868, -0.252)], AF, taper(0.05, 0.07, 0.04, 0.075), carbon, { lead: fwd }); // 坐管（貼合後輪）
  tube([V(0, 0.8, 0.335), V(0, 0.83, 0.05), V(0, 0.858, -0.245)], AF, taper(0.05, 0.065, 0.04, 0.05), carbon, { lead: V(0, 1, 0) }); // 上管
  mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.09, 24).rotateZ(Math.PI / 2), carbon).position.copy(BB); // 五通
  for (const s of [-1, 1]) {
    tube([V(s * 0.03, 0.81, -0.255), V(s * 0.05, 0.58, -0.37), V(s * 0.062, 0.348, -0.482)], EL, taper(0.02, 0.03, 0.014, 0.02), orange); // 後上叉
    tube([V(s * 0.035, 0.265, -0.09), V(s * 0.058, 0.3, -0.3), V(s * 0.064, 0.335, -0.482)], EL, taper(0.024, 0.04, 0.016, 0.024), carbon, { lead: V(0, 1, 0) }); // 後下叉
    mesh(new RoundedBoxGeometry(0.008, 0.045, 0.035, 2, 0.003), carbon).position.set(s * 0.066, WHEEL_R - 0.008, RA.z);
    tube([V(s * 0.043, 0.6, 0.41), V(s * 0.046, 0.46, 0.46), V(s * 0.048, 0.336, 0.502)], AF, taper(0.024, 0.055, 0.017, 0.04), orange, { lead: fwd }); // 前叉
  }
  tube([V(-0.055, 0.605, 0.41), V(0.055, 0.605, 0.41)], AF, C(0.04, 0.075), carbon, { lateral: V(0, 1, 0), lead: fwd }); // 前叉肩
  // 坐桿、座管夾與座墊
  tube([V(0, 0.862, -0.25), V(0, 0.94, -0.285)], AF, C(0.03, 0.055), carbon, { lead: fwd });
  for (const s of [-1, 1]) tube([V(s * 0.02, 0.948, -0.4), V(s * 0.02, 0.942, -0.29), V(s * 0.018, 0.948, -0.2)], EL, C(0.006, 0.006), silver);
  const sh = new THREE.Shape();
  sh.moveTo(-0.066, -0.13);
  sh.quadraticCurveTo(0, -0.148, 0.066, -0.13);
  sh.quadraticCurveTo(0.072, -0.06, 0.042, 0.0);
  sh.quadraticCurveTo(0.036, 0.08, 0.036, 0.13);
  sh.lineTo(0.009, 0.13); sh.lineTo(0.006, 0.045); sh.lineTo(-0.006, 0.045); sh.lineTo(-0.009, 0.13);
  sh.lineTo(-0.036, 0.13);
  sh.quadraticCurveTo(-0.036, 0.08, -0.042, 0.0);
  sh.quadraticCurveTo(-0.072, -0.06, -0.066, -0.13);
  const saddleGeo = new THREE.ExtrudeGeometry(sh, { depth: 0.018, bevelEnabled: true, bevelThickness: 0.009, bevelSize: 0.008, bevelSegments: 4, curveSegments: 16 });
  saddleGeo.rotateX(Math.PI / 2);
  mesh(saddleGeo, new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.6 })).position.set(0, 0.978, -0.3);

  // 補給盒（Fuelselage）與上管便當盒
  const fuel = mesh(new RoundedBoxGeometry(0.05, 0.075, 0.2, 3, 0.02), new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.55 }));
  fuel.position.set(0, 0.47, 0.1);
  fuel.rotation.x = -0.84;
  mesh(new RoundedBoxGeometry(0.045, 0.035, 0.11, 3, 0.012), new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.55 })).position.set(0, 0.86, 0.2);

  // ---------- 前端：龍頭、基座把（紅把帶）、延伸把、手靠、水壺、碼表 ----------
  tube([V(0, 0.81, 0.345), V(0, 0.83, 0.375), V(0, 0.835, 0.4)], EL, C(0.045, 0.04), carbon);
  const bb = [[-0.215, 0.795, 0.49], [-0.21, 0.82, 0.43], [-0.17, 0.835, 0.405], [0, 0.836, 0.398], [0.17, 0.835, 0.405], [0.21, 0.82, 0.43], [0.215, 0.795, 0.49]];
  tube(bb.map((p) => V(...p)), AF, C(0.02, 0.042), carbon, { lateral: V(0, 1, 0), lead: fwd, n: 48 });
  for (const s of [-1, 1]) {
    tube([V(s * 0.203, 0.829, 0.418), V(s * 0.212, 0.815, 0.445), V(s * 0.216, 0.794, 0.492)], EL, C(0.03, 0.03), tape);
    tube([V(s * 0.216, 0.79, 0.5), V(s * 0.214, 0.775, 0.55)], EL, C(0.012, 0.022), rubber); // 煞車把
    tube([V(s * 0.095, 0.838, 0.29), V(s * 0.095, 0.872, 0.29)], EL, C(0.018, 0.018), darkMetal); // 手靠支架
    tube([V(s * 0.095, 0.838, 0.29), V(s * 0.095, 0.838, 0.4)], EL, C(0.016, 0.016), darkMetal);
    const pad = mesh(new RoundedBoxGeometry(0.088, 0.024, 0.14, 3, 0.011), new THREE.MeshStandardMaterial({ color: 0x1a1a1d, roughness: 0.9 }));
    pad.position.set(s * 0.095, 0.884, 0.27);
    tube([V(s * 0.088, 0.868, 0.215), V(s * 0.085, 0.868, 0.4), V(s * 0.075, 0.866, 0.5), V(s * 0.07, 0.874, 0.56), V(s * 0.07, 0.896, 0.586)], EL, C(0.022, 0.022), carbon, { n: 36 });
  }
  const bottleMat = new THREE.MeshPhysicalMaterial({ color: 0xeef3f6, roughness: 0.15, transmission: 0.5, thickness: 0.02, transparent: true, opacity: 0.9 });
  mesh(new THREE.CylinderGeometry(0.037, 0.037, 0.2, 24).rotateX(Math.PI / 2), bottleMat).position.set(0, 0.908, 0.465);
  mesh(new THREE.CylinderGeometry(0.03, 0.037, 0.03, 24).rotateX(Math.PI / 2), rubber).position.set(0, 0.908, 0.58);
  mesh(new RoundedBoxGeometry(0.052, 0.018, 0.082, 2, 0.006), rubber).position.set(0, 0.954, 0.47);
  const scr = mesh(new THREE.PlaneGeometry(0.04, 0.06), new THREE.MeshStandardMaterial({ color: 0x9fb6a0, roughness: 0.3, emissive: 0x223322 }));
  scr.rotation.x = -Math.PI / 2; scr.position.set(0, 0.9635, 0.47);

  // ---------- 輪組：50mm 碳框輻條輪 ----------
  const rimTex = canvasTex(1024, 64, (ctx, w, h) => {
    ctx.fillStyle = '#121316'; ctx.fillRect(0, 0, w, h);
    for (const u of [0.1, 0.6]) { // 每側兩組小型紅白標
      for (const [v0, v1] of [[0.14, 0.34], [0.66, 0.86]]) {
        ctx.fillStyle = '#d42a2a'; ctx.fillRect(u * w, v0 * h, 0.045 * w, (v1 - v0) * h);
        ctx.fillStyle = '#e8e8e8'; ctx.fillRect((u + 0.05) * w, v0 * h, 0.012 * w, (v1 - v0) * h);
        ctx.fillStyle = '#d42a2a'; ctx.fillRect((u + 0.066) * w, v0 * h, 0.012 * w, (v1 - v0) * h);
      }
    }
  });
  const rimMat = new THREE.MeshPhysicalMaterial({ map: rimTex, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.15 });
  const rimPts = [[0.262, 0], [0.265, 0.0085], [0.285, 0.0128], [0.309, 0.0118], [0.313, 0.0105], [0.313, -0.0105], [0.309, -0.0118], [0.285, -0.0128], [0.265, -0.0085], [0.262, 0]];
  const rimGeo = new THREE.LatheGeometry(rimPts.map(([r, y]) => new THREE.Vector2(r, y)), 128).rotateZ(Math.PI / 2);
  const tireTex = canvasTex(8, 256, (ctx, w, h) => {
    const gr = ctx.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#151515'); gr.addColorStop(0.12, '#151515'); gr.addColorStop(0.17, '#9a7550');
    gr.addColorStop(0.83, '#9a7550'); gr.addColorStop(0.88, '#151515'); gr.addColorStop(1, '#151515');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
  });
  const tireGeo = new THREE.TorusGeometry(WHEEL_R - 0.0128, 0.0128, 16, 128).rotateY(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ map: tireTex, roughness: 0.8 });
  const spokesGeo = (n) => {
    const geos = [], o = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, side = i % 2 ? 1 : -1;
      const p0 = V(side * 0.026, Math.sin(a + side * 0.12) * 0.028, Math.cos(a + side * 0.12) * 0.028);
      const p1 = V(0, Math.sin(a) * 0.263, Math.cos(a) * 0.263);
      const len = p0.distanceTo(p1);
      orient(o, p0, p1, V(1, 0, 0));
      o.updateMatrix();
      geos.push(new THREE.CylinderGeometry(0.0011, 0.0011, len, 4).translate(0, len / 2, 0).applyMatrix4(o.matrix));
    }
    return mergeGeometries(geos);
  };
  const makeWheel = (pos, n, rear) => {
    const w = new THREE.Group();
    w.position.copy(pos);
    mesh(rimGeo, rimMat, w);
    mesh(tireGeo, tireMat, w);
    mesh(spokesGeo(n), silver, w);
    mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.1, 16).rotateZ(Math.PI / 2), darkMetal, w);
    for (const s of [-1, 1]) mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.004, 24).rotateZ(Math.PI / 2), darkMetal, w).position.x = s * 0.026;
    if (rear) {
      for (let i = 0; i < 11; i++) {
        const r = 0.052 - i * 0.0026;
        mesh(new THREE.CylinderGeometry(r, r, 0.0018, 32).rotateZ(Math.PI / 2), silver, w).position.x = -(0.022 + i * 0.0037);
      }
    }
    return add(w);
  };
  const rearWheel = makeWheel(RA, 24, true);
  const frontWheel = makeWheel(FA, 18, false);

  // ---------- 傳動：曲柄、大盤、鏈條、後變 ----------
  const crank = add(new THREE.Group());
  crank.position.copy(BB);
  const gear = (teeth, r) => {
    const s = new THREE.Shape();
    for (let k = 0; k <= teeth * 2; k++) {
      const a = (k / (teeth * 2)) * Math.PI * 2, rr = k % 2 ? r - 0.004 : r;
      k ? s.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : s.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    const hole = new THREE.Path();
    hole.absarc(0, 0, r - 0.016, 0, Math.PI * 2, true);
    s.holes.push(hole);
    return new THREE.ExtrudeGeometry(s, { depth: 0.003, bevelEnabled: false, curveSegments: 4 }).rotateY(Math.PI / 2);
  };
  mesh(gear(53, 0.107), darkMetal, crank).position.x = -0.05;
  mesh(gear(39, 0.079), silver, crank).position.x = -0.043;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const arm = mesh(new THREE.BoxGeometry(0.008, 0.012, 0.09), carbon, crank);
    arm.position.set(-0.05, Math.sin(a) * 0.045, Math.cos(a) * 0.045);
    arm.rotation.x = -a;
  }
  for (const s of [-1, 1]) {
    const dir = s < 0 ? 1 : -1; // 右曲柄朝 +Z（θ=0），左曲柄相反
    tube([V(s * 0.072, 0, 0), V(s * 0.074, 0, dir * CRANK)], EL, taper(0.018, 0.04, 0.014, 0.026), carbon, { lateral: V(1, 0, 0) }, crank);
    mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.05, 10).rotateZ(Math.PI / 2), silver, crank).position.set(s * 0.095, 0, dir * CRANK);
  }
  mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 12).rotateZ(Math.PI / 2), silver, crank);

  const chainMat = new THREE.MeshStandardMaterial({ color: 0x5d6168, metalness: 0.9, roughness: 0.45 });
  const cx = -0.05;
  const upP = V(cx, RA.y - 0.05, RA.z + 0.01), loP = V(cx, RA.y - 0.115, RA.z + 0.04);
  const seg = (a, b) => tube([a, b], EL, C(0.004, 0.01), chainMat, { n: 2, lateral: V(1, 0, 0) });
  seg(V(cx, BB.y + 0.106, BB.z), V(cx, RA.y + 0.04, RA.z));
  seg(V(cx, BB.y - 0.106, BB.z), loP);
  seg(loP, upP);
  for (const p of [upP, loP]) mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.008, 16).rotateZ(Math.PI / 2), darkMetal).position.copy(p);
  tube([V(cx - 0.008, upP.y, upP.z), V(cx - 0.008, loP.y, loP.z)], EL, C(0.004, 0.03), darkMetal, { n: 2 });
  tube([V(-0.065, RA.y - 0.01, RA.z), V(-0.07, RA.y - 0.03, RA.z + 0.02), V(cx - 0.008, upP.y, upP.z)], EL, C(0.018, 0.022), darkMetal);
  mesh(new RoundedBoxGeometry(0.02, 0.03, 0.06, 2, 0.006), darkMetal).position.set(-0.045, BB.y + 0.13, BB.z - 0.04);

  // 踏板（不隨曲柄旋轉）
  const pedals = [-1, 1].map((s) => mesh(new RoundedBoxGeometry(0.07, 0.014, 0.066, 2, 0.005), rubber));

  // ---------- 下管字樣（不使用品牌商標） ----------
  const logoTex = canvasTex(1024, 96, (ctx, w, h) => {
    ctx.fillStyle = '#fff';
    ctx.font = 'italic 900 84px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('SPECIAL', w / 2, h / 2 + 4);
  });
  const logoMat = new THREE.MeshStandardMaterial({ map: logoTex, transparent: true, roughness: 0.3, polygonOffset: true, polygonOffsetFactor: -2 });
  const dt = new THREE.CatmullRomCurve3(dtPts);
  const p = dt.getPointAt(0.5), T = dt.getTangentAt(0.5);
  for (const s of [-1, 1]) {
    // 兩側都從五通往頭管方向閱讀、字頭朝上
    const zA = V(s, 0, 0), xA = T.clone().multiplyScalar(s), yA = V().crossVectors(zA, xA);
    const N = V().crossVectors(T, V(1, 0, 0));
    if (N.dot(V(0, -1, 1)) < 0) N.negate();
    const logo = mesh(new THREE.PlaneGeometry(0.42, 0.04), logoMat);
    logo.castShadow = false;
    logo.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xA, yA, zA));
    logo.position.copy(p).addScaledVector(zA, 0.0285).addScaledVector(N, 0.012);
  }

  return {
    group: g,
    update(theta, wheelAngle) {
      crank.rotation.x = theta;
      rearWheel.rotation.x = frontWheel.rotation.x = wheelAngle;
      pedals.forEach((pd, i) => {
        const s = i ? 1 : -1;
        pedalPos(s, theta, pd.position);
        pd.position.x = s * 0.112;
      });
    },
  };
}

// s = -1 右腳、+1 左腳；θ=0 右曲柄朝前，往下為正轉
export function pedalPos(s, theta, out = V()) {
  const th = theta + (s < 0 ? 0 : Math.PI);
  return out.set(s * 0.12, BB.y - CRANK * Math.sin(th), BB.z + CRANK * Math.cos(th));
}
