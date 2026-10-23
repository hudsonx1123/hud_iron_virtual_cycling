import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { V, canvasTex, speckle, fbm, noise2, rng } from './geom.js';
import { buildBike, WHEEL_R } from './bike.js';
import { buildRider } from './rider.js';
import { leafAtlas, broadleaf, conifer, bush } from './trees.js';
import { loadRiderModel } from './riderModel.js';
import { buildCity } from './city.js';

// 世界座標：道路沿 +Z 無限延伸，車手組（rig）向 +Z 前進，地景以 100m 區塊循環重建。
// 素材：Poly Haven（CC0）的 HDRI 天空、柏油/草地/林地 PBR 材質、草叢/蕨類/岩石模型。
const CH = 100, NCH = 8, ROAD_W = 7, HALF = ROAD_W / 2;
const LANE_X = -1.75; // 靠右行駛（騎士右側為 -X）
const ASSET = 'assets/';

const VIEWS = {
  back: { pos: V(0.0, 1.5, -3.4), look: V(0, 0.95, 0.6) },
  side: { pos: V(-3.1, 1.0, 0.05), look: V(0, 0.75, 0.05) },
  front: { pos: V(0.6, 1.1, 3.2), look: V(0, 0.85, 0) },
  front34: { pos: V(-2.2, 1.3, 2.5), look: V(0, 0.8, 0) },
  top: { pos: V(0, 5.5, -4.5), look: V(0, 0.6, 1.5) },
  detail: { pos: V(-1.75, 0.85, 0.05), look: V(0, 0.68, 0.05) },
  detailLeft: { pos: V(1.75, 0.85, 0.05), look: V(0, 0.68, 0.05) },
  face: { pos: V(-0.32, 1.17, 0.78), look: V(0, 1.215, 0.33) },
  faceSide: { pos: V(-0.6, 1.22, 0.32), look: V(0, 1.22, 0.32) },
  model: { pos: V(-2.6, 1.0, 0.1), look: V(0, 0.85, 0.1) },
  modelFront: { pos: V(-0.3, 1.0, 2.6), look: V(0, 0.85, 0) },
  detailFront: { pos: V(-0.9, 1.25, 1.4), look: V(0, 0.95, 0.1) },
  scenery: { pos: V(-4, 2.2, -6), look: V(3, 2.0, 25) },
  aerial: { pos: V(0, 260, -380), look: V(0, 0, 120) },
  chase: { pos: V(-6, 14, -30), look: V(0, 2, 30) },
};

const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

// 山路地形：右側山壁、左側緩降谷地，路面兩側 4.6m 內保持平坦
export function groundH(x, z) {
  const d = Math.abs(x);
  if (d < 4.6) return -0.03;
  const k = smooth((d - 4.6) / 10);
  const side = x > 0 ? d * 0.28 : -Math.min(d * 0.08, 8);
  const hills = (fbm(x * 0.006, z * 0.006, 4, 7) - 0.45) * 70 * smooth((d - 12) / 90);
  const bumps = fbm(x * 0.15, z * 0.15, 2, 3) * 0.6;
  return -0.03 + k * (side + hills + bumps);
}

