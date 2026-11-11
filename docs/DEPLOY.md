# Cloudflare 部署手册

本手册按新域名 `example.com`、客户入口 `inbox.example.com` 举例；上线时全部替换为真实域名。需要 Cloudflare 账号、可管理 DNS 的域名和部署权限。本仓库没有生产密钥，也没有自动操作任何 Cloudflare 账号。

## 0. 上线前决定

1. 使用一个**专用收信域名**。若现有域名已经有企业邮箱，直接启用 Email Routing 可能改变 MX 并影响原邮箱，先换一个域名或规划专用域名。
2. 确定客户入口域名，例如 `inbox.example.com`。客户看到的邮箱地址是 `mb-...@example.com`，网页登录域名与收信域名可以不同。
3. 确定 `expiresAt` 来源：平台订单中的用餐日期和你希望保留的时长。由订单系统传入精确、带时区的到期时间。
4. 确认谁接收管理员密钥。密钥只给后端服务，不能进入浏览器、小程序前端、飞书记录或代码仓库。

## 1. 准备本地工具

Node.js 20+，然后在项目目录执行：

```bash
npm install
npm test
npx wrangler login
```

`npm install` 会生成锁文件；部署前应提交锁文件，以固定依赖版本。安装和登录会访问外部服务，需要在你有网络和账号权限的环境执行。

本地运行 `wrangler dev` 时，可复制 `.dev.vars.example` 为 `.dev.vars` 并填入两个本地随机密钥，同时把 `wrangler.jsonc` 的 `MAIL_DOMAIN` 和 D1 ID 配好。`.dev.vars` 已加入 `.gitignore`；本地模拟通过不能替代真实邮件投递测试。

## 2. 创建 Cloudflare 资源

把域名加入 Cloudflare 并按提示将域名的权威 DNS 指向 Cloudflare。然后：

```bash
npx wrangler d1 create pokemon-mailbox
npx wrangler r2 bucket create pokemon-mailbox-raw
```

记下 D1 返回的 `database_id`。编辑 `wrangler.jsonc`：

- `MAIL_DOMAIN` 改成真实收信域名，如 `example.com`，不要带 `@`。
- `d1_databases[0].database_id` 改成真实 D1 ID。
- 若 R2 桶采用其他名称，同步修改 `bucket_name`。
- `MAX_MESSAGE_BYTES` 默认 1 MiB，`MAX_MESSAGES_PER_MAILBOX` 默认 50；应按真实确认信大小调整，但不要无上限放开。
- `PURGE_GRACE_HOURS` 默认 48。到期访问立即失效；这个值只控制物理清理前的宽限。

初次部署前应用数据库迁移：

```bash
npx wrangler d1 migrations apply pokemon-mailbox --remote
```

迁移到生产 D1 前，先检查目标数据库名称和账号；已经有生产数据时先备份。不要在生产库上使用 `--local`。

## 3. 创建密钥并部署 Worker

分别设置两个**不同**的随机密钥：

```bash
openssl rand -base64 48 | npx wrangler secret put ADMIN_API_KEY
openssl rand -base64 48 | npx wrangler secret put AUTH_PEPPER
npm run deploy
```

`ADMIN_API_KEY` 用于后台管理 API；`AUTH_PEPPER` 用于客户密码与会话令牌的 HMAC 摘要。保存在安全的密钥管理系统中，不能丢失：更换 `AUTH_PEPPER` 会使旧客户密码和会话失效。首次部署后访问 `/health` 应返回 `{ "ok": true }`。`/health` 只证明 Worker 已运行，不证明邮件路由已生效。

## 4. 配置收信与客户入口

在 Cloudflare 控制台启用该域名的 Email Routing，让它设置入站 MX。打开 Email Routing 的路由配置，把 **Catch-all 的动作指向刚部署的 Worker**。不需要按客户建立规则；未知地址由 Worker 拒收。

在 Worker 的 Domains & Routes 中为客户入口绑定自定义域名 `inbox.example.com`，启用 HTTPS。首次联调可使用 `*.workers.dev` 地址，但正式交付建议使用固定自有域名。检查浏览器登录后的 Cookie 带 `Secure`、`HttpOnly` 和 `SameSite=Strict`。

正式切到自定义域名后，可把 `wrangler.jsonc` 的 `workers_dev` 改为 `false` 并重新部署，避免同时存在两个客户入口。Worker 也会把非本地 HTTP 请求重定向到 HTTPS。

Cloudflare 的界面名称可能更新；关键结果是：`example.com` 的 MX 指向 Cloudflare，Catch-all 的目标是本 Worker，`https://inbox.example.com/` 能打开本项目收件箱。

## 5. 线上最小验收

按顺序完成以下验证；不建议只看部署成功提示就交付客户：

1. 用管理 API 创建一条测试订单的邮箱，记录返回的 `id` 和 `address`。
2. 从外部真实邮箱向该地址发送邮件。管理 API 的 `messages` 应能看到它，R2 应出现对应 `.eml` 对象。
3. 向一个从未创建的地址发信，应被拒收；向已停用的地址也应被拒收。
4. 用宝可梦预约站做一次受控测试，确认验证码邮件确实发到新域名，且 `code?since=...` 在预约有效时间内返回正确码。
5. 完成一笔测试预约，确认官方确认邮件在客户页面可读、发件人与预约番号正确，原始 `.eml` 可下载。
6. 签发密码、客户网页登录，再停用邮箱；旧密码和已有会话都应立即失败。
7. 测试过期时间到达后，即使 Cron 还未运行，登录、读信和新收信也立即失败。随后确认 Cron 清理 D1/R2。
8. 使用两条测试订单互相访问邮件 ID，应返回 404，不得串箱。

其中第 4、5 项依赖宝可梦站点真实邮件，目前本地测试不能替代。若自有域名被对方拒绝或邮件延迟过高，应在接入正式订单前停下排查。

## 6. 发布与回退

代码更新先运行 `npm test` 和 `npm run check`，再部署 Worker。数据库迁移应向前兼容，先备份、再迁移、最后部署代码。出现问题时可在 Cloudflare Worker 部署历史中回退代码；**回退代码不会自动回退 D1 结构和已收邮件**。不要删除 R2 桶或 D1 库作为普通回退手段。

参阅：[Cloudflare Email Service](https://developers.cloudflare.com/email-service/)、[Email Routing 限制](https://developers.cloudflare.com/email-service/platform/limits/)、[Workers 部署](https://developers.cloudflare.com/workers/get-started/guide/)。
