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

# 启动应用
npm start
```

### 项目结构

```
WalkingJourney/
├── main.js                 # Electron 主进程（窗口管理、IPC、OTA）
├── preload.js              # 预加载脚本（安全上下文桥接）
├── renderer/
│   ├── index.html          # 主界面
│   ├── renderer.js         # 前端逻辑（Three.js 3D、轨迹、UI）
│   └── styles.css          # 样式
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