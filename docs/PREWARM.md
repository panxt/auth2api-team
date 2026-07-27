# 窗口暖机(Prewarm)配置与生效说明

> 面向部署 / 运维(含安装 agent)。**不要靠猜** —— 本文是暖机的唯一权威配置说明。

## 1. 它解决什么

Anthropic 订阅账号的限流是 **5 小时滚动窗口 + 首条消息锚定**:窗口从当天第一条请求那一刻开始计时,5 小时后重置、可再开一个新窗口。若不主动锚定,窗口起点取决于当天第一个真实请求几点到,边界随机、常浪费上班前额度。

**暖机** = 每天固定时刻自动给每个账号发一条最便宜的 ping(Haiku,`max_tokens=1`,成本≈0)主动开窗,让工作时段尽量跨满 2 个完整 5h 窗口。

## 2. 配置项(唯一入口:设置页,或 config.yaml 种子)

| 字段 | 含义 | 默认 |
|---|---|---|
| `enabled` | 总开关 | `true` |
| `times` | 触发时刻列表,`"HH:MM"`(24h),每个每天触发一次 | `["08:00"]` |
| `timezone` | **`times` 按哪个时区解释**(IANA,如 `Asia/Shanghai`);**留空 = 服务器本地时区** | `""` |
| `providers` | 只暖这些 provider;**空 = 所有支持暖机的 provider** | `[]` |

**配置优先级(后者覆盖前者)**:内置默认 `<` `config.yaml` 的 `prewarm:` 段 `<` 页面(SettingsStore)保存的值。**页面改动即时热生效,无需重启。**

### 2a. 页面配置(推荐)
`设置 → 窗口暖机`:勾选启用 → 填「时区」(下拉可搜,建议 `Asia/Shanghai`)→ 加时间点(如 `08:00`、`13:00`)→ 保存。旁边有「立即暖机一次」可手动验证。

### 2b. config.yaml 种子(可选)
```yaml
prewarm:
  enabled: true
  timezone: "Asia/Shanghai"
  times: ["08:00", "13:00"]
  providers: []        # 空=全部
```
> 注意:config.yaml 只是**初始种子**;一旦在页面保存过,页面值(SettingsStore)优先。要以文件为准就别在页面改。

### 2c. 命令行(等价于页面保存)
```bash
curl -X PUT http://<host>/admin/prewarm/config \
  -H "Authorization: Bearer <admin-key>" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"timezone":"Asia/Shanghai","times":["08:00","13:00"]}'
```

## 3. 触发语义(重要:按时区 + 过点补跑)

- **按 `timezone` 判定钟点**:设 `Asia/Shanghai` + `08:00` → **上海时间 08:00** 触发,与服务器操作系统时区无关。留空才用服务器本地时区。
- **过点补跑,不漏跑**:调度每 30s tick 一次;触发条件是「**当天已到点且今天还没跑过**」的最晚时刻——即使定时器迟到、事件循环卡顿、进程刚重启,只要过了点当天没跑过,就会**补上一次**(可能稍晚),不会永久漏。
- **每时刻每天只跑一次**;已触发记录**落库**,重启不会重复也不会因重启丢失。
- 账号处于 cooldown / 已禁用会自动跳过;失败不影响其他账号。

## 4. 推荐配置

- **最省心**:`enabled + timezone=Asia/Shanghai + times=["08:00"]` —— 上班前开第一个窗口,13:00 自动重置开第二个。
- **严格双窗**:再加 `13:00`,保证第二个窗口也准点锚定(否则第二窗口要等 13:00 后第一个真实请求才开)。
- 周末也建议开,避免周一冷启动。

## 5. 如何确认生效(验证清单)

1. **看配置**:`GET /admin/prewarm/config` 返回的 `enabled/times/timezone` 是否符合预期。
2. **手动跑一次**:设置页「立即暖机一次」或 `POST /admin/prewarm` → 看返回 `ok/total`(成功/尝试账号数)。
3. **看历史**:设置页暖机历史 或 `GET /admin/prewarm/history` —— 每条含:
   - `scheduledTime`:满足的计划时刻(手动为 null);
   - `at`:**实际执行时间(UTC ISO)**;
   - `ok/total` + 每账号结果。
   用它核对「计划 08:00(上海)」是否真的在对应 UTC 时刻(上海 08:00 = 00:00 UTC)跑了。
4. **时区自检**:若历史里 `scheduledTime` 与 `at` 折算后对不上你的预期,基本就是 `timezone` 没设对(设成 `Asia/Shanghai`)。

## 6. 常见「漏跑 / 不对点」原因

| 现象 | 原因 | 处理 |
|---|---|---|
| 早上没暖、晚上才跑 | `timezone` 留空且服务器 OS 时区不是北京(如 UTC-7) | 设 `timezone=Asia/Shanghai` |
| 某些时刻从不触发 | 旧版(< v2.6.0)用"精确整分匹配"、无补跑,高负载/重启就丢 | 升级到 ≥ v2.6.0(过点补跑) |
| 完全不跑 | `enabled=false` 或 `times` 为空 | 页面启用并加时间点 |
| ok=0 | 账号全在 cooldown / 需重新认证 | 账号页看健康、重新认证 |

## 7. 端点一览(admin)

- `GET  /admin/prewarm/config` —— 读当前配置
- `PUT  /admin/prewarm/config` —— 改配置(热生效;非法 `HH:MM` / 非法时区返回 400)
- `POST /admin/prewarm` —— 立即手动暖机一次
- `GET  /admin/prewarm/history?limit=N` —— 运行历史(计划 vs 实际)
