# AGENTS.md — BiliMark（哔哩标记）代理交接文档

> 给下一个接手的 agent：这是一份"从零到能干活"的压缩包。按顺序读完本文 + 四份文档，你就能安全改代码。

## 项目是什么

面向 B 站网页端的浏览器插件（MV3）+ 配套社区服务：**众包标记低质量视频**（AI低创/标题党/造谣），在标题区用非阻断角标提醒，减少给低创贡献播放量。灵感来自 BilibiliSponsorBlock（https://github.com/hanydd/BilibiliSponsorBlock ，**本项目全部文档中的"SB"均指此项目**），但标注对象是**实体级信誉**（视频/UP主）而非时间片段——这是与 SB 的本质区别，所有设计都由此展开。

当前状态（2026-09）：**Slice 3 + 治理实现完成（v0.3）**——提交闭环（常驻入口→页面内面板→撤回重提）、本地+服务器双管线、投票状态机（待确认→已确认≥3→驳回≤-2）、治理落地（新手期×2 / Lv6 自声明豁免 / 影子封禁 / `X-Admin-Key` 管理端点，见 GOVERNANCE.md v0.3.1）、待同步队列（chrome.alarms 每小时重试，409 视为完成）。对外名称**「小电视避雷针」**（manifest/商店/文案用，与 SB 的「小电视空降助手」同理避商标），BiliMark 保留为内部代号。**未部署**（用户暂缓花钱，DEPLOY.md 就绪待执行）、未上架商店。唯一用户 = 项目作者本人。

## 必读文档（按此顺序）

1. **CONTEXT.md** — 领域术语表（30+ 词条）。所有命名、UI 文案、概念歧义先查这里；改概念必须同步改这里（改代码顺手改，不要批量攒）。
2. **docs/adr/** — 7 条架构决策，**每条都含被否决的选项**——重新提案前先确认不是已被否决的东西（例：确认卡、全宽浮层、播放器角落浮标、强制绑定 B 站身份、连续信誉分、行为指纹，全部已否决）。
3. **docs/GOVERNANCE.md** — 治理规则唯一权威口径（信任根/新手期/等级豁免/影子封禁/执行时点）。
4. **docs/FEASIBILITY.md** — 可行性判定、风险 Top3、二期路线图、实现期待定项（阈值数值等）。
5. **DEPLOY.md** — 部署照做清单（买 VPS→域名→Caddy→systemd→扩展切换）。用户决定暂缓执行。

## 架构速览

```
src/                    扩展（TypeScript + webpack，MV3）
  content/              页面注入
    mount.ts            ★ 自愈式挂载核心（三档位+持续监测）——见下方血泪教训
    banner.ts           分类角标（标题行尾内联药丸）+ 理由面板（body 顶层 portal）+ 👍/👎
    entry.ts            常驻「＋标记/✓已标记」入口（与角标共用 mount.ts）
    submissionPanel.ts  提交/管理面板（POST 服务器，失败落本地；撤回）
    feedPage.ts         feed 角标（首页/搜索/热门/播放页右侧栏，仅「已确认」）
    videoPage.ts        播放页控制器（token 防竞态）
    bilibili/           URL 解析/SPA 监听/DOM 等待
  core/                 types（分类表）/ provider 接口 / api（API_BASE+POST）/ apiProvider /
                        mockProvider / localProvider（本地待确认合并）/ submissions（chrome.storage）/ privateId
  popup/ options/       弹窗（演示入口）/ 设置页（API_BASE 可配置）
server/                 零依赖微服务（node:http + Node24 内置 node:sqlite，单文件 src/index.ts）
                        端点：GET /api/markings、POST /api/markings、POST /api/vote、GET /database.json、GET /api/health
                        状态机阈值写死为常量（确认≥3/驳回≤-2），属调优待定项
```

**数据链**：`LocalMarkProvider(ApiProvider(mockProvider))` —— 服务器优先，不可达回退 Mock；本地提交以「待确认」对本人可见（与服务器数据按分类去重，不重复叠加）。

## 开发命令

```bash
# 扩展（产物 dist/，chrome://extensions 加载已解压扩展）
npm install --registry=https://registry.npmmirror.com
npm run build        # 或 npm run dev（watch）

# 服务器（http://127.0.0.1:8787，数据 server/data/bilimark.db）
cd server && npm install --registry=https://registry.npmmirror.com && npm run dev

# 服务器冒烟测试（POST→投票→GET 回读验证状态机）见 git 历史或重写：
# health → POST marking → POST vote×2 → GET markings 应为 confirmed(net=3)
```

扩展默认连 `http://127.0.0.1:8787`（选项页可改，storage.sync 持久化）。

## 血泪教训（改代码前必读，每条都是真实事故）

1. **mount.ts 自愈挂载三原则**：① 初始挂载不走 detached 检查（元素未入 DOM 时 `isConnected` 必为 false，误判成"已销毁"会导致角标永不出现）；② detached ≠ 用户销毁——B 站首屏水合会清掉标题区子树，非 stopped 的脱离要重挂当前档位自愈；③ 升级档位必须双帧确认（120ms 复测），单帧测量会被面板关闭/布局过渡骗到，且档位只升不降、错误就此凝固。
2. **挂载点查找必须排除自家元素**（`:scope > span:not([class*="bmk-"])`）——我们的角标本身就是 span，不加排除会互相吞进肚子里（用户截图实锤过两种包含方向）。
3. **同容器排序 `orderSiblings`** 保证两角标左右顺序跨刷新确定（入口在前、分类角标在后）；入口挂载前要等标题文本 span 出现（水合完成标志，waitForPredicate 1s 超时），否则早挂进 h1 裸文本态会导致首帧与后续位置不一致。
4. **转录不可信时直读磁盘**：本会话多次出现工具结果渲染失真（假构建输出、假路径拼写）。Edit 的 old_string 必须来自 Bash cat/grep 的磁盘真实内容，不要凭记忆写。
5. **长文件一次写一个、成稿再落盘**：历史上三次"多草稿拼接"事故（内容混杂无法编译），全部靠删掉重写解决。写大文件时不在同一条消息里并行写多个。
6. **Windows 沙盒**：/tmp 不跨 Bash 调用持久（用工作区路径）；`taskkill /IM node.exe` 会误杀机器上全部 node 进程（教训：用 PID 定点杀）；npm 直连官方源极慢，一律加 `--registry=https://registry.npmmirror.com`。
7. **合规红线**（CONTEXT.md「社区提示」「非阻断原则」）：对外文案只能说「社区标记」+免责声明，禁用"拉黑/曝光"；一切页面内提示不遮画面、不推挤内容、可关闭；鉴政区永不启用（分区隔离墙）。

## 当前已知问题（用户确认不影响使用，暂挂待反馈）

- UI 存在少量小问题（用户原话"还存在一些小问题，不过不是特别影响使用"——未具体化，下次用户反馈时逐条定位）

## 方向与下一步

- **部署**：用户暂缓花钱；DEPLOY.md 全套就绪，执行即上线（含 options 页切换 API_BASE）
- **阈值调优**：确认≥3/驳回≤-2 用真实数据校准
- **商店上架**（被部署阻塞）：以对外名「小电视避雷针」上架，文案按「社区提示」措辞、隐私政策页、开发者账号 $5
