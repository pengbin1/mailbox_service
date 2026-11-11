# 与 `pengbin1/pokemon_cafe` 的接入方式

目标仓库在当前工作区为 `/Users/wp/WebProject/pokemon_cafe`。本项目是独立服务，尚未修改该抢票仓库；先部署并验证收信，再接入真实预约，避免同时改变两个系统而无法判断故障来源。

## 现有接点

当前东京与大阪流程在锁到座位后调用 `get_one_email_163()`，从池里取 `phone_number`、`email`、`password`、`code`，然后 `update_customer_info()` 提交信息、`validate_auth_code()` 用 `email_163.get_email_yzm()` 通过 IMAP 读取验证码。成功结果还把邮箱密码和 IMAP 授权码写入记录。相关代码位置：

- 东京：`reserve_yh.py` 的 `_run_booking()`，约 1165–1235 行。
- 大阪：`osaka_yh.py` 的 `_run_booking()`，约 1017–1085 行。
- 邮箱池：`settings_mongo_new.py` 的 `get_one_email_163()`。
- 验证码：`email_163.py` 的 `get_email_yzm()`。

这些行号基于 2026-11-11 工作区版本，更新代码后请按函数名定位。

## 建议的数据流

1. 客户在原平台提交姓名和目标用餐日期时，业务后台生成稳定的 `order_id`，调用 `POST /api/admin/mailboxes` 创建专属地址，保存 `mailbox_id` 与地址到订单记录。`expiresAt` 由用餐日期加你确定的保留时间计算，必须带时区。
2. 指定抢票任务携带 `order_id`、客户姓名和 `mailbox_id`。选中该任务时，姓名与邮箱必须来自**同一订单**，不能只换姓名、邮箱仍从公共 163 池随机抽取。
3. 在提交 `update_customer_info()` 前记录 `verification_since = 当前时间`。提交后轮询 `GET /api/admin/mailboxes/{id}/code?since=...`，取返回的验证码提交给原 `validate_auth_code` 后半段。
4. 预约成功并拿到 `reservation_id` 后，调用 `POST /credentials`，把客户邮箱地址、密码和收件箱网址安全地放到该客户的订单交付页。不要把管理员 API 密钥或客户密码写入普通日志、飞书表或库存接口。
5. 预约失败、订单撤销或邮箱不再需要时调用 `/disable`；预约成功则由邮箱服务按 `expiresAt` 自动失效。退换票不在本阶段实现。

邮箱服务**不生成手机号**。当前预约接口的 `phone_number` 来源于原 163 邮箱池；切换为专属邮箱后，预约层需要明确从哪里获得手机号，不能假设新邮箱记录里自带手机号。

## Python 调用示例

可参考本项目的 `examples/pokemon_client.py`。以下代码只说明调用顺序，不直接修改现有抢票逻辑：

```python
from datetime import datetime, timedelta, timezone
from pokemon_client import MailboxClient

client = MailboxClient(service_url, admin_key)
jst = timezone(timedelta(hours=9))
expires_at = datetime(2026, 12, 1, 12, 0, tzinfo=jst)
mailbox = client.create(order_id, expires_at)

# 提交预约信息之前记录时间，稍后避免读到旧验证码。
since = datetime.now(timezone.utc)
# update_customer_info(..., mailbox["address"], ...)
code_result = client.verification_code(mailbox["id"], since)
# validate_auth_code(..., code_result["code"], ...)

# 仅在确认预约成功后：
customer_access = client.issue_credentials(mailbox["id"])
# 把 customer_access 安全交付到该客户订单页。
```

实际流程应在验证码尚未到达的 `404` 上短间隔重试，设置总超时并记录没有敏感数据的错误。创建接口按订单 ID 幂等，但**签发密码接口不是幂等的**；重复签发会让前一次交付的密码失效。

## 接入时的回归检查

- 指定任务没有 `mailbox_id` 时应拒绝进入专属流程，不要悄悄回退到随机邮箱。
- 同一订单重复调度时使用同一邮箱；不同订单不能共享邮箱。
- 客户姓名、预约邮箱、订单 ID 和最终 `reservation_id` 保持一一关联。
- 只有收到验证码且提交通过后才继续预约确认；验证码查询的 `since` 是本次尝试的起点。
- 预约成功邮件确实进入同一个邮箱，客户登录能看到预约号与正确姓名。
- 新旧邮箱渠道同时存在期间，日志和库存接口不能泄露任一渠道的密码或授权码。
