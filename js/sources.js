/* ===========================================================================
 * sources.js —— 曲库与在线接口
 * ---------------------------------------------------------------------------
 * 1) 本地曲库：8 首离线可用曲目（assets/audio/*.mp3），元数据为合成时设定的
 *    真实声学参数（能量/效价/律动/原声度/速度）。
 * 2) 在线接口：
 *    - iTunes Search API（免 key、支持 CORS，返回 30s 试听 m4a）—— 主用
 *    - Audius API（开放、免 key、返回整曲流媒体地址）—— 备用
 * 3) 在线曲目的声学特征估计：
 *    元数据先验（曲风字典 + 关键词增量）+ 音频实测校正（能量/速度/律动/调式）
 * =========================================================================== */

import { MOOD_ACOUSTIC, tempoNorm, clamp01 } from './recommender.js';

/* --------------------------------------------------------------------------
 * 本地曲库
 * ------------------------------------------------------------------------ */
export const LOCAL_TRACKS = [
  { id: 'local-1', title: '阳光碎片', sub: 'Sunbeam Fragments', artist: 'MoodTune Lab',
    file: '01_sunbeam_happy.mp3', duration: 31.5, genre: 'Synth Pop', mood: 'happy',
    color: ['#fbbf24', '#f97316'], emoji: '☀️',
    features: { energy: 0.86, valence: 0.95, danceability: 0.88, acousticness: 0.18, tempo: 124 } },

  { id: 'local-2', title: '玻璃上的雨', sub: 'Rain on Glass', artist: 'MoodTune Lab',
    file: '02_rain_on_glass_sad.mp3', duration: 29.6, genre: 'Piano Ballad', mood: 'sad',
    color: ['#60a5fa', '#3b82f6'], emoji: '🌧️',
    features: { energy: 0.16, valence: 0.10, danceability: 0.20, acousticness: 0.82, tempo: 66 } },

  { id: 'local-3', title: '铁脉搏', sub: 'Iron Pulse', artist: 'MoodTune Lab',
    file: '03_iron_pulse_angry.mp3', duration: 26.1, genre: 'Industrial Rock', mood: 'angry',
    color: ['#ef4444', '#7f1d1d'], emoji: '🔥',
    features: { energy: 0.95, valence: 0.18, danceability: 0.60, acousticness: 0.05, tempo: 150 } },

  { id: 'local-4', title: '像素火花', sub: 'Pixel Spark', artist: 'MoodTune Lab',
    file: '04_pixel_spark_surprise.mp3', duration: 22.3, genre: 'Chiptune', mood: 'surprise',
    color: ['#a855f7', '#6366f1'], emoji: '✨',
    features: { energy: 0.80, valence: 0.62, danceability: 0.72, acousticness: 0.12, tempo: 132 } },

  { id: 'local-5', title: '空心的光', sub: 'Hollow Light', artist: 'MoodTune Lab',
    file: '05_hollow_light_fear.mp3', duration: 27.8, genre: 'Dark Ambient', mood: 'fear',
    color: ['#0ea5a4', '#134e4a'], emoji: '🌫️',
    features: { energy: 0.45, valence: 0.10, danceability: 0.22, acousticness: 0.55, tempo: 88 } },

  { id: 'local-6', title: '酸涩大理石', sub: 'Sour Marble', artist: 'MoodTune Lab',
    file: '06_sour_marble_disgust.mp3', duration: 28.7, genre: 'Art Rock', mood: 'disgust',
    color: ['#84cc16', '#3f6212'], emoji: '🫧',
    features: { energy: 0.40, valence: 0.15, danceability: 0.35, acousticness: 0.45, tempo: 102 } },

  { id: 'local-7', title: '纸月亮', sub: 'Paper Moon', artist: 'MoodTune Lab',
    file: '07_paper_moon_neutral.mp3', duration: 32.5, genre: 'Lo-fi Jazz', mood: 'neutral',
    color: ['#94a3b8', '#475569'], emoji: '🌙',
    features: { energy: 0.40, valence: 0.50, danceability: 0.50, acousticness: 0.60, tempo: 90 } },

  { id: 'local-8', title: '软潮', sub: 'Soft Tide', artist: 'MoodTune Lab',
    file: '08_soft_tide_calm.mp3', duration: 33.8, genre: 'Ambient Pop', mood: 'calm',
    color: ['#38bdf8', '#0ea5e9'], emoji: '🌊',
    features: { energy: 0.18, valence: 0.72, danceability: 0.25, acousticness: 0.88, tempo: 72 } },
].map(t => ({
  ...t,
  source: 'local',
  src: 'assets/audio/' + t.file,
  features: { ...t.features, tempoNorm: tempoNorm(t.features.tempo) },
  featSource: 'known',
}));

