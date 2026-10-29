/* ===========================================================================
 * recommender.js —— 情绪驱动的歌曲推荐算法
 * ---------------------------------------------------------------------------
 * 一、情绪 → 声学目标向量
 *     用心理学"效价-唤醒度"（Russell 环形模型）作为桥梁，把 7 类离散情绪映射
 *     到 5 维可计算声学特征空间：
 *
 *        valence 效价      0..1   越接近 1 越积极（大调、明亮）
 *        energy 能量       0..1   响度、力度、密度
 *        danceability 律动 0..1   节奏驱动程度
 *        acousticness 原声 0..1   原声乐器比例（与电子化负相关）
 *        tempoNorm 速度    0..1   BPM 的对数归一化
 *
 * 二、三种调节策略（决定"推荐什么情绪的歌"）
 *     empathize 共情：目标 = 当前情绪原型（陪着用户）
 *     heal      疗愈：目标 = lerp(当前情绪, 向上情绪, λ=0.62)（慢慢拉出负面情绪）
 *     energize  激励：目标 = lerp(当前情绪, 高能情绪, λ=0.58)
 *
 * 三、打分（0..1，可解释的加权线性组合）
 *     score = 0.42·加权特征贴近度 + 0.18·效价高斯契合 + 0.16·情绪环形邻近度
 *           + 0.14·用户偏好亲和度 + 0.10·速度契合
 *
 * 四、列表级重排：MMR（最大边际相关）保证多样性
 *     mmr = λ·score − (1−λ)·max_{已选} sim(track, selected),  λ = 0.78
 *
 * 五、反馈学习：喜欢 / 不喜欢 / 跳过 → 在线更新偏好向量（指数移动）
 *           pref ← pref + η·f(track, pref)，η_like = 0.22，η_dislike = −0.20
 * =========================================================================== */

export const DIMS = ['energy', 'valence', 'danceability', 'acousticness', 'tempoNorm'];

export const DIM_LABEL = {
  energy: '能量',
  valence: '效价',
  danceability: '律动',
  acousticness: '原声',
  tempoNorm: '速度',
};

const DIM_W = { energy: 1.15, valence: 1.50, danceability: 0.95, acousticness: 0.70, tempoNorm: 0.85 };
const W_SUM = DIMS.reduce((s, d) => s + DIM_W[d], 0);

/* ---- 情绪原型（声学侧）---- */
export const MOOD_ACOUSTIC = {
  happy:    { valence: 0.92, energy: 0.82, danceability: 0.80, acousticness: 0.22, tempo: 122 },
  sad:      { valence: 0.12, energy: 0.24, danceability: 0.22, acousticness: 0.80, tempo: 68 },
  angry:    { valence: 0.18, energy: 0.95, danceability: 0.56, acousticness: 0.08, tempo: 148 },
  surprise: { valence: 0.62, energy: 0.78, danceability: 0.70, acousticness: 0.16, tempo: 130 },
  fear:     { valence: 0.14, energy: 0.50, danceability: 0.20, acousticness: 0.60, tempo: 92 },
  disgust:  { valence: 0.20, energy: 0.45, danceability: 0.36, acousticness: 0.50, tempo: 100 },
  neutral:  { valence: 0.50, energy: 0.42, danceability: 0.50, acousticness: 0.60, tempo: 90 },
};

/* 疗愈策略的"向上情绪"映射 */
const UPLIFT = {
  sad: 'calm', angry: 'calm', fear: 'calm', disgust: 'neutral',
  surprise: 'happy', happy: 'happy', neutral: 'calm',
};

const CALM_PROTO = { valence: 0.72, energy: 0.20, danceability: 0.28, acousticness: 0.85, tempo: 72 };

export function tempoNorm(bpm) {
  const lo = Math.log(55), hi = Math.log(190);
  return Math.min(1, Math.max(0, (Math.log(Math.max(40, bpm)) - lo) / (hi - lo)));
}

export function clamp01(v) { return Math.min(1, Math.max(0, v)); }

