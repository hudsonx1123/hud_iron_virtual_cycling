import * as THREE from 'three';
import { V, limbGeo, orient, keyed, roundEnds, sweep, path, ellipse, canvasTex } from './geom.js';
import { pedalPos } from './bike.js';
import { buildBody } from './body.js';

// 騎士：Zoot 三鐵衣（白→粉紅→紅漸層、深色側片）、白色空力帽、藍色小腿套、螢光黃綠車鞋
const THIGH = 0.46, SHIN = 0.46, FOOT = 0.27;
const SKIN = '#c49274';

const vy = (v, h) => (1 - v) * h; // 貼圖 v（0 下、1 上）→ canvas y

// 車鞋貼圖（u: 0.25 = 鞋底）
const shoeTex = () => canvasTex(256, 128, (ctx, w, h) => {
  ctx.fillStyle = '#c6f52a'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#18191b'; ctx.fillRect(0.14 * w, 0, 0.22 * w, h);
  ctx.fillStyle = '#e9ffb0'; ctx.fillRect(0.6 * w, 0.2 * h, 0.3 * w, 0.06 * h);
  ctx.fillStyle = '#18191b';
  for (const v of [0.35, 0.6]) ctx.fillRect(0.55 * w, vy(v, h), 0.4 * w, 0.05 * h);
});

