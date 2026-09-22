import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_ZCODE_APPLICATION_NAME, ZCODE_DESKTOP_APPLICATION_NAME_ENV } from "@zcode/shared";
import { createSettingService } from "../src/setting/settingService.js";

// Settings 按桌面应用实例分区的行为测试（specs/settings-instance-isolation）：
// 正式版路径零变化；非默认应用名使用 ~/.zcode/v2/{应用名}/ 并从缺省文件种子复制；
// 非法应用名回落缺省目录；实例写入绝不回写缺省文件。

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function makeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "zcode-settings-instance-"));
}

async function writeDefaultSettings(home: string, content: string): Promise<void> {
  const dir = join(home, ".zcode", "v2");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "setting.json"), content);
}

async function withInstanceEnv(
  home: string,
  applicationName: string | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const previousHome = process.env.ZCODE_DESKTOP_HOME_DIR;
  const previousName = process.env[ZCODE_DESKTOP_APPLICATION_NAME_ENV];
  process.env.ZCODE_DESKTOP_HOME_DIR = home;
  if (applicationName === undefined) {
    delete process.env[ZCODE_DESKTOP_APPLICATION_NAME_ENV];
  } else {
    process.env[ZCODE_DESKTOP_APPLICATION_NAME_ENV] = applicationName;
  }
  try {
    await run();
  } finally {
    if (previousHome === undefined) {
      delete process.env.ZCODE_DESKTOP_HOME_DIR;
    } else {
      process.env.ZCODE_DESKTOP_HOME_DIR = previousHome;
    }
    if (previousName === undefined) {
      delete process.env[ZCODE_DESKTOP_APPLICATION_NAME_ENV];
    } else {
      process.env[ZCODE_DESKTOP_APPLICATION_NAME_ENV] = previousName;
    }
  }
}

test("默认应用名保持既有 ~/.zcode/v2 路径，不产生实例目录", async () => {
  const home = await makeHome();
  await writeDefaultSettings(home, JSON.stringify({ locale: "zh-CN" }));
  try {
    await withInstanceEnv(home, undefined, async () => {
      const service = createSettingService();
      const settings = await service.get();
      assert.equal(settings.locale, "zh-CN");
      await service.update({ memoryEnabled: true });

      const persisted = JSON.parse(
        await readFile(join(home, ".zcode", "v2", "setting.json"), "utf-8"),
      );
      assert.equal(persisted.memoryEnabled, true);
      assert.equal(await pathExists(join(home, ".zcode", "v2", "ZCode Dev")), false);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("非默认应用名分区到实例目录并从缺省文件种子复制，实例写入不回写缺省文件", async () => {
  const home = await makeHome();
  const defaultContent = JSON.stringify({ locale: "zh-CN", memoryEnabled: true });
  await writeDefaultSettings(home, defaultContent);
  const defaultFile = join(home, ".zcode", "v2", "setting.json");
  const instanceFile = join(home, ".zcode", "v2", "ZCode Dev", "setting.json");
  try {
    await withInstanceEnv(home, "ZCode Dev", async () => {
      const service = createSettingService();
      const seeded = await service.get();
      assert.equal(seeded.memoryEnabled, true);

      assert.equal(await pathExists(instanceFile), true);
      assert.equal(await readFile(defaultFile, "utf-8"), defaultContent);

      await service.update({ memoryEnabled: false });
      const instancePersisted = JSON.parse(await readFile(instanceFile, "utf-8"));
      assert.equal(instancePersisted.memoryEnabled, false);
      // 实例写入后缺省文件逐字节不变：两实例从此互不重写。
      assert.equal(await readFile(defaultFile, "utf-8"), defaultContent);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("实例目录已有 setting.json 时直接沿用，不用缺省文件覆盖", async () => {
  const home = await makeHome();
  await writeDefaultSettings(home, JSON.stringify({ locale: "zh-CN" }));
  const instanceFile = join(home, ".zcode", "v2", "ZCode Dev", "setting.json");
  await mkdir(join(home, ".zcode", "v2", "ZCode Dev"), { recursive: true });
  await writeFile(instanceFile, JSON.stringify({ locale: "en-US" }));
  try {
    await withInstanceEnv(home, "ZCode Dev", async () => {
      const service = createSettingService();
      const settings = await service.get();
      assert.equal(settings.locale, "en-US");
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("缺省文件不存在时实例从空配置起步", async () => {
  const home = await makeHome();
  const instanceFile = join(home, ".zcode", "v2", "ZCode Dev", "setting.json");
  try {
    await withInstanceEnv(home, "ZCode Dev", async () => {
      const service = createSettingService();
      const settings = await service.get();
      // 空配置起步：读到的是 schema 默认值（memoryEnabled 默认 false）。
      assert.equal(settings.memoryEnabled, false);
      await service.update({ memoryEnabled: true });
      const persisted = JSON.parse(await readFile(instanceFile, "utf-8"));
      assert.equal(persisted.memoryEnabled, true);
      assert.equal(await pathExists(join(home, ".zcode", "v2", "setting.json")), false);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("非法应用名（路径穿越）回落缺省目录", async () => {
  const home = await makeHome();
  await writeDefaultSettings(home, JSON.stringify({ locale: "zh-CN" }));
  try {
    await withInstanceEnv(home, "../evil", async () => {
      const service = createSettingService();
      await service.update({ memoryEnabled: true });
      const persisted = JSON.parse(
        await readFile(join(home, ".zcode", "v2", "setting.json"), "utf-8"),
      );
      assert.equal(persisted.memoryEnabled, true);
      assert.equal(await pathExists(join(home, ".zcode", "evil")), false);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("显式设置为正式版应用名时不分区", async () => {
  const home = await makeHome();
  await writeDefaultSettings(home, JSON.stringify({ locale: "zh-CN" }));
  try {
    await withInstanceEnv(home, DEFAULT_ZCODE_APPLICATION_NAME, async () => {
      const service = createSettingService();
      await service.update({ memoryEnabled: true });
      const persisted = JSON.parse(
        await readFile(join(home, ".zcode", "v2", "setting.json"), "utf-8"),
      );
      assert.equal(persisted.memoryEnabled, true);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
