# WalkingJourney — 多设备惯导控制系统
中文 | [English](README.en.md)

**WalkingJourney（行迹）** 是一个基于 Electron 的多目标惯性导航设备管理与可视化平台。支持多设备 WebSocket / 串口连接、IMU 数据实时解码、3D 姿态可视化、轨迹绘制与回放、固件在线升级（OTA）等功能。

## 功能特性

- **多设备管理** — 同时连接数十台 IMU 设备（WiFi / 串口）
- **实时数据** — 加速度、陀螺仪、四元数、欧拉角、卡尔曼位移等
- **3D 可视化** — 基于 Three.js 的设备姿态 3D 渲染
- **轨迹绘制** — 多设备实时轨迹追踪与历史回放
- **数据录制** — 原始数据录制与导出
- **在线升级** — 固件 OTA 批量升级
- **IMU 详情页** — 单设备 uPlot 图表、参数配置

## 快速开始

### 环境要求

- Node.js 18+
- npm 9+

### 安装 & 运行

```bash
# 克隆仓库
git clone https://github.com/Joey0609/WalkingJourney.git
cd WalkingJourney

# 安装依赖
npm install

# 启动应用（开发模式）
npm start
```

Windows 下也可以直接双击 **`run-dev.bat`**：自动检查 Node.js、缺依赖时自动安装（走国内镜像）、清掉可能干扰的 `ELECTRON_RUN_AS_NODE`，然后以开发模式启动，不产出安装包。

### 构建

```bash
# NSIS 安装包 → dist-installer/行迹 Setup <版本>.exe
npm run dist

# 免安装版 → dist-installer/win-unpacked/（直接双击 行迹.exe）
# 与安装包同一次 npm run dist 产出
```

国内网络下 Electron 与打包工具的资源默认从 GitHub 下载，容易超时，先设置镜像：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_CUSTOM_DIR='{{ version }}'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm install
npm run dist
```

`npm run pack`（electron-packager）是旧流程，在部分 Windows 环境会静默失败，建议统一使用 `npm run dist`。
`npm run release` 会在打包后把产物发布到 GitHub Release（需要 `GH_TOKEN`）。

### 常见问题

- **`npm : 无法加载文件 …npm.ps1`**：PowerShell 执行策略限制，改用 `npm.cmd run dist`。
- **`node-gyp failed to rebuild @serialport/bindings-cpp`**：`serialport` 自带 N-API 预编译二进制，无需重编；`package.json` 的 `build.npmRebuild` 已设为 `false`。
- **应用启动后立刻退出，日志出现 `bad option`**：环境变量里存在 `ELECTRON_RUN_AS_NODE=1`（Electron 会退化成纯 Node 运行），先执行 `$env:ELECTRON_RUN_AS_NODE=$null`。
- **首次运行被 SmartScreen 拦截**：安装包未做代码签名，选择「更多信息 → 仍要运行」。

### 项目结构

```
WalkingJourney/
├── main.js                 # Electron 主进程入口（窗口、IPC、更新、OTA 注册）
├── main/                   # 主进程模块（window / updates / device-ipc / calibration / ota）
├── preload.js              # 预加载脚本（安全上下文桥接）
├── renderer/
│   ├── index.html          # 主界面
│   ├── renderer.js         # 前端组合根
│   ├── theme.css           # 主题令牌（浅色 / 深色，两层令牌体系）
│   ├── theme.js            # 主题服务（跟随系统 / 浅色 / 深色）
│   ├── styles.css          # 样式
│   └── …                   # 设备、轨迹、OTA、扫描等视图模块
├── src/
│   ├── imupage.html        # 设备 IMU 详情页（uPlot 图表）
│   ├── imuDataProcessor.js # IMU 数据解码模块
│   ├── wsManager.js        # WebSocket / 串口连接管理
│   ├── uplot.js            # uPlot 图表库
│   └── uplot.css           # uPlot 样式
└── assets/
    └── models/
        ├── PCBmodel.obj    # 3D PCB 模型
        └── PCBmodel.mtl    # 模型材质
```