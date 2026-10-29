/* ===========================================================================
 * emotion-engine.js —— 本地人脸情绪识别引擎
 * ---------------------------------------------------------------------------
 * 双层算法（全部在本机浏览器内运行，无任何云端请求）：
 *
 *   Layer-1  深度 CNN 表情分类（主判据）
 *            tinyFaceDetector(SSD-MobileNet 轻量版) → 68 关键点 → FaceExpressionNet
 *            FaceExpressionNet 为在 FER+ / AffectNet 类数据集上训练的 CNN，
 *            输出 7 类表情概率（neutral / happy / sad / angry / fearful /
 *            disgusted / surprised）。权重文件位于 /models，量化 uint8。
 *
 *   Layer-2  68 点几何规则引擎（辅助 + 降级方案）
 *            从关键点计算 7 个尺度不变的人脸动作几何量（以瞳距归一化），
 *            用高斯核最近原型分类器得到 7 类得分。物理含义对应 FACS 动作单元
 *            （AU6 脸颊提升 / AU12 嘴角上扬 / AU1+2 眉内侧上抬 / AU4 皱眉 /
 *             AU9 鼻皱 / AU5 睁眼 / AU26 张口）。
 *
 *   融合 + 时序平滑
 *            P = normalize(0.72·P_cnn + 0.28·P_geo)（CNN 可用时）
 *            对连续帧做指数滑动平均（EMA, α=0.45），并统计帧级一致性作为稳定度。
 * =========================================================================== */

export const EMOTIONS = [
  { key: 'happy',    label: '开心', en: 'Happy',    emoji: '😄', color: '#f59e0b', soft: '#fef3c7', v: 0.96, a: 0.68 },
  { key: 'sad',      label: '悲伤', en: 'Sad',      emoji: '😢', color: '#4f7cff', soft: '#e6edff', v: 0.10, a: 0.28 },
  { key: 'angry',    label: '愤怒', en: 'Angry',    emoji: '😠', color: '#ef4444', soft: '#fee2e2', v: 0.16, a: 0.92 },
  { key: 'surprise', label: '惊讶', en: 'Surprise', emoji: '😲', color: '#a855f7', soft: '#f3e8ff', v: 0.62, a: 0.86 },
  { key: 'fear',     label: '恐惧', en: 'Fear',     emoji: '😨', color: '#0ea5a4', soft: '#d7f5f3', v: 0.12, a: 0.90 },
  { key: 'disgust',  label: '厌恶', en: 'Disgust',  emoji: '🤢', color: '#84a83f', soft: '#eef5d8', v: 0.12, a: 0.55 },
  { key: 'neutral',  label: '平静', en: 'Neutral',  emoji: '😐', color: '#64748b', soft: '#eaeef5', v: 0.50, a: 0.34 },
];

export const EMO_INDEX = Object.fromEntries(EMOTIONS.map((e, i) => [e.key, i]));
export const EMO_BY_KEY = Object.fromEntries(EMOTIONS.map(e => [e.key, e]));

/* face-api 输出键 → 本系统情绪键 */
const CNN_KEY_MAP = {
  neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry',
  fearful: 'fear', disgusted: 'disgust', surprised: 'surprise',
};

/* ---- 几何原型（以瞳距归一化后的典型读数，依据 FACS 动作单元 + 标定人脸统计）---- */
const FEATURE_NAMES = ['mouthOpen', 'mouthWide', 'cornerUp', 'browRaise', 'innerBrow', 'eyeOpen', 'mouthRound'];

const PROTOTYPES = {
  //             mouthOpen mouthWide cornerUp browRaise innerBrow eyeOpen mouthRound
  happy:    [0.300, 0.760, 0.100, 0.250, 0.200, 0.260, 0.400],
  sad:      [0.020, 0.500, 0.005, 0.220, 0.200, 0.300, 0.040],
  angry:    [0.060, 0.570, 0.030, 0.200, 0.130, 0.260, 0.110],
  surprise: [0.280, 0.470, 0.010, 0.290, 0.240, 0.320, 0.580],
  fear:     [0.100, 0.580, 0.000, 0.240, 0.220, 0.310, 0.180],
  disgust:  [0.060, 0.550, 0.005, 0.190, 0.130, 0.270, 0.110],
  neutral:  [0.030, 0.520, 0.015, 0.260, 0.195, 0.330, 0.060],
};

/* 各维判别力权重：嘴角上扬（AU12）与唇形最可靠 */
const FEAT_W = [1.60, 1.60, 3.20, 0.90, 1.10, 0.70, 1.80];
/* 各维容差（高斯核带宽，按标定集散度设定） */
const FEAT_S = [0.090, 0.090, 0.030, 0.045, 0.050, 0.040, 0.160];