// 雕塑頭部：在球面上以高斯起伏塑出五官，頂點色畫唇色、臉頰與鬍渣。
// 局部座標 x 橫向、y 向上、z 朝前；五官位置以單位球座標表示。
function headGeo() {
  const g = new THREE.SphereGeometry(1, 96, 72);
  const p = g.attributes.position, col = [];
  const G = (x, y, cx, cy, sx, sy) => Math.exp(-(((x - cx) / sx) ** 2) - (((y - cy) / sy) ** 2));
  const pair = (x, y, cx, cy, sx, sy) => G(x, y, cx, cy, sx, sy) + G(x, y, -cx, cy, sx, sy);
  const sm = (v) => { v = Math.min(1, Math.max(0, v)); return v * v * (3 - 2 * v); };
  const base = new THREE.Color(SKIN), lip = new THREE.Color('#9a5a52'), blush = new THREE.Color('#cf8270'), stubble = new THREE.Color('#7f604d');
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const front = sm((z - 0.2) / 0.5);

    // 五官起伏（公尺）
    const t = Math.min(1, Math.max(0, (0.08 - y) / 0.36));
    let nose = (0.007 + 0.021 * t * t) * Math.exp(-((x / (0.065 + 0.05 * t)) ** 2));
    if (y < -0.3) nose *= Math.exp(-(((y + 0.3) / 0.045) ** 2));
    let d = nose
      + 0.007 * pair(x, y, 0.09, -0.26, 0.05, 0.05)    // 鼻翼
      - 0.011 * pair(x, y, 0.3, 0.12, 0.12, 0.08)      // 眼窩
      + 0.006 * pair(x, y, 0.28, 0.25, 0.2, 0.06)      // 眉骨
      + 0.008 * pair(x, y, 0.45, -0.05, 0.15, 0.12)    // 顴骨
      + 0.006 * G(x, y, 0, -0.43, 0.17, 0.04)          // 上唇
      + 0.007 * G(x, y, 0, -0.53, 0.14, 0.045)         // 下唇
      - 0.004 * G(x, y, 0, -0.48, 0.18, 0.015)         // 唇線
      + 0.012 * G(x, y, 0, -0.72, 0.22, 0.1);          // 下巴
    d *= front;

    // 基本頭型：下顎收窄、下巴前突、後頸內收
    const sx = 0.074 * (y < 0 ? 1 - 0.22 * Math.pow(-y, 1.5) : 1);
    let sz = 0.092;
    if (y < 0 && z > 0) sz += 0.01 * -y * z;
    if (y < -0.3 && z < 0) sz *= 1 - 0.3 * (-y - 0.3);
    p.setXYZ(i, x * (sx + d), y * (0.098 + d), z * (sz + d));

    c.copy(base)
      .lerp(blush, 0.35 * pair(x, y, 0.42, -0.12, 0.18, 0.15) * front)
      .lerp(stubble, 0.32 * sm((-y - 0.35) / 0.25) * sm((z + 0.2) / 0.4) + 0.25 * G(x, y, 0, -0.37, 0.15, 0.035) * front)
      .lerp(lip, 0.8 * Math.min(1, G(x, y, 0, -0.445, 0.15, 0.03) + G(x, y, 0, -0.525, 0.12, 0.035)) * front)
      .multiplyScalar(1 - 0.45 * pair(x, y, 0.07, -0.31, 0.03, 0.02) * front);
    col.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

export function buildRider() {
  const g = new THREE.Group();
  const skin = new THREE.MeshPhysicalMaterial({ color: SKIN, roughness: 0.5, sheen: 0.25, sheenColor: new THREE.Color(0xffc8a8) });
  const shoeM = new THREE.MeshStandardMaterial({ map: shoeTex(), roughness: 0.45 });
  const add = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = true; g.add(m); return m; };
  const sphere = (r, mat, p, sc) => { const m = add(new THREE.SphereGeometry(r, 24, 18), mat); m.position.copy(p); if (sc) m.scale.set(...sc); return m; };
  const R = (ks) => keyed(ks);

  // 軀幹、頸、手臂、腿為一體成形的蒙皮網格（body.js），此處只放頭部與配件
  const head = add(headGeo(), new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.48, sheen: 0.3, sheenRoughness: 0.4, sheenColor: new THREE.Color(0xffc0a0) }));
  head.position.set(0, 1.235, 0.3);
  head.rotation.x = 0.05;
  for (const s of [-1, 1]) { // 耳朵
    const ear = sphere(0.024, skin, V(s * 0.074, 1.238, 0.285), [0.35, 1.15, 0.75]);
    ear.rotation.y = s * 0.35;
  }
  const helmetStart = g.children.length; // 以下為安全帽組（下巴帶、帽體、護目鏡、號碼），可改掛到照片模型的頭上
  const strapM = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.7 });
  for (const s of [-1, 1]) { // 安全帽下巴帶
    add(sweep(path([V(s * 0.078, 1.275, 0.335), V(s * 0.076, 1.215, 0.338), V(s * 0.055, 1.163, 0.35), V(0, 1.141, 0.355)], 16), ellipse(8), () => [0.005, 0.012]), strapM);
    add(sweep(path([V(s * 0.08, 1.272, 0.25), V(s * 0.078, 1.24, 0.3), V(s * 0.076, 1.215, 0.338)], 10), ellipse(8), () => [0.005, 0.012]), strapM);
  }

  // 白色空力帽 + 鏡面護目鏡
  const hr = R([[0, 0.02], [0.08, 0.085], [0.3, 0.122], [0.55, 0.115], [0.85, 0.07], [1, 0.035]]);
  // 帽緣停在額頭（眼睛以上），護目鏡沿臉部弧度包覆
  const helmetPts = path([V(0, 1.312, 0.39), V(0, 1.318, 0.3), V(0, 1.305, 0.19), V(0, 1.28, 0.095)], 32);
  add(sweep(helmetPts, ellipse(32), (t) => { const r = hr(t) * roundEnds(t, 0.06, 0.05); return [r * 1.85, r * 1.84]; }),
    new THREE.MeshPhysicalMaterial({ color: 0xf6f6f6, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 }));
  const shieldPts = [];
  for (let i = 0; i <= 24; i++) {
    const a = -1.3 + (2.6 * i) / 24;
    shieldPts.push(V(Math.sin(a) * 0.084, 1.25 + 0.008 * a * a, 0.3 + Math.cos(a) * 0.104));
  }
  add(sweep(shieldPts, ellipse(16), (t) => [0.044 - 0.014 * (2 * t - 1) ** 2, 0.004], { lateral: V(0, 1, 0) }),
    new THREE.MeshPhysicalMaterial({ color: 0x0a0d14, metalness: 0.85, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.03 }));
  const numTex = canvasTex(128, 64, (ctx, w, h) => {
    ctx.fillStyle = '#ff8a1f'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#111'; ctx.font = '900 42px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('1810', w / 2, h / 2 + 2);
  });
  for (const s of [-1, 1]) {
    const n = add(new THREE.PlaneGeometry(0.075, 0.035), new THREE.MeshStandardMaterial({ map: numTex, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 }));
    n.position.set(s * 0.111, 1.322, 0.23);
    n.rotation.y = s * Math.PI / 2;
    n.castShadow = false;
  }
  const HEAD_C = V(0, 1.235, 0.3);
  const helmet = new THREE.Group(), helmetInner = new THREE.Group();
  helmetInner.position.copy(HEAD_C).negate();
  helmet.position.copy(HEAD_C);
  helmetInner.add(...g.children.slice(helmetStart));
  helmet.add(helmetInner);
  g.add(helmet);

  // ---------- 手臂位置（靠在手靠上、握延伸把）與手錶 ----------
  const arms = [-1, 1].map((s) => ({
    sh: V(s * 0.17, 1.15, 0.13), el: V(s * 0.095, 0.918, 0.272), wr: V(s * 0.072, 0.89, 0.52), hand: V(s * 0.07, 0.886, 0.556),
  }));
  {
    const { el, wr } = arms[1]; // 左手腕
    const watch = add(new THREE.TorusGeometry(0.03, 0.008, 8, 20).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.5 }));
    const d = V().subVectors(wr, el).normalize();
    orient(watch, V().copy(wr).addScaledVector(d, -0.045), V().copy(wr).addScaledVector(d, -0.005), V(0, 1, 0));
  }

  // ---------- 腿（每幀 IK） ----------
  const footW = (t) => R([[0, 0.07], [0.3, 0.082], [0.65, 0.09], [0.9, 0.075], [1, 0.05]])(t) * roundEnds(t, 0.14, 0.18);
  const footD = (t) => R([[0, 0.085], [0.35, 0.07], [0.7, 0.052], [1, 0.035]])(t) * roundEnds(t, 0.14, 0.18);
  const footGeo = limbGeo(FOOT, footW, footD, 22, 20);
  const legs = [-1, 1].map((s) => ({
    s,
    hip: V(s * 0.085, 1.02, -0.34),
    foot: add(footGeo, shoeM),
    P: V(), A: V(), K: V(), H: V(), Tt: V(), dir: V(), perp: V(), up: V(),
  }));

  const rot = (out, y, z, phi) => out.set(0, y * Math.cos(phi) - z * Math.sin(phi), y * Math.sin(phi) + z * Math.cos(phi));
  const tmp = V(), FWD = V(0, 0, 1);
  const solve = (L, theta) => {
    const th = theta + (L.s < 0 ? 0 : Math.PI);
    pedalPos(L.s, theta, L.P);
    L.P.x = L.s * 0.108;
    const phi = 0.1 + 0.12 * Math.sin(th - 0.4); // 腳踝擺動：下死點後腳尖略朝下
    L.A.copy(L.P).add(rot(tmp, 0.095, -0.07, phi));
    L.H.copy(L.P).add(rot(tmp, 0.045, -0.115, phi));
    L.Tt.copy(L.P).add(rot(tmp, 0.02, 0.155, phi));
    rot(L.up, 1, 0, phi);

    L.dir.subVectors(L.A, L.hip);
    const d = Math.min(L.dir.length(), THIGH + SHIN - 1e-3);
    L.dir.normalize();
    const a = (THIGH * THIGH - SHIN * SHIN + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(THIGH * THIGH - a * a, 0));
    L.perp.copy(FWD).addScaledVector(L.dir, -L.dir.z).normalize();
    L.K.copy(L.hip).addScaledVector(L.dir, a).addScaledVector(L.perp, h);
    orient(L.foot, L.H, L.Tt, L.up);
  };

  // 以曲柄水平的靜止姿勢建立身體網格並綁定骨架
  legs.forEach((L) => solve(L, 0));
  const rest = legs.map((L) => ({ hip: L.hip.clone(), K: L.K.clone(), A: L.A.clone() }));
  const body = buildBody({ legs: rest, arms, thigh: THIGH, shin: SHIN });
  g.add(body.mesh);

  let model = null;
  return {
    group: g,
    // 換成照片生成的模型：隱藏程式繪製的身體，安全帽改跟隨模型頭部
    useModel(m, helmetScale = 1.06) {
      model = m;
      for (const c of g.children) if (c !== helmet) c.visible = false;
      g.add(m.mesh);
      helmet.scale.setScalar(helmetScale);
    },
    update(theta) {
      if (model) {
        model.update(theta);
        helmet.position.copy(model.head.pos);
        helmet.quaternion.copy(model.head.quat);
        return;
      }
      legs.forEach((L) => solve(L, theta));
      body.pose(legs);
    },
  };
}
