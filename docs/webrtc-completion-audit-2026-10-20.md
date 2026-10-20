# Scramjet WebRTC 工程完成度审计报告

审计日期：2026-10-20（Asia/Shanghai）。

> **更新（2026-10-20）：** 本报告是提交 `f116bf59` 的历史审计快照。F01–F11 的修复、回归测试和新的隔离证据见 [`webrtc-remediation-2026-10-20.md`](./webrtc-remediation-2026-10-20.md)。下文的“未通过”结论仅描述修复前状态。

**结论：当前工作区尚未完整完成附件任务；Web-only Relay Mode 已有实质实现和部分真实通信证据，Enforced Isolation Mode 未通过严格网络隔离验收。** 当前存在可复现的授权 TURN 配置绕过、防火墙加载失败后防护规则消失，以及隔离验证误报通过的问题。功能测试通过也不能消除这些验收阻断项。

## 1. 审计对象与证据范围

- 工作区：`/Users/xiaosong/dev/scramjet`。
- 分支：`feat/webrtc-takeover`；审计代码提交：`f116bf5909147bb02ce532a70772449ba8d7c614`。
- 对照基线：`origin/main`、本次获取的 `upstream/main` 均为 `b14b709ac190b786dd03becbd0728ab72bdd3ad6`。
- 分支增量：10 个提交，48 个文件，新增 5,655 行、删除 18 行。
- 验收依据：用户提供的《Scramjet WebRTC 完整接管与防泄漏工程任务》全文；附件 SHA-256：`a3e382f73b7081089611cbaa124e98b73b0f8216abe8a41ef28d96d8419cff0c`。
- 本次证据目录：`/Volumes/1T/scramjet/audits/2026-10-20-f116bf59/`，包含执行命令、退出码、日志、浏览器策略探针、Linux 防火墙故障注入脚本和 CI 快照。

审计结合源码审阅、本次复验、仓库历史测试报告、原始本地 PCAP 和 GitHub Actions 日志。历史记录与本次结果分别标注。原始 PCAP 保持在本地忽略目录；临时测试栈使用已有镜像和浏览器缓存。代码审计开始时工作区干净，本报告是本次新增的仓库交付物。

上游核查：`upstream/main` 的相关源码搜索仅发现现有 adversarial 测试对 `typeof RTCPeerConnection` 的断言，未发现本分支的 WebRTC Hook。最近 100 条上游 issue/PR 的关键词检索未命中相关实现；该检索范围不等于完整历史 issue 审计。

## 2. 主要发现

下述 P1 表示验收前需要解决的阻断项；P2 表示需补齐的兼容性、可靠性或交付问题。每项标明验证程度。

### F01 · P1 · 网页修改 Array.prototype.map 可替换授权 TURN 列表

**状态：本次在真实 Chromium、Scramjet 注入页面中复现。**

`cloneIceServers()` 通过 `servers.map(...)` 克隆受信任的 ICE 配置，运行时仍会查找可被网页改写的数组原型方法。网页替换该方法后，构造器实际收到的 ICE 列表可变为攻击者选择的 TURN 服务。构造器完成后未执行授权列表的原生配置复核。

- 来源：[webrtc.ts:65](/Users/xiaosong/dev/scramjet/packages/core/src/shared/webrtc.ts:65)、[构造器处理:422](/Users/xiaosong/dev/scramjet/packages/core/src/client/shared/requests/webrtc.ts:422)。
- 探针给定授权地址 `turn:127.0.0.1:13479`，网页只修改自身 `Array.prototype.map`，新连接的原生 `getConfiguration()` 返回 `turn:127.0.0.1:9?transport=udp`。
- `relay` 和带隔离声明的 `enforced` 两种 JavaScript 策略均复现；策略字段仍为 `relay`。
- 证据：`policy-probe.ts`、`policy-probe.log`、`policy-probe.json`。

这证明“网页只能使用指定 TURN”的配置约束可被绕过。本次探针未进行该替换地址下的实际通信，也未证明能绕过已经正确安装的系统防火墙。需要使用稳定的原生方法引用或避免可污染的原型调用，构造后复核授权配置，并增加原型污染回归测试。

### F02 · P1 · 防火墙规则重新加载失败会移除既有防护

