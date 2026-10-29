/* ===========================================================================
 * app.js —— Vue 3 应用主逻辑
 * =========================================================================== */

const { createApp, ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } = Vue;

import { EmotionEngine, EMOTIONS, EMO_BY_KEY, FEATURE_LABELS } from './emotion-engine.js';
import {
  recommend, buildTarget, PreferenceStore, DIMS, DIM_LABEL, STRATEGIES, tempoNorm,
} from './recommender.js';
import {
  LOCAL_TRACKS, fetchOnlineTracks, measureTracks, buildCandidates,
} from './sources.js';

const DEMO_FACES = [
  { file: 'assets/faces/happy.jpg', label: '开心', expect: 'happy' },
  { file: 'assets/faces/sad.jpg', label: '悲伤', expect: 'sad' },
  { file: 'assets/faces/angry.jpg', label: '愤怒', expect: 'angry' },
  { file: 'assets/faces/surprise.jpg', label: '惊讶', expect: 'surprise' },
  { file: 'assets/faces/fear.jpg', label: '恐惧', expect: 'fear' },
  { file: 'assets/faces/disgust.jpg', label: '厌恶', expect: 'disgust' },
  { file: 'assets/faces/neutral.jpg', label: '平静', expect: 'neutral' },
  { file: 'assets/faces/group.jpg', label: '双人', expect: '' },
];

const thumbCache = new Map();  // moodKey -> online tracks
const coverCache = new Map();

