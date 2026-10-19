import { describe, expect, it } from "vitest";
import { createComputerUseRuntime } from "../index.js";
import { callBrokerMethod } from "../broker.js";

// 本文件原为「占位包」断言：要求实现体对一切调用返回不可用。
// 本仓库已还原 Computer Use 的真实实现（broker IPC 客户端 + 工具派发），
// 因此断言随之改为钉住还原后的契约：
//   1. 未知工具名必须在触达 broker 之前就被拒绝（不产生任何系统副作用）；
//   2. 已知工具名必须真正进入 broker 准备流程；
//   3. broker 调用失败必须是具体的连接/协议错误，而不是笼统的 unavailable。
describe("Computer Use runtime", () => {
  it("未知工具名直接拒绝，且不触发真实 broker 准备", async () => {
    let prepared = false;
    const runtime = createComputerUseRuntime({
      ensureBrokerAvailable: async () => {
        prepared = true;
      },
    });
    await expect(
      runtime.execute({
        toolName: "computer_use",
        arguments: {},
        context: { sessionId: "example", runtimeScope: "main", workspaceKey: "example" },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(prepared).toBe(false);
    await runtime.dispose();
  });

  it("已知工具名进入 broker 准备流程", async () => {
    let prepared = false;
    const runtime = createComputerUseRuntime({
      ensureBrokerAvailable: async () => {
        prepared = true;
      },
    });
    await runtime.execute({
      toolName: "list_apps",
      arguments: {},
      context: { sessionId: "example", runtimeScope: "main", workspaceKey: "example" },
    });
    expect(prepared).toBe(true);
    await runtime.dispose();
  });

  it("broker 调用失败返回具体连接错误，而非笼统不可用", async () => {
    await expect(
      callBrokerMethod({ method: "example", socketPath: "unused" }),
    ).rejects.toMatchObject({ code: "connect_failed" });
  });

  it("缺少 socketPath 时按参数错误拒绝", async () => {
    await expect(callBrokerMethod({ method: "example", socketPath: "" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });
});