**状态：本次在独立 Linux 容器网络命名空间中复现。**

安装脚本先删除 `inet scramjet_webrtc`，随后才执行新规则加载。新规则因配置错误加载失败时，旧表已经消失。

- 来源：[setup-nftables.sh:30](/Users/xiaosong/dev/scramjet/tests/webrtc/isolation/setup-nftables.sh:30)、[规则加载:68](/Users/xiaosong/dev/scramjet/tests/webrtc/isolation/setup-nftables.sh:68)。
- 复验：先安装有效规则，再以无效 TURN 地址触发加载错误；日志为 `initial_policy_present=true`、`reload_exit_nonzero=true`、`policy_after_failure=ABSENT`。
- 证据：`nft-reload-check.sh`、`nft-reload.log`。

依赖该表提供出口限制的部署，在重新配置失败后会失去这一层限制。需要先验证规则，并在同一 nftables 事务中替换；失败时保留原有拒绝策略，或阻止浏览器继续运行。

### F03 · P1 · 隔离验证器在未授权 TCP 可达时仍报告通过

**状态：本次在独立 Linux 容器中通过故障注入复现。**

脚本忽略 TCP 探针的成功与失败，只检查 UDP/TCP 探针前后的总丢弃计数是否增加。只要某个探针触发丢弃，其他未授权路径即使放行也可能通过。

- 来源：[verify-isolation.sh:30](/Users/xiaosong/dev/scramjet/tests/webrtc/isolation/verify-isolation.sh:30)、[总计数判断:46](/Users/xiaosong/dev/scramjet/tests/webrtc/isolation/verify-isolation.sh:46)。
- 复验中故意加入一条错误的 TCP 放行规则；配置为“未授权”的 HTTP 目标返回 `200`，验证器仍返回 `deniedBefore=0`、`deniedAfter=1`、`ok=true`。
- 证据：`verifier-false-positive.sh`、`verifier-false-positive.log`。

需要逐个断言未授权 TCP、UDP、IPv6 和实际 WebRTC 直连均被阻断，并将每类探针与各自计数/抓包证据关联。现有 `ok=true` 不能作为完整隔离的验收依据。

### F04 · P1 · 严格模式的浏览器端到端 CI 未运行成功

**状态：最新 PR CI 失败；启动逻辑存在可定位的不一致。**

最新 WebRTC workflow 的隔离任务在访问 `http://10.200.0.1:4500/` 时收到 `ERR_CONNECTION_REFUSED`，尚未进入实际中继与防泄漏验收。

- 来源：[命名空间内执行:85](/Users/xiaosong/dev/scramjet/tests/webrtc/isolation/run-in-netns.sh:85)、[CI 调用:200](/Users/xiaosong/dev/scramjet/.github/workflows/webrtc.yml:200)、[Runway 启动 Harness:752](/Users/xiaosong/dev/scramjet/packages/runway/src/index.ts:752)。
- runner 与浏览器都由命名空间内的命令启动，Harness 地址却配置为宿主侧 `10.200.0.1`；当前脚本没有相应的宿主 Harness 启动步骤。
- 证据：`ci-39405470232.json`、`ci-39405470232-failed.log`。

此外，`networkIsolationVerified` 是部署方布尔声明，未与浏览器实际所在命名空间、规则版本或实时有效性绑定。需要修正拓扑后完成真实浏览器运行，并补齐移除隔离后的真实直连对照、客户端出口抓包、IPv6 和 TURN 故障验证。

### F05 · P2 · 无法验证 selectedCandidatePair 时继续保持连接

**状态：源码确认，异常路径未做运行时故障注入。**

`getStats()` 抛错后直接返回；多次找不到候选对时只输出警告。代码不会因此拒绝连接。严格模式对“不支持或不能验证”的环境缺少明确的失败处理。

- 来源：[webrtc.ts:202](/Users/xiaosong/dev/scramjet/packages/core/src/client/shared/requests/webrtc.ts:202)。
- 只选取一个 transport 的候选对，尚缺多 transport/非 BUNDLE 场景验证：[候选对解析:356](/Users/xiaosong/dev/scramjet/packages/core/src/shared/webrtc.ts:356)。

