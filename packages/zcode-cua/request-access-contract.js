export const CUA_REQUEST_ACCESS_STATUS_META_KEY = "zcode.cua/request-access-status-v1";

const ACCESSIBILITY_STATES = new Set(["granted", "stale", "denied"]);
const SCREEN_RECORDING_STATES = new Set(["unknown", "granted", "denied"]);

function failure(message) {
  return { success: false, error: new Error(message) };
}

/**
 * request_access 结果的状态 schema。
 *
 * 补齐原因：开源版桩的 `safeParse` 恒返回失败，导致 request_access 的授权快照
 * 无法被持久化/回读，桌面侧每次都当「从未请求过权限」重新走引导流程。
 * 字段集对齐 .d.ts 的 `CuaRequestAccessStatus`，缺字段即判失败，不静默补默认值
 * （补默认值会把「权限被拒」伪装成「未知」，引导逻辑会走错分支）。
 */
export const cuaRequestAccessStatusSchema = {
  safeParse(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return failure("request access status must be an object");
    }
    const record = input;

    if (record.schemaVersion !== 1) {
      return failure(`unsupported schemaVersion: ${String(record.schemaVersion)}`);
    }
    if (record.platform !== "darwin") {
      return failure(`unsupported platform: ${String(record.platform)}`);
    }
    if (typeof record.grantOwner !== "string" || !record.grantOwner.trim()) {
      return failure("grantOwner must be a non-empty string");
    }
    if (typeof record.accessibility !== "string" || !ACCESSIBILITY_STATES.has(record.accessibility)) {
      return failure(`invalid accessibility state: ${String(record.accessibility)}`);
    }
    if (
      typeof record.screenRecording !== "string" ||
      !SCREEN_RECORDING_STATES.has(record.screenRecording)
    ) {
      return failure(`invalid screenRecording state: ${String(record.screenRecording)}`);
    }

    return {
      success: true,
      data: {
        schemaVersion: 1,
        platform: "darwin",
        grantOwner: record.grantOwner.trim(),
        accessibility: record.accessibility,
        screenRecording: record.screenRecording,
      },
    };
  },
};
