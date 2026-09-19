# GitHub 公开发布清单

## 发布前

- [ ] `git status` 只包含预期源码、文档和工作流。
- [ ] 执行 `rg` 检查服务器地址、密码、Cookie、API 密钥、私钥、导出 JSON 和加密存储文件。
- [ ] `node --check server.mjs`、`node --check public/app.js` 和 `npm test` 全部通过。
- [ ] 确认 `.env`、`.private/`、`DATA_DIR` 和发布归档未被 Git 跟踪。
- [ ] 检查 README、部署示例和版本号，不包含真实生产域名或内部运维记录。

## 建议发布步骤

```sh
git add .
git diff --cached --check
git commit -m "chore: prepare public release"
git tag -a v2.2.5 -m "Public release 2.2.5"
git remote add origin <your-public-repository-url>
git push -u origin main --follow-tags
```

如果远程仓库已经存在，请先核对远程地址和默认分支，再执行推送。公开仓库创建后，启用 Actions，确认两种 Node.js 版本的测试均通过，再在 GitHub Releases 中引用对应 tag。

## 发布后

- [ ] GitHub 仓库可见性、分支保护和 Actions 权限符合预期。
- [ ] 使用全新临时 `DATA_DIR` 完成初始化、登录、增强、收藏、模型配置及导入导出验收。
- [ ] 生产部署只使用服务器环境文件，不把生产配置、加密数据或导出 JSON 放入仓库。