此处属于策略可验证性缺口，现有证据未证明发生了实际直连。需要定义严格模式的验证超时行为，并覆盖候选对切换、所有活动 transport 和统计接口不完整的情形。

### F06 · P1 · 新代码存在 TypeScript 错误，CI 缺少独立质量门禁

**状态：本次编译器复现。**

Controller 的定时器类型包含 `null`，却直接传给当前 DOM 类型定义中的 `clearTimeout()`，触发 `TS2769`。

- 来源：[Controller:239](/Users/xiaosong/dev/scramjet/packages/controller/src/index.ts:239)、[Controller:271](/Users/xiaosong/dev/scramjet/packages/controller/src/index.ts:271)。
- 证据：`controller-typecheck-direct.log`。
- 全量 Core 类型检查也失败，报 50 处 TS 诊断；全量 Core lint 报 104 个 error、175 个 warning。未对全部诊断逐项复验基线，不能把全部错误归因于本分支。
- 新增的两个 WebRTC 文件单独 lint 退出码为 0，存在 6 个 warning；它们的类型检查日志未出现直接诊断。

现有两个 workflow 没有独立 lint/typecheck 任务。Rspack 的类型检查插件被注释，声明生成逻辑还会吞掉 TypeScript 的部分失败，因此构建成功不足以证明类型检查通过。来源：[rspack.config.ts:178](/Users/xiaosong/dev/scramjet/rspack.config.ts:178)、[rspack.config.ts:340](/Users/xiaosong/dev/scramjet/rspack.config.ts:340)。

通用 CI 启动全套 Runway，却没有启动新增测试依赖的 TURN/凭据服务；五个 WebRTC 用例因此进入失败清单。需要补齐测试依赖或明确划分由独立集成 job 承担的测试集合，并保证这些测试仍由有效门禁执行。

### F07 · P2 · 凭据签发具备 HMAC 基础，但滥用防护与生命周期交付不完整

**状态：源码确认，并对本地服务执行了一次匿名只读请求。**

本地匿名 `GET /turn-credentials` 返回 200 和可用字段。服务未实现用户鉴权、签发限频、按用户额度、单凭据撤销或共享密钥轮换接口；`ALLOWED_ORIGIN` 提供 Origin/CORS 控制。默认测试启动脚本将其设为 `*`。

- 来源：[credential-server.mjs:52](/Users/xiaosong/dev/scramjet/tests/webrtc/server/credential-server.mjs:52)、[start-test-stack.sh:20](/Users/xiaosong/dev/scramjet/tests/webrtc/start-test-stack.sh:20)。
- HMAC 共享密钥保存在服务端环境变量；客户端拿到短期凭据，这部分架构已实现。
- 凭据刷新会调用活动连接的 `setConfiguration()`；失败只记录日志，尚缺到期、失败重试、ICE Restart 后恢复及既有 allocation 撤销的集成测试。
- 来源：[刷新逻辑:297](/Users/xiaosong/dev/scramjet/packages/core/src/client/shared/requests/webrtc.ts:297)、[活动连接更新:370](/Users/xiaosong/dev/scramjet/packages/core/src/client/shared/requests/webrtc.ts:370)。

这是一套测试/参考服务。按任务要求交付受控服务时，还需实现或配套交付前置鉴权、签发限流、轮换和撤销方案，并验证其实际效果。

### F08 · P2 · 凭据容器健康检查端口错误

**状态：配置与当前容器状态共同确认。**

Compose 将服务端口设置为 18081，健康检查却请求容器内 8081。当前原有凭据容器显示 `unhealthy`，而 18081 的 `/healthz` 返回 200。

- 来源：[docker-compose.yml:39](/Users/xiaosong/dev/scramjet/tests/webrtc/docker-compose.yml:39)、[健康检查:54](/Users/xiaosong/dev/scramjet/tests/webrtc/docker-compose.yml:54)。

应统一监听与健康检查端口，并使测试栈启动依赖正确的就绪状态。

### F09 · P2 · setConfiguration(null) 的兼容行为被破坏

**状态：本次真实浏览器对照复现。**