const App = {
  setup() {
    /* ------------------------------ 状态 ------------------------------ */
    const engine = new EmotionEngine();
    const prefs = new PreferenceStore();

    const modelState = ref('loading');     // loading | ready | error
    const modelError = ref('');
    const backend = ref('-');

    const mode = ref('camera');            // camera | image | video | shot
    const camState = ref('idle');          // idle | starting | running | denied
    const camError = ref('');
    const videoReady = ref(false);
    const imageSrc = ref('');
    const imageName = ref('');
    const videoName = ref('');
    const expecting = ref(false);          // 是否已有可分析画面

    const frame = ref(null);               // 聚合结果
    const fps = ref(0);
    const frameCount = ref(0);
    const inferMs = ref(0);
    const showDetail = ref(false);
    const countdown = ref(0);
    const flash = ref(false);

    const strategy = ref('empathize');
    const playlist = ref([]);
    const target = ref(null);
    const recommending = ref(false);
    const recInfo = ref({ online: 0, measured: 0, estimated: 0, from: '' });
    const recBusyKey = ref('');

    const onlineEnabled = ref(true);
    const provider = ref('itunes');
    const measureEnabled = ref(true);

    const current = ref(null);
    const playing = ref(false);
    const progress = ref(0);
    const duration = ref(0);
    const volume = ref(0.8);
    const playlistIdx = ref(-1);

    const toastMsg = ref('');
    const showDocs = ref(false);
    const prefStats = reactive({ like: 0, dislike: 0, skip: 0 });

    const videoEl = ref(null);
    const overlayEl = ref(null);
    const audioEl = ref(null);

    let stream = null;
    let loopTimer = 0;
    let busy = false;
    let inferBusySince = 0;
    let lastInfer = 0;
    let epoch = 0;
    let recTimer = 0;
    let recKey = '';          // 已完成推荐所对应的情绪
    let pendingKey = '';      // 正在请求中的情绪
    let lastRecAt = 0;

    /* ------------------------------ 工具 ------------------------------ */
    function toast(m) {
      toastMsg.value = m;
      clearTimeout(toast._t);
      toast._t = setTimeout(() => { toastMsg.value = ''; }, 2600);
    }

    function fmtTime(s) {
      if (!isFinite(s) || s < 0) s = 0;
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${String(sec).padStart(2, '0')}`;
    }

    /* ------------------------------ 模型初始化 ------------------------ */
    async function initModel() {
      try {
        await engine.init();
        backend.value = engine.backend;
        modelState.value = 'ready';
        if (mode.value === 'camera') startCamera();
      } catch (e) {
        console.error(e);
        modelState.value = 'error';
        modelError.value = e.message || String(e);
      }
    }

    /* ------------------------------ 摄像头 ---------------------------- */
    async function startCamera() {
      if (camState.value === 'running' || camState.value === 'starting') return;
      camState.value = 'starting';
      camError.value = '';
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: 'user' },
          audio: false,
        });
        const v = videoEl.value;
        v.srcObject = stream;
        await v.play();
        await nextTick();
        videoReady.value = true;
        expecting.value = true;
        camState.value = 'running';
        startLoop();
      } catch (e) {
        camState.value = 'denied';
        camError.value = e.name === 'NotAllowedError'
          ? '摄像头权限被拒绝，请在浏览器地址栏允许摄像头访问'
          : (e.message || '无法访问摄像头');
      }
    }

    function stopCamera() {
      stopLoop();
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
      }
      const v = videoEl.value;
      if (v) v.srcObject = null;
      videoReady.value = false;
      camState.value = 'idle';
      clearOverlay();
    }

    /* ------------------------------ 推理循环 --------------------------
     * 固定节拍（约 110 ms/帧）+ 互斥锁 + 看门狗：
     * 上一帧没算完就跳过，单帧超过 8 s 仍未返回则强制解锁，避免循环被拖死。
     * -------------------------------------------------------------- */
    function stopLoop() {
      if (loopTimer) { clearInterval(loopTimer); loopTimer = 0; }
      busy = false;
      inferBusySince = 0;
    }

    function startLoop() {
      stopLoop();
      loopTimer = setInterval(tick, 110);
      tick();
    }

    async function tick() {
      if (busy || !expecting.value) return;
      const el = videoEl.value;
      if (!el || !(el.videoWidth || el.naturalWidth)) return;

      busy = true;
      inferBusySince = performance.now();
      const t0 = inferBusySince;
      let res = null;
      try {
        res = await Promise.race([
          engine.analyze(el, { smooth: true }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('infer timeout')), 8000)),
        ]);
      } catch (e) {
        console.warn('[loop]', e && e.message);
      } finally {
        busy = false;
        inferBusySince = 0;
      }
      if (!res) return;
      inferMs.value = Math.round(performance.now() - t0);
      frameCount.value++;
      fps.value = +(1000 / Math.max(80, performance.now() - t0)).toFixed(1);
      handleResult(res);
    }

    /* ------------------------------ 结果处理 -------------------------- */
    function handleResult(res) {
      const agg = res.aggregate;
      frame.value = agg;
      drawOverlay(agg, res.faces);
      if (agg.exists && agg.primary) {
        maybeRecommend(agg.primary.key, agg.primary.confidence, agg.streak || 0);
      }
    }

    function maybeRecommend(key, conf, streak) {
      // 实时流里情绪会抖动：连续 3 帧同一情绪 + 足够自信，且与上次推荐的情绪不同才重算歌单
      const streaming = mode.value === 'camera' || mode.value === 'video';
      if (streaming && streak < 3) return;
      if (conf < 0.40) return;
      if (recommending.value || pendingKey) return;
      if (key === recKey && playlist.value.length) return;
      if (performance.now() - lastRecAt < 1500) return;
      clearTimeout(recTimer);
      recTimer = setTimeout(() => {
        lastRecAt = performance.now();
        pendingKey = key;
        doRecommend(key);
      }, 380);
    }

    /* ------------------------------ 静态图分析 ------------------------ */
    async function analyzeStill(imgEl) {
      if (!imgEl || !imgEl.complete || !imgEl.naturalWidth) return;
      const myEpoch = ++epoch;
      stopCamera();
      expecting.value = true;
      clearOverlay();
      await nextTick();
      try {
        const t0 = performance.now();
        const res = await engine.analyze(imgEl, { smooth: false });
        if (myEpoch !== epoch) return;
        inferMs.value = Math.round(performance.now() - t0);
        handleResult(res);
        if (res.aggregate.exists) {
          doRecommend(res.aggregate.primary.key);
        } else {
          toast('未检测到人脸，换一张试试');
          playlist.value = [];
        }
      } catch (e) {
        console.error(e);
        toast('分析失败：' + (e.message || e));
      }
    }

    /* ------------------------------ 图片载入 -------------------------- */
    function loadImageFromFile(file) {
      if (!file) return;
      if (!file.type.startsWith('image/')) { toast('请选择图片文件'); return; }
      const url = URL.createObjectURL(file);
      imageName.value = file.name;
      imageSrc.value = url;
      mode.value = 'image';
      expecting.value = false;
      frame.value = null;
      playlist.value = [];
      stopCamera();
      nextTick(() => {
        const img = document.getElementById('still-img');
        if (img) {
          if (img.complete) analyzeStill(img);
          else img.onload = () => analyzeStill(img);
        }
      });
    }

    function loadDemo(url, name) {
      epoch++;
      imageSrc.value = url;
      imageName.value = name;
      mode.value = 'image';
      frame.value = null;
      playlist.value = [];
      expecting.value = false;
      stopCamera();
      engine.reset();
      nextTick(() => {
        const img = document.getElementById('still-img');
        if (!img) return;
        const go = () => analyzeStill(img);
        if (img.complete && img.naturalWidth) go();
        else img.onload = go;
      });
    }

    /* ------------------------------ 视频文件 -------------------------- */
    async function loadVideoFile(file) {
      if (!file) return;
      if (!file.type.startsWith('video/')) { toast('请选择视频文件'); return; }
      stopCamera();
      epoch++;
      videoName.value = file.name;
      const url = URL.createObjectURL(file);
      const v = videoEl.value;
      v.srcObject = null;
      v.src = url;
      v.loop = true;
      v.muted = false;
      mode.value = 'video';
      frame.value = null;
      playlist.value = [];
      engine.reset();
      try {
        await v.play();
      } catch (e) {
        v.muted = true;
        try { await v.play(); } catch (e2) { /* ignore */ }
      }
      videoReady.value = true;
      expecting.value = true;
      startLoop();
    }

    async function loadDemoVideo() {
      try {
        const res = await fetch('assets/video/demo_moods.mp4');
        const blob = await res.blob();
        loadVideoFile(new File([blob], 'demo_moods.mp4', { type: 'video/mp4' }));
      } catch (e) {
        toast('示例视频加载失败');
      }
    }

    /* ------------------------------ 拍照 ------------------------------ */
    async function capturePhoto() {
      if (camState.value !== 'running') {
        await startCamera();
        await new Promise(r => setTimeout(r, 500));
      }
      if (camState.value !== 'running') { toast(camError.value || '摄像头未就绪'); return; }
      for (let i = 3; i > 0; i--) {
        countdown.value = i;
        await new Promise(r => setTimeout(r, 700));
      }
      countdown.value = 0;
      flash.value = true;
      setTimeout(() => { flash.value = false; }, 480);

      const v = videoEl.value;
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      const ctx = c.getContext('2d');
      ctx.translate(c.width, 0);
      ctx.scale(-1, 1);                      // 与镜像预览一致
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL('image/jpeg', 0.92);

      const img = new Image();
      img.onload = () => {
        stopCamera();
        imageSrc.value = dataUrl;
        imageName.value = '拍照 ' + new Date().toLocaleTimeString();
        mode.value = 'image';
        frame.value = null;
        playlist.value = [];
        nextTick(() => analyzeStill(img));
      };
      img.src = dataUrl;
    }

    /* ------------------------------ 覆盖层绘制 ------------------------ */
    function clearOverlay() {
      const cv = overlayEl.value;
      if (!cv) return;
      const ctx = cv.getContext('2d');
      ctx && ctx.clearRect(0, 0, cv.width, cv.height);
    }

    function drawOverlay(agg, faces) {
      const cv = overlayEl.value;
      if (!cv) return;
      const el = mode.value === 'image'
        ? document.getElementById('still-img')
        : videoEl.value;
      if (!el) return;
      const w = el.videoWidth || el.naturalWidth || 0;
      const h = el.videoHeight || el.naturalHeight || 0;
      if (!w || !h) return;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      if (!agg || !agg.exists) return;

      for (const f of agg.all) {
        const emo = EMO_BY_KEY[f.key];
        const box = f.box;
        const lw = Math.max(2, w / 320);
        // 角标框
        ctx.strokeStyle = emo.color;
        ctx.lineWidth = lw;
        const r = Math.max(6, w / 90);
        ctx.beginPath();
        const x = box.x, y = box.y, bw = box.width, bh = box.height;
        const c = Math.min(r, bw / 3, bh / 3);
        ctx.moveTo(x + c, y);
        ctx.arcTo(x + bw, y, x + bw, y + bh, c);
        ctx.arcTo(x + bw, y + bh, x, y + bh, c);
        ctx.arcTo(x, y + bh, x, y, c);
        ctx.arcTo(x, y, x + bw, y, c);
        ctx.closePath();
        ctx.stroke();

        // 关键点
        ctx.fillStyle = 'rgba(255,255,255,.85)';
        for (const p of f.landmarks) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(1.2, w / 700), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = emo.color;
        for (const i of [36, 39, 42, 45, 48, 54, 51, 57, 62, 66, 27, 30, 8]) {
          const p = f.landmarks[i];
          if (!p) continue;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(2, w / 420), 0, Math.PI * 2);
          ctx.fill();
        }

        // 标签（镜像预览时把文字反向翻转回来，避免出现"镜像字"）
        const label = `${emo.label} ${Math.round(f.p * 100)}%`;
        const fs = Math.max(13, w / 34);
        ctx.font = `600 ${fs}px "Inter","PingFang SC","Microsoft YaHei",sans-serif`;
        const tw = ctx.measureText(label).width;
        const padX = fs * 0.5, ph = fs * 1.7;
        const bw2 = tw + padX * 2;
        const lx = Math.max(4, Math.min(w - bw2 - 4, box.x));
        const ly = Math.max(4, box.y - ph - 6);
        const cx = lx + bw2 / 2;
        const cy = ly + ph / 2;
        const mirrored = mode.value !== 'video';
        ctx.save();
        ctx.translate(cx, cy);
        if (mirrored) ctx.scale(-1, 1);
        ctx.fillStyle = emo.color;
        roundRect(ctx, -bw2 / 2, -ph / 2, bw2, ph, fs * 0.4);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 0, 1);
        ctx.restore();
      }
    }

    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    /* ------------------------------ 推荐 ------------------------------ */
    async function doRecommend(key, { force = false } = {}) {
      if (!key) return;
      const moodKey = key;
      recommending.value = true;
      recBusyKey.value = key;
      try {
        let online = [];
        if (onlineEnabled.value) {
          const cacheKey = `${provider.value}:${moodKey}`;
          if (thumbCache.has(cacheKey) && !force) {
            online = thumbCache.get(cacheKey);
          } else {
            try {
              online = await fetchOnlineTracks(moodKey, { provider: provider.value });
              if (measureEnabled.value && online.length) {
                await measureTracks(online.slice(0, 10), { concurrency: 3 });
              }
              thumbCache.set(cacheKey, online);
            } catch (e) {
              console.warn('在线曲库失败', e);
              online = [];
              toast('在线曲库连接失败，已使用本地曲库');
            }
          }
        }
        const pool = buildCandidates(moodKey, online, { includeLocal: true });
        const res = recommend({
          emotionKey: moodKey,
          strategy: strategy.value,
          tracks: pool,
          prefs,
          k: 9,
        });
        playlist.value = res.list;
        target.value = res.target;
        recInfo.value = {
          online: online.length,
          measured: res.list.filter(t => t.source !== 'local' && t.featSource === 'measured').length,
          estimated: res.list.filter(t => t.source !== 'local' && t.featSource !== 'measured').length,
          from: online.length ? '本地 + 在线' : '本地曲库',
        };
        if (!current.value || !res.list.find(t => t.id === current.value.id)) {
          current.value = res.list[0] || null;
          playlistIdx.value = 0;
          progress.value = 0;
        }
        recKey = moodKey;
      } finally {
        recommending.value = false;
        pendingKey = '';
        recBusyKey.value = '';
      }
    }

    function reroll() {
      const key = frame.value?.primary?.key || recKey || 'neutral';
      thumbCache.delete(`${provider.value}:${key}`);
      doRecommend(key, { force: true });
      toast('已重新计算推荐');
    }

    watch(strategy, () => {
      const key = frame.value?.primary?.key;
      if (key) doRecommend(key);
      if (current.value) {
        // 切换策略后重新排队，但保留当前播放
        const idx = playlist.value.findIndex(t => t.id === current.value.id);
        playlistIdx.value = idx;
      }
    });

    watch(onlineEnabled, () => {
      const key = frame.value?.primary?.key;
      if (key) doRecommend(key, { force: true });
    });

    /* ------------------------------ 播放器 ---------------------------- */
    function playTrack(t) {
      const idx = playlist.value.findIndex(x => x.id === t.id);
      playlistIdx.value = idx;
      current.value = t;
      progress.value = 0;
      nextTick(() => {
        const a = audioEl.value;
        if (!a) return;
        a.src = t.src;
        a.volume = volume.value;
        a.play().then(() => { playing.value = true; })
          .catch(err => { playing.value = false; toast('播放失败：' + (err.message || '未知错误')); });
      });
    }

    function togglePlay() {
      const a = audioEl.value;
      if (!current.value && playlist.value.length) { playTrack(playlist.value[0]); return; }
      if (!a || !current.value) return;
      if (a.paused) {
        if (!a.src) a.src = current.value.src;
        a.play().then(() => { playing.value = true; }).catch(() => {});
      } else {
        a.pause();
        playing.value = false;
      }
    }

    function next() {
      if (!playlist.value.length) return;
      const nextIdx = (playlistIdx.value + 1) % playlist.value.length;
      playTrack(playlist.value[nextIdx]);
    }

    function prev() {
      if (!playlist.value.length) return;
      const i = (playlistIdx.value - 1 + playlist.value.length) % playlist.value.length;
      playTrack(playlist.value[i]);
    }

    function onTime() {
      const a = audioEl.value;
      if (!a) return;
      progress.value = a.currentTime;
      if (isFinite(a.duration) && a.duration > 0) duration.value = a.duration;
    }

    function onMeta() {
      const a = audioEl.value;
      if (a && isFinite(a.duration)) duration.value = a.duration;
    }

    function onAudioError() {
      toast('音频加载失败（可能为网络或版权限制），换一首试试');
      playing.value = false;
    }

    function seek(e) {
      const a = audioEl.value;
      if (!a || !duration.value) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      a.currentTime = p * duration.value;
      progress.value = a.currentTime;
    }

    watch(volume, v => {
      if (audioEl.value) audioEl.value.volume = v;
    });

    const progressPct = computed(() => {
      const d = duration.value || current.value?.duration || 30;
      return Math.min(100, (progress.value / d) * 100);
    });

    /* ------------------------------ 反馈 ------------------------------ */
    function like(t) {
      prefs.feedback(t, 'like');
      prefStats.like = prefs.counts.like;
      t.liked = true;
      toast(`已记住你更喜欢「${t.title}」这类声音`);
      const key = frame.value?.primary?.key;
      if (key) doRecommend(key);
    }

    function dislike(t) {
      prefs.feedback(t, 'dislike');
      prefStats.dislike = prefs.counts.dislike;
      playlist.value = playlist.value.filter(x => x.id !== t.id);
      toast('已减少这类推荐');
      const key = frame.value?.primary?.key;
      if (key) doRecommend(key);
    }

    function resetPrefs() {
      prefs.reset();
      prefStats.like = 0; prefStats.dislike = 0;
      toast('偏好已重置');
      const key = frame.value?.primary?.key;
      if (key) doRecommend(key, { force: true });
    }

    /* ------------------------------ 计算属性 -------------------------- */
    const emoRows = computed(() => {
      // 固定顺序（不按概率重排），实时模式下条形图不会跳动
      const s = frame.value?.primary?.scores;
      return EMOTIONS.map(e => ({ ...e, p: s ? s[e.key] || 0 : 0 }));
    });

    const primaryEmo = computed(() => {
      const k = frame.value?.primary?.key;
      return k ? EMO_BY_KEY[k] : null;
    });

    const confPct = computed(() => Math.round((frame.value?.primary?.confidence || 0) * 100));
    const confDash = computed(() => {
      const r = 26, c = 2 * Math.PI * r;
      return { c, off: c * (1 - (frame.value?.primary?.confidence || 0)) };
    });

    const hasMedia = computed(() => {
      if (mode.value === 'image') return !!imageSrc.value;
      return videoReady.value;
    });

    const showVideo = computed(() => mode.value !== 'image');

    const featRows = computed(() => {
      const f = frame.value?.primary?.features;
      if (!f) return [];
      const maxes = { mouthOpen: 0.60, mouthWide: 0.95, cornerUp: 0.14, browRaise: 0.40, innerBrow: 0.35, eyeOpen: 0.42, mouthRound: 0.80 };
      return Object.keys(FEATURE_LABELS).map(k => ({
        key: k,
        label: FEATURE_LABELS[k],
        v: f[k],
        pct: Math.min(100, Math.max(0, (f[k] / maxes[k]) * 100)),
      }));
    });

    const cnnTop = computed(() => {
      const c = frame.value?.primary ? null : null;
      return c;
    });

    const acousticRows = computed(() => {
      if (!target.value || !playlist.value.length) return [];
      return DIMS.map(d => {
        const t = d === 'tempoNorm' ? tempoNorm(target.value.tempo) : target.value[d];
        const avg = playlist.value.reduce((s, tr) => s + (tr.features[d] ?? 0), 0) / playlist.value.length;
        return { key: d, label: DIM_LABEL[d], target: t, mean: avg };
      });
    });

    const targetTempo = computed(() => Math.round(target.value?.tempo || 0));

    function coverStyle(t) {
      if (!t) return {};
      if (t.artwork) return { backgroundImage: `url(${t.artwork})`, backgroundSize: 'cover', backgroundPosition: 'center' };
      const [a, b] = t.color || ['#c7d2fe', '#818cf8'];
      return { background: `linear-gradient(135deg, ${a}, ${b})` };
    }

    const recDesc = computed(() => {
      const s = STRATEGIES.find(x => x.key === strategy.value);
      return s ? s.desc : '';
    });

    /* ------------------------------ 生命周期 -------------------------- */
    onMounted(async () => {
      prefStats.like = prefs.counts.like;
      prefStats.dislike = prefs.counts.dislike;
      const savedVol = localStorage.getItem('moodtune.volume');
      if (savedVol) volume.value = Number(savedVol);
      watch(volume, v => localStorage.setItem('moodtune.volume', String(v)));

      document.addEventListener('keydown', onKey);
      await initModel();
    });

    onBeforeUnmount(() => {
      document.removeEventListener('keydown', onKey);
      stopCamera();
      if (audioEl.value) audioEl.value.pause();
    });

    function onKey(e) {
      if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        togglePlay();
      }
      if (e.key === 'Escape') showDocs.value = false;
    }

    function switchMode(m) {
      if (mode.value === m) return;
      const prevMode = mode.value;
      mode.value = m;
      frame.value = null;
      clearOverlay();
      engine.reset();
      if (m === 'image') {
        stopCamera();
        if (!imageSrc.value) expecting.value = false;
        else nextTick(() => {
          const img = document.getElementById('still-img');
          if (img) analyzeStill(img);
        });
      } else if (m === 'video') {
        stopCamera();
        expecting.value = !!videoEl.value?.src;
        if (videoEl.value?.src) {
          videoEl.value.play().then(() => { videoReady.value = true; startLoop(); }).catch(() => {});
        }
      } else {
        // camera / shot
        videoEl.value.removeAttribute('src');
        videoEl.value.load();
        startCamera();
      }
    }

    function onFilePick(e, kind) {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (kind === 'image') loadImageFromFile(f);
      else loadVideoFile(f);
      e.target.value = '';
    }

    function onDrop(e) {
      e.preventDefault();
      dropOver.value = false;
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (f.type.startsWith('image/')) loadImageFromFile(f);
      else if (f.type.startsWith('video/')) loadVideoFile(f);
    }

    const dropOver = ref(false);

    return {
      // 状态
      modelState, modelError, backend, mode, camState, camError, videoReady,
      imageSrc, imageName, videoName, frame, fps, inferMs, countdown, flash,
      strategy, playlist, target, recommending, recInfo, recBusyKey, onlineEnabled, provider,
      measureEnabled, current, playing, progress, duration, volume, toastMsg,
      showDocs, prefStats, showDetail, dropOver, targetTempo, recDesc,
      // refs
      videoEl, overlayEl, audioEl,
      // 常量/派生
      EMOTIONS, STRATEGIES, DEMO_FACES, DIM_LABEL,
      emoRows, primaryEmo, confPct, confDash, hasMedia, showVideo, featRows,
      acousticRows, progressPct,
      // 方法
      startCamera, stopCamera, capturePhoto, loadDemo, loadDemoVideo, onFilePick, onDrop,
      switchMode, togglePlay, playTrack, next, prev, onTime, onMeta, onAudioError,
      seek, like, dislike, resetPrefs, reroll, doRecommend, coverStyle, fmtTime,
      audioUrl: computed(() => current.value?.src || ''),
    };
  },
};

createApp(App).mount('#app');
