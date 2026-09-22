import {
  DEFAULT_ZCODE_APPLICATION_NAME,
  ZCODE_DESKTOP_APPLICATION_NAME_ENV,
  ZCODE_PRODUCT_FLAVOR,
} from "@zcode/shared";
import { isElectronAppPackaged } from "./desktopElectronApp.js";

/**
 * 桌面应用名身份解析的唯一所有者：env 显式覆盖（e2e 隔离）→ 开发态 ZCode Dev
 * → 打包 Preview → 正式版 ZCode。幂等回写 process.env，让 main 早期 bootstrap、
 * 进程内 services（setting.json 按应用实例分区，动态读 env）以及 host/scheduler
 * 等继承进程在任何导入顺序下都拿到同一身份；desktopRuntimeEnv 与各早期
 * bootstrap 都从这里取值，不在各自模块重复推导。
 */
export function ensureDesktopApplicationNameEnv(): string {
  const explicit = process.env[ZCODE_DESKTOP_APPLICATION_NAME_ENV]?.trim();
  if (explicit) {
    process.env[ZCODE_DESKTOP_APPLICATION_NAME_ENV] = explicit;
    return explicit;
  }
  const resolved = isElectronAppPackaged()
    ? ZCODE_PRODUCT_FLAVOR === "preview"
      ? "ZCode Preview"
      : DEFAULT_ZCODE_APPLICATION_NAME
    : "ZCode Dev";
  process.env[ZCODE_DESKTOP_APPLICATION_NAME_ENV] = resolved;
  return resolved;
}
