/*
 * System echo suppressor — an AudioWorkletProcessor that removes the sound the
 * machine's speakers leak back into the microphone.
 *
 * Input 0 is the microphone, input 1 is a reference capture of what the device is
 * playing (loopback, or the app's own playback bus as a fallback). The processor
 * compares the two in the frequency domain and attenuates only the bins the
 * reference can explain, so the speaker's voice survives.
 *
 * The signal maths lives in `audio/echoSuppression.ts` next to the unit tests;
 * this file repeats those formulas because a worklet cannot import modules at
 * runtime. Keep the two in sync — the constants are duplicated on purpose.
 */

const FFT_SIZE = 1024;
const HOP_SIZE = 128;
const PEAK_HOLD_MS = 240;
const FLOOR_DB = -9;
const OVER_SUBTRACTION = 1.4;
const ATTACK = 0.55;
const RELEASE = 0.18;
const GATE_DB = -62;
const DOMINANCE = 2;

const FLOOR = 10 ** (FLOOR_DB / 20);
const GATE = 10 ** (GATE_DB / 20);

function buildBitReverse(size) {
  const bits = Math.log2(size);
  const table = new Uint32Array(size);
  for (let index = 0; index < size; index += 1) {
    let reversed = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      reversed = (reversed << 1) | ((index >> bit) & 1);
    }
    table[index] = reversed;
  }
  return table;
}

function buildTwiddles(size) {
  const half = size / 2;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let index = 0; index < half; index += 1) {
    const angle = (-2 * Math.PI * index) / size;
    cos[index] = Math.cos(angle);
    sin[index] = Math.sin(angle);
  }
  return { cos, sin };
}

function buildWindow(size) {
  const window = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / size);
  }
  return window;
}

/**
 * Overlap-add normalisation: sum of squared windows across the overlapping
 * frames. With a periodic Hann window and 8x overlap this is exactly 3.
 */
function overlapScale(window, hop) {
  let sum = 0;
  for (let offset = 0; offset < window.length; offset += hop) {
    const value = window[offset];
    sum += value * value;
  }
  return sum > 0 ? 1 / sum : 1;
}

