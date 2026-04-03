import { useEffect, useMemo, useRef, useState } from 'react';
import {
  audioBufferToMp3Blob,
  audioBufferToWavBlob,
  decodeAudioFile,
  formatTime,
  getWaveformData,
  renderHorrorBuffer,
} from './audioUtils';
import {
  analyzeTrack,
  DEFAULT_SETTINGS,
  generateAutoBest,
  generateVariants,
} from './horrorEngine';

const STYLE_OPTIONS = [
  { value: 'psychological', label: 'Make it more psychological horror' },
  { value: 'monster', label: 'Make it more monster/chase horror' },
  { value: 'ambient', label: 'Make it more ambient menu horror' },
];

const numberFmt = (num, digits = 2) => Number(num).toFixed(digits);

function App() {
  const [fileName, setFileName] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [variants, setVariants] = useState([]);
  const [sourceBuffer, setSourceBuffer] = useState(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [processedBuffer, setProcessedBuffer] = useState(null);
  const [processedUrl, setProcessedUrl] = useState('');
  const [waveform, setWaveform] = useState([]);
  const [status, setStatus] = useState('Drop an MP3 to start.');
  const [progress, setProgress] = useState(0);
  const [isRendering, setIsRendering] = useState(false);
  const [abMode, setAbMode] = useState('B');

  const waveformCanvasRef = useRef(null);

  useEffect(() => {
    if (!waveformCanvasRef.current || waveform.length === 0) return;
    const canvas = waveformCanvasRef.current;
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0a0a0b';
    ctx.fillRect(0, 0, width, height);

    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#612a2a');
    gradient.addColorStop(1, '#d65454');

    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1.2;
    ctx.beginPath();

    for (let i = 0; i < waveform.length; i += 1) {
      const x = (i / waveform.length) * width;
      const amp = waveform[i] * 0.9;
      const y = (height / 2) - (amp * (height / 2));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    for (let i = waveform.length - 1; i >= 0; i -= 1) {
      const x = (i / waveform.length) * width;
      const amp = waveform[i] * 0.9;
      const y = (height / 2) + (amp * (height / 2));
      ctx.lineTo(x, y);
    }

    ctx.closePath();
    ctx.fillStyle = 'rgba(214, 84, 84, 0.22)';
    ctx.fill();
    ctx.stroke();
  }, [waveform]);

  useEffect(() => () => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    if (processedUrl) URL.revokeObjectURL(processedUrl);
  }, [sourceUrl, processedUrl]);

  const canProcess = !!sourceBuffer && !isRendering;

  const detectedPreset = useMemo(() => {
    if (!settings) return '—';
    if (settings.slowdown >= 0.78) return 'Subtle Horror';
    if (settings.slowdown >= 0.61) return 'Game Horror';
    return 'Nightmare';
  }, [settings]);

  const handleFile = async (file) => {
    if (!file || !file.name.toLowerCase().endsWith('.mp3')) {
      setStatus('Please use an .mp3 file.');
      return;
    }

    try {
      setStatus('Decoding audio…');
      setIsRendering(true);
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      const objectUrl = URL.createObjectURL(file);
      setSourceUrl(objectUrl);
      const decoded = await decodeAudioFile(file);
      setSourceBuffer(decoded);
      setWaveform(getWaveformData(decoded));
      const metrics = analyzeTrack(decoded);
      setAnalysis(metrics);
      setFileName(file.name);

      const auto = generateAutoBest(metrics, settings.style);
      setSettings((prev) => ({ ...prev, ...auto }));
      setVariants(generateVariants(metrics, settings.style));

      setStatus('Track analyzed. Auto horror profile is ready.');
      setIsRendering(false);
      setProgress(0);
    } catch (error) {
      console.error(error);
      setIsRendering(false);
      setStatus('Could not decode this MP3. Try another file.');
    }
  };

  const onDrop = (event) => {
    event.preventDefault();
    const [file] = event.dataTransfer.files;
    handleFile(file);
  };

  const processCurrentSettings = async (targetSettings = settings) => {
    if (!sourceBuffer) return;
    try {
      setIsRendering(true);
      setProgress(1);
      setStatus('Rendering horror version…');
      const rendered = await renderHorrorBuffer(sourceBuffer, targetSettings, setProgress);
      setProcessedBuffer(rendered);

      const wav = audioBufferToWavBlob(rendered);
      if (processedUrl) URL.revokeObjectURL(processedUrl);
      setProcessedUrl(URL.createObjectURL(wav));
      setAbMode('B');
      setStatus('Horror version rendered. Compare A/B and export below.');
    } catch (error) {
      console.error(error);
      setStatus('Rendering failed. Try lower distortion or re-upload.');
    } finally {
      setIsRendering(false);
    }
  };

  const runAutoBest = async () => {
    if (!analysis) return;
    const best = generateAutoBest(analysis, settings.style);
    setSettings((prev) => ({ ...prev, ...best }));
    await processCurrentSettings({ ...settings, ...best });
  };

  const runVariants = async () => {
    if (!analysis) return;
    const nextVariants = generateVariants(analysis, settings.style);
    setVariants(nextVariants);
    const top = [...nextVariants].sort((a, b) => b.score - a.score)[0];
    setSettings((prev) => ({ ...prev, ...top.settings }));
    await processCurrentSettings({ ...settings, ...top.settings });
  };

  const updateSetting = (field, value) => {
    setSettings((prev) => ({ ...prev, [field]: value }));
  };

  const updateStyle = (style) => {
    updateSetting('style', style);
    if (analysis) {
      const auto = generateAutoBest(analysis, style);
      setSettings((prev) => ({ ...prev, ...auto, style }));
      setVariants(generateVariants(analysis, style));
    }
  };

  const downloadFile = async (type) => {
    if (!processedBuffer) return;
    const blob = type === 'mp3'
      ? audioBufferToMp3Blob(processedBuffer)
      : audioBufferToWavBlob(processedBuffer);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const baseName = (fileName || 'horrorified').replace(/\.mp3$/i, '');
    a.href = url;
    a.download = `${baseName}-horror.${type}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copySettings = async () => {
    const payload = {
      fileName,
      analysis,
      settings,
      generatedAt: new Date().toISOString(),
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setStatus('Settings JSON copied to clipboard.');
  };

  return (
    <div className="page">
      <header className="hero">
        <p className="eyebrow">Horrorifier</p>
        <h1>Turn any song into horror game audio</h1>
        <p className="subtext">
          Upload an MP3, let the engine analyze it, then generate eerie, ominous, and unsettling versions with precise decimal slowdown.
        </p>
      </header>

      <main className="grid">
        <section
          className="card upload"
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
        >
          <h2>1) Upload MP3</h2>
          <label className="file-picker">
            <input
              type="file"
              accept=".mp3,audio/mpeg"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            <span>Drag & drop or click to pick .mp3</span>
          </label>
          <p className="status">{status}</p>

          {sourceBuffer && (
            <div className="track-meta">
              <p><strong>File:</strong> {fileName}</p>
              <p><strong>Duration:</strong> {formatTime(sourceBuffer.duration)}</p>
              <p><strong>BPM:</strong> {analysis?.bpm ?? 'Not detected'}</p>
              <p><strong>Key mood:</strong> {analysis?.key ?? 'Unknown'}</p>
              <p><strong>Tonal brightness:</strong> {numberFmt((analysis?.brightness ?? 0) * 100, 0)}%</p>
            </div>
          )}

          <canvas ref={waveformCanvasRef} width="900" height="180" className="wave" />
        </section>

        <section className="card">
          <h2>2) Automatic horror conversion</h2>
          <div className="stats">
            <div>
              <span>Recommended slowdown</span>
              <strong>{numberFmt(settings.slowdown)}x</strong>
            </div>
            <div>
              <span>Recommended preset</span>
              <strong>{detectedPreset}</strong>
            </div>
            <div>
              <span>Wet / Dry mix</span>
              <strong>{numberFmt(settings.wetDry * 100, 0)}% wet</strong>
            </div>
          </div>

          <p className="microcopy">
            {analysis
              ? `Why this choice: ${generateAutoBest(analysis, settings.style).rationale}`
              : 'Upload first to see why the engine selected your horror settings.'}
          </p>

          <div className="button-row">
            <button disabled={!canProcess} onClick={runAutoBest}>Auto best horror version</button>
            <button disabled={!canProcess} onClick={runVariants}>Generate 3 horror variants</button>
            <button disabled={!canProcess} onClick={() => processCurrentSettings()}>Render current controls</button>
          </div>

          {isRendering && (
            <div className="progress">
              <div style={{ width: `${progress}%` }} />
            </div>
          )}

          {variants.length > 0 && (
            <ul className="variants">
              {variants.map((variant) => (
                <li key={variant.label}>
                  <span>{variant.label}</span>
                  <code>{numberFmt(variant.settings.slowdown)}x</code>
                  <button
                    onClick={() => {
                      setSettings((prev) => ({ ...prev, ...variant.settings }));
                      processCurrentSettings({ ...settings, ...variant.settings });
                    }}
                    disabled={!canProcess}
                  >
                    Use
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card controls">
          <h2>3) Manual controls</h2>
          <div className="control-grid">
            <Slider label="Slomo multiplier" min={0.3} max={1} step={0.01} value={settings.slowdown} onChange={(v) => updateSetting('slowdown', v)} suffix="x" />
            <Slider label="Pitch shift" min={-12} max={6} step={1} value={settings.pitchShift} onChange={(v) => updateSetting('pitchShift', v)} suffix=" st" />
            <Slider label="Distortion" min={0} max={1} step={0.01} value={settings.distortion} onChange={(v) => updateSetting('distortion', v)} />
            <Slider label="Reverb" min={0} max={1} step={0.01} value={settings.reverb} onChange={(v) => updateSetting('reverb', v)} />
            <Slider label="Low-pass / muffle" min={0} max={1} step={0.01} value={settings.lowpass} onChange={(v) => updateSetting('lowpass', v)} />
            <Slider label="Detune / wow" min={-60} max={60} step={1} value={settings.detune} onChange={(v) => updateSetting('detune', v)} suffix="¢" />
            <Slider label="Ambience / noise" min={0} max={1} step={0.01} value={settings.ambience} onChange={(v) => updateSetting('ambience', v)} />
            <Slider label="Wet / dry mix" min={0.1} max={1} step={0.01} value={settings.wetDry} onChange={(v) => updateSetting('wetDry', v)} />
          </div>

          <div className="style-buttons">
            {STYLE_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={settings.style === option.value ? 'active' : ''}
                onClick={() => updateStyle(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>4) Preview and compare</h2>
          <div className="ab-toggle">
            <button className={abMode === 'A' ? 'active' : ''} onClick={() => setAbMode('A')}>A: Original</button>
            <button className={abMode === 'B' ? 'active' : ''} onClick={() => setAbMode('B')}>B: Horror</button>
          </div>

          <div className="players">
            <div>
              <h3>Original</h3>
              <audio controls src={sourceUrl || undefined} />
            </div>
            <div>
              <h3>Transformed</h3>
              <audio controls src={processedUrl || undefined} />
            </div>
          </div>

          <p className="microcopy">
            A/B quick listen: toggle above, then play the corresponding player to compare how much unease was introduced.
          </p>
        </section>

        <section className="card">
          <h2>5) Export</h2>
          <div className="button-row">
            <button disabled={!processedBuffer} onClick={() => downloadFile('wav')}>Download .wav</button>
            <button disabled={!processedBuffer} onClick={() => downloadFile('mp3')}>Download .mp3</button>
            <button disabled={!analysis} onClick={copySettings}>Copy settings JSON</button>
          </div>
          <pre className="json-preview">
            {JSON.stringify({ slowdown: settings.slowdown, preset: detectedPreset, style: settings.style }, null, 2)}
          </pre>
        </section>
      </main>
    </div>
  );
}

function Slider({ label, min, max, step, value, onChange, suffix = '' }) {
  return (
    <label className="slider">
      <span>{label}</span>
      <div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <strong>{value.toFixed(step < 1 ? 2 : 0)}{suffix}</strong>
      </div>
    </label>
  );
}

export default App;
