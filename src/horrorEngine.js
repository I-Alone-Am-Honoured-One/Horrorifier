const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const DEFAULT_SETTINGS = {
  slowdown: 0.68,
  pitchShift: -3,
  distortion: 0.22,
  reverb: 0.45,
  lowpass: 0.5,
  detune: 10,
  ambience: 0.2,
  wetDry: 0.65,
  style: 'psychological',
};

export function analyzeTrack(buffer) {
  const channels = Math.min(buffer.numberOfChannels, 2);
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  const mono = new Float32Array(length);

  for (let c = 0; c < channels; c += 1) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) {
      mono[i] += channel[i] / channels;
    }
  }

  let rmsAccum = 0;
  let absMean = 0;
  let zeroCrossings = 0;
  let prev = mono[0] || 0;
  for (let i = 1; i < length; i += 1) {
    const current = mono[i];
    rmsAccum += current * current;
    absMean += Math.abs(current);
    if ((prev >= 0 && current < 0) || (prev < 0 && current >= 0)) {
      zeroCrossings += 1;
    }
    prev = current;
  }

  const rms = Math.sqrt(rmsAccum / length);
  const zcr = zeroCrossings / length;
  const brightness = clamp((zcr - 0.03) / 0.12, 0, 1);
  const energy = clamp(rms * 3.2, 0, 1);
  const tempo = estimateTempo(mono, sampleRate);
  const keyGuess = estimateKeyMood(mono, sampleRate, brightness, energy);

  // "Happy/clean" proxy:
  // brighter spectrum + mid/high energy + major-ish key often sounds less horror-ready.
  const happyClean = clamp((brightness * 0.5) + (energy * 0.25) + (keyGuess.isMajor ? 0.25 : 0), 0, 1);

  return {
    bpm: tempo,
    brightness,
    energy,
    key: keyGuess.label,
    isMajor: keyGuess.isMajor,
    happyClean,
    duration: buffer.duration,
  };
}

function estimateTempo(mono, sampleRate) {
  const windowSize = 1024;
  const hop = 512;
  const envelope = [];

  for (let i = 0; i + windowSize < mono.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < windowSize; j += 1) {
      const v = mono[i + j];
      sum += v * v;
    }
    envelope.push(Math.sqrt(sum / windowSize));
  }

  if (envelope.length < 8) return null;

  const minBpm = 55;
  const maxBpm = 190;
  const minLag = Math.floor((60 / maxBpm) * (sampleRate / hop));
  const maxLag = Math.ceil((60 / minBpm) * (sampleRate / hop));

  let bestLag = minLag;
  let bestCorr = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let corr = 0;
    for (let i = 0; i + lag < envelope.length; i += 1) {
      corr += envelope[i] * envelope[i + lag];
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  const bpm = 60 / ((bestLag * hop) / sampleRate);
  return Number.isFinite(bpm) ? Math.round(bpm) : null;
}

function estimateKeyMood(mono, sampleRate, brightness, energy) {
  // A lightweight key-mood approximation: compare energy around major/minor third intervals.
  // This is intentionally heuristic (not a full MIR key detector) but useful for horror scoring.
  const chunk = mono.slice(0, Math.min(mono.length, sampleRate * 20));
  const n = chunk.length;
  if (n < 4096) {
    return { label: 'Unknown', isMajor: brightness > 0.58 && energy > 0.38 };
  }

  let majorScore = 0;
  let minorScore = 0;
  const step = Math.floor(sampleRate / 220);
  for (let i = 0; i < n - step * 5; i += step) {
    const root = Math.abs(chunk[i]);
    const majorThird = Math.abs(chunk[i + (step * 4)] || 0);
    const minorThird = Math.abs(chunk[i + (step * 3)] || 0);
    majorScore += root * majorThird;
    minorScore += root * minorThird;
  }

  const isMajor = majorScore >= minorScore;
  return { label: isMajor ? 'Likely Major' : 'Likely Minor', isMajor };
}

function styleBias(style) {
  if (style === 'monster') {
    return { distortion: 0.18, detune: 15, lowpass: 0.12, reverb: 0.08, ambience: 0.1 };
  }
  if (style === 'ambient') {
    return { distortion: -0.08, detune: 6, lowpass: 0.2, reverb: 0.2, ambience: 0.22 };
  }
  return { distortion: 0.02, detune: 8, lowpass: 0.16, reverb: 0.15, ambience: 0.14 };
}

export function scoreCandidate(candidate, analysis, variant = 'auto') {
  const slowdownSweetSpot = 1 - Math.abs(candidate.slowdown - 0.66) / 0.36;
  const darknessScore = (candidate.lowpass * 0.8) + (candidate.reverb * 0.5) + (candidate.ambience * 0.7);
  const instability = (Math.abs(candidate.detune) / 36) + (candidate.distortion * 0.45);

  const happyCompensation = analysis.happyClean * (
    (Math.max(0, -candidate.pitchShift) / 8) +
    candidate.lowpass * 0.8 +
    candidate.reverb * 0.4
  );

  const intelligibilityPenalty = Math.max(0, (candidate.distortion * 1.35) + (candidate.ambience * 0.9) - 1.05);
  const extremeBonus = variant === 'nightmare' || variant === 'broken' ? 0.28 : 0;

  return (
    (slowdownSweetSpot * 1.2) +
    darknessScore +
    instability +
    happyCompensation +
    extremeBonus -
    intelligibilityPenalty
  );
}

