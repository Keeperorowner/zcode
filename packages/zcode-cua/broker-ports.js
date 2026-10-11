export function isCuaPermissionStatusAvailable(result) {
  return Boolean(result) && typeof result === "object" && result.available === true;
}

/**
 * 是否需要跑一次屏幕捕获探针。
 *
 * 补齐原因：开源版桩恒返回 false，导致 screenCaptureProbeOk 永不刷新，
 * 权限面板会一直停在「屏幕录制未知」而不去实测。
 *
 * 判据：调用方明确要求探测（`probeScreenCapture !== false`），且当前
 * screenRecording 不是已确认 granted——已授权就没必要反复打探针。
 */
export function shouldRunCuaScreenCaptureProbe(state, options = {}) {
  if (options.probeScreenCapture === false) return false;
  if (state === undefined || state === null) return true;
  return state !== "granted";
}