export function featuresToVector(f) {
  return [f.energy, f.valence, f.danceability, f.acousticness, f.tempoNorm ?? tempoNorm(f.tempo)];
}

function lerp(a, b, t) { return a + (b - a) * t; }

/* --------------------------------------------------------------------------
 * 目标向量构建
 * ------------------------------------------------------------------------ */
export const STRATEGIES = [
  { key: 'empathize', label: '共情陪伴', icon: '🤝', desc: '顺着当前情绪走，先被理解' },
  { key: 'heal', label: '温和疗愈', icon: '🌤', desc: '从当前情绪向明亮舒缓过渡' },
  { key: 'energize', label: '提振激励', icon: '⚡', desc: '直接拉高能量与效价' },
];

export function buildTarget(emotionKey, strategy = 'empathize') {
  const base = MOOD_ACOUSTIC[emotionKey] || MOOD_ACOUSTIC.neutral;
  let target = { ...base };

  if (strategy === 'heal') {
    const upKey = UPLIFT[emotionKey] || 'calm';
    const up = upKey === 'calm' ? CALM_PROTO : { ...MOOD_ACOUSTIC[upKey], tempo: MOOD_ACOUSTIC[upKey].tempo };
    const l = 0.62;
    target = {
      valence: clamp01(lerp(base.valence, up.valence, l)),
      energy: clamp01(lerp(base.energy, up.energy, l)),
      danceability: clamp01(lerp(base.danceability, up.danceability, l)),
      acousticness: clamp01(lerp(base.acousticness, up.acousticness, l)),
      tempo: lerp(base.tempo, up.tempo, l),
    };
  } else if (strategy === 'energize') {
    const l = 0.58;
    target = {
      valence: clamp01(lerp(base.valence, 0.95, l)),
      energy: clamp01(lerp(base.energy, 0.92, l)),
      danceability: clamp01(lerp(base.danceability, 0.88, l)),
      acousticness: clamp01(lerp(base.acousticness, 0.15, l)),
      tempo: lerp(base.tempo, 138, l),
    };
  }
  target.tempoNorm = tempoNorm(target.tempo);
  target.strategy = strategy;
  return target;
}

/* --------------------------------------------------------------------------
 * 单曲打分
 * ------------------------------------------------------------------------ */
export function scoreTrack(track, target, prefs) {
  const f = track.features;
  const fv = featuresToVector(f);
  const tv = featuresToVector(target);

  /* 1) 加权特征贴近度：1 − 加权平均绝对差 */
  let diff = 0;
  DIMS.forEach((d, i) => { diff += DIM_W[d] * Math.abs(fv[i] - tv[i]); });
  const closeness = 1 - diff / W_SUM;

  /* 2) 效价高斯契合 */
  const valFit = Math.exp(-Math.pow(f.valence - target.valence, 2) / (2 * 0.24 * 0.24));

  /* 3) 情绪环形邻近度（用效价/唤醒度二维距离）*/
  const aTrack = 0.62 * f.energy + 0.38 * f.danceability;
  const aTarget = 0.62 * target.energy + 0.38 * target.danceability;
  const circDist = Math.hypot(f.valence - target.valence, aTrack - aTarget);
  const moodMatch = Math.exp(-Math.pow(circDist, 2) / (2 * 0.46 * 0.46));

  /* 4) 用户偏好亲和度 */
  const pv = featuresToVector(prefs);
  let pdiff = 0;
  for (let i = 0; i < 5; i++) pdiff += Math.abs(fv[i] - pv[i]);
  const affinity = 1 - pdiff / 5;

  /* 5) 速度契合 */
  const tempoFit = Math.exp(-Math.pow(Math.log(Math.max(40, f.tempo) / Math.max(40, target.tempo)), 2) / (2 * 0.26 * 0.26));

  const parts = {
    closeness: 0.42 * closeness,
    valence: 0.18 * valFit,
    mood: 0.16 * moodMatch,
    affinity: 0.14 * affinity,
    tempo: 0.10 * tempoFit,
  };
  let score = parts.closeness + parts.valence + parts.mood + parts.affinity + parts.tempo;

  /* 稀有度/时长微调：过短不加分；本地曲库略优先（可离线）*/
  if (track.source === 'local') score += 0.008;

  return {
    score: clamp01(score),
    parts: {
      closeness, valFit, moodMatch, affinity, tempoFit, circDist,
    },
    reasons: buildReasons(track, target, parts, circDist),
  };
}

