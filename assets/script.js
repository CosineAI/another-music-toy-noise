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

  const PREVIEW_LEVEL = 0.35;
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

  // Y-mode switching (1–5)
  let yMode = 1; // 1: LP gamma, 2: LP+Q travel, 3: LP/BP/HP zones, 4: wave morph, 5: macro character

  const toneFromY = (y) => {
    const h = canvas.clientHeight || 1;
    const ny = Math.min(1, Math.max(0, y / h));
    const min = 200;
    const max = 10000;
    const ratio = max / min;

    let cutoff = min * Math.pow(ratio, 1 - ny);
    let q = 0.9;
    let filterType = 'lowpass';
    let oscType = undefined;
    let wetMix = undefined;

    switch (yMode) {
      case 1: {
        // LP gamma-shaped for more control in mid/top
        const gamma = 0.85;
        cutoff = min * Math.pow(ratio, Math.pow(1 - ny, gamma));
        q = 0.9;
        filterType = 'lowpass';
        break;
      }
      case 2: {
        // LP + resonance travel
        cutoff = min * Math.pow(ratio, 1 - ny);
        const qMin = 0.6, qMax = 12, qGamma = 1.2;
        q = qMin + Math.pow(ny, qGamma) * (qMax - qMin);
        filterType = 'lowpass';
        break;
      }
      case 3: {
        // LP/BP/HP zones
        if (ny < 0.33) {
          const t = ny / 0.33;
          filterType = 'lowpass';
          cutoff = min * Math.pow(ratio, 1 - t);
          q = 0.8;
        } else if (ny < 0.66) {
          const t = (ny - 0.33) / 0.33;
          filterType = 'bandpass';
          cutoff = 300 + t * 2400; // center frequency sweep
          q = 3 + t * 7; // from moderate to sharp
        } else {
          const t = (ny - 0.66) / 0.34;
          filterType = 'highpass';
          cutoff = 1200 + t * 6000; // more cut as we go up
          q = 0.9;
        }
        break;
      }
      case 4: {
        // Waveform morph (sine -> triangle -> sawtooth -> square)
        cutoff = min * Math.pow(ratio, 1 - ny);
        if (ny < 0.25) oscType = 'sine';
        else if (ny < 0.5) oscType = 'triangle';
        else if (ny < 0.75) oscType = 'sawtooth';
        else oscType = 'square';
        filterType = 'lowpass';
        q = 0.9;
        break;
      }
      case 5: {
        // Macro character: lead (top) -> pad (bottom)
        const bright = 1 - ny;
        cutoff = min * Math.pow(ratio, 1 - ny);
        q = 0.7 + ny * 5; // more resonance toward pad area
        filterType = 'lowpass';
        wetMix = 0.1 + ny * 0.6; // more wet toward bottom
        if (bright > 0.6) oscType = 'sawtooth';
        else if (bright > 0.3) oscType = 'triangle';
        else oscType = 'sine';
        break;
      }
      default:
        // Fallback: original mapping
        cutoff = min * Math.pow(ratio, 1 - ny);
        q = 0.9;
        filterType = 'lowpass';
        break;
    }

    return { cutoff, q, filterType, oscType, wetMix };
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

  // Bitcrusher curve (amplitude quantization)
  const makeBitcrusherCurve = (bits = 4) => {
    const steps = Math.max(2, 1 << bits);
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      const step = 2 / steps;
      curve[i] = Math.round(x / step) * step;
    }
    return curve;
  };

  // Rectifier curve (full-wave rectification -> octave-like effect)
  const makeRectifierCurve = () => {
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = Math.abs(x);
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

  // Effect color map for visual rings (A–Z)
  const effectColors = {
    a: '#22d3ee', // Autopan
    b: '#8b5cf6', // Reverb
    c: '#10b981', // Delay
    d: '#9ca3af', // Bitcrusher
    e: '#fcd34d', // Echo (multi-tap delay)
    f: '#0ea5e9', // Flanger
    g: '#4ade80', // Compressor
    h: '#7c3aed', // Highpass
    i: '#60a5fa', // Stereo spread
    j: '#ef9a9a', // Bandpass sweep
    k: '#94a3b8', // Comb filter
    l: '#d97706', // Warmth (LP + soft sat)
    m: '#34d399', // Chorus
    n: '#6b7280', // Noise
    o: '#fb923c', // Rectifier (octave-like)
    p: '#f472b6', // Phaser
    q: '#f87171', // Randomize (visual only)
    r: '#eab308', // RingMod
    s: '#fb7185', // Saturation
    t: '#22c55e', // Wow (slow pitch LFO)
    u: '#fde68a', // Exciter (high-shelf + sat)
    v: '#ef4444', // Distortion
    w: '#14b8a6', // Auto-wah
    x: '#f59e0b', // Tremolo
    y: '#a78bfa', // Phase-wash (alt phaser)
    z: '#3b82f6', // Vibrato
  };

  const FX_KEYS = Object.keys(effectColors);

  // Voice object: oscillator + filter + amp, optional effects per snapshot of activeKeys
  class Voice {
    constructor({ freq, tone, keys }) {
      this.osc = audioCtx.createOscillator();
      this.osc.type = tone.oscType || 'sawtooth';
      this.osc.frequency.value = freq;

      this.filter = audioCtx.createBiquadFilter();
      this.filter.type = tone.filterType || 'lowpass';
      this.filter.frequency.value = tone.cutoff;
      this.filter.Q.value = tone.q ?? 0.9;

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

      // Bitcrusher (D) — amplitude quantization via waveshaper
      if (keys.has('d')) {
        const crusher = audioCtx.createWaveShaper();
        crusher.curve = makeBitcrusherCurve(randInt(3, 6));
        crusher.oversample = 'none';
        wetPrev.connect(crusher);
        wetPrev = crusher;
      }

      // Echo (E) — multi-tap delays summed
      if (keys.has('e')) {
        const sum = audioCtx.createGain();
        const d1 = audioCtx.createDelay(5.0);
        d1.delayTime.value = rand(0.20, 0.32);
        const fb1 = audioCtx.createGain();
        fb1.gain.value = rand(0.25, 0.45);
        d1.connect(fb1);
        fb1.connect(d1);

        const d2 = audioCtx.createDelay(5.0);
        d2.delayTime.value = d1.delayTime.value * rand(1.8, 2.4);
        const fb2 = audioCtx.createGain();
        fb2.gain.value = rand(0.15, 0.35);
        d2.connect(fb2);
        fb2.connect(d2);

        wetPrev.connect(d1);
        wetPrev.connect(d2);
        d1.connect(sum);
        d2.connect(sum);

        wetPrev = sum;
      }

      // Compressor (G)
      if (keys.has('g')) {
        const comp = audioCtx.createDynamicsCompressor();
        comp.threshold.value = -24;
        comp.knee.value = 8;
        comp.ratio.value = 4;
        comp.attack.value = 0.003;
        comp.release.value = 0.25;
        wetPrev.connect(comp);
        wetPrev = comp;
      }

      // Stereo spread (I) — small L/R delays panned wide
      if (keys.has('i')) {
        const sum = audioCtx.createGain();
        const dL = audioCtx.createDelay(0.03);
        dL.delayTime.value = rand(0.006, 0.012);
        const dR = audioCtx.createDelay(0.03);
        dR.delayTime.value = rand(0.010, 0.018);

        const pL = audioCtx.createStereoPanner();
        pL.pan.value = -0.6;
        const pR = audioCtx.createStereoPanner();
        pR.pan.value = 0.6;

        wetPrev.connect(dL);
        wetPrev.connect(dR);
        dL.connect(pL);
        dR.connect(pR);
        pL.connect(sum);
        pR.connect(sum);

        wetPrev = sum;
      }

      // Bandpass sweep (J) — bandpass filter moved by LFO
      if (keys.has('j')) {
        this.bandpass = audioCtx.createBiquadFilter();
        this.bandpass.type = 'bandpass';
        this.bandpass.Q.value = rand(3, 8);
        this.bandpassLfo = audioCtx.createOscillator();
        this.bandpassLfo.frequency.value = rand(0.2, 1.5);
        const bpDepth = audioCtx.createGain();
        bpDepth.gain.value = rand(300, 2000);
        this.bandpassLfo.connect(bpDepth);
        bpDepth.connect(this.bandpass.frequency);
        this.bandpassLfo.start();

        wetPrev.connect(this.bandpass);
        wetPrev = this.bandpass;
      }

      // Comb filter (K) — short delay with strong feedback
      if (keys.has('k')) {
        const combDelay = audioCtx.createDelay(0.05);
        combDelay.delayTime.value = rand(0.010, 0.028);
        const combFb = audioCtx.createGain();
        combFb.gain.value = rand(0.50, 0.85);
        combDelay.connect(combFb);
        combFb.connect(combDelay);

        wetPrev.connect(combDelay);
        wetPrev = combDelay;
      }

      // Warmth (L) — lowpass with soft saturation
      if (keys.has('l')) {
        const lp = audioCtx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = rand(1200, 3200);
        lp.Q.value = rand(0.4, 0.8);
        const sat = audioCtx.createWaveShaper();
        sat.curve = makeDistortionCurve(rand(12, 24));
        sat.oversample = '2x';

        wetPrev.connect(lp);
        lp.connect(sat);
        wetPrev = sat;
      }

      // Rectifier (O) — octave-like harmonics
      if (keys.has('o')) {
        const rect = audioCtx.createWaveShaper();
        rect.curve = makeRectifierCurve();
        rect.oversample = '2x';
        wetPrev.connect(rect);
        wetPrev = rect;
      }

      // Auto-wah (W) — bandpass center automated by LFO
      if (keys.has('w')) {
        this.wah = audioCtx.createBiquadFilter();
        this.wah.type = 'bandpass';
        this.wah.Q.value = rand(6, 12);
        this.wahLfo = audioCtx.createOscillator();
        this.wahLfo.frequency.value = rand(0.6, 2.5);
        const wahDepth = audioCtx.createGain();
        wahDepth.gain.value = rand(800, 2400);
        this.wahLfo.connect(wahDepth);
        wahDepth.connect(this.wah.frequency);
        this.wahLfo.start();

        wetPrev.connect(this.wah);
        wetPrev = this.wah;
      }

      // Phase-wash (Y) — alternate phaser voicing
      if (keys.has('y')) {
        this.phaser2Lfo = audioCtx.createOscillator();
        this.phaser2Lfo.frequency.value = rand(0.05, 0.3);
        for (let i = 0; i < 3; i++) {
          const ap = audioCtx.createBiquadFilter();
          ap.type = 'allpass';
          ap.frequency.value = rand(150, 600);
          ap.Q.value = 0.9;
          const depth = audioCtx.createGain();
          depth.gain.value = rand(80, 300);
          this.phaser2Lfo.connect(depth);
          depth.connect(ap.frequency);
          wetPrev.connect(ap);
          wetPrev = ap;
        }
        this.phaser2Lfo.start();
      }

      // Wow (T) — slow pitch wander
      if (keys.has('t')) {
        this.wowLfo = audioCtx.createOscillator();
        this.wowLfo.frequency.value = rand(0.2, 0.6);
        const wowDepth = audioCtx.createGain();
        wowDepth.gain.value = rand(5, 15); // cents
        this.wowLfo.connect(wowDepth);
        wowDepth.connect(this.osc.detune);
        this.wowLfo.start();
      }

      // Exciter (U) — bright shelf into mild saturation
      if (keys.has('u')) {
        const hs = audioCtx.createBiquadFilter();
        hs.type = 'highshelf';
        hs.frequency.value = rand(2500, 4500);
        hs.gain.value = rand(4, 8);
        const sat = audioCtx.createWaveShaper();
        sat.curve = makeDistortionCurve(rand(10, 20));
        sat.oversample = '2x';
        wetPrev.connect(hs);
        hs.connect(sat);
        wetPrev = sat;
      }

      // Wet mix
      this.wetGain = audioCtx.createGain();
      const hasFx = Array.from(keys).some(k => k !== 'z' && k !== 'x'); // any chain effect present
      this.hasFx = hasFx;
      this.wetGain.gain.value = hasFx ? (tone.wetMix ?? 0.55) : 0;
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

    update(freq, tone) {
      const now = audioCtx.currentTime;
      this.osc.frequency.setTargetAtTime(freq, now, 0.01);
      if (tone.filterType && this.filter.type !== tone.filterType) {
        this.filter.type = tone.filterType;
      }
      this.filter.frequency.setTargetAtTime(tone.cutoff, now, 0.01);
      if (tone.q != null) {
        this.filter.Q.setTargetAtTime(tone.q, now, 0.03);
      }
      if (tone.oscType && this.osc.type !== tone.oscType) {
        this.osc.type = tone.oscType;
      }
      if (this.hasFx && tone.wetMix != null) {
        // smooth wet mix a bit
        this.wetGain.gain.setTargetAtTime(tone.wetMix, now, 0.06);
      }
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
        ['vibratoLfo', 'tremoloLfo', 'autopanLfo', 'flangerLfo', 'chorusLfo', 'phaserLfo', 'phaser2Lfo', 'ringLfo', 'bandpassLfo', 'wahLfo', 'wowLfo'].forEach(name => {
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
    const tone = toneFromY(y);
    if (!pointerVoice) {
      const keysSnapshot = new Set(activeKeys);
      const keys = keysSnapshot.has('q') ? randomizeEffects(keysSnapshot) : keysSnapshot;
      pointerVoice = new Voice({
        freq: freqFromX(x),
        tone,
        keys
      });
      pointerVoice.start(ampLevel);
    } else {
      pointerVoice.update(freqFromX(x), tone);
      pointerVoice.setAmplitude(ampLevel);
    }
  };

  const updatePointerVoice = (x, y) => {
    pointer.x = x; pointer.y = y;
    if (pointerVoice) {
      const tone = toneFromY(y);
      pointerVoice.update(freqFromX(x), tone);
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
    const tone = toneFromY(y);
    const voice = new Voice({
      freq: freqFromX(x),
      tone,
      keys
    });
    voice.start();
    marks.push({ x, y, voice, effects: keys });
  };

  // Find the nearest sustained mark within a hit radius; returns its index or -1
  const findMarkIndexNear = (x, y, radius = 14) => {
    let idx = -1;
    let bestD2 = radius * radius;
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      const dx = m.x - x;
      const dy = m.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        idx = i;
      }
    }
    return idx;
  };

  // Remove a sustained mark at a location (if present). Returns true if removed.
  const removeSustainedAt = (x, y, radius = 14) => {
    const idx = findMarkIndexNear(x, y, radius);
    if (idx >= 0) {
      const m = marks[idx];
      try { m.voice.stop(); } catch (_) {}
      marks.splice(idx, 1);
      return true;
    }
    return false;
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

  // Click to toggle sustain at location
  canvas.addEventListener('click', (evt) => {
    const { x, y } = getLocalPos(evt);
    // If clicking near an existing mark, remove it; else add a new sustained note.
    if (!removeSustainedAt(x, y, 16)) {
      addSustainedMark(x, y);
    }
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

    // Number keys 1–5: set Y-mode (not held)
    if (evt.code && (evt.code.startsWith('Digit') || evt.code.startsWith('Numpad'))) {
      const n = parseInt(evt.key, 10);
      if (!isNaN(n) && n >= 1 && n <= 5) {
        yMode = n;
        // Recompute tone for current pointer position
        if (pointerVoice) {
          const tone = toneFromY(pointer.y);
          pointerVoice.update(freqFromX(pointer.x), tone);
        }
        draw();
        return;
      }
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
    const tone = toneFromY(pointer.y);
    const c = tone.cutoff;
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