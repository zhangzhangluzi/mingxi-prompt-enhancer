# 贡献指南

## 开发环境

- Node.js 22 或更高版本；
- 无需安装运行时依赖；
- 复制 `.env.example` 为 `.env`，仅本地开发时可使用 `ALLOW_INSECURE_LOCAL=true`。

## 提交前检查

```sh
node --check server.mjs
node --check public/app.js
npm test
```

提交前请确认没有加入 `.env`、`.private/`、导出 JSON、加密存储文件、服务器凭据或真实模型密钥。功能修改应补充对应的边界测试，并说明浏览器端的实际交互验证结果。
