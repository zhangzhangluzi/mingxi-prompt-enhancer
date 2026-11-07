# 自托管部署

本项目使用 Node.js 原生 HTTP 服务，无 Docker、数据库或运行时 npm 依赖。下面的流程适用于 Debian/Ubuntu 类 Linux 服务器；路径和服务用户可按环境调整。

## 1. 准备配置

```sh
cp .env.example .env
chmod 600 .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

将生成的 64 位十六进制值写入 `STORAGE_KEY`。生产环境必须使用真实 HTTPS 域名，并保持 `HOST=127.0.0.1`。新部署将 `PASSWORD_HASH` 留空。不要把服务器登录密码或模型 API 密钥写入代码仓库。

## 2. 本机初始化与 systemd

创建低权限用户和数据目录，将 `.env` 放到仅 root 可读的位置，例如 `/etc/prompt-enhancer.env`，并将 `DATA_DIR` 指向仅服务用户可读写的目录。新实例在 Bash 中通过隐藏回显的提示输入两次密码，并以服务用户初始化：

```bash
sudo -v
(
  IFS= read -rs -p '管理员密码：' mingxi_password || exit 1
  printf '\n'
  IFS= read -rs -p '确认密码：' mingxi_confirmation || exit 1
  printf '\n'
  printf '%s\n%s\n' "$mingxi_password" "$mingxi_confirmation" |
    sudo systemd-run --quiet --wait --pipe --collect \
      -p User=prompt-enhancer -p Group=prompt-enhancer -p UMask=0077 \
      -p EnvironmentFile=/etc/prompt-enhancer.env \
      /opt/prompt-enhancer-runtime/bin/node /opt/prompt-enhancer/server.mjs --initialize
)
```

本机开发时可用 `npm start -- --initialize` 接收相同的两行标准输入。仅有旧版 `PASSWORD_HASH`、尚未创建 `auth.enc` 的实例，在本机以服务用户用同一环境运行 `server.mjs --migrate-password-hash`，该命令会保留原密码和业务文件。已有 `auth.enc` 的实例直接升级。凭据故障时恢复原 `auth.enc` 后重启服务。

复制并按实际 Node 路径修改 [`deploy/prompt-enhancer.service`](deploy/prompt-enhancer.service)，然后执行：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now prompt-enhancer
systemctl status prompt-enhancer
```

服务默认只监听回环地址 `127.0.0.1:3080`，不要直接把该端口暴露到公网。发布前先运行：

```sh
node --check server.mjs
node --check public/app.js
npm test
```

## 3. HTTPS 反向代理

将 [`deploy/Caddyfile.example`](deploy/Caddyfile.example) 中的示例域名替换为自己的域名，确认 DNS 已指向服务器，然后验证并重载 Caddy：

```sh
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

不要开启记录请求正文的调试日志。应用已经输出安全响应头，反向代理不要重复覆盖同类策略。

## 4. 首次验收

依次确认：

1. 未初始化或凭据损坏时，访问登录及业务路径返回 503，健康存活接口仍可访问。首次设置只能通过本机命令完成。
2. 初始化后未登录访问 `/app/*` 会进入 `/login`，业务 API 返回 401。
3. 登录后可读取指引、收藏和模型模块；模型配置保存后再进行固定短句连接测试。
4. 修改密码后旧密码失效，新密码可登录；退出后原会话失效。
5. 导入导出页面默认不显示 JSON，必须再次验证当前密码后才生成导出内容。
6. `GET /health/live` 返回最小存活状态，`GET /health/ready` 能读取并解密存储；监控应将 503 视为不可用。

通过 Cloudflare 巡检时，请为 HTTP 客户端设置明确的 `User-Agent`，例如 `mingxi-healthcheck/1.0`。默认 `Python-urllib` 标识可能被 Cloudflare 的浏览器完整性检查拦截并返回 HTTP 403（错误 1010）。可用回环地址复核源站的就绪状态。

## 数据与回退

`auth.enc`、`guides.enc`、`history.enc` 和 `model.enc` 位于 `DATA_DIR`，均使用 `STORAGE_KEY` 加密。升级前核对代码版本和数据文件校验值。回退到 2.2.7 或更早的版本时，应先在公网入口禁用 `/api/auth/initialize` 并验证原 `auth.enc` 可读，再切换代码。恢复需要与加密文件配套的原 `STORAGE_KEY`。

## 运行边界

单实例文件存储适用于个人或可信小组。多进程、多副本或大规模数据场景需要先设计跨进程事务和共享存储，不应直接横向扩容当前实现。