/* --------------------------------------------------------------------------
 * 元数据先验字典
 * ------------------------------------------------------------------------ */
const GENRE_PRIOR = {
  'pop': { energy: .66, valence: .64, danceability: .70, acousticness: .26, tempo: 116 },
  'hip-hop/rap': { energy: .70, valence: .48, danceability: .80, acousticness: .18, tempo: 96 },
  'hip hop': { energy: .70, valence: .48, danceability: .80, acousticness: .18, tempo: 96 },
  'rap': { energy: .70, valence: .48, danceability: .80, acousticness: .18, tempo: 96 },
  'rock': { energy: .80, valence: .44, danceability: .50, acousticness: .14, tempo: 124 },
  'alternative': { energy: .72, valence: .40, danceability: .52, acousticness: .22, tempo: 120 },
  'indie': { energy: .64, valence: .50, danceability: .55, acousticness: .42, tempo: 116 },
  'electronic': { energy: .80, valence: .55, danceability: .84, acousticness: .08, tempo: 126 },
  'dance': { energy: .84, valence: .68, danceability: .90, acousticness: .06, tempo: 128 },
  'house': { energy: .88, valence: .70, danceability: .92, acousticness: .05, tempo: 124 },
  'techno': { energy: .90, valence: .45, danceability: .90, acousticness: .05, tempo: 130 },
  'dubstep': { energy: .92, valence: .35, danceability: .72, acousticness: .05, tempo: 140 },
  'trap': { energy: .78, valence: .40, danceability: .82, acousticness: .10, tempo: 140 },
  'r&b/soul': { energy: .55, valence: .62, danceability: .70, acousticness: .32, tempo: 92 },
  'jazz': { energy: .40, valence: .58, danceability: .46, acousticness: .78, tempo: 108 },
  'classical': { energy: .22, valence: .60, danceability: .18, acousticness: .96, tempo: 88 },
  'country': { energy: .52, valence: .66, danceability: .55, acousticness: .58, tempo: 110 },
  'latin': { energy: .72, valence: .72, danceability: .82, acousticness: .35, tempo: 100 },
  'metal': { energy: .96, valence: .24, danceability: .44, acousticness: .04, tempo: 150 },
  'punk': { energy: .90, valence: .38, danceability: .52, acousticness: .06, tempo: 160 },
  'folk': { energy: .36, valence: .54, danceability: .40, acousticness: .90, tempo: 100 },
  'acoustic': { energy: .38, valence: .58, danceability: .42, acousticness: .92, tempo: 102 },
  'soundtrack': { energy: .42, valence: .40, danceability: .30, acousticness: .72, tempo: 100 },
  'ambient': { energy: .18, valence: .55, danceability: .16, acousticness: .80, tempo: 80 },
  'world': { energy: .55, valence: .64, danceability: .55, acousticness: .55, tempo: 104 },
  'reggae': { energy: .55, valence: .78, danceability: .72, acousticness: .45, tempo: 90 },
  'soul': { energy: .52, valence: .64, danceability: .66, acousticness: .40, tempo: 96 },
  'funk': { energy: .72, valence: .74, danceability: .84, acousticness: .30, tempo: 108 },
  'anime': { energy: .72, valence: .62, danceability: .62, acousticness: .22, tempo: 132 },
  'k-pop': { energy: .80, valence: .70, danceability: .82, acousticness: .12, tempo: 122 },
  'default': { energy: .62, valence: .58, danceability: .62, acousticness: .35, tempo: 112 },
};

