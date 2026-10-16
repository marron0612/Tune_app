(() => {
  'use strict';
  // ===== 共通ユーティリティ =====
  const NAMES = ['ド','ド♯','レ','レ♯','ミ','ファ','ファ♯','ソ','ソ♯','ラ','ラ♯','シ'];
  const $ = id => document.getElementById(id);
  const mod = (a, n) => ((a % n) + n) % n;
  const noteName = m => NAMES[mod(m, 12)] + (Math.floor(m / 12) - 1);
  const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // 目標との差(半音)。オクターブ違いは同じ扱い
  const dev = (m, target) => mod(m - target + 6, 12) - 6;
  const signed = c => (c > 0 ? '+' : c < 0 ? '−' : '±') + Math.abs(Math.round(c));
  const C = { ok: '#3ddc84', warn: '#ffc247', bad: '#ff5d5d', dim: '#8a93a0', line: '#2c333d', bar: '#3b4a63', barOn: '#5b7bb5', fg: '#f2f4f7' };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  };

  function fitCanvas(c) {
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h };
  }
  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  // ===== 音程検出 (YIN) =====
  function detectPitch(buf, sr) {
    const n = buf.length, half = n >> 1;
    let rms = 0;
    for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    if (rms < 0.008) return -1;
    const minTau = Math.floor(sr / 1100), maxTau = Math.min(n - half - 1, Math.floor(sr / 70));
    const d = new Float32Array(maxTau + 2);
    for (let t = 1; t <= maxTau; t++) {
      let s = 0;
      for (let i = 0; i < half; i++) { const x = buf[i] - buf[i + t]; s += x * x; }
      d[t] = s;
    }
    let run = 0; d[0] = 1;
    for (let t = 1; t <= maxTau; t++) { run += d[t]; d[t] = run ? d[t] * t / run : 1; }
    let tau = -1;
    for (let t = Math.max(2, minTau); t <= maxTau; t++) {
      if (d[t] < 0.15) { while (t + 1 <= maxTau && d[t + 1] < d[t]) t++; tau = t; break; }
    }
    if (tau < 0) return -1;
    const a = d[tau - 1], b = d[tau], c = d[tau + 1] ?? b, den = a + c - 2 * b;
    return sr / (tau + (den ? (a - c) / (2 * den) : 0));
  }

  // ===== マイクと音出し =====
  const Mic = {
    ctx: null, stream: null, an: null, buf: null, hist: [],
    async start() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !AC)
        throw new Error('unsupported');
      this.ctx = new AC();
      this.ctx.resume();
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      } catch (e) { this.stop(); throw e; }
      this.an = this.ctx.createAnalyser();
      this.an.fftSize = 2048;
      this.buf = new Float32Array(2048);
      this.ctx.createMediaStreamSource(this.stream).connect(this.an);
      this.hist = [];
    },
    stop() {
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      if (this.ctx) this.ctx.close().catch(() => {});
      this.ctx = this.stream = this.an = null; this.hist = [];
    },
    now() { return this.ctx.currentTime; },
    read() { // MIDI番号(小数)またはnull
      this.an.getFloatTimeDomainData(this.buf);
      const f = detectPitch(this.buf, this.ctx.sampleRate);
      if (f < 0) { this.hist = []; return null; }
      this.hist.push(69 + 12 * Math.log2(f / 440));
      if (this.hist.length > 3) this.hist.shift();
      return median(this.hist);
    }
  };
  function tone(midi, t, dur, vol = 0.28) {
    const ctx = Mic.ctx, f = 440 * 2 ** ((midi - 69) / 12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.03);
    g.gain.setValueAtTime(vol, t + Math.max(0.04, dur - 0.08));
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    g.connect(ctx.destination);
    [['triangle', f, 1], ['sine', f * 2, 0.35]].forEach(([type, fr, k]) => {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = type; o.frequency.value = fr; og.gain.value = k;
      o.connect(og).connect(g); o.start(t); o.stop(t + dur + 0.02);
    });
  }
  function click(t) {
    const ctx = Mic.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = 1000;
    g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.06);
  }

  // ===== セッション管理 (一度に1つだけマイクを使う) =====
  let session = null, raf = 0, activeBtn = null, starting = false;
  const showMsg = t => { $('msg').textContent = t || ''; };
  async function startSession(s, btn) {
    if (starting) return;
    stopSession(); showMsg(''); starting = true;
    try { await Mic.start(); }
    catch (e) {
      starting = false;
      showMsg(e && e.name === 'NotAllowedError' ? 'マイクが許可されていません。ブラウザの設定で許可してください。'
        : e && e.message === 'unsupported' ? 'このブラウザはマイクに対応していません（HTTPSで開いてください）。'
        : 'マイクを開始できませんでした：' + (e && e.message || e));
      return;
    }
    starting = false;
    session = s; activeBtn = btn;
    btn.dataset.idle = btn.textContent; btn.textContent = '■ 停止'; btn.classList.add('live');
    s.begin(Mic.now());
    raf = requestAnimationFrame(loop);
  }
  function stopSession() {
    cancelAnimationFrame(raf);
    const s = session; session = null;
    if (activeBtn) { activeBtn.textContent = activeBtn.dataset.idle; activeBtn.classList.remove('live'); activeBtn = null; }
    if (s) Mic.stop();
    if (s && s.end) s.end();
  }
  function loop() {
    if (!session) return;
    const s = session;
    s.tick(Mic.now(), Mic.read());
    if (session === s) raf = requestAnimationFrame(loop);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopSession(); });

  // ===== 履歴 =====
  const hist = {
    all() { return store.get('sing_history', []); },
    add(e) { const a = this.all(); a.push({ t: Date.now(), ...e }); store.set('sing_history', a.slice(-500)); }
  };

  // ===== タブ =====
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    stopSession();
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    ({ practice: drawPractice, long: () => drawLong(null), history: renderHistory }[b.dataset.tab] || (() => {}))();
  }));
  const noteOptions = (sel, lo, hi, def) => {
    sel.innerHTML = '';
    for (let m = lo; m <= hi; m++) {
      const o = document.createElement('option');
      o.value = m; o.textContent = noteName(m) + ' (' + 'C C# D D# E F F# G G# A A# B'.split(' ')[mod(m, 12)] + ')';
      sel.appendChild(o);
    }
    sel.value = def;
  };

  // ===== 練習 =====
  const seq = s => s.split(' ').map(t => { const [o, b] = t.split(':'); return [+o, b ? +b : 1]; });
  const EX = [
    { name: 'ドレミファソファミレド', notes: seq('0 2 4 5 7 5 4 2 0:2') },
    { name: 'ドミソミド（アルペジオ）', notes: seq('0 4 7 12:2 7 4 0:2') },
    { name: 'ドドドド（同じ音をそろえる）', notes: seq('0 0 0 0 0:2') },
    { name: '音程ジャンプ（ド→ソ→ド）', notes: seq('0 7 0 7 0:2') },
    { name: 'きらきら星', notes: seq('0 0 7 7 9 9 7:2 5 5 4 4 2 2 0:2') },
    { name: 'かえるの合唱', notes: seq('0 2 4 5 4 2 0:2 4 5 7 9 7 5 4:2 0 0 0 0 0 2 4 5 4 2 0:2') },
    { name: 'ちょうちょう', notes: seq('7 4 4:2 5 2 2:2 0 2 4 5 7 7 7:2') }
  ];
  const P = { ex: EX[0], base: store.get('sing_base', 60), bpm: store.get('sing_bpm', 80), guide: store.get('sing_guide', 'always'), last: null };
  const LAG = 0.15;

  EX.forEach((e, i) => { const o = document.createElement('option'); o.value = i; o.textContent = e.name; $('pEx').appendChild(o); });
  noteOptions($('pBase'), 40, 72, P.base);
  $('pBpm').value = P.bpm; $('pBpmV').textContent = P.bpm; $('pGuide').value = P.guide;

  function exNotes() {
    const beat = 60 / P.bpm; let t = 0;
    return P.ex.notes.map(([o, b]) => {
      const n = { midi: P.base + o, s: t, e: t + b * beat, label: NAMES[mod(P.base + o, 12)] };
      t = n.e; return n;
    });
  }
  function updateRangeTxt() {
    const ms = P.ex.notes.map(n => P.base + n[0]);
    $('pRangeTxt').textContent = 'この練習: ' + noteName(Math.min(...ms)) + '〜' + noteName(Math.max(...ms));
  }
  function setPracticeOpt() {
    store.set('sing_base', P.base); store.set('sing_bpm', P.bpm); store.set('sing_guide', P.guide);
    updateRangeTxt(); P.last = null; $('pResult').innerHTML = ''; drawPractice();
  }
  $('pEx').addEventListener('change', e => { P.ex = EX[+e.target.value]; setPracticeOpt(); });
  $('pBase').addEventListener('change', e => { P.base = +e.target.value; setPracticeOpt(); });
  $('pBpm').addEventListener('input', e => { P.bpm = +e.target.value; $('pBpmV').textContent = P.bpm; });
  $('pBpm').addEventListener('change', setPracticeOpt);
  $('pGuide').addEventListener('change', e => { P.guide = e.target.value; setPracticeOpt(); });
  $('pFit').addEventListener('click', () => {
    const r = store.get('sing_range', null);
    if (!r) { showMsg('先に「音域」タブで音域を測ってください。'); return; }
    showMsg('');
    const offs = P.ex.notes.map(n => n[0]);
    const c = (Math.min(...offs) + Math.max(...offs)) / 2;
    P.base = clamp(Math.round((r.lo + r.hi) / 2 - c), 40, 72);
    $('pBase').value = P.base; setPracticeOpt();
  });

  // 描画。state: {notes, trail, now(playhead秒), count, scored}
  function drawPractice(st) {
    const c = $('pCanvas');
    if (!c.clientWidth) return;
    st = st || P.last || { notes: exNotes(), trail: [] };
    const { g, w, h } = fitCanvas(c);
    const notes = st.notes, total = notes[notes.length - 1].e;
    const lo = Math.min(...notes.map(n => n.midi)) - 2.5, hi = Math.max(...notes.map(n => n.midi)) + 2.5;
    const L = 38, R = 8, T = 8, B = 8, pw = w - L - R, ph = h - T - B;
    const X = t => L + t / total * pw, Y = m => T + (hi - m) / (hi - lo) * ph, rowH = ph / (hi - lo);
    g.font = '11px system-ui'; g.textBaseline = 'middle';
    for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
      const nat = [0, 2, 4, 5, 7, 9, 11].includes(mod(m, 12));
      g.strokeStyle = nat ? '#303846' : '#232a33'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(L, Y(m)); g.lineTo(w - R, Y(m)); g.stroke();
      if (nat) { g.fillStyle = C.dim; g.textAlign = 'right'; g.fillText(noteName(m), L - 4, Y(m)); }
    }
    notes.forEach(n => {
      const active = st.now != null && st.now >= n.s && st.now < n.e;
      g.fillStyle = n.score == null ? (active ? C.barOn : C.bar) : (n.score >= 0.7 ? '#2f8f5b' : n.score >= 0.4 ? '#a37f1f' : '#9a3b3b');
      roundRect(g, X(n.s) + 1, Y(n.midi) - rowH * 0.4, Math.max(2, X(n.e) - X(n.s) - 2), rowH * 0.8, 5); g.fill();
    });
    st.trail.forEach(p => {
      g.fillStyle = p.ok ? C.ok : C.warn;
      g.beginPath(); g.arc(X(clamp(p.t, 0, total)), Y(clamp(p.y, lo, hi)), 3, 0, 7); g.fill();
    });
    notes.forEach(n => {
      if (X(n.e) - X(n.s) > 24) {
        g.fillStyle = C.fg; g.textAlign = 'center'; g.font = '12px system-ui';
        g.fillText(n.label, (X(n.s) + X(n.e)) / 2, Y(n.midi) - rowH * 0.4 - 6);
      }
    });
    if (st.now != null) {
      g.strokeStyle = C.fg; g.lineWidth = 2; g.beginPath();
      g.moveTo(X(clamp(st.now, 0, total)), T); g.lineTo(X(clamp(st.now, 0, total)), h - B); g.stroke();
    }
    if (st.count) {
      g.fillStyle = 'rgba(17,20,24,.55)'; g.fillRect(0, 0, w, h);
      g.fillStyle = C.fg; g.font = '800 72px system-ui'; g.textAlign = 'center'; g.fillText(st.count, w / 2, h / 2);
    }
  }

  function practiceSession() {
    const beat = 60 / P.bpm, notes = exNotes(), total = notes[notes.length - 1].e;
    const frames = [], trail = []; let T0, complete = false;
    return {
      begin(now) {
        const s0 = now + 0.2; T0 = s0 + 4 * beat;
        for (let i = 0; i < 4; i++) {
          if (i === 3 && P.guide !== 'none') tone(notes[0].midi, s0 + i * beat, beat * 0.9);
          else click(s0 + i * beat);
        }
        if (P.guide === 'always') notes.forEach(n => tone(n.midi, T0 + n.s, Math.max(0.12, (n.e - n.s) * 0.95)));
        P.last = null; $('pResult').innerHTML = '';
      },
      tick(now, m) {
        const tau = now - T0, ft = tau - LAG;
        if (tau < 0) { drawPractice({ notes, trail, now: null, count: Math.ceil(-tau / beat) }); return; }
        if (ft >= 0) {
          frames.push({ t: ft, m });
          if (m != null) {
            const n = notes.find(x => ft >= x.s && ft < x.e);
            if (n) { const d = dev(m, n.midi); trail.push({ t: ft, y: n.midi + clamp(d, -3, 3), ok: Math.abs(d) <= 0.5 }); }
            else { const ctr = (notes[0].midi + notes[notes.length - 1].midi) / 2; trail.push({ t: ft, y: m - 12 * Math.round((m - ctr) / 12), ok: false }); }
          }
        }
        drawPractice({ notes, trail, now: tau });
        if (ft > total + 0.15) { complete = true; stopSession(); }
      },
      end() {
        if (!complete) { drawPractice(); return; }
        let sum = 0, dur = 0;
        notes.forEach(n => {
          const a = n.s + Math.min(0.3, (n.e - n.s) * 0.3), b = n.e - 0.05;
          const fr = frames.filter(f => f.t >= a && f.t < b);
          const ds = fr.filter(f => f.m != null).map(f => dev(f.m, n.midi));
          n.score = fr.length ? ds.filter(d => Math.abs(d) <= 0.5).length / fr.length : 0;
          n.avg = ds.length ? mean(ds) * 100 : null;
          sum += n.score * (n.e - n.s); dur += n.e - n.s;
        });
        const score = Math.round(sum / dur * 100);
        const avgs = notes.filter(n => n.avg != null).map(n => n.avg);
        const tendency = avgs.length ? mean(avgs) : null;
        P.last = { notes, trail, now: null };
        hist.add({ name: P.ex.name, score, detail: noteName(P.base) + ' / ♩=' + P.bpm });
        const worst = notes.reduce((a, b) => (b.score < a.score ? b : a));
        let tip = '';
        if (tendency == null) tip = '声が検出できませんでした。マイクに近づいてみてください。';
        else if (Math.abs(tendency) < 10) tip = '全体の高さは安定しています。';
        else tip = '全体的に' + (tendency < 0 ? '低め' : '高め') + '（平均 ' + signed(tendency) + 'セント）。';
        if (worst.score < 0.7) tip += ' 苦手なのは「' + worst.label + '」' + (worst.avg == null ? '（声が出ていません）' : '（' + signed(worst.avg) + 'セント）') + '。';
        $('pResult').innerHTML = '<div class="big">' + score + '<small> 点</small></div><p class="note" style="margin-top:6px">' + tip + '</p><div class="chips">' +
          notes.map(n => '<span class="chip ' + (n.score >= 0.7 ? 'g' : n.score >= 0.4 ? 'o' : 'r') + '">' + n.label + ' <b>' + Math.round(n.score * 100) + '%</b>' + (n.avg != null ? ' ' + signed(n.avg) : '') + '</span>').join('') + '</div>';
        drawPractice(P.last);
      }
    };
  }
  $('pBtn').addEventListener('click', () => session ? stopSession() : startSession(practiceSession(), $('pBtn')));

  // ===== ロングトーン =====
  noteOptions($('lTarget'), 40, 76, 60);
  $('lTarget').insertAdjacentHTML('afterbegin', '<option value="auto">自動（最初に出した音）</option>');
  $('lTarget').value = 'auto';
  const LONG_SEC = 8;

  function drawLong(st) {
    const c = $('lCanvas');
    if (!c.clientWidth) return;
    const { g, w, h } = fitCanvas(c);
    const L = 38, R = 8, T = 8, B = 16, pw = w - L - R, ph = h - T - B, RNG = 75;
    const X = t => L + t / LONG_SEC * pw, Y = d => T + (RNG - d) / (2 * RNG) * ph;
    g.fillStyle = 'rgba(61,220,132,.16)'; g.fillRect(L, Y(25), pw, Y(-25) - Y(25));
    g.font = '11px system-ui'; g.fillStyle = C.dim; g.textBaseline = 'middle'; g.textAlign = 'right';
    [-50, 0, 50].forEach(d => {
      g.strokeStyle = d === 0 ? C.ok : C.line; g.lineWidth = d === 0 ? 1.5 : 1;
      g.beginPath(); g.moveTo(L, Y(d)); g.lineTo(w - R, Y(d)); g.stroke();
      g.fillText((d > 0 ? '+' : '') + d, L - 4, Y(d));
    });
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let s = 0; s <= LONG_SEC; s += 2) g.fillText(s + 's', X(s), h - B + 3);
    if (!st) return;
    g.strokeStyle = C.fg; g.lineWidth = 2; g.beginPath();
    let pen = false;
    st.pts.forEach(p => {
      if (p == null) { pen = false; return; }
      const x = X(p.t), y = Y(clamp(p.d, -RNG, RNG));
      pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true;
    });
    g.stroke();
  }

  function longSession() {
    const sel = $('lTarget').value;
    let target = sel === 'auto' ? null : +sel, G, complete = false, result = null;
    const frames = [];
    const pts = () => {
      if (target == null) return [];
      return frames.map(f => f.m == null ? null : { t: f.t, d: dev(f.m, target) * 100 });
    };
    return {
      begin(now) {
        G = now + 3.2;
        if (target != null) tone(target, now + 0.6, 1.8);
        $('lResult').innerHTML = ''; $('lNote').textContent = '--'; $('lCents').textContent = '';
      },
      tick(now, m) {
        const tau = now - G;
        if (m != null) {
          const nn = Math.round(m);
          $('lNote').textContent = noteName(nn);
          $('lCents').textContent = signed((m - nn) * 100) + ' セント';
        } else { $('lNote').textContent = '--'; $('lCents').textContent = ''; }
        if (tau < 0) { $('lInfo').textContent = String(Math.max(1, Math.ceil(-tau - 0.2))); drawLong(null); return; }
        $('lInfo').textContent = '歌って！ あと ' + Math.max(0, Math.ceil(LONG_SEC - tau)) + ' 秒';
        frames.push({ t: tau, m });
        if (target == null) {
          const v = frames.filter(f => f.m != null);
          if (v.length >= 8) target = Math.round(median(v.slice(0, 8).map(f => f.m)));
        }
        drawLong({ pts: pts() });
        if (tau >= LONG_SEC) { complete = true; stopSession(); }
      },
      end() {
        $('lInfo').textContent = '8秒間、同じ音をまっすぐ伸ばします';
        if (!complete) { drawLong(null); return; }
        const first = frames.findIndex(f => f.m != null);
        if (first < 0 || target == null) {
          $('lResult').innerHTML = '声が検出できませんでした。'; return;
        }
        const after = frames.slice(first), v = after.filter(f => f.m != null);
        const ds = v.map(f => dev(f.m, target) * 100);
        const avg = mean(ds), sd = Math.sqrt(mean(ds.map(d => (d - avg) ** 2)));
        const score = Math.round(ds.filter(d => Math.abs(d) <= 25).length / after.length * 100);
        const sustain = Math.round(v.length / after.length * 100);
        hist.add({ name: 'ロングトーン', score, detail: noteName(target) + ' / ぶれ' + Math.round(sd) + 'c' });
        $('lResult').innerHTML = '<div class="big">' + score + '<small> 点</small></div><div class="chips">' +
          '<span class="chip">目標 <b>' + noteName(target) + '</b></span>' +
          '<span class="chip ' + (Math.abs(avg) < 15 ? 'g' : 'o') + '">平均ズレ <b>' + signed(avg) + '</b>c</span>' +
          '<span class="chip ' + (sd < 20 ? 'g' : sd < 35 ? 'o' : 'r') + '">ぶれ <b>' + Math.round(sd) + '</b>c</span>' +
          '<span class="chip ' + (sustain > 90 ? 'g' : 'o') + '">継続 <b>' + sustain + '%</b></span></div>';
        drawLong({ pts: pts() });
      }
    };
  }
  $('lBtn').addEventListener('click', () => session ? stopSession() : startSession(longSession(), $('lBtn')));

  // ===== 音域 =====
  noteOptions($('kLo'), 36, 84, 55);
  noteOptions($('kHi'), 36, 84, 67);
  const myRange = () => store.get('sing_range', null);
  function showRange() {
    const r = myRange();
    $('rLo').textContent = r ? noteName(r.lo) : '--';
    $('rHi').textContent = r ? noteName(r.hi) : '--';
    suggestKey();
  }
  function suggestKey() {
    const r = myRange(), out = $('kOut');
    if (!r) { out.textContent = '先に音域を測定してください'; return; }
    const sLo = +$('kLo').value, sHi = +$('kHi').value;
    if (sLo > sHi) { out.textContent = '曲の最低音は最高音より低くしてください'; return; }
    const margin = r.hi - r.lo > 8 ? 2 : 0;       // 限界ぎりぎりは避ける
    const fLo = r.lo + margin, fHi = r.hi - margin;
    const ideal = Math.round((fLo + fHi) / 2 - (sLo + sHi) / 2);
    const fits = s => sLo + s >= fLo && sHi + s <= fHi;
    let shift = ideal, ok = fits(ideal);
    if (!ok) {
      const ok2 = [];
      for (let s = -24; s <= 24; s++) if (fits(s)) ok2.push(s);
      if (ok2.length) { shift = ok2.reduce((a, b) => (Math.abs(b - ideal) < Math.abs(a - ideal) ? b : a)); ok = true; }
    }
    const dirTxt = shift === 0 ? 'そのままのキー（±0）' : 'キー ' + (shift > 0 ? '+' : '−') + Math.abs(shift) + '（原曲より' + Math.abs(shift) + '半音' + (shift > 0 ? '上げる' : '下げる') + '）';
    out.innerHTML = '<div class="big" style="font-size:28px">' + dirTxt + '</div><p class="note" style="margin-top:8px">変更後の曲の音域: ' +
      noteName(sLo + shift) + '〜' + noteName(sHi + shift) + '<br>あなたの音域: ' + noteName(r.lo) + '〜' + noteName(r.hi) +
      (ok ? '' : '<br>⚠ 曲の音域が広く、全部は収まりません。一番近いキーを表示しています。') + '</p>';
  }
  $('kLo').addEventListener('change', suggestKey);
  $('kHi').addEventListener('change', suggestKey);
  $('rReset').addEventListener('click', () => {
    if (!confirm('音域の記録をリセットしますか？')) return;
    store.set('sing_range', null); showRange();
  });
  function rangeSession() {
    const saved = myRange();
    let lo = saved ? saved.lo : null, hi = saved ? saved.hi : null, recent = [];
    return {
      begin() { recent = []; },
      tick(now, m) {
        if (m == null) { recent = []; $('rNote').textContent = '--'; $('rCents').textContent = ''; return; }
        const nn = Math.round(m);
        $('rNote').textContent = noteName(nn); $('rCents').textContent = signed((m - nn) * 100) + ' セント';
        recent.push(m); if (recent.length > 10) recent.shift();
        if (recent.length === 10 && Math.max(...recent) - Math.min(...recent) < 0.8) {
          const s = Math.round(median(recent));
          if (lo == null || s < lo) lo = s;
          if (hi == null || s > hi) hi = s;
          $('rLo').textContent = noteName(lo); $('rHi').textContent = noteName(hi);
        }
      },
      end() {
        if (lo != null) store.set('sing_range', { lo, hi });
        $('rNote').textContent = '--'; $('rCents').textContent = ''; showRange();
      }
    };
  }
  $('rBtn').addEventListener('click', () => session ? stopSession() : startSession(rangeSession(), $('rBtn')));

  // ===== 記録 =====
  function renderHistory() {
    const all = hist.all();
    const days = new Set(all.map(e => new Date(e.t).toDateString()));
    const today = all.filter(e => new Date(e.t).toDateString() === new Date().toDateString()).length;
    $('hStats').innerHTML = '<div><b>' + all.length + '</b>練習回数</div><div><b>' + days.size + '</b>練習した日</div><div><b>' + today + '</b>今日</div>';
    const names = [...new Set(all.map(e => e.name))];
    const sel = $('hFilter'), cur = sel.value;
    sel.innerHTML = '<option value="">すべて</option>' + names.map(n => '<option>' + n + '</option>').join('');
    sel.value = names.includes(cur) ? cur : '';
    const list = sel.value ? all.filter(e => e.name === sel.value) : all;
    $('hList').innerHTML = list.slice(-15).reverse().map(e => {
      const d = new Date(e.t);
      return '<li><span>' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') +
        '</span><span>' + e.name + '</span><b>' + e.score + '点</b></li>';
    }).join('') || '<li>まだ記録がありません</li>';
    drawChart(list.slice(-30));
  }
  function drawChart(list) {
    const { g, w, h } = fitCanvas($('hCanvas'));
    const L = 30, R = 10, T = 10, B = 10, pw = w - L - R, ph = h - T - B;
    const Y = s => T + (100 - s) / 100 * ph;
    g.font = '11px system-ui'; g.fillStyle = C.dim; g.textAlign = 'right'; g.textBaseline = 'middle';
    [0, 50, 100].forEach(s => {
      g.strokeStyle = C.line; g.beginPath(); g.moveTo(L, Y(s)); g.lineTo(w - R, Y(s)); g.stroke();
      g.fillText(s, L - 4, Y(s));
    });
    if (!list.length) return;
    const X = i => L + (list.length === 1 ? pw / 2 : i / (list.length - 1) * pw);
    g.strokeStyle = C.ok; g.lineWidth = 2; g.beginPath();
    list.forEach((e, i) => (i ? g.lineTo(X(i), Y(e.score)) : g.moveTo(X(i), Y(e.score)))); g.stroke();
    g.fillStyle = C.ok; list.forEach((e, i) => { g.beginPath(); g.arc(X(i), Y(e.score), 3.5, 0, 7); g.fill(); });
  }
  $('hFilter').addEventListener('change', renderHistory);
  $('hClear').addEventListener('click', () => {
    if (confirm('練習記録をすべて消しますか？')) { store.set('sing_history', []); renderHistory(); }
  });

  window.addEventListener('resize', () => { drawPractice(); drawLong(null); if ($('tab-history').classList.contains('active')) renderHistory(); });
  updateRangeTxt(); showRange(); drawPractice(); drawLong(null);
})();
