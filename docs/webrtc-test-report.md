# WebRTC 修复验证报告

验证日期：2026-10-21（Asia/Shanghai）。基线提交：`1750e5f2abd71385d6f597db91304725b8888cd5`，分支：`feat/webrtc-takeover`。

**受控 Linux IPv4/IPv6 严格隔离验收通过；桌面 Chromium、Firefox、Playwright WebKit 的已运行 WebRTC 集合通过。** 真实设备、公网 NAT64/VPN/多网卡和小时级稳定性仍需相应环境验收。此前审计保留在 `webrtc-current-state-audit-2026-10-20.md`；本报告记录修复后的执行结果。

## 1. 实际架构与边界

浏览器原生 ICE/DTLS/SRTP/SCTP + Scramjet Realm Hook + 短期 TURN 凭据 + Linux Coturn。`relay` 强制授权 TURN 与 relay 策略，`enforced` 在其上要求浏览器实际进入 nftables 网络命名空间。Offer/Answer、远端 SDP、媒体、DataChannel、事件和 stats 维持原生实现。

媒体采集发生在本地设备；应用负责 `negotiationneeded` 信令。TURN 重启或信令隧道断开后，应用恢复 transport 并重建失败的原生会话。Wisp 继续承载 HTTP/WebSocket；WebRTC 由 TURN 中继。

## 2. 环境与证据索引

- macOS 27.0.1 arm64；Docker 29.8.2；Runway Node 24.22.0；pnpm 10.12.1。
- Playwright 1.61.0：Chromium 149.0.7827.55、Firefox 151.0、WebKit 26.5。
- Coturn `4.18.0-r0`，固定镜像 digest `bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3`。
- Linux：复用 `scramjet-webrtc-linux-verification:local`，Chromium 在受监督的双栈 namespace 内，运行器和服务在外。
- 原始证据目录：`/Volumes/1T/scramjet/verification/2026-10-20-audit-fixes/`。

每个运行目录的 `source.json` 记录源码 SHA-256、基线 Git SHA；新版还记录运行 bundle 哈希。`run.json` 或 `results.json` 记录模式、运行编号与退出码；`manifest.json` 记录产物哈希。测试在工作树修复过程中逐阶段执行，最终索引区分各次源码快照，不能把所有结果表述成同一不可变提交的一次执行。PCAP 和临时凭据仅保存在授权证据目录。

| 目录                              | 内容                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| `final-quality/`                  | 策略单测、凭据服务、全量质量、构建、包验证、隔离故障注入日志 |
| `acceptance-regression/`          | Chromium 全部 Runway 回归及其中 29 项 WebRTC                 |
| `final-browser-matrix/`           | Firefox/WebKit 各 25 项 WebRTC                               |
| `final-tcp/`、`final-tls/`        | TURN 传输矩阵                                                |
| `final-ipv4/`、`final-ipv6/`      | 严格环境各 9 项、120 秒数据持续传输和 20 秒/阶段媒体         |
| `final-credential-rotation-ipv6/` | TTL 30 秒，120 秒传输、多次实际轮换与三次重建                |
| `rotation-verified-ipv6/`         | TTL 10 秒，20 秒传输、两次实际轮换与三次重建                 |
| `final-baseline-comparison/`      | Google 应用菜单的同环境基线对照，后续固定语言用例通过        |

## 3. 质量、构建与通用回归

| 检查                                      | 实测结果                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| WebRTC 策略单测                           | 14/14 通过                                                             |
| 凭据服务鉴权、轮换等测试                  | 2/2 通过                                                               |
| Core 全量 TypeScript                      | 0 错误                                                                 |
| Core 声明 TypeScript                      | 0 错误                                                                 |
| Controller 全量 TypeScript                | 0 错误                                                                 |
| Core 全量 lint                            | 0 错误，168 条 warning                                                 |
| 全部生产 bundle 和声明构建                | 退出码 0；声明失败现在会使构建失败                                     |
| 包结构与实际 WASM 重写                    | 5/5 通过（Node 24）                                                    |
| Bootstrap 单包依赖构建                    | Core、Controller、Bootstrap 声明及 bundle 通过                         |
| 锁文件离线冻结安装                        | 通过                                                                   |
| 隔离规则故障注入                          | 通过；真实可达控制、额外放行、终止 verdict、重复标记、链策略、原子更新 |
| Python、namespace shell、设备探针 JS 语法 | 通过                                                                   |
| Chromium Runway 全集                      | 551 通过、139 失败、6 错误；预期失败差异 `unexpected=0`、`fixed=13`    |
| Google/YouTube 四个站点用例               | 全部通过                                                               |