原生 Chromium 接受 `setConfiguration(null)`。Hook 仅在参数为非空对象时清洗配置；传入 `null` 会先让原生配置恢复为 `all`，随后校验失败并关闭连接、抛出 `OperationError`。

- 来源：[webrtc.ts:449](/Users/xiaosong/dev/scramjet/packages/core/src/client/shared/requests/webrtc.ts:449)。
- 证据：`policy-probe.log` 中的 `NATIVE_NULL` 与两种模式的 `nullResult`。

需要对合法的 WebIDL 字典输入统一应用中继策略，并覆盖空对象、null、undefined 和缺参的差异。该发现证明兼容性差异，未证明该调用造成网络泄漏。

### F10 · P2 · 网络证据有价值，但统计标签和验收范围需要修正

**状态：本次重新读取原始 PCAP 并核对。**

本地原始 `tests/webrtc/capture/turn.pcap` 确实存在，包含 1,483 个包，与报告总数一致。SHA-256 为 `ae12fd04d0d99ea1fc8d119527a50e1ff761a41b09c43c3ae4c2f264c282026f`。

`pcap-summary.json` 将 `0x0016` 标为 Allocate request；这是 Send indication 的消息类型，Allocate request 为 `0x0003`。本次读取原始包得到 16 个包含 `0x0003` 的帧。部分帧含多个 STUN 消息，统计时还需区分包数与消息数。参考 RFC 8656 的方法定义 [S2]。

- 来源：[pcap-summary.json:8](/Users/xiaosong/dev/scramjet/docs/webrtc-evidence/pcap-summary.json:8)。
- 证据：`pcap-stun-types.json`。

抓包点位于 TURN 侧，能够支持“发生了真实 TURN 控制/转发流量”的判断；对客户端其他接口的未授权直连没有完整观测。现有 JSON、报告和抓包之间也缺少统一运行 ID、配置哈希与自动断言。需要增加客户端/目标 Peer 侧证据及可自动重建的统计结果。

### F11 · P2 · Coturn 参考版本需要补做安全基线与 IPv6 ACL 验证

**状态：镜像版本与官方公告版本范围匹配；实际拓扑可利用性未复现。**

Compose 固定 `coturn/coturn:4.6.3-alpine`。官方公告 GHSA-2x4g-wx24-48m4 将 `<=4.13.0` 列为受影响范围，描述了依赖 NAT64/等价转换拓扑的 peer ACL 绕过，修复版本为 4.13.1 [S3]。该公告要求有效凭据、IPv6 relay 和相应路由等条件，不能据此断言当前本地部署已经可利用。

- 来源：[docker-compose.yml:5](/Users/xiaosong/dev/scramjet/tests/webrtc/docker-compose.yml:5)。
- 需要选择包含相关修复的维护版本，复验 IPv4/IPv6、映射/转换地址和私网目标 ACL，并记录镜像 digest。当前“配置 denylist 即能阻止敏感目标转发”的交付结论仍缺这些依据。

## 3. 对附件各工作阶段的核对

