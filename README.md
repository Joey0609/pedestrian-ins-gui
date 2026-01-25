# WalkingJourney 多设备惯导控制系统

本项目是一个基于 Electron 的多目标惯性导航设备管理与可视化平台，支持多设备连接、数据解码、3D 可视化与轨迹分析。

## 目录结构

```
.
├── main.js                # Electron 主进程入口
├── preload.js             # 预加载脚本
├── renderer/
│   ├── index.html         # 主界面 HTML
│   ├── renderer.js        # 前端主逻辑
│   └── styles.css         # 样式文件
├── src/
│   ├── imupage.html       # 设备详情页
│   └── wsManager.js       # WebSocket 管理
├── package.json
└── ...
```

## 启动方式

1. **安装依赖**

   在项目根目录下执行：

   ```sh
   npm install
   ```

2. **开发模式启动**

   ```sh
   npm start
   ```

   或者（如果没有 `start` 脚本）：

   ```sh
   npx electron .
   ```

3. **访问界面**

   启动后会自动弹出主界面窗口。

## 打包为桌面应用

1. **安装 Electron 打包工具**

   推荐使用 [electron-builder](https://www.electron.build/)：

   ```sh
   npm install electron-builder --save-dev
   ```

2. **打包应用**

   生成可分发的安装包：

   ```sh
   electron-packager . WalkingJourney --platform=win32 --arch=x64 --overwrite --ignore="^/\.vscode($|/)" --ignore="^/\.gitignore$" --ignore="^/README\\.md$"--extra-resource=assets/models/PCBmodel.obj
   ```