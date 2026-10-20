# Scramjet WebRTC 当前工作区完成度审计

审计日期：2026-10-20（Asia/Shanghai）。

**结论：原任务尚未完整完成，暂不满足完整严格网络隔离验收。**

TURN 中继主体、原生 WebRTC 接管、临时凭据、Linux 隔离示例和自动化基础设施已经落地。本轮真实通信复测通过，当前提交的 WebRTC 专用 CI 也通过。但发现两项可复现的安全验证缺陷，另有媒体、跨平台、网络故障和性能验收缺口。应将当前状态认定为“桌面浏览器中继功能已验证，严格模式已有受控环境证据，整体验收待收敛”。

## 1. 审计范围与证据基线

| 项目 | 基线 |
| --- | --- |
| 工作区 | `/Users/xiaosong/dev/scramjet` |
| 分支 | `feat/webrtc-takeover` |
| 审计提交 | `1750e5f2abd71385d6f597db91304725b8888cd5` |
| 开始时工作树 | 干净，与远端跟踪分支一致 |
| 上游 HEAD / 实现比较基线 | `b14b709ac190b786dd03becbd0728ab72bdd3ad6`；本轮以 `git ls-remote upstream HEAD` 核实 |
| 实现差异 | 70 个文件，8,451 行新增、27 行删除；19 个阶段提交 |
| 需求来源 | 用户上传的“Scramjet WebRTC 完整接管与防泄漏工程任务”全文 |
| 运行环境 | macOS arm64；Node 22.23.2，Runway 使用缓存中的 Node 24；pnpm 10.12.1；Docker；仓库已有 Playwright 浏览器 |
| 本轮证据目录 | `/Volumes/1T/scramjet/audits/2026-10-20-current-head-1750e5f2/` |

审计包含需求逐项映射、关键实现静态检查、当前源码重建、定向复测、CI 日志和原始 PCAP 复算、独立故障注入。它针对本任务的完成度与验收可信性，不代表全仓库穷尽安全扫描。

源码、需求原文和生成 bundle 的哈希保存在 [source-manifest.json](/Volumes/1T/scramjet/audits/2026-10-20-current-head-1750e5f2/source-manifest.json)。本轮仅新增这份仓库审计文档；复现脚本、日志和抓包保存在外接盘。

## 2. 已确认的架构和实现

实际架构为：**浏览器原生 WebRTC 协议栈 + Scramjet Realm Hook + 服务端短期凭据 + Linux Coturn；严格模式另依赖浏览器所在的 Linux 网络命名空间和 nftables。**

| 位置 | 已确认行为 |
| --- | --- |
| [shared/webrtc.ts](/Users/xiaosong/dev/scramjet/packages/core/src/shared/webrtc.ts) | `off / relay / enforced` 配置；默认 `off`；TURN 列表校验、WebIDL 字典清洗、SDP 候选解析、凭据解析、多 transport 的 selected pair 读取。 |
| [requests/webrtc.ts](/Users/xiaosong/dev/scramjet/packages/core/src/client/shared/requests/webrtc.ts) | 接入既有 Hook；构造器和别名、`setConfiguration`、`setLocalDescription`、`restartIce`、关闭清理；强制 relay 与授权 TURN；定时凭据刷新和 selected pair 检查。 |
| [Controller](/Users/xiaosong/dev/scramjet/packages/controller/src/index.ts:270) | 页面创建前等待首次凭据请求结束，维护后续刷新；请求失败会记录并重试，初次失败后由客户端拒绝无有效配置的 PeerConnection。 |
| [credential-server.mjs](/Users/xiaosong/dev/scramjet/tests/webrtc/server/credential-server.mjs) | Coturn REST/HMAC 凭据；默认鉴权、签发限流、用户撤销名单、共享密钥文件重读；测试启动器显式启用匿名 fixture。 |
| [Coturn Compose](/Users/xiaosong/dev/scramjet/tests/webrtc/docker-compose.yml) | 固定 Coturn `4.18.0-r0` 镜像及 digest；UDP/TCP/TLS 监听、端口范围、配额和敏感 Peer 地址 denylist。 |
| [policy.py](/Users/xiaosong/dev/scramjet/tests/webrtc/isolation/policy.py) / [run-in-netns.sh](/Users/xiaosong/dev/scramjet/tests/webrtc/isolation/run-in-netns.sh) | 双栈 namespace、按目标地址和端口放行、默认丢弃、原子更新、浏览器直连对照、规则摘要监控和抓包。 |
| [Runway WebRTC tests](/Users/xiaosong/dev/scramjet/packages/runway/src/tests/webrtc) | 真实 RTCPeerConnection、SHA-256 数据校验、媒体、生命周期、并发、iframe、原型污染、统计失败关闭等测试。 |
| [WebRTC CI](/Users/xiaosong/dev/scramjet/.github/workflows/webrtc.yml) | 单元、质量增量检查、真实 TURN、三种传输、Firefox/WebKit、Linux 严格隔离和产物归档。 |