| 附件阶段                      | 状态                       | 依据与剩余工作                                                                                                                                                                                                 |
| ----------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一、仓库审计                  | 大体已交付                 | architecture 文档记录 Controller/SW/Runtime/Transport、Wisp 与 Rewriter 边界及能力矩阵；本次补查上游。审计文档存在不能控制所有原生路径的明确边界。                                                             |
| 二、技术架构                  | 已选定并集成               | 采用浏览器原生 WebRTC + Coturn；Relay 与 Enforced 分开；Wisp UDP 全隧道做了成本/边界评估。                                                                                                                     |
| 三、PeerConnection 与强制中继 | 部分完成                   | 构造、setConfiguration、本地 SDP、restartIce、close 已接入；原生媒体/DataChannel API 保留。授权列表绕过与部分 WebIDL 行为待修复。                                                                              |
| 三、Realm 注入                | 部分验证                   | 顶层、同源/跨域 iframe、about:blank/srcdoc 有自动化；动态 import/eval/Function、提前缓存 API、刷新/导航竞态和实际支持 PC 的 Worker 尚缺专项证据。                                                              |
| 三、媒体与 DataChannel        | 部分完成                   | 文本、ArrayBuffer、大消息哈希、ordered/unordered、negotiated、并发、基础音视频与 ICE Restart 有测试。Blob、replaceTrack、removeTrack、屏幕共享、动态增删轨、独立重新协商、关闭后重建和多个并发代理标签页待补。 |
| 四、Linux TURN 服务           | 参考实现已交付             | Compose、NAT 参数、端口范围、证书挂载、HMAC、配额与 denylist 已提供；健康检查、生产签发防护、轮换/撤销、双栈及依赖安全基线待完成。                                                                             |
| 五、严格网络隔离              | 未通过                     | 已有 nftables/netns 实现；F02/F03 可复现，F04 CI 未完成实际浏览器验证，IPv6/DNS/网络切换验证不足。                                                                                                             |
| 六、完整自动化                | 部分完成                   | 11 个单测、15/13/13 个浏览器用例、真实 coturn/抓包工具存在；功能、安全、平台与性能覆盖有明显缺项。                                                                                                             |
| 七、工程规范                  | 部分完成                   | 模块化接入、配置默认值、文档与许可证沿用；新增 TS 错误、原型污染和兼容性问题需要修复。                                                                                                                         |
| 八、CI                        | 未通过                     | 构建、包验证、Rewriter、前端和部分 WebRTC job 成功；完整回归、Firefox、WebKit、严格隔离失败，lint/typecheck 门禁缺失。                                                                                         |
| 九、分阶段提交                | 已完成分阶段提交           | 10 个目的明确的提交。未逐个 checkout、编译每个中间提交，不能确认所有历史阶段均可独立构建。                                                                                                                     |
| 十、最终验收                  | 未通过                     | 见下一节逐项结果。                                                                                                                                                                                             |
| 十一、交付物                  | 主要文件齐全，验收记录待补 | 四份文档、测试、Compose、隔离脚本、CI、环境示例和 Git 提交记录存在；完整逐项验收/统一变更记录、设备运行步骤和自动证据关联尚待完善。                                                                            |
| 十二、执行要求                | 已落实部分真实验证         | 测试使用原生 PeerConnection 和真实网络协议栈；本次发现的防护与验收缺陷仍需修复后复验。                                                                                                                         |

Wisp 的评估结果符合附件允许的架构选择：当前使用独立 TURN 中继，不构成原生 ICE 的 Wisp 全隧道。大量 API 保持原生实现是合理设计；它们仍需相应的功能与安全测试证明。

## 4. 最终 16 项验收标准

“部分”表示已有实现或有限环境证据，但未满足附件完整条件；“未验证”不计为通过。

| 最终验收项                                  | 结果           | 判定依据                                                                                                                            |
| ------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Scramjet 正常打开现有目标网站               | 部分           | 构建与大量回归存在；最新通用 CI 有额外失败，完整回归未通过。                                                                        |
| DataChannel 真实双向传输                    | 部分           | 有真实 TURN 集成、二进制和 128 KiB SHA-256 用例；跨浏览器 CI 未全通过。                                                             |
| 音频、视频正常传输                          | 部分           | Chromium 合成画面/振荡器音频测试存在；接收端验证聚合字节和视频帧，独立音频有效性及其他浏览器仍不足。                                |
| ICE Restart 与 Renegotiation                | 部分           | ICE Restart 有用例；独立重新协商和动态轨道变更用例不足。                                                                            |
| TURN/UDP                                    | 部分           | 历史报告及 Chromium relay CI 有成功证据；通用环境与故障恢复尚待完成。                                                               |
| TURN/TCP 或 TLS 实测                        | 部分           | 历史报告记录 TCP、多浏览器及 Chromium 自签名 TLS；可信证书生产链路未实测。                                                          |
| 所有支持环境 selectedCandidatePair 符合策略 | 未通过完整验收 | 跨浏览器失败、F01 授权列表绕过、F05 无法验证时继续运行。                                                                            |
| 目标 Peer 看到 Linux TURN 出口              | 部分           | 现有测试检查候选类型/部分端口关联，TURN 侧有抓包；缺独立公网 Peer 对指定 Linux 出口 IP 的完整断言。                                 |
| 严格模式无未授权直连                        | 未通过         | F02/F03/F04，且缺客户端双栈完整网络证据。                                                                                           |
| TURN 故障不回退直连                         | 部分           | TURN 不可达测试通过；实际服务中断/重启、错误凭据、重启恢复和网络切换待补。                                                          |
| IPv4/IPv6 泄漏测试                          | 未通过完整验收 | 有 IPv4 规则计数证据；脚本没有 IPv6 地址/路由就绪与独立旁路探针。inet 默认 drop 可限制 IPv6，但不能证明 IPv6 功能与防泄漏同时满足。 |
| 跨域 iframe                                 | 有限范围通过   | a.test/b.test 的配置 Hook 用例存在；跨域真实媒体/数据和注入竞态仍待扩展。                                                           |
| 原有网络能力无回归                          | 未确认         | 最新 CI 有 cookie race、Google 页面等额外失败；尚未逐项对基线复现归因。                                                             |
| 关键自动化测试通过                          | 未通过         | 最新 PR 两个 workflow 均失败。                                                                                                      |
| 真实抓包或等价证据                          | 部分           | 原始 PCAP 存在且包数匹配，统计字段需修正；客户端泄漏检测和严格模式证据不足。                                                        |
| 完整部署文档与复现步骤                      | 部分           | 主要文档齐全；健康检查、隔离拓扑、IPv6、设备测试及生命周期操作需要修正/补齐。                                                       |

