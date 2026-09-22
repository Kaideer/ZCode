# Settings 按桌面应用实例分区 SPEC

状态：已确认设计，实施中
触发问题：正式版 ZCode 与本仓库开发实例（ZCode Dev）并行运行时共用 `~/.zcode/v2/setting.json`；settings 写入是「读取 → schema 解析 → 整文件重写」，旧版本进程不认识新 schema 的键（Zod object 默认 strip 未知键），任何一次旧进程的设置写入都会把新实例刚写入的键（如 `responseReview*`）从磁盘上抹掉，表现为设置页「审核模型不展示当前选择的模型」且审核开关被静默关闭。

## 1. 行为

设置文件的位置由「桌面应用名」决定，应用名是进程级身份，由 Main 统一解析：

```
应用名 = env ZCODE_DESKTOP_APPLICATION_NAME（显式覆盖，供 e2e 使用）
       ?? 开发态（未打包）"ZCode Dev"
       ?? 打包 Preview "ZCode Preview"
       ?? 正式版 "ZCode"
```

- 应用名为缺省 `ZCode`（或为空 / 非法，见 §4）：设置目录保持 `~/.zcode/v2`，**正式版读写路径与现状完全一致，零变化**。
- 其他应用名（`ZCode Dev`、`ZCode Preview`、e2e 改名实例）：设置目录为 `~/.zcode/v2/{应用名}/`。
- 首次使用实例目录时做一次**种子复制**：若实例 `setting.json` 不存在且缺省目录 `~/.zcode/v2/setting.json` 存在，则把缺省文件原样复制一份到实例目录（`wx` 独占创建）。种子只读缺省文件、只写实例文件，绝不写缺省文件。此后两边完全独立，互不重写。
- Preview 打包版从「与正式版共享 setting.json」变为「首次种子后独立」。这是有意变更：preview 与正式版同样存在新旧 schema 互相 strip 的问题；种子保证 preview 用户从正式版当前值平滑起步，任务、凭据等其他数据仍共享。

## 2. 状态所有者与传递路径

| 状态               | 唯一所有者                                                                                                                          | 说明                                                                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 应用名身份         | Desktop Main `desktopApplicationNameEnv.ensureDesktopApplicationNameEnv`（`desktopRuntimeEnv.runtimeApplicationName` 固化其结果）   | env 显式覆盖 → 开发态 ZCode Dev → 打包 Preview → 正式版 ZCode；幂等回写 `process.env.ZCODE_DESKTOP_APPLICATION_NAME`，早期 bootstrap、main 进程内 services、host / cron scheduler host 在任何导入顺序下拿到同一身份；`buildHostProcessEnv` 再显式下发（sanitize 之后注入） |
| 设置目录规则与种子 | services `settingsInstanceDir`（`getSettingsDir` / `getSettingsFile` / `seedInstanceSettingsFile`，经 `@zcode/services/node` 公开） | 每次读写动态解析（与现有 HOME 动态解析保持一致）；种子按目录幂等记忆，每进程至多一次                                                                                                                                                                                       |
| 设置文件内容       | `settingService`（不变）                                                                                                            | 读写、校验、原子写语义不变，只是定位到实例目录                                                                                                                                                                                                                             |

main 进程里绕过 settingService 直接读 setting.json 的三个早期引导（`desktopDataBaseDirBootstrap`、`desktopChromiumHardwareAccelerationBootstrap`、`main/index.ts` 启动工作区解析的 `settingsFile`）统一改走 `getSettingsFile()`，读取前先调用 `ensureDesktopApplicationNameEnv()`。

```
Main 解析应用名 ──env──▶ host / scheduler host / main 进程内 services
                                │
                                ▼
                 settingService.getSettingsDir()
                 ├── "ZCode"（或缺省/非法） → ~/.zcode/v2            （正式版，现状不变）
                 └── 其他应用名          → ~/.zcode/v2/{应用名}/     （首次种子自 ~/.zcode/v2/setting.json）
```

## 3. 接口

- shared（`env.ts`）新增两个常量，desktop 与 services 共用，避免字面量漂移：
  - `ZCODE_DESKTOP_APPLICATION_NAME_ENV = "ZCODE_DESKTOP_APPLICATION_NAME"`
  - `DEFAULT_ZCODE_APPLICATION_NAME = "ZCode"`（「不分区」哨兵，同时是打包正式版应用名）
- services `getSettingsDir()` 签名与可见性不变（模块内函数）；分区逻辑对 `ISettingService` 的调用方完全透明。

## 4. 失败语义与不变量

- 实例名非法（含路径分隔符、`"."`、`".."`、空）：拒绝分区，回落缺省目录并 `log` 提示；不抛错、不阻塞设置读写。
- 种子复制任何失败（缺省文件不存在、写失败、`EEXIST` 竞态）：静默/记日志跳过，读取路径按既有 ENOENT 语义回落默认值；绝不向上抛。
- 不影响范围：`ZCODE_DATA_BASE_DIR` 数据根迁移、credentials（`getAppConfigDir`）、任务库、`~/.zcode/cli` 会话库等均不分区；`copyDataDirectory` 排除 setting.json 的既有约定不变。
- 跨实例零写：实例进程对缺省目录只存在种子阶段的只读操作。

## 5. 验收场景

1. 正式版（应用名 `ZCode`，env 未设）：`get/update` 读写 `~/.zcode/v2/setting.json`，路径与改动前完全一致。
2. ZCode Dev 首次启动：生成 `~/.zcode/v2/ZCode Dev/setting.json`，内容为当时缺省文件的逐字节副本；缺省文件不被修改。
3. ZCode Dev 后续 `update` 只改实例文件；缺省文件内容与 mtime 不变；两实例并行运行时新 schema 键各自保留，不再被对方 strip。
4. 实例目录已有 `setting.json`（含损坏文件）：直接沿用，种子跳过（`wx` EEXIST / 已有文件）。
5. 应用名非法（如 `../evil`）：回落缺省目录，行为同正式版。
6. 实例首次运行、种子尚未发生时，main 早期引导（dataBaseDir / 硬件加速 / 启动工作区）读到实例文件不存在，按各自缺省值继续；首次 settings 读取种子完成后，后续启动读到实例文件。
