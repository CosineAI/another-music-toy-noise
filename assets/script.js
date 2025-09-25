// Optional JavaScript goes here
console.log("Static site loaded!");

// Mouse Music Toy — Web Audio + Canvas
(() => {
  const canvas = document.getElementById('playCanvas');
  const clearBtn = document.getElementById('clearCanvas');
  if (!canvas || !clearBtn) return;

  const ctx2d = canvas.getContext('2d');

  // Legend toggle
  const legendEl = document.querySelector('.legend');
  let legendVisible = true;
  const setLegendVisibility = (visible) => {
    legendVisible = !!visible;
    if (legendEl) {
      legendEl.style.display = legendVisible ? '' : 'none';
    }
  };
  setLegendVisibility(true);

  // Resize canvas to match CSS size and handle HiDPI
  const resizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = canvas;
    canvas.width = Math.max(1, Math.floor(clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(clientHeight * dpr));
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };
  window.addEventListener('resize', resizeCanvas);
  // Defer initial resize until layout stabilizes
  setTimeout(resizeCanvas, 0);

  // --- Audio setup ---
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  const masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.25;
  masterGain.connect(audioCtx.destination);

  const PREVIEW_LEVEL = 0.12;
  const PLAY_LEVEL = 0.35;

  const activeKeys = new Set(); // lowercased keys currently held

  // Utility: map x to musical frequency (A2 to A6, 4 octaves, exponential)
  const freqFromX = (x) => {
    const w = canvas.clientWidth || 1;
    const nx = Math.min(1, Math.max(0, x / w));
    const base = 110;        // A2
    const octaves = 4;
    return base * Math.pow(2, nx * octaves); // ~110 Hz to ~1760 Hz
  };

  // Utility: map y to tone (lowpass cutoff, exponential mapping)
  const cutoffFromY = (y) => {
    const h = canvas.clientHeight || 1;
    const ny = Math.min(1, Math.max(0, y / h));
    const min = 200;
    const max = 10000;
    const ratio = max / min;
    return min * Math.pow(ratio, 1 - ny); // top bright, bottom mellow
  };

  // Random helpers
  const rand = (min, max) => min + Math.random() * (max - min);
  const randInt = (min, max) => Math.floor(rand(min, max + 1));
  const pickN = (arr, n) => {
    const copy = arr.slice();
    const out = [];
    while (copy.length && out.length < n) {
      const i = randInt(0, copy.length - 1);
      out.push(copy.splice(i, 1)[0]);
    }
    return out;
  };

  // Distortion curve factory
  const makeDistortionCurve = (amount = 160) => {
    const n = 2048;
    const curve = new Float32Array(n);
    const deg = Math.PI / 180;
    for (let i = 0; i < n; ++i) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  };

  // Simple impulse for Convolver (algorithmic reverb)
  const createImpulseBuffer = (ctx, seconds = 2.5, decay = 0.4) => {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(seconds * rate));
    const impulse = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        // random noise with exponential decay
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay * 6);
      }
    }
    return impulse;
  };

  // Effect color map for visual rings
  const effectColors = {
    z: '#3b82f6', // Vibrato
    x: '#f59e0b', // Tremolo
    c: '#10b981', // Delay
    v: '#ef4444', // Distortion
    b: '#8b5cf6', // Reverb
    a: '#22d3ee', // Autopan
    f: '#0ea5e9', // Flanger
    m: '#34d399', // Chorus
    p: '#f472b6', // Phaser
    h: '#7c3aed', // Highpass
    n: '#6b7280', // Noise
    r: '#eab308', // RingMod
    s: '#fb7185', // Saturation
  };

  const FX_KEYS = Object.keys(effectColors);

  // Voice object: oscillator + filter + amp, optional effects per snapshot of activeKeys
  class Voice {
    constructor({ freq, cutoff, keys }) {
      this.osc = audioCtx.createOscillator();
      this.osc.type = 'sawtooth';
      this.osc.frequency.value = freq;

      this.filter = audioCtx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = cutoff;
      this.filter.Q.value = 0.9;

      this.amp = audioCtx.createGain();
      this.amp.gain.value = 0; // envelope

      // Base chain
      this.osc.connect(this.filter);
      this.filter.connect(this.amp);

      // Dry path
      this.dryGain = audioCtx.createGain();
      this.dryGain.gain.value = 0.8;
      this.amp.connect(this.dryGain);
      this.dryGain.connect(masterGain);

      // Wet chain (conditionally assembled) as sequential pipeline
      let wetPrev = this.amp;

      // Ring Mod (R) — multiply by audio-rate LFO
      if (keys.has('r')) {
        this.ringGain = audioCtx.createGain();
        this.ringGain.gain.value = 1.0;
        this.ringLfo = audioCtx.createOscillator();
        this.ringLfo.frequency.value = rand(30, 80);
        const ringDepth = audioCtx.createGain();
        ringDepth.gain.value = 0.5;
        this.ringBias = audioCtx.createConstantSource();
        this.ringBias.offset.value = 0.5;
        this.ringLfo.connect(ringDepth);
        ringDepth.connect(this.ringGain.gain);
        this.ringBias.connect(this.ringGain.gain);
        this.ringLfo.start();
        this.ringBias.start();

        wetPrev.connect(this.ringGain);
        wetPrev = this.ringGain;
      }

      // Autopan (A) — Stereo Panner modulated by slow LFO
      if (keys.has('a')) {
        this.panner = audioCtx.createStereoPanner();
        this.autopanLfo = audioCtx.createOscillator();
        this.autopanLfo.frequency.value = rand(0.2, 1.2);
        const panDepth = audioCtx.createGain();
        panDepth.gain.value = 0.9;
        this.autopanLfo.connect(panDepth);
        panDepth.connect(this.panner.pan);
        this.autopanLfo.start();

        wetPrev.connect(this.panner);
        wetPrev = this.panner;
      }

      // Distortion (V)
      if (keys.has('v')) {
        const shaper = audioCtx.createWaveShaper();
        shaper.curve = makeDistortionCurve(rand(140, 220));
        shaper.oversample = '4x';
        wetPrev.connect(shaper);
        wetPrev = shaper;
      }

      // Saturation (S) — softer waveshaper
      if (keys.has('s')) {
        const sat = audioCtx.createWaveShaper();
        sat.curve = makeDistortionCurve(rand(30, 90));
        sat.oversample = '2x';
        wetPrev.connect(sat);
        wetPrev = sat;
      }

      // Phaser (P) — chain of allpass filters with LFO on frequency
      if (keys.has('p')) {
        this.phaserLfo = audioCtx.createOscillator();
        this.phaserLfo.frequency.value = rand(0.1, 0.6);
        for (let i = 0; i < 4; i++) {
          const ap = audioCtx.createBiquadFilter();
          ap.type = 'allpass';
          ap.frequency.value = rand(300, 1200);
          ap.Q.value = 0.8;
          const depth = audioCtx.createGain();
          depth.gain.value = rand(150, 600);
          this.phaserLfo.connect(depth);
          depth.connect(ap.frequency);
          wetPrev.connect(ap);
          wetPrev = ap;
        }
        this.phaserLfo.start();
      }

      // Flanger (F) — short delay modulated, with feedback
      if (keys.has('f')) {
        const flangerDelay = audioCtx.createDelay(0.05);
        flangerDelay.delayTime.value = rand(0.005, 0.015);
        const feedback = audioCtx.createGain();
        feedback.gain.value = rand(0.15, 0.35);
        flangerDelay.connect(feedback);
        feedback.connect(flangerDelay);
        this.flangerLfo = audioCtx.createOscillator();
        this.flangerLfo.frequency.value = rand(0.1, 0.5);
        const depth = audioCtx.createGain();
        depth.gain.value = rand(0.003, 0.008);
        this.flangerLfo.connect(depth);
        depth.connect(flangerDelay.delayTime);
        this.flangerLfo.start();

        wetPrev.connect(flangerDelay);
        wetPrev = flangerDelay;
      }

      // Chorus (M) — dual modulated delays mixed back
      if (keys.has('m')) {
        const sum = audioCtx.createGain();
        this.chorusLfo = audioCtx.createOscillator();
        this.chorusLfo.frequency.value = rand(0.6, 1.8);
        const makeChDelay = (baseMs, depthMs) => {
          const d = audioCtx.createDelay(0.05);
          d.delayTime.value = baseMs / 1000;
          const g = audioCtx.createGain();
          g.gain.value = depthMs / 1000;
          this.chorusLfo.connect(g);
          g.connect(d.delayTime);
          return d;
        };
        const d1 = makeChDelay(rand(12, 24), rand(2, 5));
        const d2 = makeChDelay(rand(18, 32), rand(2, 5));
        wetPrev.connect(d1);
        wetPrev.connect(d2);
        d1.connect(sum);
        d2.connect(sum);
        this.chorusLfo.start();

        wetPrev = sum;
      }

      // Delay (C)
      if (keys.has('c')) {
        const delay = audioCtx.createDelay(5.0);
        delay.delayTime.value = rand(0.18, 0.42);
        const feedback = audioCtx.createGain();
        feedback.gain.value = rand(0.25, 0.5);
        delay.connect(feedback);
        feedback.connect(delay);
        wetPrev.connect(delay);
        wetPrev = delay;
      }

      // Reverb (B)
      if (keys.has('b')) {
        const convolver = audioCtx.createConvolver();
        convolver.buffer = createImpulseBuffer(audioCtx, rand(1.8, 3.5), rand(0.35, 0.6));
        wetPrev.connect(convolver);
        wetPrev = convolver;
      }

      // Highpass (H) — clean low end
      if (keys.has('h')) {
        const hp = audioCtx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = rand(120, 380);
        hp.Q.value = 0.7;
        wetPrev.connect(hp);
        wetPrev = hp;
      }

      // Wet mix
      this.wetGain = audioCtx.createGain();
      const hasFx = Array.from(keys).some(k => k !== 'z' && k !== 'x'); // any chain effect present
      this.wetGain.gain.value = hasFx ? 0.55 : 0;
      wetPrev.connect(this.wetGain);
      this.wetGain.connect(masterGain);

      // Noise layer (N) — parallel into wet
      if (keys.has('n')) {
        const rate = audioCtx.sampleRate;
        const length = Math.max(1, Math.floor(0.5 * rate));
        const buf = audioCtx.createBuffer(1, length, rate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < length; i++) {
          data[i] = Math.random() * 2 - 1;
        }
        this.noiseSrc = audioCtx.createBufferSource();
        this.noiseSrc.buffer = buf;
        this.noiseSrc.loop = true;
        const noiseFilter = audioCtx.createBiquadFilter();
        noiseFilter.type = 'lowpass';
        noiseFilter.frequency.value = rand(2000, 8000);
        const noiseGain = audioCtx.createGain();
        noiseGain.gain.value = rand(0.03, 0.12);
        this.noiseSrc.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(this.wetGain);
        this.noiseSrc.start();
      }

      // LFOs
      // Vibrato (Z) — modulate detune in cents
      if (keys.has('z')) {
        this.vibratoLfo = audioCtx.createOscillator();
        this.vibratoLfo.frequency.value = rand(5, 8);
        this.vibratoDepth = audioCtx.createGain();
        this.vibratoDepth.gain.value = rand(15, 40); // cents
        this.vibratoLfo.connect(this.vibratoDepth);
        this.vibratoDepth.connect(this.osc.detune);
        this.vibratoLfo.start();
      }

      // Tremolo (X) — modulate amplitude gently
      if (keys.has('x')) {
        this.tremoloLfo = audioCtx.createOscillator();
        this.tremoloLfo.frequency.value = rand(3.5, 6);
        this.tremoloDepth = audioCtx.createGain();
        this.tremoloDepth.gain.value = 0.15; // add ±0.15 to base
        this.tremoloLfo.connect(this.tremoloDepth);
        this.tremoloDepth.connect(this.amp.gain);
        this.tremoloLfo.start();
      }
    }

    start(amplitude = PLAY_LEVEL) {
      const now = audioCtx.currentTime;
      this.amp.gain.cancelScheduledValues(now);
      this.amp.gain.setValueAtTime(0, now);
      this.amp.gain.linearRampToValueAtTime(amplitude, now + 0.06);
      this.osc.start(now);
    }

    update(freq, cutoff) {
      const now = audioCtx.currentTime;
      this.osc.frequency.setTargetAtTime(freq, now, 0.01);
      this.filter.frequency.setTargetAtTime(cutoff, now, 0.01);
    }

    setAmplitude(target = PLAY_LEVEL, ramp = 0.04) {
      const now = audioCtx.currentTime;
      this.amp.gain.cancelScheduledValues(now);
      this.amp.gain.setTargetAtTime(target, now, ramp);
    }

    stop() {
      const now = audioCtx.currentTime;
      try {
        this.amp.gain.cancelScheduledValues(now);
        this.amp.gain.linearRampToValueAtTime(0, now + 0.08);
        this.osc.stop(now + 0.10);
      } catch (_) {}

      setTimeout(() => {
        ['vibratoLfo', 'tremoloLfo', 'autopanLfo', 'flangerLfo', 'chorusLfo', 'phaserLfo', 'ringLfo'].forEach(name => {
          const node = this[name];
          if (node) { try { node.stop(); } catch (_) {} }
        });
        if (this.ringBias) { try { this.ringBias.stop(); } catch (_) {} }
        if (this.noiseSrc) { try { this.noiseSrc.stop(); } catch (_) {} }
      }, 200);
    }
  }

  // --- Interaction state ---
  let pointer = { x: 0, y: 0, down: false };
  let pointerVoice = null;
  let pointerIn = false; // whether cursor is inside canvas
  let previewHeld = false; // spacebar preview mode
  const marks = []; // sustained notes: {x, y, voice, effects:Set<string>}

  // Randomize effects helper (Q held)
  const randomizeEffects = (baseKeys) => {
    const base = new Set(baseKeys);
    base.delete('q');
    const pool = FX_KEYS.slice();
    // remove any already in base to avoid duplicates
    for (const k of base) {
      const idx = pool.indexOf(k);
      if (idx >= 0) pool.splice(idx, 1);
    }
    // pick 2-6 random additional effects
    const count = randInt(2, 6);
    const picks = pickN(pool, count);
    for (const p of picks) base.add(p);
    return base;
  };

  const startPointerVoice = (x, y, ampLevel = PLAY_LEVEL) => {
    pointer.x = x; pointer.y = y;
    if (!pointerVoice) {
      const keysSnapshot = new Set(activeKeys);
      const keys = keysSnapshot.has('q') ? randomizeEffects(keysSnapshot) : keysSnapshot;
      pointerVoice = new Voice({
        freq: freqFromX(x),
        cutoff: cutoffFromY(y),
        keys
      });
      pointerVoice.start(ampLevel);
    } else {
      pointerVoice.update(freqFromX(x), cutoffFromY(y));
      pointerVoice.setAmplitude(ampLevel);
    }
  };

  const updatePointerVoice = (x, y) => {
    pointer.x = x; pointer.y = y;
    if (pointerVoice) {
      pointerVoice.update(freqFromX(x), cutoffFromY(y));
    }
  };

  const stopPointerVoice = () => {
    if (pointerVoice) {
      pointerVoice.stop();
      pointerVoice = null;
    }
  };

  const addSustainedMark = (x, y) => {
    let keysSnapshot = new Set(activeKeys);
    const keys = keysSnapshot.has('q') ? randomizeEffects(keysSnapshot) : keysSnapshot;
    keys.delete('q');
    const voice = new Voice({
      freq: freqFromX(x),
      cutoff: cutoffFromY(y),
      keys
    });
    voice.start();
    marks.push({ x, y, voice, effects: keys });
  };

  const clearAll = () => {
    for (const m of marks) {
      try { m.voice.stop(); } catch (_) {}
    }
    marks.length = 0;
    stopPointerVoice();
    draw();
  };

  // --- Event wiring ---
  const resumeAudio = async () => {
    if (audioCtx.state !== 'running') {
      try { await audioCtx.resume(); } catch (_) {}
    }
  };

  // Mouse / pointer events
  const getLocalPos = (evt) => {
    const rect = canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    return { x, y };
  };

  canvas.addEventListener('pointerdown', async (evt) => {
    await resumeAudio();
    const { x, y } = getLocalPos(evt);
    pointer.down = true;
    startPointerVoice(x, y, PLAY_LEVEL);
  });

  canvas.addEventListener('pointermove', (evt) => {
    const { x, y } = getLocalPos(evt);
    if (pointer.down) {
      updatePointerVoice(x, y);
    } else {
      if (previewHeld) {
        startPointerVoice(x, y, PREVIEW_LEVEL);
      } else {
        pointer.x = x; pointer.y = y;
      }
    }
  });

  canvas.addEventListener('pointerup', () => {
    pointer.down = false;
    if (previewHeld) {
      if (pointerVoice) {
        pointerVoice.setAmplitude(PREVIEW_LEVEL);
      } else {
        startPointerVoice(pointer.x, pointer.y, PREVIEW_LEVEL);
      }
    } else {
      stopPointerVoice();
    }
  });

  // Hover enter/leave to manage preview lifecycle
  canvas.addEventListener('pointerenter', (evt) => {
    pointerIn = true;
    const { x, y } = getLocalPos(evt);
    if (previewHeld) {
      resumeAudio();
      startPointerVoice(x, y, PREVIEW_LEVEL);
    } else {
      // no audio while hovering unless spacebar held
      pointer.x = x; pointer.y = y;
    }
  });

  canvas.addEventListener('pointerleave', () => {
    pointer.down = false;
    pointerIn = false;
    stopPointerVoice();
  });

  // Click to mark and sustain
  canvas.addEventListener('click', (evt) => {
    const { x, y } = getLocalPos(evt);
    addSustainedMark(x, y);
  });

  // Clear button
  clearBtn.addEventListener('click', clearAll);

  // Keyboard effects (hold to apply)
  const effectKeys = new Set([...FX_KEYS, 'q']); // include randomize trigger
  window.addEventListener('keydown', (evt) => {
    // Toggle legend with backquote `
    if ((evt.key === '`') || (evt.code === 'Backquote')) {
      setLegendVisibility(!legendVisible);
      return;
    }

    // Spacebar holds preview
    if (evt.code === 'Space') {
      evt.preventDefault();
      if (!previewHeld) {
        previewHeld = true;
        resumeAudio();
        if (!pointer.down) {
          if (pointerIn) {
            startPointerVoice(pointer.x, pointer.y, PREVIEW_LEVEL);
          } else if (pointerVoice) {
            pointerVoice.setAmplitude(PREVIEW_LEVEL);
          }
        }
      }
      return;
    }

    // Resume audio for effect changes
    resumeAudio();

    const k = (evt.key || '').toLowerCase();
    if (effectKeys.has(k) && !activeKeys.has(k)) {
      activeKeys.add(k);
      if (pointerVoice) {
        const { x, y } = pointer;
        stopPointerVoice();
        startPointerVoice(x, y, pointer.down ? PLAY_LEVEL : PREVIEW_LEVEL);
      }
      draw();
    }
  });
  window.addEventListener('keyup', (evt) => {
    // Ignore legend toggle on keyup
    if ((evt.key === '`') || (evt.code === 'Backquote')) {
      return;
    }

    // Spacebar releases preview
    if (evt.code === 'Space') {
      evt.preventDefault();
      previewHeld = false;
      if (!pointer.down) {
        stopPointerVoice();
      }
      return;
    }

    const k = (evt.key || '').toLowerCase();
    if (effectKeys.has(k) && activeKeys.has(k)) {
      activeKeys.delete(k);
      if (pointerVoice) {
        const { x, y } = pointer;
        stopPointerVoice();
        startPointerVoice(x, y, pointer.down ? PLAY_LEVEL : PREVIEW_LEVEL);
      }
      draw();
    }
  });
  window.addEventListener('blur', () => {
    // release keys if window loses focus
    activeKeys.clear();
    previewHeld = false;
    stopPointerVoice();
    draw();
  });

  // --- Drawing ---
  const drawBackground = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx2d.clearRect(0, 0, w, h);
    // Background is handled by CSS gradient; leave canvas clear.
  };

  const drawEffectRing = (x, y, effects) => {
    const eff = Array.from(effects).filter(k => effectColors[k]);
    if (!eff.length) return;
    const r = 12;
    const lw = 4;
    const seg = (Math.PI * 2) / eff.length;
    let start = Math.random() * Math.PI * 2; // slight random rotation
    for (let i = 0; i < eff.length; i++) {
      const k = eff[i];
      ctx2d.beginPath();
      ctx2d.arc(x, y, r, start + i * seg, start + (i + 1) * seg);
      ctx2d.strokeStyle = effectColors[k];
      ctx2d.lineWidth = lw;
      ctx2d.lineCap = 'round';
      ctx2d.stroke();
    }
  };

  const drawMarks = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    // sustained marks
    for (const m of marks) {
      // base dot
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.arc(m.x, m.y, 8, 0, Math.PI * 2);
      ctx2d.fillStyle = 'rgba(244,63,94,0.85)';
      ctx2d.fill();
      ctx2d.strokeStyle = 'rgba(244,63,94,0.35)';
      ctx2d.lineWidth = 2;
      ctx2d.stroke();
      ctx2d.restore();

      // effect ring
      drawEffectRing(m.x, m.y, m.effects);
    }

    // pointer indicator + current effects ring
    if (pointerVoice) {
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.arc(pointer.x, pointer.y, pointer.down ? 10 : 8, 0, Math.PI * 2);
      ctx2d.fillStyle = pointer.down ? 'rgba(59,130,246,0.85)' : 'rgba(59,130,246,0.65)';
      ctx2d.fill();
      ctx2d.strokeStyle = 'rgba(59,130,246,0.35)';
      ctx2d.lineWidth = 2;
      ctx2d.stroke();
      ctx2d.restore();

      drawEffectRing(pointer.x, pointer.y, activeKeys);
    }

    // effects badges
    ctx2d.save();
    const keys = Array.from(activeKeys).sort();
    if (keys.length) {
      const text = `Effects: ${keys.map(k => k.toUpperCase()).join(' ')}`;
      ctx2d.font = '600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx2d.fillStyle = 'rgba(255,255,255,0.9)';
      ctx2d.fillText(text, 12, h - 12);
    }
    ctx2d.restore();

    // live pitch/tone readout (bottom-right)
    const f = freqFromX(pointer.x);
    const c = cutoffFromY(pointer.y);
    const noteText = `Pitch ~ ${Math.round(f)} Hz | Tone cutoff ~ ${Math.round(c)} Hz`;
    ctx2d.save();
    ctx2d.font = '500 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx2d.fillStyle = 'rgba(255,255,255,0.85)';
    ctx2d.textAlign = 'right';
    ctx2d.textBaseline = 'bottom';
    ctx2d.fillText(noteText, w - 12, h - 12);
    ctx2d.restore();
  };

  const draw = () => {
    drawBackground();
    drawMarks();
  };

  // Animation loop (for smooth pointer indicator)
  const loop = () => {
    draw();
    requestAnimationFrame(loop);
  };
  loop();
})();