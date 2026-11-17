# 滚动新闻快照采集与归档

本服务面向新闻编辑部和数据运营人员：采集经常刷新的新闻目录页面，规范化标题与链接，并在本地 SQLite 中保留每次采集及文章出现历史。一次短暂的页面缺项不会立刻从归档删除新闻；操作者可以查看快照差异、采集健康、审核记录，并导出 CSV。

## 环境

- Node.js `22.23.4`。
- 仅使用 Node 内置模块和 SQLite，无第三方包，不要求网络连接。

## 验收与演示

```sh
npm test
npm run build
npm run demo
```

演示会读取本地合成页面并在临时目录建立数据库，输出一次采集摘要后清理临时文件。生产数据库由 `ARCHIVE_DB` 指定，默认 `./var/archive.sqlite`。默认 HTTP 监听地址为 `127.0.0.1:8080`，可用 `HOST` 和 `PORT` 调整。

## HTTP 接口

- `POST /v1/feeds`：注册来源，提交 `feedId`、`baseUrl`、`allowedHosts`，以及可选的 `minimumItems`、`missingThreshold`。
- `POST /v1/feeds/:feedId/snapshots`：提交已保存的 HTML 页面；可用 `X-Captured-At` 指定采集时间。
- `POST /v1/feeds/:feedId/refresh`：手动抓取已注册来源；仅访问允许列表中的 DNS 主机。
- `GET /v1/feeds/:feedId`：查看 feed 状态、文章统计和采集健康。
- `GET /v1/feeds/:feedId/items`：分页读取文章；`visibility=visible|quiet` 可过滤状态。
- `GET /v1/feeds/:feedId/runs`：读取近期页面快照接纳/拒绝记录。
- `GET /v1/feeds/:feedId/attempts`：读取抓取请求、重试、失败和响应审计。
- `GET /v1/feeds/:feedId/changes`：比较最近两次已接纳快照；未达到两次时返回 `409`。
- `GET /v1/feeds/:feedId/health`：读取 24 小时抓取成功率、最近成功时间和异常提示。
- `GET /v1/feeds/:feedId/items.csv`：流式导出；限制输出行数并转义表格公式前缀。
- `PATCH /v1/feeds/:feedId/items/:articleId/review`：按修订号更新审核状态，状态为 `unreviewed`、`confirmed` 或 `withdrawn`。
- `GET /v1/feeds/:feedId/items/:articleId/review`：查看审核事件历史。
- `GET /v1/feeds/:feedId/items/:articleId/history`：查看文章在已接纳列表快照中的出现位置和间隔。
- `GET /health`：进程健康检查。

抓取失败、页面异常和正常列表变更有不同记录。相同页面指纹重复提交时不会重复增加文章观察次数。

## 条件请求与验证器

手动刷新会为已注册来源保存最近一次响应的 `ETag` / `Last-Modified`，并在后续请求中发送 `If-None-Match` / `If-Modified-Since`。验证器与具体来源 URL 绑定并持久化到 SQLite：

- 验证器随该次响应的接纳结果一起保存。收到 `304` 时，通过发出去的验证器反查它指向的页面快照，刷新接口返回的 `notModified` 字段说明该内容当时是 `accepted` 还是 `rejected`，以及对应的 `captureId`。
- 进程重启后仍能完成这一反查，因为验证器、快照和接纳结果都在数据库中。
- 站点若以 HTTP 200 返回残缺页并带新 `ETag`，该页仍会按质量规则被拒绝；随后同一验证器的 `304` 指向的是这次被拒绝的页面，不会被当成已成功采集，也不会增加文章出现次数。
- 修改来源 URL 后旧验证器不会被沿用；首次请求新 URL 一定是无条件请求，成功后旧验证器被清除。
- 未携带条件头的请求若收到 `304`，按上游协议错误记为失败，而不是 `not_modified`。

抓取健康把 `accepted`、`not_modified`、`rejected`、`failed` 分开统计；`lastConfirmedAt` 同时包含新内容被接纳和网络层确认未修改。`304` 指向被拒绝页面时会计入 `notModifiedRejected` 并给出 `not_modified_rejected_capture` 提示。`low_acceptance_rate` 只在真正返回页面内容的响应中计算，因此连续正常的 `304` 不会被误判为低接纳率。短暂缺失需达到来源配置的连续快照阈值后才转为 `quiet`，重新出现时恢复 `visible`。人工审核状态独立于可见性状态，旧修订号会得到冲突响应而不会覆盖新审核决定。

仓库中的 HTML 样本为本地合成数据，仅用于离线演示和测试。实际部署前请配置准确来源域名，并遵守来源站点的使用条件。本服务不在后台隐式启动定时抓取；由操作者或外部调度器显式触发刷新。