`getConfiguration`、Offer/Answer、远端 SDP、`addIceCandidate`、轨道和 DataChannel 大部分操作保留浏览器原生行为；没有为满足清单而逐一重写。构造器、原型、Promise 和基本 WebIDL 行为有专门测试。未发现伪造连接成功、伪造生产 `getStats` 或用改写 Candidate 文本代替真实中继的实现。

**目标 A：已实现 TURN 中继，桌面测试范围内有真实数据证据。目标 B：已实现 Linux 受控隔离示例，完整验收仍受下述缺陷与覆盖限制。目标 C：完成了架构边界说明；当前 WebRTC 没有接入 Wisp UDP 全隧道。** Hook 不提供操作系统级网络隔离，摄像头、麦克风与屏幕采集仍属于本地浏览器能力。以上边界与源码和现有架构文档一致。

## 3. 本轮实际执行结果

以下为本轮在当前源码重新构建后执行的结果；历史记录另行标识。

| 检查 | 实测结果 | 原始证据 |
| --- | --- | --- |
| WebRTC 策略单测 | **14/14 通过** | `unit.log` |
| 凭据服务测试 | **2/2 通过** | `credentials.log` |
| 质量增量门禁 | **通过**；Core 基线/当前均 66 个 TS 错误，Controller 均 19 个；新增错误 0；两个 WebRTC 模块 lint 为 0 error、5 warning | `quality.log` |
| Core 全量 lint | **失败**；104 error、174 warning | `core-lint.log` |
| 生产 bundle 构建 | 命令退出码 **0**，但日志仍有 Core TypeScript 声明生成错误 | `build.log` |
| Chromium，TURN/UDP，全 WebRTC 集合 | **21/21 通过**，49.63 秒 | `browser-udp/chromium-results.json` |
| Firefox，TURN/UDP | **18/18 通过**，41.49 秒 | `browser-udp/firefox-results.json` |
| Playwright WebKit，TURN/UDP | **18/18 通过**，36.30 秒 | `browser-udp/webkit-results.json` |
| Chromium，单独 TURN/TCP | **1/1 通过**，18.77 秒；真实 DataChannel + ICE Restart | `browser-tcp/` |
| Chromium，单独 TURN/TLS | **1/1 通过**，17.61 秒；测试证书及忽略证书错误参数 | `browser-tls/` |
| 本轮新增验证器故障注入 | **复现误报**：真实 TCP/UDP 可达，验证器仍通过 | `verifier-final-accept.log` |
| 本轮原生浏览器负向对照 | **复现无效断言**：未加载 Hook、策略 `all` 仍通过原负向断言 | `native-negative-control.log` |

浏览器计数说明：Firefox/WebKit 的 18 项不包含 Chromium 专属的 `webrtc-relay-media`、`webrtc-relay-media-and-channel-lifecycle`、`webrtc-hook-worker-realm` 三项。18/18 不能扩展为这三个用例通过。

本轮生命周期测试实测十个应用层 RTT 样本，平均 **3.31 ms**。这是本机容器拓扑的短时测量，不是含基线对照的性能验收。

