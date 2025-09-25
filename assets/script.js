// Optional JavaScript goes here
console.log("Static site loaded!");

// Mouse Music Toy — Web Audio + Canvas
(() => {
  const canvas = document.getElementById('playCanvas');
  const clearBtn = document.getElementById('clearCanvas');
  if (!canvas || !clearBtn) return;

  const ctx2d = canvas.getContext('2d');

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

      // Wet chain (conditionally assembled)
      let wetPrev = this.amp;
      const chain = [];

      // Distortion (V)
      if (keys.has('v')) {
        const shaper = audioCtx.createWaveShaper();
        shaper.curve = makeDistortionCurve(160);
        shaper.oversample = '4x';
        chain.push(shaper);
      }

      // Delay (C)
      if (keys.has('c')) {
        const delay = audioCtx.createDelay(5.0);
        delay.delayTime.value = 0.26;
        const feedback = audioCtx.createGain();
        feedback.gain.value = 0.35;
        delay.connect(feedback);
        feedback.connect(delay);
        chain.push(delay);
      }

      // Reverb (B)
      if (keys.has('b')) {
        const convolver = audioCtx.createConvolver();
        convolver.buffer = createImpulseBuffer(audioCtx, 2.6, 0.5);
        chain.push(convolver);
      }

      for (const node of chain) {
        wetPrev.connect(node);
        wetPrev = node;
      }

      this.wetGain = audioCtx.createGain();
      this.wetGain.gain.value = chain.length ? 0.55 : 0; // only if effects present
      wetPrev.connect(this.wetGain);
      this.wetGain.connect(masterGain);

      // LFOs
      // Vibrato (Z) — modulate detune in cents
      if (keys.has('z')) {
        this.vibratoLfo = audioCtx.createOscillator();
        this.vibratoLfo.frequency.value = 6;
        this.vibratoDepth = audioCtx.createGain();
        this.vibratoDepth.gain.value = 30; // cents
        this.vibratoLfo.connect(this.vibratoDepth);
        this.vibratoDepth.connect(this.osc.detune);
        this.vibratoLfo.start();
      }

      // Tremolo (X) — modulate amplitude gently
      if (keys.has('x')) {
        this.tremoloLfo = audioCtx.createOscillator();
        this.tremoloLfo.frequency.value = 4.5;
        this.tremoloDepth = audioCtx.createGain();
        this.tremoloDepth.gain.value = 0.15; // add ±0.15 to base
        this.tremoloLfo.connect(this.tremoloDepth);
        this.tremoloDepth.connect(this.amp.gain);
        this.tremoloLfo.start();
      }
    }

    start() {
      const now = audioCtx.currentTime;
      this.amp.gain.cancelScheduledValues(now);
      this.amp.gain.setValueAtTime(0, now);
      this.amp.gain.linearRampToValueAtTime(0.35, now + 0.06);
      this.osc.start(now);
    }

    update(freq, cutoff) {
      const now = audioCtx.currentTime;
      this.osc.frequency.setTargetAtTime(freq, now, 0.01);
      this.filter.frequency.setTargetAtTime(cutoff, now, 0.01);
    }

    stop() {
      const now = audioCtx.currentTime;
      try {
        this.amp.gain.cancelScheduledValues(now);
        this.amp.gain.linearRampToValueAtTime(0, now + 0.08);
        this.osc.stop(now + 0.10);
      } catch (_) {
        // oscillator may already be stopped
      }
      // tidy LFOs shortly after
      setTimeout(() => {
        if (this.vibratoLfo) {
          try { this.vibratoLfo.stop(); } catch (_) {}
        }
        if (this.tremoloLfo) {
          try { this.tremoloLfo.stop(); } catch (_) {}
        }
      }, 200);
    }
  }

  // --- Interaction state ---
  let pointer = { x: 0, y: 0, down: false };
  let pointerVoice = null;
  const marks = []; // sustained notes: {x, y, voice}

  const startPointerVoice = (x, y) => {
    pointer.x = x; pointer.y = y;
    if (!pointerVoice) {
      pointerVoice = new Voice({
        freq: freqFromX(x),
        cutoff: cutoffFromY(y),
        keys: new Set(activeKeys) // snapshot
      });
      pointerVoice.start();
    } else {
      pointerVoice.update(freqFromX(x), cutoffFromY(y));
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
    const voice = new Voice({
      freq: freqFromX(x),
      cutoff: cutoffFromY(y),
      keys: new Set(activeKeys) // capture effects at click
    });
    voice.start();
    marks.push({ x, y, voice });
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
    startPointerVoice(x, y);
  });

  canvas.addEventListener('pointermove', (evt) => {
    const { x, y } = getLocalPos(evt);
    if (pointer.down) {
      updatePointerVoice(x, y);
    } else {
      pointer.x = x; pointer.y = y;
    }
  });

  canvas.addEventListener('pointerup', () => {
    pointer.down = false;
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
  const effectKeys = new Set(['z', 'x', 'c', 'v', 'b']);
  window.addEventListener('keydown', (evt) => {
    const k = (evt.key || '').toLowerCase();
    if (effectKeys.has(k) && !activeKeys.has(k)) {
      activeKeys.add(k);
      // update pointer voice snapshot only by recreating on next down,
      // sustained voices keep their captured state.
      if (pointerVoice) {
        // Recreate pointer voice to apply new effect set immediately
        const { x, y } = pointer;
        stopPointerVoice();
        startPointerVoice(x, y);
      }
      draw();
    }
  });
  window.addEventListener('keyup', (evt) => {
    const k = (evt.key || '').toLowerCase();
    if (effectKeys.has(k) && activeKeys.has(k)) {
      activeKeys.delete(k);
      if (pointerVoice) {
        const { x, y } = pointer;
        stopPointerVoice();
        startPointerVoice(x, y);
      }
      draw();
    }
  });
  window.addEventListener('blur', () => {
    // release keys if window loses focus
    activeKeys.clear();
    if (pointerVoice) {
      const { x, y } = pointer;
      stopPointerVoice();
      startPointerVoice(x, y);
    }
    draw();
  });

  // --- Drawing ---
  const drawBackground = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx2d.clearRect(0, 0, w, h);

    // pitch guide (vertical bands)
    ctx2d.save();
    const cols = 12;
    for (let i = 0; i < cols; i++) {
      const x = (i / cols) * w;
      ctx2d.fillStyle = i % 2 === 0 ? 'rgba(99,102,241,0.06)' : 'rgba(99,102,241,0.03)';
      ctx2d.fillRect(x, 0, w / cols, h);
    }
    ctx2d.restore();

    // tone guide (horizontal lines)
    ctx2d.save();
    ctx2d.strokeStyle = 'rgba(31,41,55,0.12)';
    ctx2d.lineWidth = 1;
    const rows = 8;
    for (let r = 1; r < rows; r++) {
      const y = (r / rows) * h;
      ctx2d.beginPath();
      ctx2d.moveTo(0, y);
      ctx2d.lineTo(w, y);
      ctx2d.stroke();
    }
    ctx2d.restore();
  };

  const drawMarks = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    // sustained marks
    for (const m of marks) {
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.arc(m.x, m.y, 8, 0, Math.PI * 2);
      ctx2d.fillStyle = 'rgba(244,63,94,0.85)';
      ctx2d.fill();
      ctx2d.strokeStyle = 'rgba(244,63,94,0.35)';
      ctx2d.lineWidth = 2;
      ctx2d.stroke();
      ctx2d.restore();
    }

    // pointer indicator
    if (pointer.down || pointerVoice) {
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.arc(pointer.x, pointer.y, 10, 0, Math.PI * 2);
      ctx2d.fillStyle = 'rgba(59,130,246,0.85)';
      ctx2d.fill();
      ctx2d.strokeStyle = 'rgba(59,130,246,0.35)';
      ctx2d.lineWidth = 2;
      ctx2d.stroke();
      ctx2d.restore();
    }

    // effects badges
    ctx2d.save();
    const keys = Array.from(activeKeys).sort();
    if (keys.length) {
      const text = `Effects: ${keys.map(k => k.toUpperCase()).join(' ')}`;
      ctx2d.font = '600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx2d.fillStyle = 'rgba(31,41,55,0.85)';
      ctx2d.fillText(text, 12, h - 12);
    }
    ctx2d.restore();

    // live pitch/tone readout
    const f = freqFromX(pointer.x);
    const c = cutoffFromY(pointer.y);
    const noteText = `Pitch ~ ${Math.round(f)} Hz | Tone cutoff ~ ${Math.round(c)} Hz`;
    ctx2d.save();
    ctx2d.font = '500 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx2d.fillStyle = 'rgba(31,41,55,0.7)';
    ctx2d.fillText(noteText, 12, 18);
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