function fmt(v) { return v.toFixed(2); }

function buildReasons(track, target, p, circDist) {
  const r = [];
  const f = track.features;
  if (p.closeness > 0.80) r.push(`声学画像高度贴合 ${Math.round(p.closeness * 100)}%`);
  else if (p.closeness > 0.68) r.push(`声学画像接近 ${Math.round(p.closeness * 100)}%`);
  if (Math.abs(f.valence - target.valence) < 0.12) r.push(`效价 ${fmt(f.valence)} 与目标一致`);
  if (circDist < 0.22) r.push('情绪位置高度重合');
  if (Math.abs(f.energy - target.energy) < 0.12) r.push(`能量 ${fmt(f.energy)} 正好`);
  if (p.tempoFit > 0.9) r.push(`${Math.round(f.tempo)} BPM 速度契合`);
  if (f.acousticness > 0.7 && target.acousticness > 0.6) r.push('原声质感，低刺激');
  if (f.danceability > 0.75 && target.danceability > 0.65) r.push('律动驱动，易跟拍');
  if (!r.length) r.push('综合匹配');
  return r.slice(0, 3);
}

/* --------------------------------------------------------------------------
 * 列表重排：MMR 去重
 * ------------------------------------------------------------------------ */
function trackSim(a, b) {
  const av = featuresToVector(a.features), bv = featuresToVector(b.features);
  let d = 0;
  for (let i = 0; i < 5; i++) d += Math.abs(av[i] - bv[i]);
  let s = 1 - d / 5;
  if (a.artist && a.artist === b.artist) s = Math.min(1, s + 0.35);
  if (a.genre && a.genre === b.genre) s = Math.min(1, s + 0.12);
  return s;
}

/* 标题归一化：去掉 "- From ..."、"(Remastered)" 之类的后缀，用于同名曲硬去重 */
function titleKey(t) {
  return String(t.title || '')
    .toLowerCase()
    .replace(/[\(\[\{].*?[\)\]\}]/g, '')      // 括号内容
    .replace(/\s[-–—]\s.*$/, '')               // " - From xxx" 之类
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');  // 只留字母数字与汉字
}

export function mmrRerank(candidates, k = 8, lambda = 0.78) {
  // 同名曲硬去重：在线接口常常返回十几个 "Happy"/"Happy (Remastered)"，只留分数最高的那个
  const byTitle = new Map();
  for (const c of candidates) {
    const key = titleKey(c) || c.id;
    const prev = byTitle.get(key);
    if (!prev || (c.score || 0) > (prev.score || 0)) byTitle.set(key, c);
  }
  const pool = [...byTitle.values()];
  const picked = [];
  const pickedArtist = new Map();

  while (picked.length < k && pool.length) {
    let best = null, bestVal = -Infinity, bestIdx = -1;
    pool.forEach((c, i) => {
      const div = picked.length ? Math.max(...picked.map(s => trackSim(c, s))) : 0;
      let val = lambda * c.score - (1 - lambda) * div;
      // 同一歌手已出现 2 次以上的降权，避免整张歌单被一个人占满
      const ac = pickedArtist.get(c.artist) || 0;
      if (ac >= 2) val -= 0.18 * (ac - 1);
      if (val > bestVal) { bestVal = val; best = c; bestIdx = i; }
    });
    picked.push(best);
    pickedArtist.set(best.artist, (pickedArtist.get(best.artist) || 0) + 1);
    pool.splice(bestIdx, 1);
  }
  return picked;
}

/* --------------------------------------------------------------------------
 * 情绪弧线编排：第一首贴近当前情绪，之后逐步过渡到目标
 * ------------------------------------------------------------------------ */