class SystemEchoSuppressor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.bitReverse = buildBitReverse(FFT_SIZE);
    this.twiddles = buildTwiddles(FFT_SIZE);
    this.window = buildWindow(FFT_SIZE);
    this.scale = overlapScale(this.window, HOP_SIZE);

    this.mic = new Float64Array(FFT_SIZE);
    this.reference = new Float64Array(FFT_SIZE);
    this.overlap = new Float64Array(FFT_SIZE);
    this.filled = 0;

    this.reIm = new Float64Array(FFT_SIZE);
    this.imIm = new Float64Array(FFT_SIZE);
    this.reRef = new Float64Array(FFT_SIZE);
    this.imRef = new Float64Array(FFT_SIZE);
    this.peak = new Float64Array(FFT_SIZE / 2 + 1);
    this.gains = new Float64Array(FFT_SIZE / 2 + 1).fill(1);

    const hopMs = (HOP_SIZE / sampleRate) * 1000;
    this.peakDecay = Number.isFinite(hopMs) && hopMs > 0 ? Math.exp(-hopMs / PEAK_HOLD_MS) : 0.9;

    this.enabled = true;
    this.referenceLive = false;
    this.silent = new Float32Array(HOP_SIZE);

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'enabled') {
        this.enabled = Boolean(data.value);
        if (!this.enabled) this.reset();
      } else if (data.type === 'reference') {
        this.referenceLive = Boolean(data.available);
        if (!this.referenceLive) this.peak.fill(0);
      }
    };
  }

  reset() {
    this.mic.fill(0);
    this.reference.fill(0);
    this.overlap.fill(0);
    this.peak.fill(0);
    this.gains.fill(1);
    this.filled = 0;
  }

  fft(re, im, inverse) {
    const size = FFT_SIZE;
    const { cos, sin } = this.twiddles;
    for (let index = 0; index < size; index += 1) {
      const target = this.bitReverse[index];
      if (target > index) {
        let temp = re[index];
        re[index] = re[target];
        re[target] = temp;
        temp = im[index];
        im[index] = im[target];
        im[target] = temp;
      }
    }
    for (let span = 2; span <= size; span *= 2) {
      const half = span / 2;
      const step = size / span;
      for (let start = 0; start < size; start += span) {
        for (let offset = 0; offset < half; offset += 1) {
          const twiddle = offset * step;
          const wr = cos[twiddle];
          const wi = inverse ? -sin[twiddle] : sin[twiddle];
          const a = start + offset;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
    if (inverse) {
      for (let index = 0; index < size; index += 1) {
        re[index] /= size;
        im[index] /= size;
      }
    }
  }

  pushMic(sample) {
    this.mic.copyWithin(0, 1);
    this.mic[FFT_SIZE - 1] = sample;
  }

  pushReference(left, right) {
    this.reference.copyWithin(0, 1);
    this.reference[FFT_SIZE - 1] = (left + right) * 0.5;
  }

  processFrame() {
    const mic = this.mic;
    const reference = this.reference;
    const re = this.reIm;
    const im = this.imIm;

    for (let index = 0; index < FFT_SIZE; index += 1) {
      re[index] = mic[index] * this.window[index];
      im[index] = 0;
    }
    this.fft(re, im, false);

    if (this.referenceLive) {
      const refRe = this.reRef;
      const refIm = this.imRef;
      for (let index = 0; index < FFT_SIZE; index += 1) {
        refRe[index] = reference[index] * this.window[index];
        refIm[index] = 0;
      }
      this.fft(refRe, refIm, false);

      const bins = FFT_SIZE / 2 + 1;
      for (let bin = 0; bin < bins; bin += 1) {
        const magnitude = Math.hypot(refRe[bin], refIm[bin]);
        const held = this.peak[bin] * this.peakDecay;
        this.peak[bin] = magnitude > held ? magnitude : held;
      }
    } else {
      this.peak.fill(0);
    }

    const bins = FFT_SIZE / 2 + 1;
    for (let bin = 0; bin < bins; bin += 1) {
      const micMagnitude = Math.hypot(re[bin], im[bin]);
      const gain = this.binGain(bin, micMagnitude);
      this.gains[bin] = gain;
      re[bin] *= gain;
      im[bin] *= gain;
      if (bin > 0 && bin < FFT_SIZE / 2) {
        const mirror = FFT_SIZE - bin;
        re[mirror] *= gain;
        im[mirror] *= gain;
      }
    }

    this.fft(re, im, true);

    for (let index = 0; index < FFT_SIZE; index += 1) {
      this.overlap[index] += re[index] * this.window[index] * this.scale;
    }
  }

  binGain(bin, micMagnitude) {
    const previous = this.gains[bin];
    if (!this.enabled || !this.referenceLive) return this.smooth(previous, 1);
    const reference = this.peak[bin];
    if (!(reference > GATE)) return this.smooth(previous, 1);
    if (!(micMagnitude > 0)) return this.smooth(previous, FLOOR);
    const leaked = reference * OVER_SUBTRACTION;
    if (micMagnitude >= leaked * DOMINANCE) return this.smooth(previous, 1);
    const raw = 1 - leaked / micMagnitude;
    const target = raw >= 1 ? 1 : raw <= FLOOR ? FLOOR : raw;
    return this.smooth(previous, target);
  }

  smooth(previous, target) {
    const rate = target < previous ? ATTACK : RELEASE;
    const next = previous + (target - previous) * rate;
    if (next < FLOOR) return FLOOR;
    return next > 1 ? 1 : next;
  }

  flushHop(output) {
    for (let index = 0; index < HOP_SIZE; index += 1) {
      output[index] = this.overlap[index];
    }
    this.overlap.copyWithin(0, HOP_SIZE);
    this.overlap.fill(0, FFT_SIZE - HOP_SIZE);
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const micChannels = inputs[0] || [];
    const refChannels = inputs[1] || [];
    const micLeft = micChannels[0];
    const micRight = micChannels.length > 1 ? micChannels[1] : micLeft;
    const refLeft = refChannels[0];
    const refRight = refChannels.length > 1 ? refChannels[1] : refLeft;

    const frames = output[0].length;
    const outLeft = output[0];
    const outRight = output.length > 1 ? output[1] : null;

    if (!this.enabled || !this.referenceLive || !micLeft) {
      // Transparent path: copy the microphone through untouched.
      for (let channel = 0; channel < output.length; channel += 1) {
        const source = micChannels[channel] || micLeft;
        const destination = output[channel];
        if (source) {
          destination.set(source);
        } else {
          destination.fill(0);
        }
      }
      if (!this.enabled) this.reset();
      return true;
    }

    for (let frame = 0; frame < frames; frame += 1) {
      // The render quantum is expected to be HOP_SIZE samples; if a host ever
      // renders more, the extra frames are carried into the next hop.
      this.pushMic(micLeft[frame]);
      if (refLeft) {
        this.pushReference(refLeft[frame], refRight ? refRight[frame] : refLeft[frame]);
      } else {
        this.pushReference(0, 0);
      }
      this.filled += 1;
      if (this.filled >= HOP_SIZE) {
        this.filled = 0;
        this.processFrame();
        const chunk = outLeft.subarray(frame + 1 - HOP_SIZE, frame + 1);
        this.flushHop(chunk);
      }
    }

    if (outRight) {
      outRight.set(outLeft);
    }
    return true;
  }
}

registerProcessor('system-echo-suppressor', SystemEchoSuppressor);