主要命令如下，工作目录为仓库根目录；完整参数、退出码和耗时保存在证据目录的 JSON 中：

```sh
rtk node --experimental-strip-types --test tests/webrtc/unit/webrtc.test.ts
rtk node --test tests/webrtc/unit/credentials.test.mjs
rtk node tests/webrtc/check-quality.mjs
rtk pnpm --dir packages/core lint
rtk pnpm exec rspack build --mode production

rtk env PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers python3 tests/webrtc/run-browser-suite.py --transport udp --output /Volumes/1T/scramjet/audits/2026-10-20-current-head-1750e5f2/browser-udp
rtk env PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers python3 tests/webrtc/run-browser-suite.py --transport tcp --browser chromium --filter webrtc-relay-datachannel --output /Volumes/1T/scramjet/audits/2026-10-20-current-head-1750e5f2/browser-tcp
rtk env PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers python3 tests/webrtc/run-browser-suite.py --transport tls --browser chromium --filter webrtc-relay-datachannel --output /Volumes/1T/scramjet/audits/2026-10-20-current-head-1750e5f2/browser-tls
```

本轮复用了已有依赖、浏览器和外接盘构建输出；三个临时 TURN 栈均由运行器清理。

## 4. 阻断与缺口

下面的优先级表示验收修复顺序，并非 CVSS 漏洞等级。

### A01 · P1 · 隔离验证器会将实际放行的规则验成通过

位置：[verify.py:45](/Users/xiaosong/dev/scramjet/tests/webrtc/isolation/verify.py:45)、[verify.py:52](/Users/xiaosong/dev/scramjet/tests/webrtc/isolation/verify.py:52)。

验证器按注释定位末尾规则，在它前面插入目标限定的 `counter drop`，随后要求该临时计数器增长。它检查了临时规则自己的丢包效果，未确认被验证的末尾规则实际执行 `drop`。

本轮在独立 `NET_ADMIN` 容器中安装原策略，将末尾规则替换为 `counter accept`，保留原注释。真实 TCP 连接和 UDP echo 均成功；随后原验证器仍输出两项 `blocked: true` 和 `ok: true`。验证结束后，末尾放行规则仍在。

```json
{
  "realUnauthorizedTcpReachable": true,
  "realUnauthorizedUdpReachable": true,
  "verifierPassed": true
}
```

证据与可运行复现：[verifier-final-accept.log](/Volumes/1T/scramjet/audits/2026-10-20-current-head-1750e5f2/verifier-final-accept.log)、[verifier-final-accept.py](/Volumes/1T/scramjet/audits/2026-10-20-current-head-1750e5f2/verifier-final-accept.py)。

```sh
rtk docker run --rm --network none --cap-add NET_ADMIN -v /Users/xiaosong/dev/scramjet/tests/webrtc/isolation:/isolation:ro -v /Volumes/1T/scramjet/audits/2026-10-20-current-head-1750e5f2:/audit:ro nicolaka/netshoot python3 /audit/verifier-final-accept.py
```

**影响：独立验证器及部署验收回执的可信性不足。** 标准安装器生成的是默认丢弃策略，监督启动器还执行真实浏览器直连对照；本结果不证明当前默认部署已泄漏，也不抹去其真实抓包证据。但仅凭验证器 `ok: true`，不能证明当时原有规则确实阻断旁路。

修复方向：验证规则的真实 verdict、链策略与预期结构；探针观测不得通过新加终止性 `drop` 改变被测结果。增加末尾 `accept`、缺失/改变 deny、异常跳转等故障注入，要求验证失败，并保留真实可达对照。

### A02 · P1 · TURN 不可用负向用例未触发 ICE，无法证明 Fail Closed