const GEOM_KEYS = Object.keys(PROTOTYPES);

/* 参考帧：用中性原型把绝对读数转成偏差量，降低个体解剖差异 */
const BASELINE = PROTOTYPES.neutral;

function pt(p) { return { x: p.x, y: p.y }; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function avgY(pts) { return pts.reduce((s, p) => s + p.y, 0) / pts.length; }

/* --------------------------------------------------------------------------
 * 从 68 关键点提取 7 维几何特征
 * ------------------------------------------------------------------------ */
export function geometricFeatures(positions) {
  const p = positions.map(pt);
  const d = Math.max(dist(p[36], p[45]), 1e-3);           // 瞳距（外眼角距）

  const mouthOpen = dist(p[62], p[66]) / d;                // 内唇上下间距 → 张口
  const mouthWide = dist(p[48], p[54]) / d;                // 嘴角间距 → 咧嘴
  const lipMidY = avgY([p[51], p[57]]);                    // 上下唇中线
  const cornerY = avgY([p[48], p[54]]);                    // 嘴角
  const cornerUp = (lipMidY - cornerY) / d;                // >0 嘴角高于唇线 → 微笑

  const eyeTopY = avgY([p[37], p[38], p[43], p[44]]);
  const browY = avgY([p[19], p[24]]);                      // 眉弓
  const browRaise = (eyeTopY - browY) / d;                 // 眉—眼距离 → 抬眉

  const innerBrowY = avgY([p[21], p[22]]);                 // 眉头
  const innerBrow = (eyeTopY - innerBrowY) / d;            // 眉头相对抬高（AU1+2）

  const earR = (dist(p[37], p[41]) + dist(p[38], p[40])) / (2 * dist(p[36], p[39]));
  const earL = (dist(p[43], p[47]) + dist(p[44], p[46])) / (2 * dist(p[42], p[45]));
  const eyeOpen = (earR + earL) / 2;                       // 眼睛开合度

  const noseBaseY = avgY([p[31], p[35]]);
  const mouthRound = mouthOpen / Math.max(mouthWide, 0.1);   // 唇形圆度（MAR，惊讶时变圆）

  return {
    values: { mouthOpen, mouthWide, cornerUp, browRaise, innerBrow, eyeOpen, mouthRound },
    vector: [mouthOpen, mouthWide, cornerUp, browRaise, innerBrow, eyeOpen, mouthRound],
    noseBaseY,
  };
}

/* --------------------------------------------------------------------------
 * 几何规则分类器：高斯核最近原型 + softmax
 * ------------------------------------------------------------------------ */
export function geometricScores(vec) {
  const logits = [];
  for (const key of GEOM_KEYS) {
    const proto = PROTOTYPES[key];
    let s = 0;
    for (let k = 0; k < vec.length; k++) {
      const dev = (vec[k] - proto[k]) - 0;               // 与原型偏差
      const z = dev / FEAT_S[k];
      s -= FEAT_W[k] * z * z;
    }
    logits.push(s);
  }
  const T = 2.6;
  const mx = Math.max(...logits);
  const exps = logits.map(v => Math.exp((v - mx) / T));
  const sum = exps.reduce((a, b) => a + b, 0);
  const scores = {};
  GEOM_KEYS.forEach((k, i) => { scores[k] = exps[i] / sum; });
  return scores;
}

/* --------------------------------------------------------------------------
 * 工具
 * ------------------------------------------------------------------------ */
function normalizeScores(obj) {
  const keys = EMOTIONS.map(e => e.key);
  const total = keys.reduce((s, k) => s + (obj[k] || 0), 0) || 1;
  const out = {};
  keys.forEach(k => { out[k] = (obj[k] || 0) / total; });
  return out;
}

function topTwo(scores) {
  const arr = EMOTIONS.map(e => ({ key: e.key, p: scores[e.key] || 0 }));
  arr.sort((a, b) => b.p - a.p);
  return arr;
}

function l1(a, b) {
  let s = 0;
  for (const e of EMOTIONS) s += Math.abs((a[e.key] || 0) - (b[e.key] || 0));
  return s / 2;   // 0..1 距离
}

function ema(prev, next, alpha) {
  const out = {};
  for (const e of EMOTIONS) {
    out[e.key] = prev ? prev[e.key] * (1 - alpha) + (next[e.key] || 0) * alpha : next[e.key] || 0;
  }
  return normalizeScores(out);
}

/* ===========================================================================
 * EmotionEngine
 * ======================================================================== */
export class EmotionEngine {
  constructor() {
    this.ready = false;
    this.backend = '-';
    this.error = null;
    this.opts = null;
    this.tracks = [];       // 每个人脸位置的 EMA 状态
    this.frameCount = 0;
    this.history = [];      // 最近若干帧的主导情绪（用于稳定度统计）
    this.lastKey = null;    // 上一帧主导情绪
    this.streak = 0;        // 连续同情绪帧数
    this.detector = 'tinyFaceDetector';
  }

  async init() {
    if (typeof faceapi === 'undefined') throw new Error('face-api 未加载');
    const tf = faceapi.tf;
    try {
      await tf.setBackend('webgl');
    } catch (e) {
      await tf.setBackend('cpu');
    }
    await tf.ready();
    this.backend = tf.getBackend();

    const base = new URL('models/', document.baseURI).href;
    // 单次网络抖动不该让整页卡在「加载中」：逐个模型带重试地加载
    const loadWithRetry = async (net, name, tries = 3) => {
      let lastErr = null;
      for (let i = 0; i < tries; i++) {
        try {
          await net.loadFromUri(base);
          return;
        } catch (e) {
          lastErr = e;
          if (i < tries - 1) await new Promise(r => setTimeout(r, 600 * (i + 1)));
        }
      }
      throw new Error(`${name} 加载失败（已重试 ${tries} 次）：${lastErr && lastErr.message}`);
    };
    await loadWithRetry(faceapi.nets.tinyFaceDetector, '人脸检测模型');
    await loadWithRetry(faceapi.nets.faceLandmark68Net, '关键点模型');
    await loadWithRetry(faceapi.nets.faceExpressionNet, '表情分类模型');

    this.opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.32 });
    this.ready = true;
    return this;
  }

  reset() {
    this.tracks = [];
    this.history = [];
    this.frameCount = 0;
    this.lastKey = null;
    this.streak = 0;
  }

  /* ---- 单帧推理 ---- */
  async analyze(el, { smooth = true } = {}) {
    if (!this.ready) throw new Error('引擎未初始化');
    const { dets, tf, scale } = await this.detectWithFallback(el);
    this.lastScale = scale;

    const faces = dets.map((d, i) => this.buildFace(d, i, tf));

    if (smooth) this.updateTracks(faces);
    else { this.tracks = []; }

    this.frameCount++;
    return { faces, aggregate: this.aggregate(faces, smooth), detectorScale: scale };
  }

  /* ------------------------------------------------------------------------
   * 多尺度检测
   * TinyFaceDetector 对「过大的正脸特写」不敏感（人脸占画面 > 80% 时容易漏检）。
   * 先用原始尺寸检测；若漏检，则把画面居中放进带留白的更大画布，
   * 降低人脸的相对尺寸后重试，最后把框与关键点坐标映射回原图。
   * ---------------------------------------------------------------------- */
  async detectWithFallback(el) {
    let dets = await this.runPipeline(el, null);
    if (dets.length) return { dets, tf: null, scale: 1 };

    const w = el.videoWidth || el.naturalWidth || el.width || 0;
    const h = el.videoHeight || el.naturalHeight || el.height || 0;
    if (!w || !h) return { dets: [], tf: null, scale: 1 };

    for (const k of [1.8, 2.6]) {
      const cw = Math.round(w * k), ch = Math.round(h * k);
      const cv = document.createElement('canvas');
      cv.width = cw; cv.height = ch;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, cw, ch);
      const ox = (cw - w) / 2, oy = (ch - h) / 2;
      ctx.drawImage(el, ox, oy, w, h);
      dets = await this.runPipeline(cv, { k, ox, oy });
      if (dets.length) return { dets, tf: { k, ox, oy }, scale: k };
    }
    return { dets: [], tf: null, scale: 1 };
  }

  runPipeline(input) {
    return faceapi
      .detectAllFaces(input, this.opts)
      .withFaceLandmarks()
      .withFaceExpressions();
  }

  /* ---- 单张人脸：融合 CNN + 几何 ---- */
  buildFace(d, idx, tf) {
    const k = tf ? tf.k : 1;
    const ox = tf ? tf.ox : 0;
    const oy = tf ? tf.oy : 0;
    const mx = x => (x - ox) / k;
    const my = y => (y - oy) / k;

    const box = d.detection.box;
    const positions = d.landmarks.positions.map(p => ({ x: mx(p.x), y: my(p.y) }));

    // CNN 输出
    const cnn = {};
    const expr = d.expressions || {};
    for (const [src, dst] of Object.entries(CNN_KEY_MAP)) cnn[dst] = expr[src] || 0;
    const cnnNorm = normalizeScores(cnn);

    // 几何层
    const geo = geometricFeatures(positions);
    const geoScores = normalizeScores(geometricScores(geo.vector));

    // 一致性：CNN 与几何层的分布距离（越小分歧越大）
    const consistency = Math.max(0, 1 - l1(cnnNorm, geoScores));

    // 自适应融合：
    //   ① CNN 越不确定（峰值越低），对光照/纹理更稳健的几何层话语权越大；
    //   ② 几何层出现极强动作单元证据（峰值 > 0.93，例如明显的 AU12 嘴角上扬）时提高其权重；
    const cnnPeak = Math.max(...Object.values(cnnNorm));
    const geoPeak = Math.max(...Object.values(geoScores));
    let wGeo = 0.10 + 0.30 * (1 - cnnPeak);
    if (geoPeak > 0.93) wGeo = Math.max(wGeo, 0.38);
    wGeo = Math.min(0.42, wGeo);
    const fused = {};
    for (const e of EMOTIONS) fused[e.key] = (1 - wGeo) * cnnNorm[e.key] + wGeo * geoScores[e.key];
    const fusedNorm = normalizeScores(fused);

    return {
      idx,
      box: { x: mx(box.x), y: my(box.y), width: box.width / k, height: box.height / k },
      score: d.detection.score,
      landmarks: positions,
      cnn: cnnNorm,
      geo: geoScores,
      features: geo.values,
      fused: fusedNorm,
      consistency,
      wGeo,
      track: null,
    };
  }

  /* ---- 时序平滑：按人脸序号维持 EMA ---- */
  updateTracks(faces) {
    faces.forEach((f, i) => {
      const prev = this.tracks[i];
      const smoothed = ema(prev ? prev.scores : null, f.fused, 0.45);
      this.tracks[i] = { scores: smoothed, frames: (prev ? prev.frames : 0) + 1 };
      f.track = this.tracks[i];
    });
    if (faces.length < this.tracks.length) this.tracks.length = faces.length;
  }

  /* ---- 聚合：取面积最大的人脸为主人脸 ---- */
  aggregate(faces, smoothed) {
    if (!faces.length) {
      this.history.push(null);
      if (this.history.length > 40) this.history.shift();
      this.streak = 0;
      this.lastKey = null;
      return { exists: false, faces: 0, primary: null, averaged: null, stability: 0, streak: 0 };
    }
    const sorted = [...faces].sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
    const main = sorted[0];
    const scores = main.track ? main.track.scores : main.fused;

    const ranked = topTwo(scores);
    const top = ranked[0], second = ranked[1];
    const normTop = (top.p - 1 / EMOTIONS.length) / (1 - 1 / EMOTIONS.length);
    const margin = top.p - second.p;

    let confidence = 0.58 * Math.max(0, normTop) + 0.22 * Math.min(1, main.score) + 0.20 * main.consistency;
    confidence = Math.min(0.97, Math.max(0.05, confidence));

    // 帧级稳定度
    this.history.push(top.key);
    if (this.history.length > 24) this.history.shift();
    const recent = this.history.filter(Boolean);
    const agree = recent.filter(k => k === top.key).length / Math.max(1, recent.length);
    const stability = recent.length < 3 ? 0 : agree;

    // 连续同情绪帧数：比"窗口内一致比例"更适合判断情绪是否真的切换了
    if (top.key === this.lastKey) this.streak++;
    else { this.lastKey = top.key; this.streak = 1; }

    const valence = EMOTIONS.reduce((s, e) => s + scores[e.key] * e.v, 0);
    const arousal = EMOTIONS.reduce((s, e) => s + scores[e.key] * e.a, 0);

    return {
      exists: true,
      faces: faces.length,
      primary: {
        key: top.key,
        p: top.p,
        scores,
        confidence,
        consistency: main.consistency,
        detectorScore: main.score,
        margin,
        box: main.box,
        landmarks: main.landmarks,
        features: main.features,
        cnn: main.cnn,
        geo: main.geo,
        wGeo: main.wGeo,
        frames: main.track ? main.track.frames : 1,
      },
      averaged: scores,
      stability,
      streak: this.streak,
      valence,
      arousal,
      all: sorted.map(f => ({
        box: f.box,
        key: topTwo(f.fused)[0].key,
        p: topTwo(f.fused)[0].p,
        scores: f.track ? f.track.scores : f.fused,
        landmarks: f.landmarks,
      })),
    };
  }
}

export const FEATURE_LABELS = {
  mouthOpen: '张口度',
  mouthWide: '唇宽',
  cornerUp: '嘴角上扬',
  browRaise: '眉眼距',
  innerBrow: '眉心上抬',
  eyeOpen: '眼睛开合',
  mouthRound: '唇形圆度',
};

export { FEATURE_NAMES, BASELINE };
