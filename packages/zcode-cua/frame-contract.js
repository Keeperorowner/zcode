export const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "zcode.cua/official-frame-integrity-v1";

export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION = "official_cua_frame_v1";

export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;

/** 官方 CUA 的 image_ref 文本块：`{"image_ref":{"frame_id":...,"authority":...}}`。 */
const IMAGE_REF_PREFIX = '{"image_ref"';

function readTextBlock(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.text === "string") return value.text;
  return undefined;
}

/**
 * 补齐原因：开源版把这组 frame 完整性判别全部写成 `return false/undefined`，
 * 结果官方 CUA 的 frame/image_ref 配对与内容保护标记全部失效——
 * 模型拿到的截图帧无法绑定 state_id，也无法验证是否被替换。
 * 这里按 computer-use-client.mjs 记录的真实形态实现：
 * `frame_id` 不在收据顶层，而在图片**相邻**的 `image_ref` 文本块里。
 */
export function isOfficialCuaImageRefText(text) {
  const value = readTextBlock(text);
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.startsWith(IMAGE_REF_PREFIX) && parseOfficialCuaImageRef(trimmed) !== undefined;
}

export function containsOfficialCuaImageRefCredentialText(text) {
  const value = readTextBlock(text);
  if (typeof value !== "string") return false;
  // 凭据形态的 image_ref：带 authority 且含签名/密钥类字段名。
  if (!isOfficialCuaImageRefText(value)) return false;
  return /"(authority|signature|digest|credential)"/i.test(value);
}

export function containsImageRefAuthority(text) {
  const parsed = parseOfficialCuaImageRef(text);
  return typeof parsed?.authority === "string" && parsed.authority.length > 0;
}

export function parseOfficialCuaImageRef(text) {
  const value = readTextBlock(text);
  if (typeof value !== "string") return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    return undefined;
  }
  const ref = parsed?.image_ref;
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return undefined;
  const authority = typeof ref.authority === "string" ? ref.authority : undefined;
  if (!authority) return undefined;
  return { authority, frame_id: typeof ref.frame_id === "string" ? ref.frame_id : undefined };
}

export function readRasterEnvelopeIdentity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const envelope = input.envelope ?? input.rasterEnvelope ?? input;
  const algorithm = envelope?.algorithm ?? envelope?.alg ?? envelope?.hashAlgorithm;
  return typeof algorithm === "string" && algorithm.trim() ? { algorithm: algorithm.trim() } : undefined;
}

/**
 * 在 content 数组里找出「image + 其相邻 image_ref」这一对。
 *
 * 官方 CUA 把 frame_id 放在 image_ref 文本块里（见 computer-use-client.mjs 的
 * frameIdOf）；这里返回二者的下标，供上层做帧绑定与完整性证明。
 */
export function findOfficialCuaFrameContentPair(content) {
  if (!Array.isArray(content)) return undefined;
  for (let imageIndex = 0; imageIndex < content.length; imageIndex += 1) {
    const image = content[imageIndex];
    if (!isImageBlock(image)) continue;
    // image_ref 紧邻 image（前一格或后一格）；官方产物是后者。
    for (const imageRefIndex of [imageIndex + 1, imageIndex - 1]) {
      if (imageRefIndex < 0 || imageRefIndex >= content.length) continue;
      const imageRef = content[imageRefIndex];
      if (!isOfficialCuaImageRefText(imageRef)) continue;
      return { image, imageRef, imageRefIndex, imageIndex };
    }
  }
  return undefined;
}

function isImageBlock(value) {
  return Boolean(value) && typeof value === "object" && typeof value.type === "string" && value.type === "image";
}

/**
 * 给一段 content 打上官方 CUA frame 的内容保护证明。
 *
 * 只在 content 确实含合规 image/image_ref 对时才出具，否则返回 undefined——
 * 缺帧时开证明等于把「无截图」盖章成「官方帧」，会让完整性校验形同虚设。
 */
export function attestOfficialCuaFrameContent(content, expectedKind = OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION) {
  const pair = findOfficialCuaFrameContentPair(content);
  if (!pair) return undefined;
  return { kind: expectedKind, imageIndex: pair.imageIndex, imageRefIndex: pair.imageRefIndex };
}

export async function preserveOfficialCuaFrameResult(result) {
  // 透传但保留 frame 完整性标记：结果可能已被上游剥离 image_ref，
  // 这里不改写 content，只保证调用方拿到同一对象引用（可对比）。
  return result;
}
