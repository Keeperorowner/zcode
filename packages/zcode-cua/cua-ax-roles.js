/**
 * AX role → 元素 kind 映射与只读方法集。
 *
 * 与 helper 侧 `src/broker/presentation.ts` 同表，两侧必须一致，
 * 否则模型看到的元素 kind 会和实际可操作面脱节。
 */
export const ROLE_TO_KIND = Object.freeze({
  AXButton: "button",
  AXMenuButton: "button",
  AXPopUpButton: "popupbutton",
  AXComboBox: "combobox",
  AXTextField: "textfield",
  AXSearchField: "searchfield",
  AXSecureTextField: "securefield",
  AXTextArea: "textarea",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio",
  AXMenuItem: "menuitem",
  AXMenuBarItem: "menuitem",
  AXLink: "link",
  AXSlider: "slider",
  AXStaticText: "text",
  AXImage: "image",
  AXCell: "cell",
  AXRow: "row",
  AXTab: "tab",
});

export function roleToKind(role) {
  return ROLE_TO_KIND[role] ?? "";
}

/**
 * 只读 AX 方法集。
 *
 * 补齐原因：开源版返回 `{}`，导致 `isReadOnlyBrokerMethod` 之外的只读查询
 * 无法走软超时分支。这里把 source 上的非变更方法登记为只读 handler。
 */
export function createAxReadOnlyMethods(source, registry, options = {}) {
  const readOnly = options.readOnlyMethods ?? [
    "list_apps",
    "list_windows",
    "get_app_state",
    "query_permission_status",
  ];
  const out = {};
  for (const method of readOnly) {
    const handler = source?.[method];
    if (typeof handler !== "function") continue;
    out[method] = async (params, context) => {
      registry?.register?.(method, context);
      return await handler(params, context);
    };
  }
  return out;
}
