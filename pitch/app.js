(() => {
  'use strict';
  const NAMES = ['ド','ド♯','レ','レ♯','ミ','ファ','ファ♯','ソ','ソ♯','ラ','ラ♯','シ'];
  const LETTERS = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const RANGE = 50;          // メーター両端のセント
  const OK_CENTS = 5;        // この範囲内なら「ちょうど」
  const MAX_ANGLE = 70;      // 針の最大角度(度)

  const $ = id => document.getElementById(id);
  const app = $('app'), btn = $('toggle'), msg = $('msg');
  let a4 = Number(localStorage.getItem('a4')) || 440;

  // ---- メーター目盛り ----
  const pt = (deg, r) => {
    const a = deg * Math.PI / 180;
    return [r * Math.sin(a), -r * Math.cos(a)];
  };
  (function buildGauge() {
    const okDeg = OK_CENTS / RANGE * MAX_ANGLE;
    const [x1, y1] = pt(-okDeg, 90), [x2, y2] = pt(okDeg, 90);
    $('arcOk').setAttribute('d', `M ${x1} ${y1} A 90 90 0 0 1 ${x2} ${y2}`);
    const g = $('ticks'); let html = '';
    for (let c = -50; c <= 50; c += 10) {
      const d = c / RANGE * MAX_ANGLE, big = c === 0;
      const [ax, ay] = pt(d, big ? 66 : 72), [bx, by] = pt(d, 78);
      html += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"${big ? ' style="stroke:#3ddc84;stroke-width:2.5"' : ''}/>`;
    }
    g.innerHTML = html;
  })();

  // ---- 音程検出 (YIN) ----
  function detectPitch(buf, sr) {
    const n = buf.length, half = n >> 1;
    let rms = 0;
    for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    if (rms < 0.01) return -1;

    const minTau = Math.floor(sr / 1500), maxTau = Math.min(half - 1, Math.floor(sr / 60));
    const d = new Float32Array(maxTau + 1);
    for (let t = 1; t <= maxTau; t++) {
      let s = 0;
      for (let i = 0; i < half; i++) { const x = buf[i] - buf[i + t]; s += x * x; }
      d[t] = s;
    }
    // 累積平均正規化
    let run = 0; d[0] = 1;
    for (let t = 1; t <= maxTau; t++) { run += d[t]; d[t] = run ? d[t] * t / run : 1; }

    let tau = -1;
    for (let t = Math.max(2, minTau); t <= maxTau; t++) {
      if (d[t] < 0.12) {
        while (t + 1 <= maxTau && d[t + 1] < d[t]) t++;
        tau = t; break;
      }
    }
    if (tau < 0) return -1;
    // 放物線補間
    const a = d[tau - 1], b = d[tau], c = d[tau + 1] ?? b;
    const den = a + c - 2 * b;
    const shift = den ? (a - c) / (2 * den) : 0;
    return sr / (tau + shift);
  }

  // ---- 表示更新 ----
  let lastSeen = 0, smoothMidi = null, recent = [];
  function render(freq) {
    const now = performance.now();
    if (freq > 0) {
      lastSeen = now;
      let midi = 69 + 12 * Math.log2(freq / a4);
      // 急な跳びは追従、近ければ平滑化
      if (smoothMidi === null || Math.abs(midi - smoothMidi) > 0.8) recent = [];
      recent.push(midi); if (recent.length > 5) recent.shift();
      const med = [...recent].sort((x, y) => x - y)[recent.length >> 1];
      smoothMidi = smoothMidi === null || recent.length < 2 ? med : smoothMidi * 0.5 + med * 0.5;

      const nearest = Math.round(smoothMidi);
      const cents = (smoothMidi - nearest) * 100;
      const idx = ((nearest % 12) + 12) % 12;
      $('solfege').textContent = NAMES[idx];
      $('letter').textContent = LETTERS[idx];
      $('octave').textContent = Math.floor(nearest / 12) - 1;
      $('freq').textContent = freq.toFixed(1) + ' Hz';
      const c = Math.round(cents);
      $('cents').textContent = (c > 0 ? '+' : c < 0 ? '−' : '±') + Math.abs(c);
      const cl = Math.max(-RANGE, Math.min(RANGE, cents));
      $('needle').style.transform = `rotate(${cl / RANGE * MAX_ANGLE}deg)`;
      $('barDot').style.left = (50 + cl) + '%';
      let cls, text;
      if (Math.abs(cents) <= OK_CENTS) { cls = 'is-ok'; text = '✔ ちょうど'; }
      else if (cents < 0) { cls = 'is-low'; text = '▼ 低い（上げて）'; }
      else { cls = 'is-high'; text = '▲ 高い（下げて）'; }
      $('verdict').textContent = text;
      app.classList.remove('is-ok', 'is-low', 'is-high', 'silent');
      app.classList.add(cls);
    } else if (now - lastSeen > 600) {
      smoothMidi = null; recent = [];
      app.classList.remove('is-ok', 'is-low', 'is-high');
      app.classList.add('silent');
      $('verdict').textContent = '音を鳴らしてください';
      $('needle').style.transform = 'rotate(0deg)';
      $('barDot').style.left = '50%';
    }
  }

  // ---- マイク ----
  let ctx, stream, analyser, raf, buf;
  function loop() {
    analyser.getFloatTimeDomainData(buf);
    render(detectPitch(buf, ctx.sampleRate));
    raf = requestAnimationFrame(loop);
  }
  async function start() {
    msg.textContent = '';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg.textContent = 'このブラウザはマイクに対応していません（HTTPSで開いてください）。';
      return;
    }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') await ctx.resume();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      buf = new Float32Array(analyser.fftSize);
      src.connect(analyser);
      app.classList.replace('state-idle', 'state-live');
      btn.textContent = '■ 停止';
      lastSeen = 0; loop();
    } catch (e) {
      stop();
      msg.textContent = (e && e.name === 'NotAllowedError')
        ? 'マイクが許可されていません。ブラウザの設定で許可してください。'
        : 'マイクを開始できませんでした：' + (e && e.message || e);
    }
  }
  function stop() {
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (ctx) ctx.close().catch(() => {});
    stream = ctx = analyser = null;
    app.classList.remove('state-live', 'is-ok', 'is-low', 'is-high', 'silent');
    app.classList.add('state-idle');
    btn.textContent = '🎤 タップして開始';
    $('solfege').textContent = '--'; $('letter').textContent = '-'; $('octave').textContent = '';
    $('freq').textContent = '--- Hz'; $('cents').textContent = '±0';
    $('verdict').textContent = 'マイクを開始してください';
    $('needle').style.transform = 'rotate(0deg)'; $('barDot').style.left = '50%';
    smoothMidi = null; recent = [];
  }
  btn.addEventListener('click', () => (stream ? stop() : start()));
  document.addEventListener('visibilitychange', () => { if (document.hidden && stream) stop(); });

  // ---- 基準音 A4 ----
  function setA4(v) {
    a4 = Math.max(415, Math.min(466, v));
    $('a4').textContent = a4;
    try { localStorage.setItem('a4', a4); } catch (_) {}
  }
  $('a4dn').addEventListener('click', () => setA4(a4 - 1));
  $('a4up').addEventListener('click', () => setA4(a4 + 1));
  setA4(a4);
})();
