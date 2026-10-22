# 泛域名网页代理

访问 `https://baidu-com.derp.xs2api.com:8443/test/`，页面自动加载
`https://baidu.com/test/`，仅展示全屏目标网页。路径、查询参数、锚点均保留。
外部端口 `8443` 用于连接代理服务器，目标站默认使用 HTTPS 标准端口。

目标域名的点编码为连字符，形成代理根域名下的一个标签。例如
`a.b.c.example.com` 对应 `a-b-c-example-com.derp.xs2api.com`。
目标域名原有的连字符编码为双连字符：`my-site.com` 对应
`my--site-com.derp.xs2api.com`。国际化域名先使用 Punycode，再按同样规则编码；
编码结果以浏览器保留的 `xn--` 开头时，生成的链接使用显式目标参数。
HTTPS 目标的非标准端口附加在标签末尾：`example.com:9443` 对应
`example-com-9443.derp.xs2api.com`，代理入口仍可使用 `:8443`。数字后缀专用于
目标端口，IPv4/IPv6 地址使用显式目标参数。端口取值为 1–65535，HTTPS 默认端口
443 省略。编码后的完整标签仍须满足 63 字符限制。
入口解析和新标签页链接生成使用相同规则。旧的多级入口需改为扁平化格式；
更换入口域名后，浏览器存储按新域名独立保存。

## 配置与运行

前端构建时设置 `VITE_PROXY_DOMAIN`，默认值为 `derp.xs2api.com`。
`packages/demo/.env.example` 提供配置示例；可复制为该目录的 `.env.local`。
Wisp 默认连接当前域名、当前端口的 `/wisp/`，HTTPS 页面自动使用 WSS。
若单独部署 Wisp，可通过 `VITE_WISP_URL` 指定完整 WebSocket 地址。

```sh
# 本地开发，*.localhost 由浏览器解析到本机。
VITE_PROXY_DOMAIN=localhost pnpm dev
# 访问 http://example-com.localhost:4141/test/

# 生产构建。
VITE_PROXY_DOMAIN=derp.xs2api.com pnpm --dir packages/demo build
pnpm --dir packages/demo test:proxy
```

开发服务器同时监听 4141（前端）和 4142（Wisp），均可通过
`DEMO_PORT` / `WISP_PORT` 调整。开发前端将 `/wisp/` 转发至本机 Wisp。
Service Worker 从根路径 `/sw.js` 注册，作用域为 `/`，支持深层路径首次访问。

构建复用已有依赖。挂载 `/Volumes/1T` 时，默认产物和 Vite 缓存分别写入
`/Volumes/1T/scramjet/build/demo/dist` 和同级 `vite-cache`；其他环境产物写入
`packages/demo/dist`。可用 `SCRAMJET_DEMO_OUT_DIR` 指定专用产物目录；构建会清空该目录。

## DNS 与 TLS

将 `*.derp.xs2api.com` 的 DNS 记录指向代理入口，代理访问域名均位于该根域名下一级，
例如 `baidu-com.derp.xs2api.com` 和 `www-baidu-com.derp.xs2api.com`。
生产访问必须使用受浏览器信任的 HTTPS，以便启用 Service Worker。

配置 `*.derp.xs2api.com` 的 TLS 通配符证书即可覆盖这些扁平化入口。
如需通过 HTTPS 访问根域名 `derp.xs2api.com` 本身，证书还需包含该名称。

## 反向代理

生产入口应提供构建目录中的静态文件，并将所有目标网页路径回退到 `index.html`。
例如下面的 Nginx 配置；替换证书和产物路径，并使用独立运行的 Wisp 服务。
配置中的 `4142` 为 Wisp 后端端口。`pnpm dev` 可用于开发联调，生产应部署静态产物。

