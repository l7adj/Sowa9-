const canVibrate = typeof navigator !== 'undefined' && 'vibrate' in navigator;
let audioCtx = null;

function ensureAudio() {
  if (!audioCtx && typeof window !== 'undefined') {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}

export function hapticLight() {
  if (!canVibrate) return;
  try { navigator.vibrate(5); } catch {}
}

export function hapticMedium() {
  if (!canVibrate) return;
  try { navigator.vibrate(10); } catch {}
}

export function hapticHeavy() {
  if (!canVibrate) return;
  try { navigator.vibrate([15, 30, 15]); } catch {}
}

export function hapticSuccess() {
  if (!canVibrate) return;
  try { navigator.vibrate([10, 50, 10]); } catch {}
}

export function hapticError() {
  if (!canVibrate) return;
  try { navigator.vibrate([20, 40, 20, 40, 20]); } catch {}
}

export function soundClick() {
  try {
    ensureAudio();
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 800;
    gain.gain.setValueAtTime(0.02, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.05);
  } catch {}
}

export function soundSuccess() {
  try {
    ensureAudio();
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 600;
    gain.gain.setValueAtTime(0.03, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(900, audioCtx.currentTime + 0.1);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.15);
  } catch {}
}