## 5. 本次复验与浏览器结果

本次复用现有 Core、Controller bundle。Core source map 中 70 个可对照源码文件与当前文件一致，两个 WebRTC 模块一致；Controller API source map 中 `index.ts` 等可对照源码也一致。Core `scramjet.js` SHA-256：`4a17c037e328a0ea78ab11f8fb1e3b93f00a49349d9d29e8d529e42c9a038319`。本次未重新编译 Rust/WASM；构建结果依据同一分支最新 CI。

| 检查                      | 本次结果                                        | 日志                            |
| ------------------------- | ----------------------------------------------- | ------------------------------- |
| WebRTC 单元测试           | 11/11 通过                                      | unit.log                        |
| Core 类型检查             | 失败，50 处 TS 诊断；新增 WebRTC 文件无直接诊断 | core-typecheck.log              |
| Controller 类型检查       | 失败，包含新增 clearTimeout TS2769              | controller-typecheck-direct.log |
| Core 全量 lint            | 失败：104 error、175 warning                    | core-lint.log                   |
| 新增两个 WebRTC 文件 lint | 退出码 0，6 warning                             | changed-webrtc-lint.log         |
| 授权列表/字典输入探针     | 复现 F01、F09                                   | policy-probe.log                |
| 防火墙加载错误注入        | 复现 F02                                        | nft-reload.log                  |
| 隔离验证器故障注入        | 复现 F03                                        | verifier-false-positive.log     |
| 本地原始 PCAP             | 1,483 包；重新读取 STUN 类型                    | pcap-stun-types.json            |

原有本地测试栈发布的 TURN 地址为 `192.168.31.197`，本机当前 `en0` 为 `192.168.31.30`；旧地址 TCP 连接超时。该环境下 Chromium 为 12 通过/3 失败，Firefox 与 WebKit 均为 11 通过/2 失败，失败集中于真实中继。不能把这一轮超时直接归因为 Hook 回归。

首次临时栈使用当前本机地址后，Coturn 日志进一步显示其动态分配的容器私网 relay 地址被测试 denylist 拒绝。该诊断轮结果保留在 `fresh-*.log`，不作为正确测试拓扑下的兼容性结论。随后使用独立临时栈，并显式允许该栈自身 relay 地址进行复验：

| macOS / Playwright 浏览器 | 本次复验结果                                             | 用时     | 证据                   |
| ------------------------- | -------------------------------------------------------- | -------- | ---------------------- |
| Chromium                  | 15/15 通过，含真实 DataChannel、ICE Restart 和合成音视频 | 39.82 秒 | corrected-chromium.log |
| Firefox                   | 13/13 通过，媒体/Worker 用例未进入该浏览器集合           | 32.97 秒 | corrected-firefox.log  |
| WebKit                    | 13/13 通过，媒体/Worker 用例未进入该浏览器集合           | 29.76 秒 | corrected-webkit.log   |