export function sequencePlaylist(list, emotionKey, strategy) {
  if (list.length < 3 || strategy === 'empathize') return list;
  const base = MOOD_ACOUSTIC[emotionKey] || MOOD_ACOUSTIC.neutral;
  const bv = featuresToVector({ ...base, tempoNorm: tempoNorm(base.tempo) });
  const simOf = t => {
    const tv = featuresToVector(t.features);
    let d = 0;
    for (let i = 0; i < 5; i++) d += Math.abs(tv[i] - bv[i]);
    return 1 - d / 5;
  };
  // 只在「分数最高的前 4 首」里挑一首最贴近当前情绪的作为开头，避免为共情牺牲太多匹配度
  const top = [...list].sort((a, b) => b.score - a.score).slice(0, 4);
  const head = top.reduce((a, b) => (simOf(b) > simOf(a) ? b : a), top[0]);
  const best = Math.max(...list.map(t => t.score));
  if (head.score < best * 0.86) return list;
  const rest = list.filter(t => t.id !== head.id).sort((a, b) => b.score - a.score);
  return [head, ...rest];
}

/* ===========================================================================
 * 偏好学习
 * ======================================================================== */
const PREF_KEY = 'moodtune.prefs.v2';

export class PreferenceStore {
  constructor() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(PREF_KEY) || 'null'); } catch (e) { saved = null; }
    this.vector = saved?.vector
      ? saved.vector
      : { energy: 0.5, valence: 0.55, danceability: 0.5, acousticness: 0.5, tempoNorm: 0.5 };
    this.counts = saved?.counts || { like: 0, dislike: 0, skip: 0 };
    this.likedIds = new Set(saved?.likedIds || []);
    this.dislikedIds = new Set(saved?.dislikedIds || []);
  }

  save() {
    const payload = {
      vector: this.vector,
      counts: this.counts,
      likedIds: [...this.likedIds],
      dislikedIds: [...this.dislikedIds],
    };
    try { localStorage.setItem(PREF_KEY, JSON.stringify(payload)); } catch (e) { /* ignore */ }
  }

  /** type: like | dislike | skip */
  feedback(track, type) {
    const f = track.features;
    const eta = type === 'like' ? 0.22 : type === 'dislike' ? -0.20 : -0.05;
    DIMS.forEach(d => {
      const v = f[d] ?? tempoNorm(f.tempo);
      const cur = this.vector[d];
      let next = cur + eta * (v - cur);
      if (type !== 'like' && Math.abs(next - cur) < 0.004) next = cur;
      this.vector[d] = clamp01(next);
    });
    this.counts[type] = (this.counts[type] || 0) + 1;
    if (type === 'like') { this.likedIds.add(track.id); this.dislikedIds.delete(track.id); }
    if (type === 'dislike') { this.dislikedIds.add(track.id); this.likedIds.delete(track.id); }
    this.save();
  }

  reset() {
    this.vector = { energy: 0.5, valence: 0.55, danceability: 0.5, acousticness: 0.5, tempoNorm: 0.5 };
    this.counts = { like: 0, dislike: 0, skip: 0 };
    this.likedIds.clear(); this.dislikedIds.clear();
    this.save();
  }
}

/* --------------------------------------------------------------------------
 * 主推荐入口
 * ------------------------------------------------------------------------ */
export function recommend({ emotionKey, strategy, tracks, prefs, k = 8 }) {
  const target = buildTarget(emotionKey, strategy);
  const scored = [];
  for (const t of tracks) {
    if (prefs.dislikedIds.has(t.id)) continue;
    const { score, parts, reasons } = scoreTrack(t, target, prefs.vector);
    const bonus = prefs.likedIds.has(t.id) ? 0.04 : 0;
    scored.push({ ...t, score: clamp01(score + bonus), parts, reasons, liked: prefs.likedIds.has(t.id) });
  }
  scored.sort((a, b) => b.score - a.score);
  const diverse = mmrRerank(scored, k);
  return { target, list: sequencePlaylist(diverse, emotionKey, strategy) };
}