位置：[hook.ts:182](/Users/xiaosong/dev/scramjet/packages/runway/src/tests/webrtc/hook.ts:182)、[hook.ts:196](/Users/xiaosong/dev/scramjet/packages/runway/src/tests/webrtc/hook.ts:196)、[hook.ts:219](/Users/xiaosong/dev/scramjet/packages/runway/src/tests/webrtc/hook.ts:219)。同文件的 `webrtc-hook-local-sdp-has-no-direct-candidates` 也没有创建媒体或 DataChannel。

TURN 故障用例只创建空 PeerConnection 和 Offer，没有轨道、DataChannel、远端 Peer 或远端 SDP；并允许 ICE 状态为 `new`。这种情况下没有发生需要验证的 ICE 通信。

本轮将相同负向断言用于未加载 Scramjet 的原生 Chromium 页面，等待同样的 8 秒，结果如下：

```json
{
  "hookLoaded": false,
  "policy": "all",
  "connection": "new",
  "ice": "new",
  "gathering": "new",
  "sdpMediaSections": 0,
  "originalNegativeAssertionsPassedWithoutHook": true
}
```

证据：[native-negative-control.mjs](/Volumes/1T/scramjet/audits/2026-10-20-current-head-1750e5f2/native-negative-control.mjs)、[native-negative-control.log](/Volumes/1T/scramjet/audits/2026-10-20-current-head-1750e5f2/native-negative-control.log)。

**影响：该绿色用例不能作为“TURN 故障后不回退直连”的验收证明。** 源码中的 relay 强制策略仍然存在，本审计没有据此认定实际发生了回退。

修复方向：先在可直连的真实双 Peer 拓扑证明对照组能传输，再启用策略、阻断/停止 TURN，执行 Offer/Answer 和 ICE Restart；要求通信失败，并抓取客户端流量确认没有 Peer/STUN 旁路。还需加入错误凭据、已连接后的 TURN 中断及重启场景。

### A03 · P2 · 通用回归和完整质量门禁尚未收敛

当前提交的通用 CI 失败。Runway 结果为 **539 passed、143 failed、6 errors**；相对现有失败清单为 `expected=158 actual=149 unexpected=2 fixed=11`。额外失败为：

- `site-google-frontpage`
- `site-youtube-search`

这些失败是否由当前变更引入，本轮没有完成这两个站点的同环境上游基线对照，不能直接归因于 WebRTC，也不能宣告原有目标网站和网络能力全部无回归。

完整 Core lint 仍有 104 个错误。增量 TS 门禁通过只表示没有超过基线的诊断；Core 的 66 个和 Controller 的 19 个错误仍存在。构建日志出现声明生成错误却退出 0，与既有 [Rspack 声明插件](/Users/xiaosong/dev/scramjet/rspack.config.ts:173) 的错误处理方式相符。故“构建命令成功”不能代替“全量 TypeScript 与声明生成通过”。

修复方向：为两个站点做相同环境基线归因并处理验收阻断；在交付中分别报告 bundle、声明、全量 lint/typecheck、增量门禁的状态。本轮未将已有错误判为新增 WebRTC 缺陷。

### A04 · P2 · 媒体测试证明了真实收包，但未完成内容与每条轨道的验收

Chromium 测试使用动态 canvas 与 Web Audio 合成的真实轨道，已通过音视频基础传输、`replaceTrack`、移除/添加轨道、多轨道及重新协商调用。

不过 [media.ts:143](/Users/xiaosong/dev/scramjet/packages/runway/src/tests/webrtc/media.ts:143) 主要累计所有 inbound RTP 字节与解码帧；[lifecycle.ts:234](/Users/xiaosong/dev/scramjet/packages/runway/src/tests/webrtc/lifecycle.ts:234) 主要累计样本/帧计数并检查视频轨道事件数量。没有逐条新轨道在变更后的增长断言，也没有接收画面随源变化、有效音频内容或非静音能量的验证。

Firefox/WebKit 媒体、真实摄像头/麦克风、屏幕共享及其权限路径均未完成本任务要求的验收。Linux 严格 CI 只运行 DataChannel 用例，不能由桌面 Chromium 媒体通过推导出严格环境媒体也已通过。