该栈仅用于本次测试，加入自身动态容器 relay 地址的允许项；原有测试栈保持原配置。临时栈提供 UDP/TCP TURN URL，本轮未分别强制每种传输或重新验证 TLS。启动参数、临时适配脚本和清理记录见 `corrected-relay-check.py`、`turn-entrypoint-audit.sh`、`corrected-stack.json`、`corrected-stack-cleanup.json`。

这里的音视频源为浏览器 canvas 动画与 Web Audio 振荡器，属于可重复的真实媒体轨道；覆盖范围仍需按测试断言判断。Firefox/WebKit 通过浏览器过滤不运行媒体和 worker 用例，因此它们的 13 项结果不能覆盖这些能力。

Windows Chromium、Android Chrome、真实 iOS Safari、公共网络多主机、IPv6 双栈功能、真实设备采集/屏幕共享，以及延迟、抖动、吞吐、CPU/内存、长稳、allocation 泄漏等性能稳定性项目，本次及现有交付证据均未完成完整验收。

本次关键命令如下；每次执行的完整参数、工作目录与退出码保存在同名 `.json` 文件。浏览器复验的凭据端口 18082 由临时测试栈提供：

```sh
rtk node --experimental-strip-types --test tests/webrtc/unit/webrtc.test.ts
rtk pnpm --dir packages/core exec tsc --noEmit --incremental false -p tsconfig.json
rtk node packages/core/node_modules/typescript/bin/tsc --noEmit --incremental false -p packages/controller/tsconfig.json
rtk pnpm --dir packages/core lint
```

在 `packages/runway` 下分别设置 `RUNWAY_BROWSER=chromium`、`firefox`、`webkit`，执行：

```sh
rtk env PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers TURN_CREDENTIALS_URL=http://127.0.0.1:18082/turn-credentials WEBRTC_FAKE_MEDIA=1 WEBRTC_EXPOSE_HOST_CANDIDATES=1 RUNWAY_BROWSER=chromium rtk npx --offline node@24 --experimental-strip-types --no-warnings src/index.ts webrtc- --parallel 1
```

防火墙复验使用已有 `nicolaka/netshoot` 镜像的独立容器网络命名空间和 `NET_ADMIN`，执行本地保存的 `nft-reload-check.sh` 与 `verifier-false-positive.sh`。这些是错误处理及验证器健壮性测试，不构成完整浏览器隔离通过记录。

## 6. 最新 PR CI 快照

| 工作流 / job                                      | 结果        | 主要问题                                           |
| ------------------------------------------------- | ----------- | -------------------------------------------------- |
| CI 39405470231：构建、包结构、Rewriter、前端      | 通过        | 这些 job 不构成独立 lint/typecheck 门禁。          |
| CI 39405470231：Run Scramjet Tests                | 失败        | expected=158、actual=154、unexpected=7、fixed=11。 |
| WebRTC 39405470232：单测、Chromium real relay job | 通过        | 单测与 Chromium 的 Hook/relay job 成功。           |
| WebRTC 39405470232：Firefox                       | 失败，11/13 | concurrency、DataChannel/ICE Restart。             |
| WebRTC 39405470232：WebKit                        | 失败，12/13 | DataChannel/ICE Restart。                          |
| WebRTC 39405470232：Enforced isolation            | 失败        | Harness 连接被拒绝，未完成浏览器网络验收。         |

通用 CI 的 7 个额外失败为：`cookies-fetch-set-cookie-race`、`site-google-frontpage`、`webrtc-credentials-client-fetch`、`webrtc-credentials-controller-prefetch`、`webrtc-relay-concurrent-peers-and-channels`、`webrtc-relay-datachannel-ice-restart`、`webrtc-relay-media`。前两项尚需基线对照归因；后五项需要首先修复测试依赖的启动与编排。

最新 workflow 地址见本地证据 JSON 的 `url` 字段，运行编号分别为 39405470231 和 39405470232。该快照取自本次审计，替代此前 PR 发布时尚在运行的状态。

## 7. 核心实现及提交清单