既有失败清单保持原样；139 失败和 6 错误仍属于仓库现有回归债务。本轮门禁的额外失败为 0。

本轮修复了本地分发 WASM 与 wasm-bindgen 胶水不匹配的问题：原始 WASM 存在 `__wbindgen_placeholder__` 导入，浏览器重写会失败。当前使用同一 Rust 构建经 wasm-bindgen 处理、wasm-opt 优化的产物；新增构建前拒绝原始输入及包级真实 `rewriteJs` 校验。通用回归因此应以 `acceptance-regression/` 为准。

## 4. 浏览器与媒体

| 环境                                              | WebRTC 结果 | 媒体范围                                                               |
| ------------------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| macOS Chromium                                    | 29/29       | 动态 canvas + Web Audio、逐轨道内容、浏览器虚拟摄像头/麦克风和桌面采集 |
| macOS Firefox                                     | 25/25       | 真实原生 RTP，动态合成音视频、逐轨道内容与生命周期                     |
| macOS Playwright WebKit                           | 25/25       | 同上；单列为自动化 WebKit                                              |
| Linux Chromium enforced / IPv4 TURN               | 9/9         | 媒体、采集、DataChannel、跨域/多标签、故障恢复、性能、stats 失败关闭   |
| Linux Chromium enforced / IPv6 TURN               | 9/9         | 同上                                                                   |
| Windows Chromium、Android Chrome、真实 iOS Safari | 未验证      | 需要真实设备记录                                                       |

三种桌面浏览器均执行错误凭据、TURN 不可达、可直连正向控制、off 模式检测控制、ICE Restart、活跃凭据刷新与到期关闭。跨域 iframe 与另一个真实受代理顶层标签页交换 DataChannel；提前缓存 API、eval/Function、动态 import 与刷新导航均有专项检查。

每个有效接收轨道分别比较媒体变更前后字节/包/解码计数；视频实际渲染到 canvas，要求多种颜色变化；音频通过接收轨道的 AudioContext analyser 验证非静音信号。逐阶段覆盖 replaceTrack、移除、重新添加、多轨与重新协商。Chromium 虚拟采集用例调用真实 getUserMedia/getDisplayMedia 权限路径并接收两条视频和一条音频，物理设备与系统对话框仍需单独验证。

## 5. TURN 传输矩阵

| 传输 | Chromium | Firefox  | WebKit   |
| ---- | -------- | -------- | -------- |
| UDP  | 全集通过 | 全集通过 | 全集通过 |
| TCP  | 1/1      | 1/1      | 1/1      |
| TLS  | 1/1      | 未验证   | 未验证   |

每个单项为真实 DataChannel + ICE Restart。TLS 使用测试自签名证书与 Chromium 测试证书覆盖参数；生产可信证书部署需要独立记录。

## 6. 严格网络隔离证据

验证器与安装器共用完整 endpoint 规范，核对每条实际规则、链策略、优先级和最终无条件 drop。临时探针仅计数，拒绝行为来自被测策略。覆盖 IPv4/IPv6 TCP、UDP、TCP/UDP DNS 与 relay 范围外端口。

正常抓包按出口方向分析；允许配置的 Scramjet 服务、TURN 地址/端口以及有限邻居发现。测试显式启用授权 TURN 地址的 relay 端口范围，部署默认关闭该附加范围。每次正常运行之前，独立控制删除规则，确认真实原生直连可以被捕获；恢复规则后确认直连失败。

| 项目                 | IPv4 运行                          | IPv6 运行                          |
| -------------------- | ---------------------------------- | ---------------------------------- |
| Run ID               | `b47cda2061a14fa6bd55e11589bd2b48` | `3f9e64f4015e43b095fa477ecc906c88` |
| 浏览器测试           | 9/9                                | 9/9                                |
| IPv4 TURN 包         | 10,394                             | 3                                  |
| IPv6 TURN 包         | 0                                  | 9,843                              |
| 正常未授权包         | 0                                  | 0                                  |
| 负向控制检测未授权包 | 15                                 | 15                                 |
| 正常/负向分析命令    | 均退出 0                           | 均退出 0                           |

准确 run ID、policy/PCAP 哈希以对应 JSON 为准。IPv6 运行使用 IPv6 TURN 控制连接，分配给 peer 的 relay candidate 可以是 IPv4；它不代表 IPv6-only peer 或 NAT64 验收。

