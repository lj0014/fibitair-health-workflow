# 个人健康 MCP：搭建与维护

本方案大部分借鉴 [JojenJ/fibitair-health-workflow](https://github.com/JojenJ/fibitair-health-workflow)，基于其 Google Health → Cloudflare Workers/D1 → ChatGPT MCP 架构。原项目及更早上游的版权与 MIT 许可证见仓库 `LICENSE`。本页记录本分支的 MCP 优先部署方式和增补，详细步骤、Windows 操作与故障处理见[从零搭建](从零搭建.md)。

## 工作原理与要求

设备先通过手机把数据同步到 Google Health；Worker 通过 Google Health API v4 读取后保存在 Cloudflare D1，定时重新采集最近七天。ChatGPT 经独立 OAuth 连接 `/live-mcp`，查询时触发刷新并读取归档；`health_packet` 只读取指定日期历史。KV 保存令牌、缓存与 MCP 授权。刷新不会修改 Google 健康数据，也不能强制设备上传。

需要 Node.js 22.13 或更高、Cloudflare Workers/KV/D1 账号、可使用 Google Health API 的 Google Cloud 项目和数据账户，以及能连接自定义 MCP 的 ChatGPT 账号。不同账户、地区、设备及产品计划的可用性和配额可能不同，费用请在各平台确认。此分支以北京时间进行日期归档和调度；出行或其他时区需要检查日期边界。

## 从零部署（macOS / Linux）

1. 获取源码并验证：

   ```sh
   git clone https://github.com/lj0014/fibitair-health-workflow.git
   cd fibitair-health-workflow
   npx --yes pnpm@10.30.0 install --frozen-lockfile
   npm run typecheck
   npm test
   ```

2. 在自己的 Google Cloud 项目中启用 Google Health API，创建 Google Auth Platform 授权应用。配置三个只读范围：`googlehealth.activity_and_fitness.readonly`、`googlehealth.health_metrics_and_measurements.readonly`、`googlehealth.sleep.readonly`（完整 scope 为 `https://www.googleapis.com/auth/` 加上这些名称）。创建 Web application OAuth 客户端，允许回调 `http://127.0.0.1:8787/oauth/callback`，将客户端 JSON 保存为本地 `oauth-client-health.json`。具体操作参照 [Google Health 设置文档](https://developers.google.com/health/setup) 和[从零搭建](从零搭建.md)。

3. 登录自己的 Cloudflare，并创建资源：

   ```sh
   npx wrangler login
   npm run workflow:setup -- provision
   ```

   确认所选账号和 Worker 名称；同名资源存在时先核对，避免覆盖。脚本创建三个 KV、D1 和配置，执行迁移并部署。部署失败或资源已存在时不要盲目重跑，参照[恢复步骤](从零搭建.md#首次部署失败如何继续)。

4. 按部署输出修改 `wrangler.workflow.toml` 的 `PUBLIC_ORIGIN` 为自己的 HTTPS 地址（无路径和末尾斜杠），保持 `WEEKLY_EMAIL = "false"`，运行 `npm run deploy`。不需要 Gmail API 和授权即可使用 MCP。

5. 安装 Google Health 授权：

   ```sh
   npm run workflow:setup -- authorize health oauth-client-health.json
   ```

   在同一台电脑打开终端给出的链接并完成授权；脚本通过本地回调处理凭据，不要把授权链接、令牌或密钥发给他人。测试模式的令牌可能有七天期限；生产状态不等于应用已验证或令牌永不过期。具体限制参照 [Google 令牌说明](https://developers.google.com/identity/protocols/oauth2#expiration)。

6. 在支持自定义 MCP 的 ChatGPT 界面创建应用，URL 填 `https://你的-worker域名/live-mcp`，选择 OAuth。连接时核对授权页地址和返回目标，输入本机 `secrets/MCP_OWNER_KEY.txt` 的值。之后调用 `fetch_latest_health` 检查刷新状态、观测日期、空值和覆盖率。ChatGPT 接口及权限要求以当时界面为准；此 OAuth 连接针对源码中允许的 ChatGPT 回调，其他客户端可能不兼容。

## 设备最后同步时间（可选）

在 Google Auth Platform 数据访问范围添加 `https://www.googleapis.com/auth/googlehealth.settings.readonly`，然后执行：

```sh
npm run workflow:setup -- authorize health-device oauth-client-health.json
```

在 Google 页面确认四项只读授权。授权安装成功后，将本地 `wrangler.workflow.toml` 中 `[vars]` 的 `DEVICE_STATUS_ENABLED` 设为 `"true"`，执行 `npm run deploy`，调用 `fetch_latest_health` 查看 `device_status`。该权限允许读取 Google Health 设置，设备字段是否返回由 Google 和设备决定。同步时间并不证明所有健康数据已完整上传。

## 历史回补与分析边界

管理接口每次最多同步七天。按[原部署说明](从零搭建.md#6-首次同步核对数据)分段调用同步，先同步最近七天，再分四段回补此前 28 天。检查每段返回状态，以及 MCP 数据包中每项统计的 `validDays` 和 `expectedDays`。API 无数据、设备未产数、权限不足和同步错误不能当作零；同步失败可能返回上次成功的旧记录，要结合 `fetched_at` 和 `latestAttempts` 阅读。

本分支记录 `dailyRmssd`、`deepRmssd`、可选非 REM 睡眠心率和熵，以及静息心率 `calculationMethod`；可选字段未返回时保留未知。相同类型且时间重叠的运动会标为可能重复，并保留原记录，不能仅凭重叠确定重复。统计和设备状态供个人观察，不等于医疗诊断。

如只需为已有档案补 HRV 和静息心率的新增字段，管理接口 `POST /sync` 可以传 `{"start":"YYYY-MM-DD","end":"YYYY-MM-DD","streams":["hrv","resting_heart_rate"]}`，每次至多七天。该操作不会更新其他指标，并在某天 Google 返回空值时保留已有记录。管理接口必须使用本地管理令牌，切勿把令牌放入 URL 或分享。

## 安全与其他选项

`oauth-client-*.json`、`secrets/`、`exports/`、`.local-config/`、`.wrangler/` 和真实 Wrangler 配置不得提交。数据库、导出文件和 MCP 返回值可能包含敏感健康数据。Google Health、设备设置、MCP 访问分别授权，撤销应分别处理。Gmail 周包属于可选旧功能；默认关闭，只有明确需要时才按[完整文档](从零搭建.md#8-核对后再开启周邮件)单独配置。