实现由浏览器原生 WebRTC 协议栈、Scramjet 的共享 Realm Hook、Controller/Client 临时凭据刷新、独立 Linux Coturn 及可选 nftables/network namespace 组成。摄像头、麦克风与屏幕采集仍依赖本地浏览器权限和设备；严格出口限制依赖浏览器所在的系统网络边界。

| 位置                                               | 主要实现                                            |
| -------------------------------------------------- | --------------------------------------------------- |
| packages/core/src/shared/webrtc.ts                 | 配置、SDP、凭据和 stats 解析；默认 mode=off。       |
| packages/core/src/client/shared/requests/webrtc.ts | 原生 API 策略接入、候选检查、凭据刷新、关闭清理。   |
| packages/controller/src/index.ts                   | 创建 frame 前的凭据预取与定时刷新。                 |
| packages/runway/src/tests/webrtc/                  | Hook、凭据、跨域、并发、真实 DataChannel/媒体测试。 |
| tests/webrtc/coturn/、server/                      | Coturn 配置、证书工具、HMAC 签发参考服务。          |
| tests/webrtc/isolation/、capture/                  | 出口规则、namespace、验证器和 TURN 侧抓包。         |
| .github/workflows/webrtc.yml                       | 单元、Chromium relay、跨浏览器、隔离 CI。           |
| docs/webrtc-\*.md                                  | 架构、边界、部署和历史测试记录。                    |

提交从旧到新：

1. `4ea4cc5d` — 架构审计及 Relay/Enforced 设计。
2. `d4a1da51` — WebRTC Realm Hook 与策略。
3. `72c7a8de` — Coturn REST 凭据和集成。
4. `6ee01bee` — Linux 隔离及证据。
5. `c21e3853` — 媒体、并发、跨域与抓包测试。
6. `7a111ad6` — WebRTC CI 与验证文档。
7. `7c6f97a9` — 运行时全局引用快照。
8. `31968351` — 测试过滤及 Node 24 运行说明。
9. `3fb20547` — 并发与合成媒体测试稳定性调整。
10. `f116bf59` — 媒体来源和性能验证缺口记录。

## 8. 建议的验收收敛顺序

1. 修复 F01，加入网页原型方法被修改时的授权 TURN 回归；构造、setConfiguration、凭据刷新和 ICE Restart 均需覆盖。
2. 修复 F02/F03，让错误规则、验证失败和规则失效保持 Fail Closed；对故意放行的路径必须报告失败。
3. 修正 F04 的进程/网络拓扑，执行完整 Linux 浏览器双栈隔离测试，加入移除隔离的真实 WebRTC 对照和客户端/Peer 侧抓包。
4. 修复新增 TS、字典输入和健康检查问题，补齐 lint/typecheck 与各测试依赖，使本分支 CI 的额外失败得到解决或可追溯的基线归因。
5. 完成凭据鉴权、签发限流、轮换/撤销、长期连接刷新及 Coturn 安全版本/ACL 验证。
6. 补齐媒体轨道变更、重新协商、多标签页、网络切换、IPv6、移动设备与性能长稳矩阵，并自动生成带运行 ID、配置与产物哈希的验收记录。

完成上述阻断修复和对应验收后，应分别重新判定 Relay 与 Enforced 两种模式。当前适合描述为“已实现 WebRTC TURN 中继主体及测试基础设施，整体工程仍处于验证与修复阶段”。

## 9. 外部规范与公告

- [S1] W3C WebRTC Statistics：`https://www.w3.org/TR/webrtc-stats/`。候选与 relayProtocol 等字段定义用于核对统计语义；跨浏览器兼容分支仍需实际网络证据。
- [S2] IETF RFC 8656：`https://www.rfc-editor.org/rfc/rfc8656.html`。TURN 方法及网络协议边界。
- [S3] Coturn 官方公告 GHSA-2x4g-wx24-48m4（2026-08-05 发布）：`https://github.com/coturn/coturn/security/advisories/GHSA-2x4g-wx24-48m4`。版本范围和拓扑条件按原公告解释。
- [S4] Coturn TURN REST API 说明：`https://github.com/coturn/coturn/blob/master/README.turnserver`。临时用户名/HMAC 与共享密钥机制。

本报告所有运行结果均受上述提交、环境与测试断言范围约束；源码确认、实际复现、历史记录和待验证项目已分别标注。
