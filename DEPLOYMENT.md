# 自托管部署

本项目使用 Node.js 原生 HTTP 服务，无 Docker、数据库或运行时 npm 依赖。下面的流程适用于 Debian/Ubuntu 类 Linux 服务器；路径和服务用户可按环境调整。

## 1. 准备配置

```sh
cp .env.example .env
chmod 600 .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

将生成的 64 位十六进制值写入 `STORAGE_KEY`。生产环境必须使用真实 HTTPS 域名，并保持 `HOST=127.0.0.1`。首次启动时保持 `PASSWORD_HASH` 为空，由 `/setup` 页面设置管理员密码。不要把服务器登录密码或模型 API 密钥写入代码仓库。

## 2. systemd

创建低权限用户和数据目录，将 `.env` 放到仅 root 可读的位置，例如 `/etc/prompt-enhancer.env`，并将 `DATA_DIR` 指向仅服务用户可读写的目录。复制并按实际 Node 路径修改 [`deploy/prompt-enhancer.service`](deploy/prompt-enhancer.service)，然后执行：

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

1. 未初始化时访问任意业务路径会进入 `/setup`。
2. 初始化后未登录访问 `/app/*` 会进入 `/login`，业务 API 返回 401。
3. 登录后可读取指引、收藏和模型模块；模型配置保存后再进行固定短句连接测试。
4. 修改密码后旧密码失效，新密码可登录；退出后原会话失效。
5. 导入导出页面默认不显示 JSON，必须再次验证当前密码后才生成导出内容。
6. `GET /health/live` 返回最小存活状态，`GET /health/ready` 能读取并解密存储；监控应将 503 视为不可用。

通过 Cloudflare 巡检时，请为 HTTP 客户端设置明确的 `User-Agent`，例如 `mingxi-healthcheck/1.0`。默认 `Python-urllib` 标识可能被 Cloudflare 的浏览器完整性检查拦截并返回 HTTP 403（错误 1010）。可用回环地址复核源站的就绪状态。

## 数据与回退

`auth.enc`、`guides.enc`、`history.enc` 和 `model.enc` 位于 `DATA_DIR`，均使用 `STORAGE_KEY` 加密。升级前保存代码版本和数据文件校验值；回退时只替换经过验证的代码版本，不覆盖环境文件和数据目录。更换 `STORAGE_KEY` 会使既有数据无法解密。

## 运行边界

单实例文件存储适用于个人或可信小组。多进程、多副本或大规模数据场景需要先设计跨进程事务和共享存储，不应直接横向扩容当前实现。
