# Pokemon Cafe 客户专属邮箱服务

面向 `pengbin1/pokemon_cafe` 的独立收信服务。它为一个订单生成一个独立邮箱地址，让抢票程序读取宝可梦咖啡厅发来的邮件验证码，并让客户在用餐前登录网页收件箱查看实际收到的确认邮件。到期后服务端立即阻止登录和收信，随后清理邮件。

> 当前状态：代码和本地自动化测试已完成；**尚未部署到 Cloudflare，也尚未用真实宝可梦邮件验证投递**。需要域名、Cloudflare 账号权限和真实订单接点才能完成线上验收。不要把本项目的测试结果当作线上收信成功证明。

## 客户需要做什么

客户在原业务平台填写预约姓名即可。后台自动创建邮箱地址，抢票程序读取验证码。预约成功后，平台把 `https://inbox.你的域名`、邮箱地址和系统生成的密码交给客户。客户到店时登录查看确认信；不需要自行注册邮箱、设置密码、提供个人邮箱或协助收验证码。

## 功能范围

- 一条 Cloudflare Email Routing Catch-all 规则接收整个域名，Worker 只接受已创建且未过期的地址；无需为每个客户创建 Cloudflare 路由规则。
- 按 `externalId`（订单 ID）幂等创建独立邮箱；默认最多保留 90 天。
- 保存每封邮件的原始 RFC 822/MIME 数据到 R2；D1 保存邮箱、邮件索引和会话。
- 后台通过密钥查询最近 24 小时内、发件人为 `info@mail-pokemon-cafe.jp` 的验证码。
- 预约成功后才签发客户密码；重复签发会使旧密码和旧会话失效。
- 客户网页登录、查看邮件文本与发件信息、下载原始 `.eml` 文件。
- 登录和收信请求实时检查 `expiresAt`；Cron 清理过期邮箱、会话和 R2 原文。
- 客户收件箱之间隔离；登录错误次数限制；邮件正文作为纯文本显示，避免邮件 HTML 执行脚本。

## 不在本项目内

- 退票、换票、抢位逻辑及宝可梦站点的验证码/风控处理。
- SMTP 发信、回复邮件、IMAP/POP3 登录和第三方邮箱 App 接入。客户登录的是本项目提供的网页收件箱。
- 自动判断现场人员是否接受自建网页展示；须进行真实业务验收。

## 技术结构

```text
客户订单 ──创建邮箱──► 管理 API ──► D1 邮箱记录
                                  │
宝可梦官方邮件 ──MX──► Email Routing Catch-all ──► Email Worker
                                                   ├─► D1 邮件索引
                                                   └─► R2 原始 .eml
抢票程序 ──管理 API──► 最近验证码
客户 ──邮箱+密码──► 网页收件箱 ──► 确认邮件
Cron ──到期清理──► D1 / R2
```

代码入口为 `src/index.js`，数据库定义在 `migrations/0001_initial.sql`。

## 文档导航

- [架构与生命周期](docs/ARCHITECTURE.md)
- [Cloudflare 部署步骤](docs/DEPLOY.md)
- [管理 API 与客户接口](docs/API.md)
- [与 pokemon_cafe 集成](docs/INTEGRATION.md)
- [运维、成本及验收](docs/OPERATIONS.md)
- [安全与数据处理](docs/SECURITY.md)

## 本地验证

需要 Node.js 20 及以上版本。

```bash
cd /Users/wp/WebProject/pokemon_mailbox_service
npm test
npm run check
```

部署命令需要先完成 [部署文档](docs/DEPLOY.md) 中的 Cloudflare 资源创建和配置。`wrangler.jsonc` 中的 `MAIL_DOMAIN`、D1 `database_id` 都是待填写项，不能直接作为生产配置使用。
