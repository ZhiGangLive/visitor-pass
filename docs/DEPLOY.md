# 部署指南

## 先选形态

| 形态 | 适用 | 需要什么 |
|---|---|---|
| 单机试用 | 一台电脑，自己看效果 | Node 16+ |
| 局域网正式 | 一栋楼，员工 + 保安日常使用 | 一台常开的电脑 / 小主机 + 固定内网 IP |
| 反代 + HTTPS | 需要用剪贴板、手机访问体验好 | 域名 + Caddy/Nginx |

这套系统**不需要**数据库、不需要 Docker、不需要外网。

---

## 一、Windows（最常见）

### 1. 装 Node

到 <https://nodejs.org/> 下载 LTS 版，一路下一步。装完打开 cmd 验证：

```bat
node -v
```

### 2. 放代码

建议放固定路径，例如 `D:\visitor-pass`。**不要放在桌面或下载目录**，否则清理时容易误删数据。

### 3. 先手动跑一次

```bat
cd /d D:\visitor-pass
node server.js
```

浏览器打开 `http://127.0.0.1:8080`，能登录就说明没问题。按 `Ctrl+C` 停掉。

### 4. 注册成 Windows 服务（关窗口不停服）

用 [NSSM](https://nssm.cc/download)：

```bat
nssm install VisitorPass "C:\Program Files\nodejs\node.exe" "D:\visitor-pass\server.js"
nssm set VisitorPass AppDirectory D:\visitor-pass
nssm set VisitorPass AppStdout D:\visitor-pass\logs\out.log
nssm set VisitorPass AppStderr D:\visitor-pass\logs\err.log
nssm set VisitorPass Start SERVICE_AUTO_START
nssm start VisitorPass
```

验证：

```bat
nssm status VisitorPass
curl http://127.0.0.1:8080/api/health
```

### 5. 放行防火墙

```bat
netsh advfirewall firewall add rule name="VisitorPass 8080" dir=in action=allow protocol=TCP localport=8080
```

### 6. 固定内网 IP

在路由器上给这台机器绑定 MAC，或在网卡里设静态 IP。否则重启后 IP 变了，员工存的地址就失效了。

启动时控制台会打印可用地址，例如 `http://192.168.1.10:8080/`，把它发给员工即可。

---

## 二、Linux

```bash
# 代码放到 /opt/visitor-pass
sudo mkdir -p /opt/visitor-pass
sudo chown -R $USER:$USER /opt/visitor-pass

# systemd
sudo tee /etc/systemd/system/visitor-pass.service > /dev/null <<'EOF'
[Unit]
Description=Visitor Pass
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/visitor-pass
ExecStart=/usr/bin/node server.js
Environment=PORT=8080
Environment=HOST=0.0.0.0
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now visitor-pass
sudo systemctl status visitor-pass
```

---

## 三、HTTPS（推荐，剪贴板需要）

浏览器只在**安全上下文**开放剪贴板写入。用局域网 IP + http 访问时，「复制图片」会被拦，只能走「右键复制图像」的兜底。

### 用 Caddy（最省事，自动签证书）

```caddyfile
pass.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
caddy run --config Caddyfile
```

### 用 Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name pass.example.com;

    ssl_certificate     /etc/ssl/pass.crt;
    ssl_certificate_key /etc/ssl/pass.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

服务端已经会读 `X-Forwarded-For`，日志里的 IP 不会全变成 `127.0.0.1`。

### 上 HTTPS 后记得加 Secure 标记

改 `lib/auth.js` 第 179 行附近：

```js
'; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=' + maxAge;
```

不加也能用，但 Cookie 会以明文走内网。

---

## 四、数据备份与迁移

**全部数据就是一个文件：** `data/db.json`

```bash
# 备份
cp data/db.json /backup/visitor-$(date +%F).json

# 迁移到新机器
# 1. 停旧服务  2. 拷贝整个 data/ 目录  3. 启新服务
```

系统自带的保护：

- 写入用「先写 `.tmp` 再原子改名」，断电不会写出半个文件
- 每天第一次写入时自动备份到 `data/backups/db-YYYY-MM-DD.json`，保留 7 天
- 解析失败会把坏文件改名成 `db.json.broken-<时间>` 并起空库，服务不会起不来

**建议再加一层异地备份**：把这台机器的 `data/` 目录同步到 NAS 或另一台电脑。访客台账是行政和安监都要查的东西，丢一次很麻烦。

### 把数据放到独立磁盘

默认数据在代码目录下的 `data/`。如果代码装在系统盘、数据想放数据盘：

```bash
# Linux / macOS
DATA_DIR=/data/visitor-pass node server.js

# Windows（服务方式）
nssm set VisitorPass AppEnvironmentExtra DATA_DIR=D:\visitor-data
```

`DATA_DIR` 支持绝对路径，也支持相对当前工作目录的路径。多个实例共用一个二进制时，用它隔离各自的数据。

---

## 五、升级

```bash
# 1. 备份数据
cp data/db.json ../db.json.bak

# 2. 替换代码（保留 data/ 目录！）
# 3. 重启服务
sudo systemctl restart visitor-pass
```

**不要覆盖 `data/`。** 那是全部业务数据。

---

## 六、容量

- 单进程，Node 单线程，设计场景是「一栋楼、日均几百访客」
- 核验日志上限 3 万条、操作日志上限 5000 条，超出自动淘汰最旧的
- 日均几百条，十年约几十 MB

要接多进程或上百万条：把 `lib/store.js` 换成 SQLite，业务代码一行不用改（接口是 `table()` / `commit()`）。

---

## 七、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `EADDRINUSE` | 8080 被占 | `netstat -ano \| findstr :8080` 找到 PID，或改 `PORT=8081` |
| 别人打不开，本机能开 | 防火墙 / 不在同一网段 | 放行入站端口；确认在同一局域网 |
| 登录提示「密码错误次数过多」 | 触发了 5 次锁 5 分钟 | 等 5 分钟，或重启服务（内存计数会清空） |
| 复制图片没反应 | 非安全上下文 | 用 localhost 或配 HTTPS；或点「下载 PNG」 |
| 时间显示不对 | 服务器时区不是东八区 | Windows 设时区；Linux `timedatectl set-timezone Asia/Shanghai` |
| 门岗端空白 | 未登录或没有 `guard.verify` 权限 | 用保安账号登录；检查角色权限 |
| 服务重启后数据没了 | `data/` 被删或在别的目录启动 | 确认工作目录是代码根目录 |
