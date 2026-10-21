# WebRTC 隔离监督与 TURN ACL 补充验证

日期：2026-10-21（Asia/Shanghai）。分支：`feat/webrtc-takeover`。本补充记录针对当前原生 WebRTC / Coturn / Linux 网络命名空间部署。

## 隔离失效时的进程终止

真实 Chromium 故障注入复现了 `run-in-netns.sh` 的终止缺陷：原实现通过 `xargs kill` 发送信号，而复用的 Linux 验证镜像只有 shell 内建 `kill`，缺少独立 `/bin/kill` 和 `/usr/bin/kill`。执行失败被清理路径忽略，监督器退出和 namespace 名称删除之后仍存在 Chromium 进程。

修复使用 Bash 内建 `kill`：先暂停 namespace 内进程，重新枚举直到 PID 集合稳定，再发送 SIGKILL。规则摘要变化和常规清理共享同一终止函数。该路径适用于不可信浏览器进程，避免依赖应用处理 SIGTERM。

新增 `tests/webrtc/isolation/test-supervisor.py` 在离线容器中启动真实原生 Chromium。确认 DevTools 监听和浏览器 PID 属于 namespace 后，分别删除规则表、插入额外 accept 规则。测试要求监督器退出码为 1、对应诊断出现、全部已观察进程退出或成为 zombie、namespace 和 veth 被清理。两项均通过；最终本机回执中，从规则变更到监督器退出分别为 0.438 秒和 0.432 秒。独立复核也通过两项测试，测得 0.383 秒和 0.504 秒。监督器按 0.5 秒周期检测，这些测量不构成零延迟终止或对拥有宿主机管理权限的攻击者的隔离保证。

```sh
rtk python3 tests/webrtc/isolation/test-supervisor.py --output /Volumes/1T/scramjet/verification/2026-10-21-supervisor-final-receipt
```

原始回执与逐场景日志保存在上述目录；独立复核位于 `/Volumes/1T/scramjet/verification/2026-10-21-independent-supervisor-review/`。两个故障注入只作用于其独占容器内的浏览器 namespace。

## TURN 敏感目标访问控制

新增 `tests/webrtc/coturn/test-peer-acl.py`，使用固定 Coturn 镜像和仓库参考配置，在 `--network none` 的容器中验证真实协议响应。测试完成双栈 Allocate 认证、校验响应 MESSAGE-INTEGRITY、校验分配地址族，并以 lifetime=0 释放分配。

18 个地址分别经过 CreatePermission 和 ChannelBind，共 36 项通过。公网 IPv4/IPv6 控制地址允许建立权限；环回、私网、共享地址空间、链路本地、云元数据、组播、IPv4-mapped IPv6、未指定 IPv6、标准 NAT64 前缀下的环回与元数据地址均得到 403。离线容器不向这些公网控制地址发送数据；本测试证明服务端权限决策，真实媒体与数据转发由 WebRTC 集成和抓包用例验证。

```sh
rtk python3 tests/webrtc/coturn/test-peer-acl.py --output /Volumes/1T/scramjet/verification/2026-10-21-turn-acl-final/permissions.json
```

JSON 记录配置、脚本哈希和固定镜像 digest；输出不含凭据。独立复核的 36 项也通过，回执为 `/Volumes/1T/scramjet/verification/2026-10-21-independent-peer-acl-review-final.json`。敏感目标拒绝覆盖的是列出的地址表示；它不能代替具体运营网络中自定义 NAT64 前缀与独立公网 peer 的部署验收。

## 媒体统计与双栈回归

本轮 IPv6 复测发现媒体测试的统计时序问题：接收端已超过 100,000 字节时，发送端独立采样仍为 99,574 字节，导致原有发送量断言失败。`packages/runway/src/tests/webrtc/media.ts` 现在在接收确认后继续读取真实 `getStats()`，最多等待 5 秒，让发送端统计更新。发送与接收字节阈值、解码帧数和候选对检查保持原有要求。失败证据保存在 `/Volumes/1T/scramjet/verification/2026-10-21-supervisor-dualstack/`。

修复后的 IPv6 媒体专项 2/2 通过，随后完整双栈复测各 9/9。覆盖真实 DataChannel、媒体、逐轨道生命周期、ICE Restart、跨域与多标签、TURN 中断恢复、资源回收和 stats 失败关闭。

| 最终复测                     | IPv4                               | IPv6                               |
| ---------------------------- | ---------------------------------- | ---------------------------------- |
| Run ID                       | `e9338c57b7e24c859fb91ffd49c12940` | `cf17cd6d9e1344cd960fa4bac6585ac8` |
| 浏览器测试                   | 9/9                                | 9/9                                |
| 授权 TURN 包                 | 5,565                              | 7,062                              |
| 正常未授权包                 | 0                                  | 0                                  |
| 故意移除隔离后的未授权包     | 15                                 | 15                                 |
| 浏览器、正向和负向分析退出码 | 均为 0                             | 均为 0                             |

运行目录为 `/Volumes/1T/scramjet/verification/2026-10-21-final-dualstack/{ipv4,ipv6}/`，包含 PCAP、JSON、日志及哈希清单。两次运行的测试源码摘要均为 `bc377def0fcec876521e75a53b19568e79c557e24722b5e4551b06071fbd279f`，基线为 `24b3dded28f04d027a0db98c4e767117112196b8` 加本轮工作树修复；具体文件与 bundle 哈希以 `source.json` 为准。此次数据持续 15 秒、媒体每阶段 2.5 秒、测试凭据 TTL 3,600 秒，长时与凭据轮换测量仍使用主报告各自的运行记录。

```sh
rtk env TURN_TTL=3600 PYTHONDONTWRITEBYTECODE=1 python3 tests/webrtc/isolation/run-linux-suite.py --output /Volumes/1T/scramjet/verification/2026-10-21-final-dualstack/ipv4
rtk env TURN_TTL=3600 PYTHONDONTWRITEBYTECODE=1 python3 tests/webrtc/isolation/run-linux-suite.py --ipv6 --output /Volumes/1T/scramjet/verification/2026-10-21-final-dualstack/ipv6
```

策略单测 14/14、凭据服务测试 2/2、Shell/Python 语法、相关 Prettier 和 `git diff --check` 均通过。独立候选补丁复核未发现可操作的旁路或兼容性回归。

## CI 与验收范围

监督器和 TURN ACL 两套新增检查接入 `.github/workflows/webrtc.yml` 的 enforced job，复用既有 Linux 验证镜像。上述最终结果是本地容器运行证据；提交后的 GitHub Actions 需按对应提交另行读回。当前远端旧提交仍存在跨浏览器媒体与原生直连控制、Coturn socket 观测失败，不能据本地双栈通过宣称全部 CI 通过。完整桌面浏览器、设备与公网环境的验收范围继续以 `webrtc-test-report.md` 和 `webrtc-device-validation.md` 为准。
