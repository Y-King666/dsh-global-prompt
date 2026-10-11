# dsh-global-prompt

在 DSH 设置页加一个「全局提示词」分区：一个大输入框 + 保存 / 取消，写入用户级全局指令文件
`~/.dsh/AGENTS.md`（即 `$DSH_HOME/AGENTS.md`），由 DSH 官方的 `dsh-agent-instructions` 插件在会话中注入 Agent 上下文。

## 为什么不需要自己写注入

`@deepseek-ai/dsh-agent-instructions`（`dsh-base` 默认启用，config `maxBytes: 65536`）在会话开始时读取
`join(dshHome, "AGENTS.md")` 这个用户级全局文件，包成 `<system-reminder>` 注入上下文，并在每一步通过
`reconcileInstructionContext` 比对文件版本。因此本插件只负责**写那个文件**，注入沿用官方现成机制。

实测（本机 web GUI）：保存后**同一会话的下一步**就收到
`<system-reminder>Instructions from: ~/.dsh/AGENTS.md …</system-reminder>`；删除文件后收到
`Instructions removed: ~/.dsh/AGENTS.md`。无需等待新会话。

## 结构

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半边：`ctx.webServer.register({ kind: 'exact', path: '/global-prompt/api', handler })`。GET 读取现状，POST 覆盖写入。只 import Node 内置模块。 |
| `lib/client.js` | 客户端半边：自注册 bundle（`window.__ModuleLoader__.load({...})`），只 `require('react')`，向 `settings.section` 注册分区。 |
| `cordis.patch.yml` | 向 profile 插入一行 `global-prompt`，不改动任何官方组件。 |

## 设置导航图标

设置导航的图标是官方 shell 里 `navIcon(id)` 的硬编码映射，第三方 section 一律拿兜底齿轮，注册参数里没有图标位
（`dsh-client-ui-settings-general/lib/client.js:244`）。所以 `lib/client.js` 走 `dsh-plugin-wallpaper-engine` 同一条
纯 DOM 补丁路线：盯 `document.body` 的一层 childList，在设置对话框（`[role="dialog"] nav`）里按本分区 label 文本
认那一格，把齿轮换成官方 `IconContextInjectionOutline` 的几何（16px 网格 / stroke 1.3 / currentColor）。补丁装不上
（结构变了 / 找不到行）= 保留齿轮，不抛、不重试。

## HTTP 接口

`GET /global-prompt/api` → `{ ok, exists, content, bytes, mtimeMs, path, displayPath, budgetBytes, limitBytes }`

`POST /global-prompt/api`，body `{ "content": string }` → 同 GET 的载荷（写入后的快照）。请求体上限 1 MiB。

`webServer` 的普通路由不经过 connection 层的 token 鉴权，所以 handler 自带 fence（照抄 `dsh-mcp-connector` 的
`isTrustedWebRequest`）：Host 必须回环或属于 `webRuntime.trustedHosts`，`sec-fetch-site: cross-site` 拒绝，
`Origin` 必须与 Host 同源。

写入采用「同目录临时文件 + rename」原子替换，避免 Agent 读到半截文件；Windows 上 rename 偶发失败时退回直接写。

## 启用

```powershell
# 已安装为 profile 的 link: 依赖，配置见 profile package.json 的 dsh.profile.bundles
# 重新启用：
plugin_manager(action: "set_bundle", target: "dsh-global-prompt", enabled: true)
```

安装位置：`%USERPROFILE%\.dsh\plugins\dsh-global-prompt`，profile 通过 junction 链接到
`%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-global-prompt`，改动源码即时生效（无需重启）。

## 注意

- 宿主半边**不能** import `@deepseek-ai/*`：profile 的 `node_modules` 里没有该作用域，核心包只在 asar 的
  installAnchor 下可见。
- 不要声明 `peerDependencies`：`evaluatePluginCompatibility` 会因此校验 `@deepseek-ai/dsh*` 版本范围并可能拒绝安装。
- 客户端 bundle 由宿主**原样**投递（不做构建/转译），所以 `lib/client.js` 必须手写成自注册脚本；
  相对分块只能用 `require.async("./client.<name>.js")`。
