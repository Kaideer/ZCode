/* setting.json 按桌面应用实例分区的目录规则与首次种子复制；设计见 specs/settings-instance-isolation。 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_ZCODE_APPLICATION_NAME,
  formatLogPrefix,
  ZCODE_DESKTOP_APPLICATION_NAME_ENV,
} from "@zcode/shared";

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("settingService", process.pid), ...args);

function resolveUserHomeDir() {
  // 独立桌面 Dev 实例已设置自己的 home，设置服务却仍写真实 HOME，
  // 导致启动迁移和外观操作污染其他实例。与 Electron 的显式 home 覆盖保持一致。
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function getSettingsBaseDir() {
  return join(resolveUserHomeDir(), ".zcode", "v2");
}

/** 当前进程的桌面应用名；Main 解析后经 env 下发，缺省视为正式版（不分区）。 */
function resolveDesktopApplicationName(): string {
  return process.env[ZCODE_DESKTOP_APPLICATION_NAME_ENV]?.trim() || DEFAULT_ZCODE_APPLICATION_NAME;
}

/** 实例目录名必须是单段安全路径：含分隔符或 "."/".." 时拒绝分区，回落缺省目录。 */
function isSafeInstanceDirName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name !== "." &&
    name !== ".."
  );
}

/**
 * 设置目录：正式版（应用名 ZCode，或非法/为空）保持既有 ~/.zcode/v2，
 * 其他应用名（ZCode Dev / ZCode Preview / e2e 改名实例）分区到 ~/.zcode/v2/{应用名}/。
 */
export function getSettingsDir(): string {
  const baseDir = getSettingsBaseDir();
  const applicationName = resolveDesktopApplicationName();
  if (
    applicationName === DEFAULT_ZCODE_APPLICATION_NAME ||
    !isSafeInstanceDirName(applicationName)
  ) {
    return baseDir;
  }
  return join(baseDir, applicationName);
}

export function getSettingsFile(): string {
  return join(getSettingsDir(), "setting.json");
}

// 实例目录的种子记忆：同进程内每个目录至多种子一次，避免高频 get() 反复查种子。
const seededInstanceDirs = new Map<string, Promise<void>>();

/**
 * 实例目录首次使用时的种子：把缺省目录的 setting.json 原样复制一份，让
 * Dev/Preview 实例从正式版当前偏好起步；此后两边完全独立。只读缺省文件、
 * 只写实例文件（wx 独占创建）；任何失败都不阻塞设置读取（读取按 ENOENT
 * 回落默认值），也绝不写缺省文件。
 */
export async function seedInstanceSettingsFile(
  settingsDir: string,
  settingsFile: string,
): Promise<void> {
  const baseDir = getSettingsBaseDir();
  if (settingsDir === baseDir) return;
  const pending = seededInstanceDirs.get(settingsDir);
  if (pending) return;
  const task = (async () => {
    const defaultSettingsFile = join(baseDir, "setting.json");
    let content: string;
    try {
      content = await readFile(defaultSettingsFile, "utf-8");
    } catch {
      return; // 缺省配置尚不存在：实例从空配置起步
    }
    try {
      await mkdir(settingsDir, { recursive: true });
      await writeFile(settingsFile, content, { flag: "wx" });
      log("seeded instance settings from", defaultSettingsFile, "to", settingsFile);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "EEXIST"
      ) {
        return; // 实例文件已存在（含并发竞态）：直接沿用
      }
      log("seed instance settings skipped. error:", error);
    }
  })();
  seededInstanceDirs.set(settingsDir, task);
  await task;
}
