# 小电视避雷针（内部代号 BiliMark）

> 众包标记 B 站低质量视频（AI低创 / 标题党 / 造谣），在播放前与推荐流中**非阻断**提醒。
> 对外名称「小电视避雷针」（manifest/商店/文案用，与 SB 的「小电视空降助手」同理，不携带官方商标字样）；BiliMark 保留为内部代号。
> 设计与决策文档：[CONTEXT.md](CONTEXT.md)（术语表）、[docs/adr/](docs/adr/)（架构决策）、[docs/FEASIBILITY.md](docs/FEASIBILITY.md)（可行性分析）。

## 当前状态：Slice 3 + 治理实现完成（v0.3，未部署）

- ✅ MV3 插件骨架（content / background / popup）
- ✅ 播放页分类角标：SB 分类角标同位（标题行尾内联药丸，零推挤）；点击展开理由+证据；× 关闭
- ✅ Feed 角标：视频卡片右下角文字标签，悬浮展开详情；覆盖首页/搜索/热门与播放页右侧「相关视频」；仅展示「已确认」
- ✅ 标记提交（页面内）：标题区常驻「＋ 标记」入口 → 页面内提交面板；「造谣」强制证据链接；每人每视频一次，提交后按钮变「✓ 已标记」，面板内可撤回、撤回后可重新提交
- ✅ 轻量 API 服务器（server/，零运行时依赖，ADR-0006）：提交/投票/聚合全走真数据；服务器不可达时 ApiProvider 自动回退 Mock，本地闭环不受影响
- ✅ 投票：理由面板 👍/👎（一人一票可改票，服务器去重）
- ✅ 待同步队列：服务器不可达时提交落本地，chrome.alarms 每小时自动重试（409 视为同步完成）
- ✅ 治理（GOVERNANCE.md v0.3.1）：新手期阈值乘法器（前3条×2）、Lv6 自声明豁免、影子封禁、`X-Admin-Key` 管理端点
- ⬜ 真实 DOM 选择器校准（已埋多重候选，见「已知边界」）
- ⬜ 部署上线（DEPLOY.md 就绪，暂缓）与商店上架

## 开发

```bash
npm install          # 国内建议: npm install --registry=https://registry.npmmirror.com
npm run build        # 产物在 dist/
npm run dev          # watch 模式
```

## 安装（Chrome / Edge）

1. 打开 `chrome://extensions`（Edge: `edge://extensions`）
2. 开启右上角「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本项目的 `dist/` 目录
4. 打开任意 B 站页面（`www.bilibili.com`）

## 演示（不依赖 Mock 数据命中）

Mock 数据里的 BVID 是虚构的，不会匹配真实视频。两个演示按钮走与真实数据**完全相同**的渲染管线：

- 点浏览器工具栏的 BiliMark 图标打开 popup
- 「在本页演示『播放页提示条』」→ 标题行尾出现橙色分类角标（视频与布局零推挤；点角标展开理由浮层；× 关闭）
- 「在本页演示『feed 角标』」→ 首页/搜索页前 6 个视频卡片右下角出现粉色虚线「演示 · 3」角标（悬浮看详情）

## 目录结构

```
src/
├── manifest.json          MV3 清单
├── background.ts          待同步队列（chrome.alarms 每小时重试未同步提交）
├── core/                  领域类型 / 分类表 / MarkProvider 接口 / Api·ApiProvider·LocalProvider / Mock 实现
├── mocks/markings.json    Mock 标记数据（虚构 BVID）
├── content/
│   ├── index.ts           路由分发（SPA 感知）
│   ├── banner.ts          播放页提示条
│   ├── videoPage.ts       播放页控制器
│   ├── feedPage.ts        Feed 角标控制器
│   ├── demo.ts            演示入口
│   ├── content.css        全部样式（bmk- 前缀）
│   └── bilibili/          URL 解析 / SPA 监听 / DOM 等待
└── popup/                 Popup（演示入口）
```

## 服务器（开发）

```bash
cd server
npm install --registry=https://registry.npmmirror.com
npm run dev        # http://127.0.0.1:8787，数据在 server/data/bilimark.db
```

扩展端默认连接 `http://127.0.0.1:8787`（`src/core/api.ts` 的 `API_BASE`）；服务器未启动时自动回退 Mock，本地提交闭环与演示不受影响。

## 已知边界

1. **选择器需实测校准**：`feedPage.ts` 的 `CARD_SELECTORS` 与 `videoPage.ts` 的 `ANCHOR_CANDIDATES` 各有多重候选；B 站改版时更新这两张表即可。
2. Mock 数据的 BVID 是虚构的，不会命中真实视频——用 popup 演示按钮验证 UI。
3. 分类角标采用自愈式挂载：优先内联标题文字行尾（零推挤），并在挂载后 2 秒内持续监测（100/400/1000/2000ms 四个检查点）——B 站标题的行数钳制是异步生效的，无论何时生效都会自动回退到「标题下方独立一行」→「标题容器上方」，最终停在可见档位。长标题下角标可能独占一行，属预期。
4. 动态页（/dyn）暂不注入角标。
5. 合规基线已内置：全部 UI 文案为「社区标记」中性措辞 + 免责声明（见 CONTEXT.md「社区提示」「非阻断原则」）。