const KEYWORD_RULES = [
  { re: /(remix|extended|club mix|bootleg)/i, d: { danceability: .10, energy: .07 } },
  { re: /(acoustic|unplugged)/i, d: { acousticness: .22, energy: -.10 } },
  { re: /(piano|lullaby|music box)/i, d: { acousticness: .18, energy: -.09, tempo: -10 } },
  { re: /(lofi|lo-fi|study|sleep|relax|chillhop)/i, d: { energy: -.26, danceability: -.12, acousticness: .18, tempo: -16 } },
  { re: /(chill|calm|peaceful|gentle)/i, d: { energy: -.12, acousticness: .06 } },
  { re: /(ambient|drone|cinematic|soundtrack|score)/i, d: { energy: -.16, acousticness: .22 } },
  { re: /(sad|blue|cry|tears|lonely|broken|miss you|goodbye|memories|秋天|孤单|遗憾)/i,
    d: { valence: -.24, energy: -.06 } },
  { re: /(happy|sunshine|good time|feel good|smile|joy|元气|快乐|阳光)/i,
    d: { valence: .18, energy: .10 } },
  { re: /(love|heart|baby|forever|kiss|情|爱)/i, d: { valence: .08 } },
  { re: /(fast|uptempo|speed|energy)/i, d: { energy: .12, tempo: 14 } },
  { re: /(slow|ballad|rain|night|dream|慢)/i, d: { energy: -.13, tempo: -14, valence: -.05 } },
  { re: /(rock|metal|punk|hardcore|dubstep)/i, d: { energy: .18, acousticness: -.12 } },
  { re: /(edm|electro|synth|techno|house|remix)/i, d: { energy: .14, danceability: .14, acousticness: -.10 } },
  { re: /(guitar|folk|strings|violin|cello)/i, d: { acousticness: .14 } },
];

const AUDIUS_MOOD = {
  'peaceful': { energy: .22, valence: .66, acousticness: .75, tempo: 82 },
  'romantic': { energy: .42, valence: .74, acousticness: .55, tempo: 92 },
  'sentimental': { energy: .32, valence: .45, acousticness: .70, tempo: 80 },
  'tender': { energy: .28, valence: .60, acousticness: .72, tempo: 84 },
  'easylistening': { energy: .35, valence: .62, danceability: .45, tempo: 96 },
  'upbeat': { energy: .82, valence: .82, danceability: .78, tempo: 122 },
  'happy': { energy: .78, valence: .88, danceability: .76, tempo: 118 },
  'funky': { energy: .72, valence: .76, danceability: .86, tempo: 108 },
  'electronic': { energy: .80, valence: .55, danceability: .84, tempo: 126 },
  'fiery': { energy: .94, valence: .30, danceability: .60, tempo: 146 },
  'sad': { energy: .20, valence: .10, danceability: .20, tempo: 70 },
  'dark': { energy: .55, valence: .12, danceability: .40, tempo: 96 },
  'melancholy': { energy: .24, valence: .14, danceability: .25, tempo: 76 },
  'aggressive': { energy: .95, valence: .18, acousticness: .05, tempo: 150 },
  'chill': { energy: .28, valence: .58, acousticness: .70, tempo: 84 },
  'dreamy': { energy: .30, valence: .55, acousticness: .68, tempo: 86 },
  'mellow': { energy: .30, valence: .50, acousticness: .66, tempo: 88 },
  'trippy': { energy: .45, valence: .40, acousticness: .30, tempo: 104 },
  'cinematic': { energy: .42, valence: .40, acousticness: .70, tempo: 100 },
  'ambient': { energy: .18, valence: .55, acousticness: .82, tempo: 78 },
};

function pickGenrePrior(genre = '') {
  const g = String(genre).toLowerCase();
  for (const k of Object.keys(GENRE_PRIOR)) {
    if (k !== 'default' && g.includes(k)) return GENRE_PRIOR[k];
  }
  return GENRE_PRIOR.default;
}

