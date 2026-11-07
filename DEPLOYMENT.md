# 自托管部署

本项目使用 Node.js 原生 HTTP 服务，无 Docker、数据库或运行时 npm 依赖。下面的流程适用于 Debian/Ubuntu 类 Linux 服务器；路径和服务用户可按环境调整。

## 1. 准备配置

```sh
cp .env.example .env
chmod 600 .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

将生成的 64 位十六进制值写入 `STORAGE_KEY`。生产环境必须使用真实 HTTPS 域名，并保持 `HOST=127.0.0.1`。初始化由本机管理员完成。不要把服务器登录密码或模型 API 密钥写入代码仓库。

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

本机开发时可用 `npm start -- --initialize` 接收相同的两行标准输入。旧版实例按下文离线迁移。仅持有旧版密码散列的实例可先通过 --migrate-password-hash 创建旧凭据文件，再核验全部业务文件。

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

1. 缺少有效状态时，存活检查返回 200，就绪和业务路径返回 503。
2. 初始化后未登录访问 `/app/*` 会进入 `/login`，业务 API 返回 401。
3. 登录后可读取指引、收藏和模型模块；模型配置保存后再进行固定短句连接测试。
4. 修改密码后旧密码失效，新密码可登录；退出后原会话失效。
5. 导入导出页面默认不显示 JSON，必须再次验证当前密码后才生成导出内容。
6. `GET /health/live` 返回最小存活状态，`GET /health/ready` 能读取并解密存储；监控应将 503 视为不可用。

通过 Cloudflare 巡检时，请为 HTTP 客户端设置明确的 `User-Agent`，例如 `mingxi-healthcheck/1.0`。默认 `Python-urllib` 标识可能被 Cloudflare 的浏览器完整性检查拦截并返回 HTTP 403（错误 1010）。可用回环地址复核源站的就绪状态。

## 初始化、迁移与恢复

首次部署时，使用应用服务账号从受控终端将两行相同的密码通过标准输入传给 `node --env-file=.env server.mjs --init-state`。先设置目录归属和权限，再执行初始化。命令与正常启动使用同一份环境配置。

已有部署先停服务，再使用相同账号及环境执行 `node --env-file=.env server.mjs --migrate-state`。该命令验证 auth.enc、guides.enc、history.enc 和 model.enc 并登记原文件，沿用原密文。用 `--check-state` 确认清单和数据可读后启动服务。两条命令只输出状态及记录数。

`state.enc` 是当前数据的提交点。故障时先停写，恢复清单及其引用的准确加密文件，用 `--check-state` 验证后重新启动。初始化与迁移命令应在服务停止时执行。开放新版写入前可切回原代码及原格式，接收新写入后按当前清单恢复，降级前须离线验证数据转换。

在使用 glibc 的 Linux 上，systemd 示例设置 `MALLOC_MMAP_THRESHOLD_=131072`，让较大的分配在释放后可以及时归还系统。沿用已有单元的部署可以只给本服务添加该环境变量，凭据和模型配置继续从原环境文件读取。

`TRUST_PROXY_CLIENT=true` 仅用于回环反代已覆盖 `X-Workbench-Client` 并已校验上游来源的部署。直接运行或普通反代保持默认 false。每个可信来源独立限制登录失败次数；来源超限和密码校验过载均返回 429，并附带以秒为单位的 `Retry-After`。

## 运行边界

单实例文件存储适用于个人或可信小组。多进程、多副本或大规模数据场景需要先设计跨进程事务和共享存储，不应直接横向扩容当前实现。