```nginx
server {
    listen 8443 ssl;
    server_name .derp.xs2api.com;
    ssl_certificate     /etc/nginx/certs/proxy-fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/proxy-key.pem;

    root /srv/scramjet;

    location ^~ /wisp/ {
        proxy_pass http://127.0.0.1:4142;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $http_host;
        proxy_read_timeout 3600s;
    }

    location = /sw.js {
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }
    location = /icon.png { try_files $uri =404; }
    location ^~ /scramjet/ { try_files $uri =404; }
    location ^~ /controller/ { try_files $uri =404; }
    location ^~ /assets/ { try_files $uri =404; }

    location / {
        # HTML 文档路径（包括 /test.html）统一从代理入口启动。
        try_files /index.html =404;
    }
}
```

入口保留 `/sw.js`、`/icon.png`、`/scramjet/`、`/controller/`、`/assets/` 和
`/wisp/` 作为代理资源路径；开发时还保留 `/src/`、`/node_modules/`、`/@vite/`、
`/@id/` 和 `/@fs/`。`/__scramjet_handoff` 用于跨域导航状态交接。访问目标站
这些路径时，使用下面的显式目标参数入口，避免与代理运行文件冲突。

## 页面跳转与刷新

同一目标主机内跳转时，地址栏同步目标路径。站内页面历史由浏览器的 iframe
历史处理，浏览器返回/前进可正常使用。普通 HTTPS 跨站 GET 导航会切换到目标的
扁平化代理域名。例如，从百度入口点击 `https://accounts.example.com/login`：

```text
https://accounts-example-com.derp.xs2api.com:8443/login
```

HTTPS 自定义目标端口也直接编码到域名，例如：

```text
https://example-com-9443.derp.xs2api.com:8443/test/
→ https://example.com:9443/test/
```

切换域名前，代理通过目标域名下的隐藏入口交接当前标签页的导航状态；仅传递
同时适用于来源和目标域名的 Cookie，保留 HttpOnly 等属性，并合入目标控制器的
持久化存储。目标入口已有的其他 Cookie 保持其作用域。
交接消息核验窗口、代理域名、协议、代理端口和随机令牌。状态有效期为 30 秒，
消费后删除；Cookie 不进入地址栏。Cookie 作用域通过公共后缀列表校验，包含
私有后缀（如 `github.io`）。首个请求的来源、Referer 和 SameSite 上下文按
发送方实际代理域名校验；跨站交接即使隐藏 Referer 也会执行跨站 Cookie 限制。
`localStorage`、IndexedDB 等网页存储仍按代理域名独立，交接不提供跨标签页的
持续 Cookie 同步。目标服务器应允许同一代理根域名下的入口相互嵌入，
并将 `GET /__scramjet_handoff` 回退到同一个 `index.html`。

跨站 POST 表单继续保留原控制器和请求体，地址栏以 `__scramjet_url` 参数记录
目标。HTTP、IP 地址、保留资源路径、含保留参数的目标地址，以及超长或无法编码的
域名也使用该参数。交接受到浏览器存储限制、入口策略阻止或超时时，同样保留当前
控制器继续加载；刷新可恢复目标地址。例如：

```text
https://baidu-com.derp.xs2api.com:8443/?__scramjet_url=http%3A%2F%2Fexample.com%2F
```

新标签页中的 HTTPS 链接使用目标泛域名及可选目标端口；新标签页使用该代理域名
已有的浏览器存储。
该参数只接受 HTTP(S) 绝对地址，且拒绝 URL 内嵌用户名和密码。

根域名本身没有目标主机，访问时显示地址说明。现有环境预设与字体保护继续生效，
默认配置见 `packages/demo/src/environment.ts`。

## 导航回归验证

`pnpm --dir packages/demo test:proxy` 验证编码、端口和交接状态校验。
`pnpm --dir packages/demo test:navigation` 使用 Playwright 驱动本机 Chrome，
验证跨站、端口、刷新、历史、Cookie 作用域、POST 和交接失败后的回退。
浏览器测试以本地上游响应替代 Wisp 网络传输；Service Worker 和控制器使用实际实现。
可通过 `BROWSER_CHANNEL` 选择已安装的浏览器通道，`SCRAMJET_NAVIGATION_OUTPUT`
指定证据目录。CI 复用 runner 自带的 Chrome，并在失败时上传证据。