/* --------------------------------------------------------------------------
 * 元数据 → 声学特征估计
 * ------------------------------------------------------------------------ */
export function estimateFeatures(meta, moodKey) {
  const genreP = pickGenrePrior(meta.genre);
  const moodP = meta.moodKey ? AUDIUS_MOOD[String(meta.moodKey).toLowerCase()] : null;
  const proto = MOOD_ACOUSTIC[moodKey] || MOOD_ACOUSTIC.neutral;

  // 曲风先验 55% + 检索情绪原型 30% + 平台情绪标签 15%
  const w1 = moodP ? 0.45 : 0.62, w2 = 0.35, w3 = moodP ? 0.20 : 0;
  const blend = (key, fallback) => {
    const g = genreP[key] ?? fallback;
    const m = proto[key] ?? fallback;
    const u = moodP ? (moodP[key] ?? m) : m;
    return g * w1 + m * w2 + u * w3;
  };

  const f = {
    energy: blend('energy', 0.6),
    valence: blend('valence', 0.55),
    danceability: blend('danceability', 0.6),
    acousticness: blend('acousticness', 0.4),
    tempo: (genreP.tempo ?? 112) * w1 + (proto.tempo ?? 112) * w2 + ((moodP && moodP.tempo) || proto.tempo || 112) * w3,
  };

  // 关键词增量（只看标题/歌手/专辑/标签，曲风已由 GENRE_PRIOR 处理，避免重复计入）
  const text = [meta.title, meta.artist, meta.album, ...(meta.tags || [])].filter(Boolean).join(' ');
  for (const rule of KEYWORD_RULES) {
    if (!rule.re.test(text)) continue;
    for (const [k, v] of Object.entries(rule.d)) {
      if (k === 'tempo') f.tempo += v;
      else f[k] = (f[k] ?? 0.5) + v;
    }
  }

  f.energy = clamp01(f.energy);
  f.valence = clamp01(f.valence);
  f.danceability = clamp01(f.danceability);
  f.acousticness = clamp01(f.acousticness);
  f.tempo = Math.min(180, Math.max(58, f.tempo));
  f.tempoNorm = tempoNorm(f.tempo);
  return f;
}

/* --------------------------------------------------------------------------
 * 音频实测（WebAudio 解码 + FFT 特征提取）
 *    - 能量：RMS 均值
 *    - 亮度：谱质心
 *    - 律动：谱通量本体密度（onset/s）
 *    - 速度：onset 包络自相关峰值
 *    - 调式：Krumhansl-Kessler 调性模板相关（大调 → 效价上调）
 * ------------------------------------------------------------------------ */
const analysisCache = new Map();

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / Math.sqrt(da * db + 1e-9);
}

