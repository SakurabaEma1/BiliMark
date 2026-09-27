# 部署手册（照做清单）

目标：把 `server/` 跑到一台海外 VPS 上，HTTPS 对外提供，扩展切到正式地址。
预算：**约 ¥110-130/年**（VPS 促销价 + 特价域名），符合 ADR-0005 的 ≤¥200/年 上限。
备案：**不需要**（服务器与解析均在海外）。

> 为什么必须域名 + HTTPS：B 站页面是 HTTPS，浏览器禁止其向裸 IP 的 HTTP 接口发请求
> （混合内容拦截，仅 localhost 豁免）。所以 VPS 可以买最便宜的，域名不能省。

---

## 第 1 步 · 买 VPS（约 ¥80-100/年，一次性操作 10 分钟）

1. 打开 [racknerd.com](https://www.racknerd.com)（或 cloudcone.com，选促销年付即可）
2. 找 **KVM 年付促销款**：1 核 / 1GB 内存 / 10GB+ 硬盘足够（本服务空载内存 < 50MB）
3. 系统选 **Ubuntu 24.04 LTS**，机房选美西（洛杉矶）——国内延迟与可达性较好
4. 付款后记下：**IP**、**root 密码**（邮件里有）
5. 验收：`ssh root@你的IP` 能登录即 OK

备选：任何厂商的年付促销轻量云都可以，唯一硬要求是**海外（免备案）+ Ubuntu**。

## 第 2 步 · 买域名（约 ¥10-30/年，10 分钟）

1. 腾讯云/阿里云域名页搜 `.top` 特价（首年约 ¥9，续费约 ¥30）
2. 实名认证后，进 DNS 解析控制台，添加一条 **A 记录**：`@`（或 `api`）→ 你的 VPS IP
3. 验收：`ping 你的域名` 返回 VPS IP 即 OK（新域名生效几分钟到几小时）

## 第 3 步 · 服务器初始化（SSH 里照抄，约 10 分钟）

```bash
# Node 24（NodeSource 源）
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs git caddy

# 代码（本地先 git init/push 到 GitHub/Gitee，或直接 scp 上传整个仓库）
mkdir -p /opt/bilimark
# 方式 A：git clone 你的仓库地址 /opt/bilimark
# 方式 B：本地执行  scp -r F:/AI/AgentWorkspace/BilibiliPlugin root@你的IP:/opt/bilimark

cd /opt/bilimark/server
npm install
npm run build

# 防火墙放行
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
```

## 第 4 步 · systemd 常驻（服务器崩了自动拉起）

```bash
cat > /etc/systemd/system/bilimark.service << 'EOF'
[Unit]
Description=BiliMark API server
After=network.target

[Service]
WorkingDirectory=/opt/bilimark/server
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now bilimark
curl -s http://127.0.0.1:8787/api/health   # 应返回 {"ok":true,...}
```

## 第 5 步 · Caddy 自动 HTTPS（5 行配置，证书全自动续期）

```bash
cat > /etc/caddy/Caddyfile << 'EOF'
你的域名 {
    reverse_proxy 127.0.0.1:8787
}
EOF

systemctl reload caddy
```

验收：`curl https://你的域名/api/health` 返回 `{"ok":true,...}`（首次访问 Caddy 自动签发证书，可能需几秒）。

## 第 6 步 · 扩展切换到正式服务器

1. `chrome://extensions` 刷新 BiliMark
2. 扩展图标右键 → **选项**（或 popup 里进选项页）
3. 服务器地址填 `https://你的域名` → 保存 → 刷新 B 站页面
4. 验收：提交一条标记，换浏览器配置文件再打开同视频，能看到该条（说明走的是服务器数据）

---

## 数据与接管（ADR-0005）

- 备份 = `scp root@你的IP:/opt/bilimark/server/data/bilimark.db .`（单文件）
- 全量发布 = `https://你的域名/database.json`（任何人可下载重建）
- 迁移 = 新机器装好 Node + 代码，把 db 文件放回 `server/data/`，重启服务

## 后续可选

- Cloudflare 套一层 CDN（免费）：隐藏源站 IP、抗小流量攻击——域名 NS 托管到 Cloudflare 开小黄云即可，Caddy 配置不变
- Chrome Web Store 上架：开发者注册 $5 一次性，审核约数天；上架前把商店文案按 CONTEXT.md「社区提示」措辞写
