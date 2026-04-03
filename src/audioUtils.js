import lamejs from 'lamejs';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function createDistortionCurve(amount) {
  const k = amount * 600;
  const n = 44100;
  const curve = new Float32Array(n);
  const deg = Math.PI / 180;
  for (let i = 0; i < n; i += 1) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + (k * Math.abs(x)));
  }
  return curve;
}

function createImpulseResponse(sampleRate, seconds, decay = 2.5) {
  const length = Math.max(1, Math.floor(sampleRate * seconds));
  const impulse = new AudioBuffer({
    length,
    sampleRate,
    numberOfChannels: 2,
  });

  for (let c = 0; c < impulse.numberOfChannels; c += 1) {
    const channel = impulse.getChannelData(c);
    for (let i = 0; i < length; i += 1) {
      const n = (Math.random() * 2) - 1;
      channel[i] = n * ((1 - (i / length)) ** decay);
    }
  }

  return impulse;
}

function createNoiseBuffer(context, durationSec = 18) {
  const length = Math.floor(context.sampleRate * durationSec);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = ((Math.random() * 2) - 1) * 0.22;
  }
  return buffer;
}

export async function decodeAudioFile(file) {
  const bytes = await file.arrayBuffer();
  const context = new AudioContext();
  try {
    return await context.decodeAudioData(bytes.slice(0));
  } finally {
    await context.close();
  }
}

export function getWaveformData(buffer, points = 600) {
  const source = buffer.getChannelData(0);
  const blockSize = Math.floor(source.length / points);
  const waveform = new Array(points).fill(0);

  for (let i = 0; i < points; i += 1) {
    const start = i * blockSize;
    let peak = 0;
    for (let j = 0; j < blockSize; j += 1) {
      const v = Math.abs(source[start + j] || 0);
      if (v > peak) peak = v;
    }
    waveform[i] = peak;
  }

  return waveform;
}

export async function renderHorrorBuffer(inputBuffer, settings, onProgress) {
  const slowdown = clamp(settings.slowdown, 0.3, 1);
  const stretchedLength = Math.floor((inputBuffer.length / slowdown) * 1.04);
  const offline = new OfflineAudioContext({
    numberOfChannels: 2,
    sampleRate: inputBuffer.sampleRate,
    length: stretchedLength,
  });

  const source = offline.createBufferSource();
  source.buffer = inputBuffer;
  source.playbackRate.value = slowdown;
  source.detune.value = (settings.pitchShift * 100) + settings.detune;

  const dryGain = offline.createGain();
  dryGain.gain.value = 1 - settings.wetDry;

  const wetGain = offline.createGain();
  wetGain.gain.value = settings.wetDry;

  const filter = offline.createBiquadFilter();
  filter.type = 'lowpass';
  const cutoff = 350 + ((1 - settings.lowpass) * 6200);
  filter.frequency.value = cutoff;
  filter.Q.value = 1.2;

  const distortion = offline.createWaveShaper();
  distortion.curve = createDistortionCurve(settings.distortion);
  distortion.oversample = '4x';

  const convolver = offline.createConvolver();
  convolver.buffer = createImpulseResponse(offline.sampleRate, 2.6 + (settings.reverb * 3));

  const delay = offline.createDelay(0.15);
  delay.delayTime.value = 0.018 + (settings.detune / 4000);
  const feedback = offline.createGain();
  feedback.gain.value = 0.08 + (Math.abs(settings.detune) / 550);
  delay.connect(feedback);
  feedback.connect(delay);

  const ambienceGain = offline.createGain();
  ambienceGain.gain.value = settings.ambience * 0.35;

  const noise = offline.createBufferSource();
  noise.buffer = createNoiseBuffer(offline, Math.ceil(inputBuffer.duration / slowdown) + 1);
  noise.loop = true;

  source.connect(dryGain);
  source.connect(filter);
  filter.connect(distortion);
  distortion.connect(delay);
  delay.connect(convolver);
  convolver.connect(wetGain);

  dryGain.connect(offline.destination);
  wetGain.connect(offline.destination);

  noise.connect(ambienceGain);
  ambienceGain.connect(offline.destination);

  source.start(0);
  noise.start(0);

  const renderPromise = offline.startRendering();
  if (onProgress) {
    let progress = 0;
    const timer = setInterval(() => {
      progress = Math.min(95, progress + (2 + Math.random() * 5));
      onProgress(progress);
    }, 120);

    try {
      const rendered = await renderPromise;
      onProgress(100);
      clearInterval(timer);
      return rendered;
    } catch (error) {
      clearInterval(timer);
      throw error;
    }
  }

  return renderPromise;
}

function interleave(buffer) {
  const channels = Math.min(2, buffer.numberOfChannels);
  const length = buffer.length;
  const result = new Float32Array(length * channels);

  for (let i = 0; i < length; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      result[(i * channels) + c] = buffer.getChannelData(c)[i];
    }
  }

  return { data: result, channels };
}

export function audioBufferToWavBlob(buffer) {
  const { data, channels } = interleave(buffer);
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = buffer.sampleRate * blockAlign;
  const dataSize = data.length * bytesPerSample;

  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < data.length; i += 1) {
    const sample = clamp(data[i], -1, 1);
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
    offset += 2;
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

export function audioBufferToMp3Blob(buffer) {
  const channels = Math.min(2, buffer.numberOfChannels);
  const left = buffer.getChannelData(0);
  const right = channels > 1 ? buffer.getChannelData(1) : left;
  const sampleRate = buffer.sampleRate;

  const encoder = new lamejs.Mp3Encoder(channels, sampleRate, 192);
  const blockSize = 1152;
  const mp3Chunks = [];

  for (let i = 0; i < left.length; i += blockSize) {
    const leftChunk = left.subarray(i, i + blockSize);
    const rightChunk = right.subarray(i, i + blockSize);

    const left16 = new Int16Array(leftChunk.length);
    const right16 = new Int16Array(rightChunk.length);

    for (let j = 0; j < leftChunk.length; j += 1) {
      left16[j] = clamp(leftChunk[j], -1, 1) * 32767;
      right16[j] = clamp(rightChunk[j], -1, 1) * 32767;
    }

    const mp3buf = channels > 1
      ? encoder.encodeBuffer(left16, right16)
      : encoder.encodeBuffer(left16);

    if (mp3buf.length > 0) {
      mp3Chunks.push(new Uint8Array(mp3buf));
    }
  }

  const end = encoder.flush();
  if (end.length > 0) {
    mp3Chunks.push(new Uint8Array(end));
  }

  return new Blob(mp3Chunks, { type: 'audio/mpeg' });
}

export function formatTime(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.round(totalSeconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}