export async function analyzeAudioFeatures(url) {
  if (analysisCache.has(url)) return analysisCache.get(url);
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('no WebAudio');

  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = await res.arrayBuffer();

  const ctx = new Ctx();
  const audio = await ctx.decodeAudioData(buf);
  try { ctx.close(); } catch (e) { /* ignore */ }

  const sr = audio.sampleRate;
  const chs = Math.min(2, audio.numberOfChannels);
  const start = Math.floor(Math.min(1.0, audio.duration * 0.1) * sr);
  const len = Math.min(audio.length - start, 20 * sr);
  const mono = new Float32Array(len);
  for (let c = 0; c < chs; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[start + i] / chs;
  }

  const N = 2048, hop = 1024;
  const frames = Math.floor((len - N) / hop);
  const flux = new Float32Array(frames);
  const chroma = new Array(12).fill(0);
  let rmsSum = 0, centroidSum = 0, prevMag = null;

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    const re = new Float32Array(N), im = new Float32Array(N);
    let sum2 = 0;
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); // Hann
      const v = mono[off + i] * w;
      re[i] = v; sum2 += mono[off + i] * mono[off + i];
    }
    rmsSum += Math.sqrt(sum2 / N);
    fft(re, im);

    const half = N / 2;
    let wsum = 0, csum = 0, fsum = 0;
    const mag = new Float32Array(half);
    for (let k = 1; k < half; k++) {
      const m = Math.hypot(re[k], im[k]);
      mag[k] = m;
      const freq = k * sr / N;
      wsum += m;
      csum += m * freq;
      if (prevMag) { const d = m - prevMag[k]; if (d > 0) fsum += d; }
      if (freq > 80 && freq < 2200 && m > 1e-4) {
        const midi = 69 + 12 * Math.log2(freq / 440);
        const pc = ((Math.round(midi) % 12) + 12) % 12;
        chroma[pc] += m * m;
      }
    }
    flux[f] = fsum;
    if (wsum > 1e-6) centroidSum += csum / wsum;
    prevMag = mag;
  }

  const rms = rmsSum / Math.max(1, frames);
  const centroidHz = centroidSum / Math.max(1, frames);

  // 本体密度
  const meanFlux = flux.reduce((a, b) => a + b, 0) / Math.max(1, frames);
  let onsets = 0;
  for (let i = 1; i < frames; i++) if (flux[i] > meanFlux * 1.35 && flux[i] > flux[i - 1]) onsets++;
  const onsetRate = onsets / (len / sr);

  // 速度：onset 包络自相关
  const envRate = frames / (len / sr);
  let bestBpm = 0, bestScore = -1;
  for (let bpm = 60; bpm <= 180; bpm += 1) {
    const lag = Math.round(envRate * 60 / bpm);
    if (lag < 2 || lag >= frames / 2) continue;
    let acc = 0;
    for (let i = 0; i + lag < frames; i++) acc += flux[i] * flux[i + lag];
    acc /= (frames - lag);
    if (acc > bestScore) { bestScore = acc; bestBpm = bpm; }
  }

  // 调式
  const chromaNorm = chroma.map(v => v / (Math.max(...chroma) + 1e-9));
  let bestMajor = -2, bestMinor = -2;
  for (let rot = 0; rot < 12; rot++) {
    const rotated = [];
    for (let i = 0; i < 12; i++) rotated.push(chromaNorm[(i + rot) % 12]);
    bestMajor = Math.max(bestMajor, corr(rotated, KK_MAJOR));
    bestMinor = Math.max(bestMinor, corr(rotated, KK_MINOR));
  }
  const mode = bestMajor >= bestMinor ? 'major' : 'minor';
  const modeConf = Math.abs(bestMajor - bestMinor);

  const out = {
    energy: clamp01(rms / 0.26),
    brightness: clamp01((centroidHz - 600) / 3600),
    onsetRate,
    danceability: clamp01((onsetRate - 0.7) / 2.4),
    tempo: bestBpm || 0,
    mode,
    modeConf: clamp01(modeConf * 3),
    measured: true,
  };
  analysisCache.set(url, out);
  return out;
}

/** 用实测结果校正元数据估计 */
export function applyMeasurement(features, m) {
  const f = { ...features };
  f.energy = clamp01(0.62 * m.energy + 0.38 * f.energy);
  if (m.danceability > 0.05) f.danceability = clamp01(0.55 * m.danceability + 0.45 * f.danceability);
  if (m.tempo >= 60) {
    f.tempo = 0.65 * m.tempo + 0.35 * f.tempo;
    f.tempoNorm = tempoNorm(f.tempo);
  }
  if (m.mode === 'minor') f.valence = clamp01(f.valence - 0.10 * (0.4 + m.modeConf));
  else f.valence = clamp01(f.valence + 0.08 * (0.4 + m.modeConf));
  f.acousticness = clamp01(f.acousticness + (0.5 - m.brightness) * 0.18);
  return f;
}

/* --------------------------------------------------------------------------
 * 在线接口 1：iTunes Search API
 * ------------------------------------------------------------------------ */
const QUERY_TERMS = {
  happy: ['happy upbeat pop', 'feel good songs', 'sunshine dance pop'],
  sad: ['sad acoustic songs', 'melancholy piano', 'sad piano ballad'],
  angry: ['angry rock anthem', 'hard rock heavy', 'aggressive rock'],
  surprise: ['quirky upbeat pop', 'playful electronic', 'whimsical indie pop'],
  fear: ['dark ambient cinematic', 'eerie suspense', 'dark cinematic score'],
  disgust: ['grunge dirty rock', 'noise rock', 'raw garage rock'],
  neutral: ['lofi chill beats', 'easy listening acoustic', 'chill jazz'],
  calm: ['calm piano ambient', 'soft acoustic relax', 'peaceful ambient'],
};

