# 泛域名网页代理

访问 `https://baidu.com.derp.xs2api.com:8443/test/`，页面自动加载
`https://baidu.com/test/`，仅展示全屏目标网页。路径、查询参数、锚点均保留。
外部端口 `8443` 用于连接代理服务器，目标站默认使用 HTTPS 标准端口。

## 配置与运行

前端构建时设置 `VITE_PROXY_DOMAIN`，默认值为 `derp.xs2api.com`。
`packages/demo/.env.example` 提供配置示例；可复制为该目录的 `.env.local`。
Wisp 默认连接当前域名、当前端口的 `/wisp/`，HTTPS 页面自动使用 WSS。
若单独部署 Wisp，可通过 `VITE_WISP_URL` 指定完整 WebSocket 地址。

```sh
# 本地开发，*.localhost 由浏览器解析到本机。
VITE_PROXY_DOMAIN=localhost pnpm dev
# 访问 http://example.com.localhost:4141/test/

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

将 `*.derp.xs2api.com` 的 DNS 记录指向代理入口，并确认 DNS 服务可解析
`baidu.com.derp.xs2api.com` 和 `www.baidu.com.derp.xs2api.com` 等多层名称。
生产访问必须使用受浏览器信任的 HTTPS，以便启用 Service Worker。

TLS 通配符只匹配一个标签：`*.derp.xs2api.com` **不能**覆盖
`baidu.com.derp.xs2api.com`。需要为实际访问的完整主机名签发证书，或在受控客户端
安装受信任的私有 CA 并按主机名签发证书。公开部署可为允许访问的目标主机预签发
证书，并在入口按 SNI 选择证书。DNS 泛解析与证书覆盖范围需要分别配置。

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
`/@id/` 和 `/@fs/`。访问目标站这些路径时，可使用下面的显式目标参数入口。

## 页面跳转与刷新

同一目标主机内跳转时，地址栏同步目标路径。站内页面历史由浏览器的 iframe
历史处理，浏览器返回/前进可正常使用。跨站跳转保持当前控制器运行，以保留当前
表单请求、Cookie 和代理连接，地址栏使用 `__scramjet_url` 参数记录完整目标地址，
刷新可恢复当前页面。例如：

```text
https://baidu.com.derp.xs2api.com:8443/?__scramjet_url=https%3A%2F%2Faccounts.example.com%2Flogin
```

新标签页中的标准 HTTPS 链接使用对应的目标泛域名。HTTP、IPv6、非标准目标端口
和含保留参数 `__scramjet_url` 的目标地址使用显式目标参数，以保留原始 URL。
该参数只接受 HTTP(S) 绝对地址，且拒绝 URL 内嵌用户名和密码。
各代理域名的浏览器存储独立，新标签页切换代理域名时登录状态不共享。

根域名本身没有目标主机，访问时显示地址说明。现有环境预设与字体保护继续生效，
默认配置见 `packages/demo/src/environment.ts`。