function buildCandidateFromBase(base, jitter = 0, style = 'psychological') {
  const bias = styleBias(style);
  return {
    slowdown: clamp(base.slowdown + jitter, 0.3, 1),
    pitchShift: clamp(base.pitchShift + (jitter * -6), -12, 6),
    distortion: clamp(base.distortion + bias.distortion + Math.abs(jitter * 0.2), 0, 1),
    reverb: clamp(base.reverb + bias.reverb + Math.abs(jitter * 0.2), 0, 1),
    lowpass: clamp(base.lowpass + bias.lowpass, 0, 1),
    detune: clamp(base.detune + bias.detune + jitter * 30, -60, 60),
    ambience: clamp(base.ambience + bias.ambience + Math.abs(jitter * 0.15), 0, 1),
    wetDry: clamp(base.wetDry + (bias.reverb * 0.2), 0.1, 1),
    style,
  };
}

export function generateAutoBest(analysis, style = 'psychological') {
  const moodDrop = analysis.happyClean * 0.22;
  const base = {
    slowdown: clamp(0.72 - moodDrop - (analysis.energy * 0.06), 0.45, 0.9),
    pitchShift: clamp(-2 - (analysis.happyClean * 4), -10, 2),
    distortion: clamp(0.15 + (analysis.energy * 0.2), 0.05, 0.45),
    reverb: clamp(0.35 + (analysis.brightness * 0.25), 0.2, 0.85),
    lowpass: clamp(0.28 + (analysis.happyClean * 0.5), 0.1, 0.9),
    detune: clamp(8 + (analysis.happyClean * 14), -20, 45),
    ambience: clamp(0.15 + (analysis.brightness * 0.25), 0.05, 0.75),
    wetDry: 0.62,
  };

  const candidates = [];
  const jitters = [-0.12, -0.07, -0.03, 0, 0.04, 0.08];
  for (const jitter of jitters) {
    candidates.push(buildCandidateFromBase(base, jitter, style));
  }

  let best = candidates[0];
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, analysis, 'auto');
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return {
    ...best,
    rationale: buildRationale(best, analysis),
    score: bestScore,
  };
}

export function generateVariants(analysis, style = 'psychological') {
  const subtleBase = buildCandidateFromBase({
    slowdown: clamp(0.83 - (analysis.happyClean * 0.05), 0.75, 0.9),
    pitchShift: -1,
    distortion: 0.08,
    reverb: 0.3,
    lowpass: 0.2,
    detune: 4,
    ambience: 0.1,
    wetDry: 0.52,
  }, 0.01, style);

  const deepBase = buildCandidateFromBase({
    slowdown: clamp(0.69 - (analysis.happyClean * 0.08), 0.55, 0.78),
    pitchShift: -3,
    distortion: 0.2,
    reverb: 0.5,
    lowpass: 0.45,
    detune: 12,
    ambience: 0.22,
    wetDry: 0.66,
  }, -0.02, style);

  const brokenBase = buildCandidateFromBase({
    slowdown: clamp(0.55 - (analysis.happyClean * 0.1), 0.38, 0.64),
    pitchShift: -6,
    distortion: 0.4,
    reverb: 0.62,
    lowpass: 0.6,
    detune: 24,
    ambience: 0.35,
    wetDry: 0.74,
  }, -0.04, style);

  return [
    {
      label: 'Subtle Horror',
      mode: 'subtle',
      settings: subtleBase,
      score: scoreCandidate(subtleBase, analysis, 'subtle'),
    },
    {
      label: 'Deep Unsettling',
      mode: 'deep',
      settings: deepBase,
      score: scoreCandidate(deepBase, analysis, 'nightmare'),
    },
    {
      label: 'Broken Nightmare',
      mode: 'broken',
      settings: brokenBase,
      score: scoreCandidate(brokenBase, analysis, 'broken'),
    },
  ];
}

function buildRationale(settings, analysis) {
  const points = [];
  if (analysis.happyClean > 0.5) {
    points.push('Track felt bright/clean, so extra pitch drop and muffling were applied.');
  }
  if (analysis.bpm && analysis.bpm > 120) {
    points.push('Detected higher tempo, so slowdown was pushed toward the 0.55x–0.72x horror zone.');
  } else {
    points.push('Tempo was moderate, so slowdown stayed closer to preserving musical intelligibility.');
  }
  if (settings.distortion < 0.25) {
    points.push('Distortion kept controlled to avoid losing melody detail.');
  } else {
    points.push('Added aggressive texture for a rougher survival-horror vibe.');
  }
  return points.join(' ');
}