export async function searchITunes(term, limit = 10, country = 'us') {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}`
    + `&media=music&entity=song&limit=${limit}&country=${country}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('iTunes HTTP ' + res.status);
  const data = await res.json();
  return (data.results || [])
    .filter(r => r.previewUrl && r.kind === 'song')
    .map(r => ({
      id: 'itunes-' + r.trackId,
      title: r.trackName,
      artist: r.artistName,
      album: r.collectionName,
      genre: r.primaryGenreName,
      artwork: (r.artworkUrl100 || '').replace('100x100', '300x300'),
      src: r.previewUrl,
      duration: 30,
      source: 'itunes',
      rawTags: [],
    }));
}

/* --------------------------------------------------------------------------
 * 在线接口 2：Audius
 * ------------------------------------------------------------------------ */
const AUDIUS_APP = 'MoodTune';
let audiusHost = 'https://api.audius.co';

export async function searchAudius(term, limit = 8) {
  const url = `${audiusHost}/v1/tracks/search?query=${encodeURIComponent(term)}&app_name=${AUDIUS_APP}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Audius HTTP ' + res.status);
  const data = await res.json();
  return (data.data || [])
    .filter(t => t.is_streamable && t.id)
    .map(t => ({
      id: 'audius-' + t.id,
      title: t.title,
      artist: (t.user && t.user.name) || 'Audius',
      album: '',
      genre: t.genre,
      moodKey: t.mood,
      artwork: t.artwork ? t.artwork['480x480'] : '',
      src: `${audiusHost}/v1/tracks/${t.id}/stream?app_name=${AUDIUS_APP}`,
      duration: t.duration || 180,
      source: 'audius',
      rawTags: t.tags ? String(t.tags).split(',') : [],
    }));
}

/* --------------------------------------------------------------------------
 * 聚合：情绪 → 候选池
 * ------------------------------------------------------------------------ */
export async function fetchOnlineTracks(moodKey, { provider = 'itunes', limit = 12, country = 'us' } = {}) {
  const terms = QUERY_TERMS[moodKey] || QUERY_TERMS.neutral;
  const picked = terms.slice(0, 2);
  const batches = await Promise.allSettled(
    picked.map(t => (provider === 'audius' ? searchAudius(t, limit) : searchITunes(t, limit, country)))
  );
  const seen = new Set();
  const out = [];
  for (const b of batches) {
    if (b.status !== 'fulfilled') continue;
    for (const t of b.value) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      t.features = estimateFeatures(
        { title: t.title, artist: t.artist, album: t.album, genre: t.genre, moodKey: t.moodKey, tags: t.rawTags },
        moodKey
      );
      t.featSource = 'estimated';
      out.push(t);
    }
  }
  return out;
}

/** 对在线曲目做真实的音频特征实测（并发限流） */
export async function measureTracks(tracks, { concurrency = 3, timeout = 9000 } = {}) {
  const queue = [...tracks];
  let done = 0;
  const workers = new Array(concurrency).fill(0).map(async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        const m = await Promise.race([
          analyzeAudioFeatures(t.src),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout)),
        ]);
        t.features = applyMeasurement(t.features, m);
        t.featSource = 'measured';
        t.measured = { mode: m.mode, brightness: m.brightness, onsetRate: m.onsetRate, bpm: m.tempo };
      } catch (e) {
        t.featSource = 'estimated';
      }
      done++;
    }
  });
  await Promise.all(workers);
  return { measured: done, total: tracks.length };
}

export function buildCandidates(moodKey, onlineTracks, { includeLocal = true } = {}) {
  const list = [];
  if (includeLocal) list.push(...LOCAL_TRACKS);
  list.push(...onlineTracks);
  return list;
}
