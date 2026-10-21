# WebRTC 审计问题修复记录

日期：2026-10-21。对应审计：`webrtc-current-state-audit-2026-10-20.md`。基线：`1750e5f2abd71385d6f597db91304725b8888cd5`，分支：`feat/webrtc-takeover`。

**结果：A01/A02 的验证缺陷已关闭；质量、媒体、Realm、故障恢复和证据链已补齐可执行部分。受控 Linux 双栈验收通过；桌面浏览器结果按运行快照列示。真实设备和公网复杂网络保留明确验收边界。**

## 逐项处理

| 审计项                        | 修复与验证                                                                                                                                                                      | 状态                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| A01 验证器误报                | 安装器/验证器共用完整规则规范；核对链策略、优先级、规则顺序和全部放行；探针仅计数；额外 accept、条件 deny、return、重复标记和 accept policy 故障注入均被拒绝，真实可达控制通过  | 已关闭                                                  |
| A02 负向用例未触发 ICE        | 实际 DataChannel、完整双 peer SDP、可直连正向控制、错误凭据、不可达 TURN、ICE Restart、已连接 TURN 暂停/重启、网络中断；off 模式控制确认检测器可识别直连成功                    | 已关闭                                                  |
| A03 质量与通用回归            | 全量 TS/Core lint 零错误；声明生成等待完成并传播失败；修复单包依赖；匹配 WASM 与胶水并增加构建/包校验；Google/YouTube 定位与语言固定；696 项回归额外失败 0                      | 本轮门禁通过，既有预期失败继续保留                      |
| A04 媒体内容与每轨验证        | Chromium/Firefox/WebKit 逐轨统计增长、实际视频颜色和音频能量；add/remove/replace/transceiver/重新协商；Chromium 虚拟设备真实采集 API、双视频与音频接收；Linux enforced 媒体通过 | 自动化范围完成；物理设备未验证                          |
| A05 Realm、生命周期与网络矩阵 | 跨域 iframe 与独立受代理顶层标签页真实通信；缓存构造器、eval/Function/import、导航；活跃凭据刷新/到期关闭、双栈 DNS、链路中断恢复；真实设备探针和步骤落地                       | 当前环境完成；Windows/移动端、公网 NAT64/VPN/多网卡待验 |
| A06 性能与稳定性              | 原生基线/真实 TURN、SHA-256 吞吐、RTT、逐轨 jitter/loss、页面 CPU/heap、120 秒持续传输、三次重建和实际 TURN socket 释放；短 TTL 连续轮换                                        | 短时测量完成；小时级和系统总体资源曲线待验              |
| A07 报告追踪                  | 重写当前测试报告，固定实际 Coturn digest、浏览器/用例范围、命令、run ID、源码和 bundle 哈希、PCAP 与负向控制；保留原始审计                                                      | 已完成                                                  |

## 核心实现位置

- `packages/core/src/client/shared/requests/webrtc.ts`：捕获原生 restartIce，活跃凭据或 TURN URL 变化时请求原生 ICE 重启，并由应用完成信令；失败继续关闭。
- `tests/webrtc/isolation/policy.py`、`verify.py`、`regression.py`：完整 allowlist、终止规则、链策略和故障注入验证。
- `tests/webrtc/isolation/run-linux-suite.py`、`run-in-netns.sh`、`runner_control.py`：可信外层故障注入、双栈地址/路由恢复、Coturn 稳定 relay 绑定、task-owned 清理。
- `tests/webrtc/capture/check-client-egress.py`、`browser-control.mjs`：方向性抓包、非 TCP/UDP 出口检查、正向/负向 PCAP。
- `packages/runway/src/tests/webrtc/`：真实对端、采集、媒体内容、故障、Realm、生命周期、性能和凭据轮换。
- `rspack.config.ts`、`tests/webrtc/check-quality.mjs`、`tests/ci/packageValidation.js`：全量零错误门禁、真实重写包验证、原始 WASM 输入拒绝、声明生成失败传播。
- Core/Controller 相关类型和原生绑定文件：修复门禁暴露的既有 TS/lint 错误，并以全量回归核对行为。
- `.github/workflows/webrtc.yml`：真实故障控制、三浏览器、传输矩阵及 IPv4/IPv6 严格运行器；`.github/workflows/main.yml`：使用同一可复现运行器执行通用回归。

## 验收结果

- Chromium WebRTC 29/29；Firefox 25/25；Playwright WebKit 25/25。
- TURN/TCP 三浏览器各 1/1；Chromium TURN/TLS 1/1。
- Linux enforced IPv4/IPv6 各 9/9；正向抓包未授权包均为 0；故意开启直连的负向抓包均检测到 15 包，两个分析命令均退出 0。
- 全量通用回归：551 通过、139 预期失败、6 预期错误，`unexpected=0`。失败清单保持原样。
- 严格 IPv6 的 TTL 30 秒、120 秒持续传输记录 5 次实际轮换，三次重建成功，TURN socket 0→2→0。
- Core/Controller TS 0 错误，Core lint 0 错误/168 warning，生产构建与声明通过，包校验 5/5。

上述为修复阶段矩阵。发布前重新核对 `336a9259`：Chromium 29/29、Firefox 25/25、Linux IPv4/IPv6 各 9/9，正常出口未授权包均为 0。当前 VPN 环境中 WebKit 使用局域网 TURN 后为 23/25，两项原生直连前置控制超时；TURN UDP/TCP 单项通过。运行器新增显式 `--turn-host` 和地址记录。CI 干净环境的 WASM 类型依赖通过 `a7ea5c83` 补齐，质量门禁重跑通过。

完整命令、运行目录、实际测量和限制见 `webrtc-test-report.md`。源码修复、实测通过与环境尚未提供的证明在报告中分别列出。

后续 CI 稳定性修复与完整复验见 [webrtc-ci-repair-2026-10-21.md](webrtc-ci-repair-2026-10-21.md)：三浏览器 29/25/25、Linux 双栈各 9/9，实际媒体和直连对照均通过；正常抓包未授权包为 0，负向对照各检测 15 包。

## 部署使用要求

1. 在可信 Controller 上配置模式、授权 TURN 和短期凭据 endpoint，等待 Controller ready 后创建 frame。
2. 处理原生 `negotiationneeded`；凭据更新/网络切换需要应用信令。信令隧道失效时初始化新 transport 并调用 Controller.setTransport，再重建失败的会话。
3. 严格模式将浏览器进程实际放入 Linux 网络边界；配置对应 IPv4/IPv6、TURN listener 和必要的显式 relay 范围。
4. 核对规则回执、正常抓包、直连负向控制与真实媒体/数据送达后，才能对该部署作严格验收结论。
5. 多网卡 Coturn 配置固定 relay-ip 和正确 external-ip 映射，避免重启发现临时接口导致地址不一致。

## 交付边界

本次验证支持桌面自动化浏览器和受控 Linux 拓扑。物理摄像头/麦克风/屏幕、Windows/Android/iOS、公共可信 TURN/TLS、公网 NAT64/VPN/多网卡及小时级长稳需要对应设备与网络。按 `webrtc-device-validation.md` 使用原生探针可继续收集这些证据。完整跨平台全场景目标尚不能由本机结果保证。