修复方向：逐轨道采样前后 stats 和媒体内容；完成真实或明确可重复的权限/采集测试，并单列每种浏览器支持范围。

### A05 · P2 · 网络、Realm 和真实平台矩阵仍不完整

当前已覆盖配置层面的跨域 iframe、同源 iframe、`about:blank`、`srcdoc`，以及有限并发和 ICE Restart。仍缺少完整证据的要求包括：

- 跨域 iframe 内真实 DataChannel/媒体的网络出口验收；专用跨域用例只核对构造后的配置。
- 提前缓存原生 API、延迟注入竞态、动态 import/eval/Function 与刷新导航组合下的 WebRTC 专项验收。
- 独立受代理顶层标签页；当前第二 Peer 页面不等于多个受代理顶层标签页的验收。
- VPN、多网卡、网络切换、IPv6 DNS、公共双栈/NAT/NAT64 及独立公网 Peer 观察到指定 Linux 出口的矩阵。
- Windows Chromium、Android Chrome、真实 iOS Safari；Playwright WebKit 仅代表相应自动化浏览器。
- 活跃会话跨凭据到期/轮换后的持续通信、重建及重新协商；现有签发服务测试和客户端 fetch 测试不能覆盖这条完整链路。

上述能力有些可以通过原生协议栈工作，但“保留原生 API”不等于“完成对应验收”。现有部署指南有桌面运行命令，真实设备测试还需要明确的设备、证书、信令、网络观测和结果收集步骤。

### A06 · P2 · 性能和稳定性要求只完成少量短时测量

有有限并发、数据完整性、`bufferedAmount` 排空检查和十个 RTT 样本。缺少带基线的吞吐、丢包、抖动、CPU/内存、长时间音视频、反复重建、TURN allocation 回收/泄漏、网络故障恢复和 Wisp 侧相关稳定性证据。当前不能判为性能与长稳验收通过。

### A07 · P3 · 测试报告存在历史信息混用

[webrtc-test-report.md](/Users/xiaosong/dev/scramjet/docs/webrtc-test-report.md) 的环境仍写 Coturn `4.6.3-alpine`，单测仍写 `11/11`；当前配置是固定 digest 的 `4.18.0-r0`，本轮单测为 `14/14`。该文档的平台表将 Linux netns 媒体列为 synthetic tracks，但当前严格 CI 的结果 JSON 只有一个 DataChannel + ICE Restart 用例。

现有文档已坦诚列出许多未验证项，但不同阶段的记录还需要整合为按 Git SHA、run ID、环境、浏览器/传输和产物哈希索引的最终报告。早先审计的缺陷结论应结合后续修复读取；本报告以当前源码和本轮证据为准。

## 5. CI 与网络层证据复核

本轮读取了当前 HEAD 的两次工作流结果和完整日志，保存为 `ci-39431829520.*`、`ci-39431829558.*`。

| 工作流 | 状态与范围 |
| --- | --- |
| WebRTC，run `39431829520` | **成功**。质量/凭据/隔离故障注入、策略单测、Chromium Hook 与真实 relay、UDP/TCP/TLS、Firefox、WebKit、Enforced namespace 均成功。Chromium 的 CI 专用步骤为 Hook 14 项与 relay 5 项；本轮本地全集合另含两项客户端/Controller 凭据用例，共 21 项。 |
| 通用 CI，run `39431829558` | **失败**。构建、前端、包结构、Rewriter 测试通过；Run Scramjet Tests 有上文两项额外失败。发布步骤跳过。 |

工作流地址保存在对应 JSON 的 `url` 字段；该次快照的运行地址为 `https://github.com/tzf1003/scramjet/actions/runs/39431829520` 与 `https://github.com/tzf1003/scramjet/actions/runs/39431829558`，发起时间为北京时间 2026-10-20 21:36。

**当前提交的 Linux CI 原始产物：**本轮下载了 `webrtc-isolation-logs`，重新执行仓库的客户端出口分析器，结果一致：

