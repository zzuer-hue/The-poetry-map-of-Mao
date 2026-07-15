# 毛主席诗词全景地图 · 编年史特展

一张地图纵览毛主席 65 首诗词创作足迹，跨越 1910—1976 六十六年峥嵘岁月的沉浸式编年史特展。

## 功能亮点

- 🗺️ **交互式中国地图**：ECharts 实现点位标注、缩放漫游，点击诗词节点弹出赏析
- 📜 **编年史时间线**：底部滑块拖拽穿越六十六年，自动播放时空巡游
- 🎓 **诗词闯关**：年份/地点/背景三种题型，阅读门槛机制，连对计分
- ✨ **毛体金句墙**：瀑布流展示经典名句，点击跳转原诗
- 📊 **阅读足迹**：统计已读数量、时代分布、省份覆盖
- 🚩 **长征专题**：十八首长征组诗专项巡展
- 🔊 **朗读音频**：每首诗词配独立朗读 MP3，进度条同步
- 📸 **全景海报**：html2canvas 生成分享海报，二维码自动适配部署 URL

## 项目结构

```
诗词路线图6.0/
├── index.html          # 主页面入口
├── maoti.ttf           # 毛体字库（标题装饰）
├── poemkai.ttf         # 楷体字库（诗词原文）
├── css/
│   └── style.css       # 全部样式
├── js/
│   ├── data.js         # 诗词数据（标题/年份/地点/原文/背景/音频路径）
│   ├── map.js          # ECharts 地图初始化与交互
│   ├── app.js          # 主逻辑（弹窗/朗读/收藏/海报/分享）
│   └── particle.js     # Three.js 3D 粒子背景
├── audio/              # 朗读音频（MP3 128kbps）
├── video/              # 先导转场视频 + 弹窗背景视频
├── images/
│   ├── card-bg/        # 卡片背景图（50 张，JPG 压缩）
│   ├── og-share.jpg    # 社交分享预览图
│   └── favicon.svg     # 站点图标
├── lib/
│   └── echarts.min.js  # ECharts 本地兜底
└── data/
    └── china.json      # 中国地图 GeoJSON 本地兜底
```

## 本地预览

需通过 HTTP 服务器访问（fetch 在 file:// 下无法工作）：

```powershell
# 方式一：Node.js
node -e "require('http').createServer((req,res)=>{const f='.'+req.url;require('fs').readFile(f,(e,d)=>{res.writeHead(e?404:200);res.end(e?'404':d)})}).listen(5500)"

# 方式二：Python
python -m http.server 5500
```

浏览器打开 http://127.0.0.1:5500/

## 部署到 GitHub Pages

1. 在 GitHub 创建 **Public** 仓库（如 `poetry-map`）
2. 初始化并推送代码：
   ```powershell
   git init
   git add -A
   git commit -m "毛主席诗词全景地图编年史特展"
   git branch -M main
   git remote add origin https://github.com/你的用户名/poetry-map.git
   git push -u origin main
   ```
3. 仓库 **Settings → Pages → Branch** 选 `main` → Save
4. 等待 1-2 分钟，访问 `https://你的用户名.github.io/poetry-map/`

## 技术栈

- ECharts 5.5（交互地图 + GeoJSON）
- Three.js（3D 粒子星空背景）
- html2canvas（海报生成）
- 原生 JavaScript（无框架依赖）
