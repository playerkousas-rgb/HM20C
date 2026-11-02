// Loaded only when a QR is needed. Production's service worker precaches both
// chunks, so an installed app can generate and read them without a network.
let encoderPromise;
let decoderPromise;
export async function loadQrEncoder() {
  try {
    encoderPromise ||= import('qrcode').then((module) => module.default);
    return await encoderPromise;
  } catch {
    encoderPromise = null;
    throw new Error('QR 產生元件未能載入；請連網更新 App 後重試。');
  }
}
export async function loadQrDecoder() {
  try {
    decoderPromise ||= import('jsqr').then((module) => module.default);
    return await decoderPromise;
  } catch {
    decoderPromise = null;
    throw new Error('QR 掃描元件未能載入；請連網更新 App 後重試。');
  }
}