故障恢复实际执行 Coturn pause/unpause/restart、客户端 veth down/up、恢复信令 transport、重建 PeerConnection，并要求消息实际送达。Linux 启动器保留静态 IPv6 地址并恢复默认路由；Coturn 显式绑定稳定 relay 地址，防止重启后选中临时客户端 veth。

## 7. 性能与资源

严格环境分别执行 120 秒数据持续回传、每阶段 20 秒媒体（共三阶段），记录每条轨道 jitter/loss、30 个 RTT 样本、约 1 MiB SHA-256 数据往返、3 次会话重建、CDP 页面 CPU 时间/堆及 Coturn 实际 relay socket 身份。

| 本机受控测量         | IPv4        | IPv6        |
| -------------------- | ----------- | ----------- |
| 原生直连平均应用 RTT | 5.24 ms     | 5.16 ms     |
| TURN 平均应用 RTT    | 5.36 ms     | 5.13 ms     |
| 原生往返吞吐         | 60.42 MiB/s | 40.73 MiB/s |
| TURN 往返吞吐        | 3.96 MiB/s  | 0.95 MiB/s  |
| 逐轨道样本丢包       | 0           | 0           |
| 采样 jitter          | 0–3 ms      | 0–3 ms      |

吞吐包含回传两个方向；Coturn 限流、共享容器、自动化开销及本机拓扑影响测量，不能用作公网服务 SLA。CDP TaskDuration 与 JSHeap 有原始前后值，未据此宣称系统总 CPU 或长期内存泄漏已排除。新增 socket 身份均释放，数量回到运行前水平；运行前已有的其他测试 allocation 单列保留。

短 TTL 轮换另行验证：TTL 10 秒的 20 秒传输记录两次凭据变化，原生重新协商后持续回传，三次重建成功，relay socket 为 0→2→0。另一个 TTL 30 秒、120 秒运行记录 5 次真实凭据轮换，重建与资源回收通过，正向/负向抓包分析均通过。

## 8. 复现命令

工作目录为仓库根目录，浏览器与依赖使用已有缓存：

```sh
rtk node --experimental-strip-types --test tests/webrtc/unit/webrtc.test.ts
rtk node --test tests/webrtc/unit/credentials.test.mjs
rtk node tests/webrtc/check-quality.mjs
rtk env CI=1 pnpm exec rspack build --mode production
rtk npx --offline node@24 node_modules/ava/entrypoints/cli.mjs tests/ci/packageValidation.js
rtk env PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers python3 tests/webrtc/run-browser-suite.py --output /Volumes/1T/scramjet/verification/browser-matrix
rtk env PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers OMIT_WPT=1 python3 tests/webrtc/run-browser-suite.py --browser chromium --filter "" --output /Volumes/1T/scramjet/verification/regression
rtk env TURN_TTL=3600 WEBRTC_SOAK_SECONDS=120 WEBRTC_MEDIA_SOAK_SECONDS=20 python3 tests/webrtc/isolation/run-linux-suite.py --output /Volumes/1T/scramjet/verification/enforced-ipv4
rtk env TURN_TTL=3600 WEBRTC_SOAK_SECONDS=120 WEBRTC_MEDIA_SOAK_SECONDS=20 python3 tests/webrtc/isolation/run-linux-suite.py --ipv6 --output /Volumes/1T/scramjet/verification/enforced-ipv6
```

同一主机浏览器运行器使用固定端口，应顺序运行；测试内部执行真实并发连接。Linux 每次创建自身容器与网络，并在 finally 清理。构建位置复用外接盘，依赖不重复下载。

## 9. 尚需环境验证的项目

- 真实摄像头、麦克风、显示设备及系统权限拒绝/撤销路径。
- Windows Chromium、Android Chrome、iOS Safari，以及对应系统强制隔离实现。
- 独立公网 peer 观察指定 Linux 公网出口，公共双栈/NAT64、VPN、多网卡和跨真实网络切换。
- 公共可信 TURN/TLS 证书、Firefox/WebKit TLS、小时级音视频/数据稳定性和操作系统总体资源曲线。

`webrtc-device-validation.md` 和 `tests/webrtc/device-probe.html` 提供真实设备及独立公网 peer 的信令、哈希、媒体与 stats 导出流程。当前环境可执行的阻断缺陷已修复；上述项目保持未验证，整体跨平台全场景验收仍待这些环境证据。