// 暗角 + 輕微調色（在 OutputPass 之後，sRGB 空間）
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, vignette: { value: 0.28 }, warmth: { value: 0.025 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float vignette; uniform float warmth; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      c.rgb += vec3(warmth, warmth * 0.4, -warmth);
      c.rgb = mix(vec3(dot(c.rgb, vec3(0.299,0.587,0.114))), c.rgb, 1.08);
      float d = distance(vUv, vec2(0.5));
      c.rgb *= 1.0 - vignette * smoothstep(0.35, 0.85, d);
      gl_FragColor = c;
    }`,
};

export class World {
  constructor(canvas) {
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }));
    this.dprMax = Math.min(devicePixelRatio, 1.5);
    this.dpr = this.dprMax;
    r.setPixelRatio(this.dpr);
    r.info.autoReset = false;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.85;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#9fb8cf');
    this.scene.fog = new THREE.FogExp2(new THREE.Color('#9fb8cf'), 0.0012);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 25000);
    this.map = new URLSearchParams(location.search).get('map') || 'mountain';
    this.routeS = 0;
    this.sunDir = V(-0.5, 0.7, 0.3).normalize();

    this.buildLights();
    this.buildPost();
    this.buildStaticMaterials();

    this.rig = new THREE.Group();
    this.rig.position.x = LANE_X;
    this.scene.add(this.rig);
    this.bike = buildBike();
    this.rider = buildRider();
    this.rig.add(this.bike.group, this.rider.group);
    // 車底接觸陰影
    const blob = canvasTex(128, 256, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.setTransform(1, 0, 0, h / w, 0, 0); ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
    });
    const contact = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 1.5).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false }));
    contact.position.set(0, 0.006, 0);
    this.rig.add(contact);

    this.chunks = [];
    this.crank = 0;
    this.wheel = 0;
    this.setView('back', true);
    addEventListener('resize', () => this.resize());
    this.resize();
    this.ready = this.loadAssets();
    // 照片生成的騎士模型：預設使用程式繪製的騎士，網址加 ?photo=1 才改用照片模型
    if (/[?&]photo=1/.test(location.search)) loadRiderModel(ASSET + 'models/rider/athlete.glb')
      .then((m) => { this.rider.useModel(m); this.rider.update(this.crank); })
      .catch((e) => console.warn('rider model', e));
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setPixelRatio(this.dpr);
    this.composer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setView(name, instant) {
    this.view = VIEWS[name] || VIEWS.back;
    if (instant) {
      this.camOff = this.view.pos.clone();
      this.lookOff = this.view.look.clone();
    }
  }

  buildLights() {
    const sun = (this.sun = new THREE.DirectionalLight(0xfff4e6, 3.0));
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 160 });
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);
  }

  buildPost() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    const c = (this.composer = new EffectComposer(this.renderer, rt));
    c.addPass(new RenderPass(this.scene, this.camera));
    c.addPass(new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.12, 0.5, 0.92));
    c.addPass(new OutputPass());
    c.addPass(new ShaderPass(GradeShader));
  }

  // ---------- 不需外部素材的材質 ----------
  buildStaticMaterials() {
    // 道路標線（透明疊層）：白色邊線、黃色雙中線、路肩髒污
    const lineTex = canvasTex(1024, 2048, (ctx, w, h) => {
      const line = (cx, lw, color) => {
        ctx.fillStyle = color; ctx.fillRect((cx - lw / 2) * w, 0, lw * w, h);
        ctx.globalCompositeOperation = 'destination-out';
        for (let i = 0; i < 6000; i++) {
          ctx.fillStyle = `rgba(0,0,0,${0.3 + Math.random() * 0.7})`;
          ctx.fillRect((cx - lw / 2 + Math.random() * lw) * w, Math.random() * h, 1 + Math.random() * 3, 1 + Math.random() * 3);
        }
        ctx.globalCompositeOperation = 'source-over';
      };
      line(0.05, 0.018, 'rgba(236,234,226,0.95)'); line(0.95, 0.018, 'rgba(236,234,226,0.95)');
      line(0.485, 0.014, 'rgba(226,176,34,0.95)'); line(0.515, 0.014, 'rgba(226,176,34,0.95)');
      for (const [x0, dir] of [[0, 1], [1, -1]]) {
        const g = ctx.createLinearGradient(x0 * w, 0, (x0 + dir * 0.04) * w, 0);
        g.addColorStop(0, 'rgba(105,92,70,0.7)'); g.addColorStop(1, 'rgba(105,92,70,0)');
        ctx.fillStyle = g; ctx.fillRect(Math.min(x0, x0 + dir * 0.04) * w, 0, 0.04 * w, h);
      }
    });
    this.lineMat = new THREE.MeshStandardMaterial({ map: lineTex, transparent: true, roughness: 0.75, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

    // 黃黑斜紋水泥護欄（照片中的山路護欄）
    const barrierTex = canvasTex(512, 160, (ctx, w, h) => {
      ctx.fillStyle = '#d9ad22'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#26282b';
      for (let x = -h; x < w + h; x += 90) {
        ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + 45, h); ctx.lineTo(x + 45 + h, 0); ctx.lineTo(x + h, 0); ctx.fill();
      }
      speckle(ctx, w, h, 9000, 2, ['rgba(60,55,40,.35)', 'rgba(255,255,255,.15)', 'rgba(30,30,30,.3)']);
      const gr = ctx.createLinearGradient(0, h, 0, 0);
      gr.addColorStop(0, 'rgba(70,60,45,.75)'); gr.addColorStop(0.25, 'rgba(70,60,45,.2)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
    });
    const bg = new THREE.BoxGeometry(0.5, 0.78, 2.3, 1, 1, 1);
    const p = bg.attributes.position;
    for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) p.setX(i, p.getX(i) * 0.45);
    bg.translate(0, 0.39, 0);
    bg.computeVertexNormals();
    this.barrierGeo = bg;
    this.barrierMat = new THREE.MeshStandardMaterial({ map: barrierTex, roughness: 0.9 });

    // 紅色反光標誌
    const signTex = canvasTex(128, 128, (ctx) => {
      ctx.fillStyle = '#f4f4f4'; ctx.beginPath(); ctx.arc(64, 64, 63, 0, 7); ctx.fill();
      ctx.fillStyle = '#d81e1e'; ctx.beginPath(); ctx.arc(64, 64, 54, 0, 7); ctx.fill();
    });
    this.signGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.035, 0.035, 1.3, 8).translate(0, 0.65, 0),
      new THREE.CircleGeometry(0.17, 24).translate(0, 1.3, 0.04),
    ], true);
    this.signMats = [new THREE.MeshStandardMaterial({ color: 0x9a9da2, metalness: 0.6, roughness: 0.4 }), new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.4, side: THREE.DoubleSide })];

    // 樹（葉片卡）
    const leafMat = (needle) => new THREE.MeshStandardMaterial({ map: leafAtlas(needle), alphaTest: 0.35, side: THREE.DoubleSide, vertexColors: true, roughness: 0.8 });
    const bark = new THREE.MeshStandardMaterial({ color: 0x5b4a3c, roughness: 0.95 });
    const broad = leafMat(false), needle = leafMat(true);
    this.treeKinds = [
      { ...broadleaf(11, { height: 9, crownR: 3.2 }), leafMat: broad, bark, cap: 70 },
      { ...broadleaf(23, { height: 12, crownR: 4.2, cards: 200 }), leafMat: broad, bark, cap: 40 },
      { ...broadleaf(37, { height: 7, crownR: 2.6, cards: 120 }), leafMat: broad, bark, cap: 70 },
      { ...conifer(41), leafMat: needle, bark, cap: 60 },
      { ...bush(53), leafMat: broad, bark, cap: 90 },
    ];
  }

  // ---------- 載入 Poly Haven 素材 ----------
  async loadAssets() {
    const r = this.renderer, maxAniso = r.capabilities.getMaxAnisotropy();
    const tl = new THREE.TextureLoader();
    const tex = (name, srgb) => tl.loadAsync(ASSET + 'tex/' + name).then((t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = maxAniso;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    });
    const gl = new GLTFLoader();
    const [hdr, aD, aN, aR, gD, gN, fD, grassG, fernG, rockG] = await Promise.all([
      new RGBELoader().setDataType(THREE.FloatType).loadAsync(ASSET + 'hdri/sky_2k.hdr'),
      tex('asphalt_02_diff_2k.jpg', true), tex('asphalt_02_nor_gl_2k.jpg'), tex('asphalt_02_rough_2k.jpg'),
      tex('aerial_grass_rock_diff_2k.jpg', true), tex('aerial_grass_rock_nor_gl_2k.jpg'),
      tex('forrest_ground_01_diff_2k.jpg', true),
      gl.loadAsync(ASSET + 'models/grass_medium_01/grass_medium_01.gltf'),
      gl.loadAsync(ASSET + 'models/fern_02/fern_02.gltf'),
      gl.loadAsync(ASSET + 'models/boulder_01/boulder_01.gltf'),
    ]);

    this.setupSky(hdr);

    this.roadMat = new THREE.MeshStandardMaterial({ map: aD, normalMap: aN, roughnessMap: aR, color: 0xc8c8c8, normalScale: new THREE.Vector2(1.2, 1.2) });

    // 地形：草地與林地泥土依頂點屬性 aDirt 混合，頂點色做大尺度明暗變化（消除重複感）
    const gm = (this.groundMat = new THREE.MeshStandardMaterial({ map: gD, normalMap: gN, vertexColors: true, roughness: 0.95 }));
    gm.onBeforeCompile = (sh) => {
      sh.uniforms.dirtMap = { value: fD };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aDirt;\nvarying float vDirt;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvDirt = aDirt;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D dirtMap;\nvarying float vDirt;')
        .replace('#include <map_fragment>', `
          vec4 gTex = texture2D(map, vMapUv);
          vec4 dTex = texture2D(dirtMap, vMapUv * 1.3);
          diffuseColor *= mix(gTex, dTex, vDirt);`);
    };

    // glTF 植被：攤平成獨立幾何，底部對齊 y=0，改用 alphaTest 以便大量實例化
    const variants = (gltf, minTris, maxTris, norm) => {
      const out = [];
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        const tris = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
        if (tris < minTris || tris > maxTris) return;
        g.computeBoundingBox();
        const b = g.boundingBox, s = norm ? 1 / Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) : 1;
        g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2).scale(s, s, s);
        out.push({ geo: g, mat: o.material });
      });
      return out;
    };
    this.grassVars = variants(grassG, 200, 1000);
    this.fernVars = variants(fernG, 0, 1e9);
    this.rockVars = variants(rockG, 0, 1e9, true);
    for (const v of [...this.grassVars, ...this.fernVars]) { v.mat.transparent = false; v.mat.alphaTest = 0.5; v.mat.side = THREE.DoubleSide; }

    if (this.map === 'yuanshan') {
      // 真實地點：圓山交流道（OpenStreetMap）
      this.scene.fog.density = 0.00045;
      this.mountains.scale.set(9, 1.3, 9); // 台北盆地四周的山
      this.mountains.material.fog = false;
      this.farGround.visible = false;
      this.city = await buildCity(this, ASSET + 'osm/yuanshan.json');
      this.scene.traverse((o) => { for (const m of [].concat(o.material || [])) if ('envMapIntensity' in m && m.envMapIntensity === 1) m.envMapIntensity = 0.7; });
      return;
    }
    for (let i = 0; i < NCH; i++) this.chunks.push(this.buildChunk((i - 1) * CH + Math.floor(this.rig.position.z / CH) * CH));
  }

  // HDRI：背景 + 環境光；找出最亮像素作為太陽方向，並取地平線平均色作為霧色
  setupSky(hdr) {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    this.scene.background = hdr;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromEquirectangular(hdr).texture;

    const { data, width, height } = hdr.image;
    let best = 0, bi = 0;
    for (let i = 0; i < width * height; i++) {
      const l = data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722;
      if (l > best) { best = l; bi = i; }
    }
    const u = ((bi % width) + 0.5) / width, v = 1 - (Math.floor(bi / width) + 0.5) / height;
    const lon = (u - 0.5) * Math.PI * 2;
    // 保留 HDRI 的太陽方位，仰角上限 36°，讓路旁樹影能落到路面上（畫面中看不到太陽本體，差異不明顯）
    const lat = Math.min((v - 0.5) * Math.PI, THREE.MathUtils.degToRad(36));
    this.sunDir.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)).normalize();

    const fog = new THREE.Color(0, 0, 0);
    const row0 = Math.floor(height * 0.47), row1 = Math.floor(height * 0.49);
    let n = 0;
    for (let y = row0; y <= row1; y++) for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * 4;
      fog.r += data[i]; fog.g += data[i + 1]; fog.b += data[i + 2]; n++;
    }
    fog.multiplyScalar(0.85 / n);
    this.scene.fog.color.copy(fog);
    this.fogColor = fog;

    this.buildDistant();
    this.scene.traverse((o) => {
      for (const m of [].concat(o.material || [])) if ('envMapIntensity' in m) m.envMapIntensity = 0.7;
    });
  }

  // 遠山（跟著騎士移動），顏色混入霧色形成空氣透視
  buildDistant() {
    const segs = 256, rings = 7, pos = [], col = [], idx = [];
    const cA = new THREE.Color('#4d6b45'), cB = this.fogColor.clone().multiplyScalar(0.75).lerp(new THREE.Color('#6d8a8a'), 0.5);
    for (let j = 0; j < rings; j++) {
      const rad = 700 + j * 260;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const hgt = j === 0 ? -5 : (fbm(Math.cos(a) * 3 + j * 0.3, Math.sin(a) * 3, 5, 21) - 0.3) * 520 * Math.sin((j / (rings - 1)) * Math.PI * 0.9);
        pos.push(Math.cos(a) * rad, Math.max(-5, hgt), Math.sin(a) * rad);
        const c = cA.clone().lerp(cB, j / rings);
        col.push(c.r, c.g, c.b);
      }
    }
    for (let j = 0; j < rings - 1; j++)
      for (let i = 0; i < segs; i++) {
        const a = j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    mg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    mg.setIndex(idx);
    mg.computeVertexNormals();
    this.mountains = new THREE.Mesh(mg, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.farGround = new THREE.Mesh(new THREE.CircleGeometry(3000, 48).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x46603a }));
    this.farGround.position.y = -40;
    this.scene.add(this.mountains, this.farGround);
  }

  // ---------- 地景區塊 ----------
  buildChunk(z0) {
    const c = { z0, group: new THREE.Group() };
    this.scene.add(c.group);

    const ds = [4.6, 5.0, 5.6, 6.4, 7.5, 9, 11, 14, 18, 23, 30, 40, 54, 72, 95, 125, 165, 215, 280];
    c.xs = [...ds.map((d) => -d).reverse(), 0, ...ds];
    c.nz = 51;
    const nx = c.xs.length, idx = [];
    for (let j = 0; j < c.nz - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, cc = a + nx, d = cc + 1;
        idx.push(a, cc, b, b, cc, d);
      }
    const tg = new THREE.BufferGeometry();
    const n = nx * c.nz;
    tg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    tg.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    tg.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
    tg.setAttribute('aDirt', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
    tg.setIndex(idx);
    c.terrain = new THREE.Mesh(tg, this.groundMat);
    c.terrain.receiveShadow = true;

    const quad = () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(8), 2));
      g.setIndex([0, 2, 1, 1, 2, 3]);
      return g;
    };
    c.road = new THREE.Mesh(quad(), this.roadMat);
    c.lines = new THREE.Mesh(quad(), this.lineMat);
    c.road.receiveShadow = c.lines.receiveShadow = true;
    c.group.add(c.terrain, c.road, c.lines);

    const inst = (geo, mat, cap, cast = true) => {
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.castShadow = cast; m.receiveShadow = true;
      c.group.add(m);
      (c.instanced ||= []).push(m);
      return m;
    };
    c.trees = this.treeKinds.map((k) => ({
      wood: k.wood && inst(k.wood, k.bark, k.cap),
      leaves: inst(k.leaves, k.leafMat, k.cap),
      cap: k.cap,
    }));
    c.grass = this.grassVars.map((v) => inst(v.geo, v.mat, 110, false));
    c.ferns = this.fernVars.map((v) => inst(v.geo, v.mat, 20, false));
    c.rocks = this.rockVars.map((v) => inst(v.geo, v.mat, 4));
    c.barriers = inst(this.barrierGeo, this.barrierMat, 90);
    c.signs = inst(this.signGeo, this.signMats, 8);

    this.fillChunk(c, z0);
    return c;
  }

  fillChunk(c, z0) {
    c.z0 = z0;
    const rand = rng(Math.floor(z0 / CH) * 7919 + 13);
    const nx = c.xs.length;

    // 地形
    const ga = c.terrain.geometry.attributes;
    for (let j = 0; j < c.nz; j++) {
      const z = z0 + (j / (c.nz - 1)) * CH;
      for (let i = 0; i < nx; i++) {
        const x = c.xs[i], k = j * nx + i;
        ga.position.setXYZ(k, x, groundH(x, z), z);
        ga.uv.setXY(k, x / 5, z / 5);
      }
    }
    c.terrain.geometry.computeVertexNormals();
    const nrm = ga.normal, tmp = new THREE.Color(), rockTint = new THREE.Color('#a49c8c');
    for (let k = 0; k < ga.position.count; k++) {
      const x = ga.position.getX(k), z = ga.position.getZ(k), d = Math.abs(x);
      const macro = fbm(x * 0.02, z * 0.02, 3, 5), micro = noise2(x * 0.25, z * 0.25, 9);
      const b = 0.72 + macro * 0.5 + (micro - 0.5) * 0.12;
      tmp.setRGB(b * 0.56, b * 0.92, b * 0.42); // 草地貼圖偏乾黃，往台灣山區的濕潤綠調
      const steep = smooth((0.82 - nrm.getY(k)) * 4);
      if (steep > 0) tmp.lerp(rockTint, steep * 0.6);
      col(ga.color, k, tmp);
      const dirt = Math.max(smooth((6.4 - d) / 1.6), smooth((macro - 0.55) * 5) * 0.7, steep * 0.8);
      ga.aDirt.setX(k, Math.min(1, dirt * (0.75 + micro * 0.25)));
    }
    ga.position.needsUpdate = ga.color.needsUpdate = ga.uv.needsUpdate = ga.aDirt.needsUpdate = true;
    c.terrain.geometry.computeBoundingSphere();

    // 路面 + 標線
    const setQuad = (mesh, uOf, vLen) => {
      const p = mesh.geometry.attributes.position, uv = mesh.geometry.attributes.uv;
      [[-HALF, z0], [HALF, z0], [-HALF, z0 + CH], [HALF, z0 + CH]].forEach(([x, z], i) => {
        p.setXYZ(i, x, 0, z);
        uv.setXY(i, uOf(x), z / vLen);
      });
      p.needsUpdate = uv.needsUpdate = true;
      mesh.geometry.computeBoundingSphere();
    };
    setQuad(c.road, (x) => (x + HALF) / 3.5, 3.5);
    setQuad(c.lines, (x) => (x < 0 ? 0 : 1), 14);

    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qt = new THREE.Quaternion(), s = V(), p = V(), up = V(0, 1, 0), zAx = V(0, 0, 1);
    const put = (mesh, i, x, y, z, rotY, sc, tilt = 0) => {
      q.setFromAxisAngle(up, rotY);
      if (tilt) q.premultiply(qt.setFromAxisAngle(zAx, tilt));
      mesh.setMatrixAt(i, m4.compose(p.set(x, y, z), q, s.set(sc, sc, sc)));
    };
    const finish = (mesh, n) => { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; };

    // 樹：路旁大樹樹冠伸向路面（林蔭山路），往外逐漸稀疏
    const counts = c.trees.map(() => 0);
    const plant = (kind, x, z, sc) => {
      const t = c.trees[kind], i = counts[kind];
      if (i >= t.cap) return;
      const y = groundH(x, z) - 0.2, ry = rand() * Math.PI * 2;
      const tilt = (rand() - 0.5) * 0.08 + (Math.abs(x) < 10 ? Math.sign(x) * 0.07 : 0);
      put(t.leaves, i, x, y, z, ry, sc, tilt);
      if (t.wood) put(t.wood, i, x, y, z, ry, sc, tilt);
      counts[kind]++;
    };
    for (let i = 0; i < 26; i++) {
      const side = rand() < 0.5 ? -1 : 1;
      plant(rand() < 0.5 ? 1 : 0, side * (6.5 + rand() * 4), z0 + rand() * CH, 0.85 + rand() * 0.35);
    }
    for (let i = 0; i < 170; i++) {
      const side = rand() < 0.5 ? -1 : 1, x = side * (10 + rand() ** 1.3 * 200), z = z0 + rand() * CH;
      const r = rand();
      plant(r < 0.35 ? 0 : r < 0.5 ? 1 : r < 0.75 ? 2 : 3, x, z, 0.8 + rand() * 0.6);
    }
    for (let i = 0; i < 80; i++) {
      const side = rand() < 0.5 ? -1 : 1;
      plant(4, side * (5.2 + rand() ** 1.5 * 35), z0 + rand() * CH, 0.6 + rand() * 0.9);
    }
    c.trees.forEach((t, k) => { finish(t.leaves, counts[k]); if (t.wood) finish(t.wood, counts[k]); });

    // 草叢、蕨類、岩石
    const scatter = (meshes, cap, total, xMin, xSpread, pow, scMin, scMax) => {
      const cnt = meshes.map(() => 0);
      for (let i = 0; i < total; i++) {
        const v = (rand() * meshes.length) | 0;
        if (cnt[v] >= cap) continue;
        const side = rand() < 0.5 ? -1 : 1, x = side * (xMin + rand() ** pow * xSpread), z = z0 + rand() * CH;
        put(meshes[v], cnt[v]++, x, groundH(x, z) - 0.03, z, rand() * Math.PI * 2, scMin + rand() * (scMax - scMin));
      }
      meshes.forEach((m, k) => finish(m, cnt[k]));
    };
    scatter(c.grass, 110, 500, HALF + 0.7, 16, 1.8, 1.1, 2.2);
    scatter(c.ferns, 20, 60, HALF + 1.4, 12, 1.5, 0.8, 1.5);
    scatter(c.rocks, 4, 1, 9, 25, 1, 0.8, 2.6);

    // 護欄：分段出現
    let nb = 0;
    for (const side of [-1, 1]) {
      for (let z = z0 + 1.2; z < z0 + CH; z += 2.45) {
        if (noise2(z * 0.012, side * 10, 77) < 0.42) continue;
        put(c.barriers, nb++, side * (HALF + 0.6), -0.03, z, 0, 1);
      }
    }
    finish(c.barriers, nb);

    let ns = 0;
    for (let i = 0; i < 3; i++) {
      const side = rand() < 0.5 ? -1 : 1;
      put(c.signs, ns++, side * (HALF + 1.3), -0.03, z0 + rand() * CH, side < 0 ? Math.PI : 0, 1);
    }
    finish(c.signs, ns);
    for (const m of c.instanced) m.computeBoundingSphere(); // 讓整個區塊可被視錐與陰影範圍剔除
  }

  // ---------- 每幀 ----------
  update(dt, { speed, cadence }) {
    this.crank += (cadence * Math.PI * 2 / 60) * dt;
    this.wheel += (speed / WHEEL_R) * dt;
    this.bike.update(this.crank, this.wheel);
    this.rider.update(this.crank);

    const route = this.city?.route;
    if (route) this.followRoute(route, speed * dt);
    const rz = route ? this.rig.position.z : (this.rig.position.z += speed * dt);
    for (const c of this.chunks) {
      if (c.z0 + CH < rz - CH) this.fillChunk(c, c.z0 + NCH * CH);
      const near = c.z0 + CH > rz - 40 && c.z0 < rz + 240; // 小型植被只在近處繪製，遠處已被霧遮住
      for (const m of [...c.grass, ...c.ferns, ...c.rocks]) m.visible = near;
    }

    const k = 1 - Math.exp(-dt * 4);
    this.camOff.lerp(this.view.pos, k);
    this.lookOff.lerp(this.view.look, k);
    const q = route ? this.headingQ : null; // 城市模式：鏡頭跟著行進方向轉
    this.camera.position.copy(this.rig.position).add(q ? this.camOff.clone().applyQuaternion(q) : this.camOff);
    this.camera.lookAt(V().copy(this.rig.position).add(q ? this.lookOff.clone().applyQuaternion(q) : this.lookOff));

    this.sun.position.copy(this.rig.position).addScaledVector(this.sunDir, 90);
    this.sun.target.position.copy(this.rig.position);
    if (this.mountains) {
      this.mountains.position.set(route ? this.rig.position.x : 0, 0, rz);
      this.farGround.position.z = rz;
    }
  }

  // 沿路線前進；到終點後回到起點
  followRoute(route, ds) {
    this.routeS = (this.routeS + ds) % route.length;
    const u = this.routeS / route.length;
    const p = route.curve.getPointAt(u), t = route.curve.getTangentAt(u);
    this.rig.position.copy(p);
    const yaw = Math.atan2(t.x, t.z), pitch = -Math.atan2(t.y, Math.hypot(t.x, t.z));
    this.rig.rotation.set(pitch, yaw, 0, 'YXZ');
    (this.headingQ ||= new THREE.Quaternion()).setFromAxisAngle(V(0, 1, 0), yaw);
  }

  render() {
    this.renderer.info.reset();
    this.composer.render();
    this.adaptResolution();
  }

  // 動態解析度：效能瓶頸在像素填充，FPS 不足時降低渲染解析度，有餘裕時再調回
  adaptResolution() {
    const now = performance.now();
    this.perf ||= { t0: now, n: 0 };
    this.perf.n++;
    const el = now - this.perf.t0;
    if (el < 1500) return;
    const fps = (this.perf.n * 1000) / el;
    this.perf = { t0: now, n: 0 };
    const prev = this.dpr;
    if (fps < 48) this.dpr = Math.max(0.6, this.dpr * Math.max(0.75, fps / 55));
    else if (fps > 58) this.dpr = Math.min(this.dprMax, this.dpr + 0.05);
    if (Math.abs(this.dpr - prev) > 0.01) this.resize();
  }
}

function col(attr, k, c) { attr.setXYZ(k, c.r, c.g, c.b); }