| 字段 | 结果 |
| --- | --- |
| run ID | `ba93fa3b1a4e4357a09f26e838d47a7c` |
| 模式和实际功能 | `enforced`；DataChannel + ICE Restart，1/1 通过 |
| 原生浏览器隔离对照 | 隔离时直连被阻断；移除规则后同类直连可检测 |
| 客户端流量 | IPv4 TURN 包 598；IPv6 TURN 包 0；未授权 TCP/UDP 包 0 |
| PCAP SHA-256 | `a91901de019035896722dd67b43f78a5ebfd93a449cebcb1c0b60a243073643b` |
| 双栈阻断探针 | IPv4/IPv6 TCP、UDP 和 IPv4 UDP DNS 记录为通过；验证器可信性受 A01 限制 |

产物：[ci-isolation/](/Volumes/1T/scramjet/audits/2026-10-20-current-head-1750e5f2/ci-isolation)；复算：[reanalyzed-ci-client-egress.json](/Volumes/1T/scramjet/audits/2026-10-20-current-head-1750e5f2/reanalyzed-ci-client-egress.json)。这证明所抓取流量和该功能用例的结果，不能扩展到未运行的故障、媒体和平台组合。

**历史本地 IPv6 证据：**还重新读取了已有 `current-linux-isolation/client.pcap`，确认其哈希为 `aa5a3030c7f984d19aaec3b8d496ccda3c9f30b20cc1dfb3bab4f38698024ad6`，重算得到 IPv6 TURN 包 592、未授权包 0。对应 run ID 为 `9399d0a7725946bfb824f2a162f8a5af`。其回执未直接记录 Git SHA，本报告将其保留为历史环境证据，未与当前 HEAD 的整体验收混同。

本轮没有新运行完整 Linux 浏览器隔离流程；对当前 HEAD 的 Linux 结论来自上述 CI 原始产物和日志复核。本轮新运行的 Linux 测试是 A01 的独立故障注入。客户端 PCAP 分析器主要按已知客户端地址核对 TCP/UDP 目标，它不是覆盖所有协议、任意新接口与源地址的通用泄漏证明。

## 6. 对原任务最终验收清单的判定

| 原任务验收项 | 当前判定 |
| --- | --- |
| Scramjet 正常打开现有目标网站 | **未完全验收**：通用 CI 有两个站点额外失败，待基线归因。 |
| DataChannel 真实双向传输 | **已验证**：桌面三浏览器、文本/二进制/大消息、SHA-256；另有 Blob、ordered/unordered、negotiated 和部分可靠测试。 |
| 音频和视频正常传输 | **部分验证**：Chromium 合成轨道有真实收包/解码；内容、权限、其他平台见 A04。 |
| ICE Restart 与 Renegotiation | **部分验证**：三浏览器 DataChannel restart；Chromium 轨道重新协商；故障和平台组合未全覆盖。 |
| TURN/UDP | **已验证**：本轮三浏览器。 |
| TURN/TCP 或 TLS | **已验证限定路径**：本轮 Chromium TCP/TLS；TLS 为测试证书覆盖。 |
| 所有受支持环境 selected pair 符合策略 | **已验证测试子集**：含原生统计检查；完整平台/媒体/故障矩阵未完成。 |
| 目标 Peer 看到指定 Linux TURN 出口 | **部分验证**：受控拓扑有 TURN 通信、远端 stats 和客户端 PCAP；独立公网 Peer 出口验收未完成。 |
| 严格模式无未授权直连路径 | **暂不通过完整验收**：受控示例有有效证据，A01、A02 及未覆盖场景仍阻断全面结论。 |
| TURN 故障不回退直连 | **证据不足**：现有负向用例可在无 Hook 时通过，见 A02。 |
| IPv4/IPv6 泄漏测试 | **部分验证**：当前 HEAD IPv4 通信、双栈阻断记录及历史 IPv6 通信；DNS/切换等未完整覆盖。 |
| 跨域 iframe | **Hook 配置通过**；实际通信与出口尚未专项验收。 |
| 原有网络能力无回归 | **未完全验收**：通用 CI 未通过；未将站点失败直接归因于本变更。 |
| 关键自动化测试 | **已通过现有集合**，但 A01/A02 证明部分安全测试不足。 |
| 真实网络抓包或等价证据 | **有**：当前 CI 原始 PCAP 已复算；历史本地 IPv6 PCAP 也可追溯。 |
| 完整部署文档与复现步骤 | **主体齐备**；最终报告版本一致性、真实设备/网络/长稳步骤仍需补齐。 |

不存在有依据的“整体完成百分比”；功能实现、验证覆盖和验收缺陷不能用测试通过比例互相替代。

## 7. 交付物与阶段提交

原任务指定的四份架构/安全/部署/测试文档、`tests/webrtc/`、Coturn 配置、隔离与抓包脚本、CI、示例环境变量均存在。变更目的可通过以下阶段提交追溯；尚缺的是完整、统一且满足全部条件的最终验收记录。

| 提交 | 目的 |
| --- | --- |
| `4ea4cc5d` | 架构审计、relay/enforced 设计 |
| `d4a1da51` | WebRTC Realm Hook 与 relay 策略 |
| `72c7a8de` | Coturn、HMAC 凭据与集成 |
| `6ee01bee` | Linux 隔离与证据 |
| `c21e3853` | 媒体、并发、跨域与抓包测试 |
| `7a111ad6` | WebRTC CI 和验证文档 |
| `7c6f97a9` | 全局引用快照 |
| `31968351` | 测试过滤、Node 24 运行说明 |
| `3fb20547` | 并发和合成媒体测试调整 |
| `f116bf59` | 媒体来源及性能缺口记录 |
| `8727fd73` | relay 策略、凭据和隔离修复 |
| `cda980c0` | 原型污染、统计失败、生命周期及监督隔离测试 |
| `326b6811` | 修复与隔离证据记录 |
| `67f3de6d` | CI 客户端出口 PCAP 检查 |
| `a82babe9` | namespace 转发规则 |
| `ac7d4b11` | UDP/TCP/TLS CI 矩阵 |
| `15e7dfc4` | Python bytecode 忽略规则 |
| `5919d4de` | TLS 测试密钥加载与 restart 时序 |
| `1750e5f2` | Runway 多 frame 测试端口冲突重试 |

## 8. 建议的验收收敛顺序

1. 修复 A01、A02，并将本轮两种对照纳入自动化；真实 TURN 中断、错误凭据和 ICE Restart 的负向路径必须有网络层证据。
2. 对当前 HEAD 重新执行 Linux 严格模式，覆盖 IPv4/IPv6、DNS、跨域通信、媒体和策略故障；把运行配置、Git SHA、日志和 PCAP 哈希绑定到同一份产物清单。
3. 处理或同环境基线归因通用 CI 额外失败，明确 bundle/声明、全量质量检查和增量门禁的不同结果。
4. 完成每轨道媒体内容、凭据生命周期、独立标签页和网络切换矩阵；为真实 Windows/Android/iOS 给出可执行步骤及真实结果。
5. 完成带基线的性能/长稳测试，整合文档，再分别判定 Relay 与 Enforced 的正式支持范围。

**最终判定：可确认 WebRTC TURN 中继及 Linux 受控隔离示例具备实质实现和真实测试成果；按上传任务的全部要求，当前工作区仍有明确的验收阻断与未验证项，不能宣布完整完成。**

## 9. 规范参考

本轮核对了 W3C WebRTC 与 Statistics 规范、Coturn 官方 TURN 配置说明及上游仓库。实际实现和执行结论均以本报告列出的本地源码、日志、CI 和 PCAP 为依据。

- W3C WebRTC：`https://www.w3.org/TR/webrtc/`
- W3C WebRTC Statistics：`https://www.w3.org/TR/webrtc-stats/`
- Coturn 官方配置说明：`https://github.com/coturn/coturn/blob/master/README.turnserver`
- Scramjet 上游：`https://github.com/MercuryWorkshop/scramjet`
